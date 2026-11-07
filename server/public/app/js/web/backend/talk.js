// Canal "talk" (chat, fotos y señales de llamada), el mismo protocolo que
// `pasalo_core::Talk`: una conexión de iroh por equipo que se reutiliza, cada
// mensaje en su propio stream bidireccional (JSON con la longitud delante y,
// si es una foto, sus bytes) y un `ack` de vuelta. La voz va en datagramas
// de esa conexión y el vídeo, una imagen por stream unidireccional.
//
// Los mensajes que no se pueden entregar quedan pendientes y se reintentan
// cuando el otro equipo aparece y, por si acaso, cada vez más espaciados.

import {
  LONG, PasaloError, Reader, SHORT, asError, concat, frameBytes, protocolError, readMsg, sleep, timed, uuid,
} from './util.js';
import * as store from './store.js';

export const TALK_ALPN = 'pasalo/talk/1';
const MAX_IMAGE = 25 * 1024 * 1024;
const MAX_FRAME = 256 * 1024;
const RETRY_FIRST = 20_000;
const RETRY_MAX = 600_000;
const MAX_VIDEO_FRAME = 1024 * 1024;
const STREAM_VIDEO = 1;
const VIDEO_MAX_LAG = 1000;
const VIDEO_TIMEOUT = 10_000;
/** Sin mensajes ni llamada en este tiempo, la conexión se cierra. */
const IDLE = 90_000;
const HOLD_RETRY = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Envía `frame` (y `body`) en un stream nuevo y espera el acuse. */
async function exchange(conn, frame, body) {
  try {
    const [send, recv] = await conn.openBi(SHORT);
    const head = frameBytes(frame);
    await send.write(body ? concat([head, body]) : head, body ? LONG : SHORT);
    send.finish();
    const ack = await readMsg(new Reader(recv), SHORT, MAX_FRAME);
    if (ack.type !== 'ack') throw protocolError('se esperaba un acuse');
  } catch (err) {
    throw asError(err);
  }
}

/** Lado de envío del vídeo: como `VideoSender` en Rust. */
class VideoSender {
  constructor(conn) {
    this.conn = conn;
    this.inFlight = new Map(); // seq → cuándo salió
    this.next = 0;
  }

  /** `false` si se descartó porque la red va atrasada (la siguiente, clave). */
  send(frame) {
    const oldest = this.inFlight.values().next().value;
    if (oldest !== undefined && performance.now() - oldest > VIDEO_MAX_LAG) return false;
    const seq = this.next++;
    this.inFlight.set(seq, performance.now());
    (async () => {
      let stream = null;
      try {
        stream = await this.conn.openUni(VIDEO_TIMEOUT);
        stream.setPriority(-1);
        const data = new Uint8Array(frame.length + 1);
        data[0] = STREAM_VIDEO;
        data.set(frame, 1);
        await stream.write(data, VIDEO_TIMEOUT);
        stream.finish();
        await stream.stopped(VIDEO_TIMEOUT);
      } catch {
        // Una imagen vieja ya no sirve: se cancela para que no siga gastando
        // red. El otro lado pedirá una clave si le hace falta.
        stream?.reset();
      } finally {
        this.inFlight.delete(seq);
      }
    })();
    return true;
  }
}

export class Talk {
  /** `node` es el `Node` de iroh; `emit` saca eventos hacia la interfaz. */
  constructor(node, emit) {
    this.node = node;
    this.emit = emit;
    this.name = '';
    this.conns = new Map(); // código → Conn
    this.connecting = new Map(); // código → Promise<Conn>
    this.used = new Map(); // código → última vez
    this.backoff = new Map(); // código → { next, fails }
    this.pinned = new Set();
    this.voice = new Map(); // código → (datagrama) => void
    this.video = new Map(); // código → (imagen) => void
    this.pending = new Map(); // id → mensaje
    this.delivering = new Map(); // id → intento
    this.attempts = 0;
  }

  async init() {
    for (const m of await store.pendingMessages()) this.pending.set(m.id, m);
    setInterval(() => {
      this.retryDue();
      this.closeIdle();
    }, 10_000);
  }

  setName(name) {
    this.name = name;
  }

  normalize(peer) {
    return this.node.parse(peer) || peer;
  }

  parsePeer(peer) {
    const code = this.node.parse(peer);
    if (!code) throw protocolError(`código no válido: ${peer}`);
    return code;
  }

  history(peer) {
    return store.history(this.normalize(peer));
  }

  sendText(peer, text) {
    return this.queue(uuid(), peer, text, null);
  }

  async sendImage(peer, bytes, ext) {
    if (bytes.length > MAX_IMAGE) throw protocolError(`la imagen supera ${MAX_IMAGE / 1024 / 1024} MB`);
    const id = uuid();
    const name = mediaName(id, ext);
    await store.putMedia(name, new Blob([bytes], { type: imageType(name) }));
    return this.queue(id, peer, null, `media:${name}`);
  }

  /** Envía una señal y espera la confirmación. No se reintenta. */
  async signal(peer, signal) {
    const code = this.parsePeer(peer);
    const conn = await this.connection(code);
    try {
      await exchange(conn, { type: 'signal', name: this.name, signal });
    } catch (err) {
      // En plena llamada no se abre otra conexión por una señal que no llegó.
      if (!this.voice.has(code) && !this.video.has(code)) this.forgetConnection(code, conn);
      throw err;
    }
  }

  /** Abre la voz con `peer`: los datagramas que lleguen van a `onPacket`. */
  async openVoice(peer, onPacket) {
    const code = this.parsePeer(peer);
    const conn = await this.connection(code);
    this.voice.set(code, onPacket);
    return conn;
  }

  endVoice(peer) {
    const code = this.node.parse(peer);
    if (code) this.voice.delete(code);
  }

  /** Abre el vídeo con `peer`: cada imagen que llegue va a `onFrame`. */
  async openVideo(peer, onFrame) {
    const code = this.parsePeer(peer);
    const conn = await this.connection(code);
    this.video.set(code, onFrame);
    return new VideoSender(conn);
  }

  endVideo(peer) {
    const code = this.node.parse(peer);
    if (code) this.video.delete(code);
  }

  /**
   * Mantiene abierta la conexión con `peer` (la pareja). Termina con `true`
   * al llamar a `release`, o con `false` si no se logra conectar en `first`
   * (la primera vez) o en `grace` (tras un corte).
   */
  async hold(peer, first, grace) {
    const code = this.node.parse(peer);
    if (!code) return false;
    this.pinned.add(code);
    let wait = first;
    for (;;) {
      const deadline = Date.now() + wait;
      wait = grace;
      let conn;
      for (;;) {
        if (!this.pinned.has(code)) return true;
        try {
          conn = await this.connection(code);
          this.retry(code);
          break;
        } catch {
          if (Date.now() >= deadline) {
            this.pinned.delete(code);
            return false;
          }
          await sleep(HOLD_RETRY);
        }
      }
      await conn.waitClosed();
    }
  }

  /** Deja de hablar con `peer`: cierra la conexión y no reintenta hasta que vuelva. */
  release(peer) {
    const code = this.node.parse(peer);
    if (!code) return;
    this.pinned.delete(code);
    this.voice.delete(code);
    this.video.delete(code);
    this.used.delete(code);
    for (const [id] of this.delivering) {
      if (this.pending.get(id)?.peer === code) this.delivering.delete(id);
    }
    this.backoff.set(code, { next: Date.now() + RETRY_MAX, fails: 10 });
    const conn = this.conns.get(code);
    this.conns.delete(code);
    conn?.close(0, 'desconectado');
  }

  /** Olvida la conexión con `code` (si es `which`) y la cierra, salvo en plena llamada. */
  forgetConnection(code, which) {
    const conn = this.conns.get(code);
    if (!conn || (which && which.id !== conn.id)) return;
    this.conns.delete(code);
    if (!this.voice.has(code) && !this.video.has(code)) conn.close(0, 'sin respuesta');
  }

  /** Conexión entrante del protocolo talk. */
  accept(conn) {
    this.serve(conn);
  }

  async queue(id, peer, text, image) {
    const code = this.parsePeer(peer);
    const message = { id, peer: code, outgoing: true, ts: Date.now(), text, image, status: 'pending' };
    await store.saveMessage(message);
    this.pending.set(id, message);
    this.spawnDelivery(message);
    return message;
  }

  /** Reintenta ya lo pendiente (de un equipo o de todos). */
  retry(peer) {
    const code = peer ? this.normalize(peer) : null;
    if (code) this.backoff.delete(code);
    else this.backoff.clear();
    for (const m of this.pending.values()) if (!code || m.peer === code) this.spawnDelivery(m);
  }

  retryDue() {
    const now = Date.now();
    for (const m of this.pending.values()) {
      if (this.delivering.has(m.id)) continue;
      const b = this.backoff.get(m.peer);
      if (!b || b.next <= now) this.spawnDelivery(m);
    }
  }

  failed(code) {
    const fails = this.backoff.get(code)?.fails ?? 0;
    const wait = Math.min(RETRY_FIRST * 2 ** Math.min(fails, 10), RETRY_MAX);
    this.backoff.set(code, { next: Date.now() + wait, fails: fails + 1 });
  }

  touch(code) {
    this.used.set(code, Date.now());
  }

  closeIdle() {
    const now = Date.now();
    for (const [code, at] of this.used) {
      if (now - at < IDLE || this.voice.has(code) || this.video.has(code) || this.pinned.has(code)) continue;
      this.used.delete(code);
      const conn = this.conns.get(code);
      this.conns.delete(code);
      conn?.close(0, 'inactiva');
    }
  }

  spawnDelivery(message) {
    const attempt = ++this.attempts;
    this.delivering.set(message.id, attempt);
    this.deliver(message).then(
      () => {},
      () => {
        // Si lo sustituyó otro intento (o se soltó al equipo), este no cuenta.
        if (this.delivering.get(message.id) === attempt) this.failed(message.peer);
      },
    ).finally(() => {
      if (this.delivering.get(message.id) === attempt) this.delivering.delete(message.id);
    });
  }

  async deliver(message) {
    const conn = await this.connection(message.peer);
    let body = null;
    let image = null;
    if (message.image) {
      const name = message.image.replace(/^media:/, '');
      const blob = await store.getMedia(name);
      if (!blob) throw new PasaloError('local', 'foto perdida');
      body = new Uint8Array(await blob.arrayBuffer());
      image = { ext: name.split('.').pop() || 'jpg', size: body.length };
    }
    const frame = { type: 'chat', id: message.id, ts: message.ts, name: this.name, text: message.text, image };
    try {
      await exchange(conn, frame, body);
    } catch (err) {
      this.forgetConnection(message.peer, conn);
      throw err;
    }
    if (!this.pending.has(message.id)) return;
    const delivered = { ...message, status: 'delivered' };
    await store.saveMessage(delivered);
    this.pending.delete(message.id);
    this.emit({ kind: 'chat', message: delivered, name: null });
  }

  /** La conexión con `code`: la que hubiera abierta o una nueva. */
  connection(code) {
    this.touch(code);
    const open = this.conns.get(code);
    if (open && !open.closed) return Promise.resolve(open);
    let connecting = this.connecting.get(code);
    if (!connecting) {
      connecting = this.node
        .connect(code, TALK_ALPN)
        .then((conn) => {
          this.conns.set(code, conn);
          this.serve(conn);
          return conn;
        })
        .finally(() => this.connecting.delete(code));
      this.connecting.set(code, connecting);
    }
    return connecting;
  }

  /** Atiende lo que llegue por `conn`, entrante o abierta por nosotros. */
  async serve(conn) {
    const code = conn.remote;
    // La más reciente manda: si el otro acaba de conectar es que esta funciona.
    if (conn.incoming || !this.conns.has(code)) this.conns.set(code, conn);
    this.touch(code);
    if (conn.incoming) this.retry(code);

    const datagrams = (async () => {
      for (;;) {
        const packet = await conn.readDatagram().catch(() => null);
        if (!packet) return;
        this.voice.get(code)?.(packet);
      }
    })();
    const streams = (async () => {
      for (;;) {
        const pair = await conn.acceptBi().catch(() => null);
        if (!pair) return;
        this.touch(code);
        this.handle(code, pair[0], pair[1]).catch((err) => console.debug('mensaje fallido', err));
      }
    })();
    const uni = (async () => {
      for (;;) {
        const recv = await conn.acceptUni().catch(() => null);
        if (!recv) return;
        this.touch(code);
        recv.readToEnd(MAX_VIDEO_FRAME + 1, VIDEO_TIMEOUT).then(
          (data) => {
            if (data[0] === STREAM_VIDEO) this.video.get(code)?.(data.subarray(1));
          },
          () => {},
        );
      }
    })();
    await Promise.all([datagrams, streams, uni]);

    if (this.conns.get(code)?.id === conn.id) this.conns.delete(code);
    // Puede quedar otra (los dos lados conectaron a la vez): no se perdió nada.
    if (this.conns.get(code) && !this.conns.get(code).closed) return;
    const voice = this.voice.delete(code);
    const video = this.video.delete(code);
    if (voice || video) this.emit({ kind: 'talk_lost', peer: code });
  }

  async handle(code, send, recv) {
    const reader = new Reader(recv);
    const frame = await readMsg(reader, SHORT, MAX_FRAME);
    const ack = async () => {
      await send.write(frameBytes({ type: 'ack' }), SHORT);
      send.finish();
    };
    if (frame.type === 'chat') {
      // El id forma el nombre de la foto: solo un uuid.
      if (!UUID.test(String(frame.id))) throw protocolError('id de mensaje no válido');
      const before = await store.getMessage(frame.id);
      const known = before && before.peer === code;
      let image = null;
      if (frame.image) {
        if (frame.image.size > MAX_IMAGE) throw protocolError('imagen demasiado grande');
        const bytes = await reader.exact(frame.image.size, LONG);
        if (!known) {
          const name = mediaName(frame.id, frame.image.ext);
          await store.putMedia(name, new Blob([bytes], { type: imageType(name) }));
          image = `media:${name}`;
        }
      }
      await ack();
      if (known) return;
      const message = {
        id: frame.id, peer: code, outgoing: false, ts: frame.ts, text: frame.text ?? null, image, status: 'received',
      };
      await store.saveMessage(message);
      this.emit({ kind: 'chat', message, name: frame.name });
    } else if (frame.type === 'signal') {
      await ack();
      this.emit({ kind: 'signal', peer: code, name: frame.name, signal: frame.signal });
    } else {
      throw protocolError('acuse inesperado');
    }
  }
}

function mediaName(id, ext) {
  let clean = String(ext || '').replace(/[^a-z0-9]/gi, '').slice(0, 5).toLowerCase();
  if (!clean) clean = 'bin';
  return `${id}.${clean}`;
}

function imageType(name) {
  const ext = name.split('.').pop();
  return { png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/jpeg';
}

export { timed };
