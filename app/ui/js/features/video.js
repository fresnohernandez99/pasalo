// Vídeo de las videollamadas: la cámara se comprime aquí con WebCodecs y
// cada imagen viaja por la conexión de iroh (`video_send`), la misma que la
// voz, así que llega siempre que llegue la voz. Lo que viene del otro lado se
// recoge con `video_recv` (ver call.js) y se dibuja en un <canvas>.
//
// Nada puede dejar el vídeo parado para siempre mientras sigue la voz: el
// receptor vigila con un temporizador (no solo cuando llegan imágenes) y pide
// una imagen clave; el emisor rehace el compresor si se cuelga sin avisar,
// pide la cámara de nuevo si deja de dar imágenes, y baja la calidad sola si
// la red va descartando imágenes.
//
// Cada imagen lleva delante una cabecera de 12 bytes:
//   [versión u8][flags u8: bit 0 = clave][códec u8][época u8][seq u32][ms u32]
// La época cambia cada vez que se vuelve a encender la cámara: así el otro
// lado sabe que la numeración empieza de nuevo.

// Lo más largo de la imagen (alto o ancho, según se sujete el teléfono), las
// imágenes por segundo y el bitrate. Con poca red, mejor pocas imágenes
// nítidas que muchas borrosas.
export const VIDEO_MODES = {
  minimum: { long: 160, fps: 6, kbps: 40 },
  low: { long: 240, fps: 10, kbps: 70 },
  normal: { long: 320, fps: 15, kbps: 140 },
  high: { long: 480, fps: 20, kbps: 300 },
};

// Por orden de preferencia al enviar. AV1 comprime más, pero sin hardware
// gasta demasiada CPU en un teléfono.
const VIDEO_CODECS = [
  { id: 1, name: 'vp9', codec: 'vp09.00.10.08' },
  { id: 2, name: 'h264', codec: 'avc1.42E01F', avc: { format: 'annexb' } },
  { id: 0, name: 'vp8', codec: 'vp8' },
];

import { Upscaler } from './upscale.js';

const HEADER = 12;
const VERSION = 1;
// Una imagen clave cada tanto, por si algo se pierde sin que nadie lo note.
const KEY_EVERY_MS = 30_000;
// Lo que se espera a una imagen que falta antes de saltar a la siguiente clave.
const GAP_WAIT_MS = 300;
const KEY_REQUEST_EVERY_MS = 1000;
// Llegan imágenes pero no se dibuja ninguna en este tiempo: el decodificador
// se quedó trabado sin avisar y se empieza de nuevo.
const STALL_MS = 2500;
// Lo mínimo entre dos intentos de rehacer el compresor tras un error.
const REBUILD_EVERY_MS = 1000;
// Sin salida del compresor en este tiempo, con imágenes esperando: se colgó.
const ENCODER_STUCK_MS = 2000;
// La cámara sin imágenes nuevas en este tiempo: se pide de nuevo.
const CAMERA_STUCK_MS = 3000;
// Imágenes descartadas por la red en la ventana: se baja un modo.
const DEGRADE_DROPS = 5;
const DEGRADE_WINDOW_MS = 5000;
// Entre dos bajadas, para que la red se asiente.
const DEGRADE_EVERY_MS = 8000;
// Modos de más a menos calidad.
const MODE_ORDER = ['high', 'normal', 'low', 'minimum'];
// Con el fondo desenfocado hay mucho menos detalle que comprimir: se pide
// esta parte del bitrate del modo. Así ahorra datos de verdad (si no, el
// compresor gasta lo mismo afinando la cara).
const BLUR_BITRATE = 0.7;
// Lo que se guarda como mucho mientras se espera una imagen clave.
const PENDING_MAX = 120;
// Lo que se mide antes de decidir si el teléfono da abasto con el desenfoque
// o la mejora de imagen, y la parte del tiempo de cada imagen que pueden usar.
const MEASURE_FRAMES = 20;
const BUDGET = 0.5;

export const videoSupported = () => typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';

/** Nombres de los códecs que este equipo sabe descomprimir. */
export async function decodableCodecs() {
  if (!videoSupported()) return [];
  const out = [];
  for (const c of VIDEO_CODECS) {
    const ok = await VideoDecoder.isConfigSupported({ codec: c.codec }).then((r) => r.supported, () => false);
    if (ok) out.push(c.name);
  }
  return out;
}

/** El mejor códec que aquí se sabe comprimir y allí descomprimir. */
export async function pickCodec(theirs) {
  if (!videoSupported()) return null;
  for (const c of VIDEO_CODECS) {
    if (!theirs.includes(c.name)) continue;
    const config = { codec: c.codec, width: 320, height: 240, bitrate: 100_000, framerate: 15, latencyMode: 'realtime' };
    if (c.avc) config.avc = c.avc;
    const ok = await VideoEncoder.isConfigSupported(config).then((r) => r.supported, () => false);
    if (ok) return c;
  }
  return null;
}

/** Tamaño de envío: la orientación de la cámara y el lado largo del modo, en pares. */
function targetSize(width, height, long) {
  const scale = Math.min(1, long / Math.max(width, height));
  const even = (n) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/**
 * Cámara → imágenes comprimidas. `send(bytes)` devuelve una promesa con
 * `false` si la red las está descartando (la siguiente sale clave).
 * `onBytes(n)` cuenta lo enviado, para las estadísticas.
 * `onCameraLost()` avisa de que la cámara se cortó (p. ej. otra app la tomó)
 * y hay que pedirla de nuevo con `setStream`. `onBlurSlow()`, de que el
 * desenfoque se quitó porque el equipo no daba abasto.
 */
export class VideoSender {
  constructor({ stream, codec, mode, send, onBytes, onCameraLost, onBlurSlow, onBlurFailed, onDegrade }) {
    this.onBlurFailed = onBlurFailed;
    this.onDegrade = onDegrade;
    this.drops = [];
    this.degradedAt = 0;
    this.lastOutputAt = performance.now();
    this.cameraFrameAt = performance.now();
    this.stream = stream;
    this.codec = codec;
    this.mode = mode;
    this.send = send;
    this.onBytes = onBytes;
    this.onCameraLost = onCameraLost;
    this.onBlurSlow = onBlurSlow;
    this.blur = null;
    this.blurTimes = [];
    this.epoch = Math.floor(Math.random() * 256);
    this.seq = 0;
    this.needKey = true;
    this.lastKey = 0;
    this.paused = false;
    this.size = null;
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = stream;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.builtAt = 0;
    this.encoder = this.makeEncoder();
    this.watchCamera();
  }

  // Cuándo dio la cámara su última imagen: si deja de darlas (Android al
  // volver del fondo, otra app con la cámara), se mandaría la misma imagen
  // congelada.
  watchCamera() {
    const v = this.video;
    if (typeof v.requestVideoFrameCallback === 'function') {
      const tick = () => {
        this.cameraFrameAt = performance.now();
        if (!this.stopped) v.requestVideoFrameCallback(tick);
      };
      v.requestVideoFrameCallback(tick);
    } else {
      let last = -1;
      this.cameraTimer = setInterval(() => {
        if (v.currentTime !== last) {
          last = v.currentTime;
          this.cameraFrameAt = performance.now();
        }
      }, 250);
    }
  }

  // Si el compresor falla (pasa con el de hardware del teléfono), se rehace en
  // la siguiente imagen: si no, el vídeo se quedaría parado para siempre.
  makeEncoder() {
    this.builtAt = Date.now();
    this.size = null;
    const encoder = new VideoEncoder({
      output: (chunk) => this.output(chunk),
      error: (err) => {
        console.warn('encoder', err);
        if (this.encoder === encoder) this.encoder = null;
      },
    });
    return encoder;
  }

  async start() {
    await this.video.play().catch(() => {});
    this.schedule();
  }

  schedule() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.capture(), 1000 / VIDEO_MODES[this.mode].fps);
  }

  setMode(mode) {
    if (!VIDEO_MODES[mode] || mode === this.mode) return;
    this.mode = mode;
    this.size = null; // reconfigura con el tamaño y el bitrate nuevos
    this.schedule();
  }

  /** Otra cámara (la de atrás, la de delante): sigue sin cortar la llamada. */
  async setStream(stream) {
    this.stream = stream;
    this.video.srcObject = stream;
    this.size = null;
    this.cameraLost = false;
    this.cameraFrameAt = performance.now();
    this.needKey = true;
    await this.video.play().catch(() => {});
  }

  /** Desenfoque del fondo (un `BackgroundBlur`) o ninguno (`null`). */
  setBlur(blur) {
    if (!!blur !== !!this.blur) this.size = null; // reconfigura con el otro bitrate
    this.blur = blur;
    this.blurTimes = [];
    if (blur) this.blurUsed = true;
  }

  /** Lo que se envía, para verlo en la miniatura (con el fondo desenfocado). */
  preview() {
    if (!this.previewStream) this.previewStream = this.canvas.captureStream();
    return this.previewStream;
  }

  // Si desenfocar se come más de la mitad del tiempo de cada imagen, se quita.
  watchBlur(ms) {
    if (this.blurTimes.length >= MEASURE_FRAMES) return;
    this.blurTimes.push(ms);
    if (this.blurTimes.length < MEASURE_FRAMES) return;
    const avg = this.blurTimes.reduce((a, b) => a + b, 0) / this.blurTimes.length;
    if (avg > (1000 / VIDEO_MODES[this.mode].fps) * BUDGET) {
      console.warn(`desenfoque demasiado lento: ${avg.toFixed(1)} ms por imagen`);
      this.blur = null;
      this.size = null;
      this.onBlurSlow?.();
    }
  }

  /** El otro lado perdió algo: la siguiente imagen, clave. */
  requestKey() {
    this.needKey = true;
  }

  /** Sin enviar imágenes (cámara apagada), pero sin soltar la cámara. */
  setPaused(paused) {
    this.paused = paused;
    if (!paused) {
      this.needKey = true;
      this.cameraFrameAt = performance.now();
    }
  }

  /** La red descartó una imagen: si pasa a menudo, se baja un modo. */
  noteDrop() {
    const now = performance.now();
    this.drops = this.drops.filter((t) => now - t < DEGRADE_WINDOW_MS);
    this.drops.push(now);
    if (this.drops.length < DEGRADE_DROPS || now - this.degradedAt < DEGRADE_EVERY_MS) return;
    const next = MODE_ORDER[MODE_ORDER.indexOf(this.mode) + 1];
    if (!next) return;
    this.degradedAt = now;
    this.drops = [];
    this.setMode(next);
    this.onDegrade?.(next);
  }

  configure(width, height) {
    const m = VIDEO_MODES[this.mode];
    const config = {
      codec: this.codec.codec,
      width,
      height,
      bitrate: Math.round(m.kbps * 1000 * (this.blur ? BLUR_BITRATE : 1)),
      framerate: m.fps,
      latencyMode: 'realtime',
    };
    if (this.codec.avc) config.avc = this.codec.avc;
    this.encoder.configure(config);
    this.canvas.width = width;
    this.canvas.height = height;
    this.size = { width, height };
    this.needKey = true;
  }

  capture() {
    const v = this.video;
    if (this.paused || this.stopped) return;
    const track = this.stream?.getVideoTracks()[0];
    const frozen = performance.now() - this.cameraFrameAt > CAMERA_STUCK_MS;
    if (!track || track.readyState === 'ended' || frozen) {
      if (!this.cameraLost) {
        this.cameraLost = true;
        this.onCameraLost?.();
      }
      return;
    }
    // Android pausa el <video> al salir de la app y no siempre lo reanuda: se
    // seguiría mandando la misma imagen congelada.
    if (v.paused) v.play().catch(() => {});
    if (!this.encoder || this.encoder.state === 'closed') {
      if (Date.now() - this.builtAt < REBUILD_EVERY_MS) return;
      this.encoder = this.makeEncoder();
    }
    if (!v.videoWidth) return;
    // Si el compresor va atrasado, esta imagen sobra. Si además lleva un rato
    // sin sacar nada, se colgó sin avisar (pasa con el de hardware): se rehace.
    if (this.encoder.encodeQueueSize > 1) {
      const now = performance.now();
      if (now - this.lastOutputAt > ENCODER_STUCK_MS && Date.now() - this.builtAt > ENCODER_STUCK_MS) {
        console.warn('compresor de vídeo colgado: se rehace');
        try {
          this.encoder.close();
        } catch {}
        this.encoder = null;
        this.needKey = true;
      }
      return;
    }
    const want = targetSize(v.videoWidth, v.videoHeight, VIDEO_MODES[this.mode].long);
    if (!this.size || want.width !== this.size.width || want.height !== this.size.height) {
      this.configure(want.width, want.height);
    }
    this.ctx.drawImage(v, 0, 0, this.size.width, this.size.height);
    if (this.blur) {
      const started = performance.now();
      try {
        this.blur.apply(this.ctx, v, this.size.width, this.size.height);
        this.watchBlur(performance.now() - started);
      } catch (err) {
        console.warn('desenfoque', err);
        this.blur = null;
        this.size = null;
        this.onBlurFailed?.();
      }
    }
    const frame = new VideoFrame(this.canvas, { timestamp: Math.round(performance.now() * 1000) });
    const now = Date.now();
    const key = this.needKey || now - this.lastKey > KEY_EVERY_MS;
    if (key) {
      this.needKey = false;
      this.lastKey = now;
    }
    try {
      this.encoder.encode(frame, { keyFrame: key });
    } finally {
      frame.close();
    }
  }

  output(chunk) {
    this.lastOutputAt = performance.now();
    const bytes = new Uint8Array(HEADER + chunk.byteLength);
    const view = new DataView(bytes.buffer);
    bytes[0] = VERSION;
    bytes[1] = chunk.type === 'key' ? 1 : 0;
    bytes[2] = this.codec.id;
    bytes[3] = this.epoch;
    view.setUint32(4, this.seq++ >>> 0);
    view.setUint32(8, Math.round(chunk.timestamp / 1000) >>> 0);
    chunk.copyTo(bytes.subarray(HEADER));
    this.onBytes?.(bytes.length);
    this.send(bytes).then(
      (sent) => {
        if (sent) return;
        this.needKey = true;
        this.noteDrop();
      },
      () => (this.needKey = true),
    );
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.cameraTimer);
    this.previewStream?.getTracks().forEach((track) => track.stop());
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    this.encoder = null;
    this.video.srcObject = null;
  }
}

/**
 * Imágenes comprimidas → <canvas>. Las imágenes pueden llegar desordenadas
 * (cada una va por su stream): se ponen en orden y, si falta una, se espera
 * un poco y luego se salta a la siguiente clave. `needKey()` pide una clave
 * al otro lado.
 */
export class VideoReceiver {
  /** Con `enhance`, la imagen se mejora en la GPU (ver upscale.js) si se puede. */
  constructor({ canvas, needKey, onBytes, onFrame, enhance = false }) {
    // Un canvas que en otra llamada acabó con contexto 2D ya no admite la
    // mejora (WebGL): se cambia por uno nuevo igual.
    if (enhance && canvas.dataset.ctx === '2d') {
      const fresh = canvas.cloneNode(false);
      delete fresh.dataset.ctx;
      canvas.replaceWith(fresh);
      canvas = fresh;
    }
    this.canvas = canvas;
    this.ctx = null;
    this.upscaler = enhance ? Upscaler.create(canvas) : null;
    this.drawTimes = [];
    this.needKey = needKey;
    this.onBytes = onBytes;
    this.onFrame = onFrame;
    this.decoder = null;
    this.codecId = null;
    this.drawnAt = Date.now();
    this.expecting = true;
    this.reset(null);
    // Vigilancia por temporizador: si no se dibuja nada (lleguen imágenes o
    // no), se empieza de nuevo y se pide una imagen clave. Antes solo se
    // miraba al llegar una imagen, y si dejaban de llegar no se pedía nada.
    this.watchdog = setInterval(() => this.checkStall(), 1000);
  }

  /** Si se esperan imágenes (con la cámara del otro apagada, no). */
  setExpecting(on) {
    this.expecting = on;
    this.drawnAt = Date.now();
  }

  checkStall() {
    if (!this.expecting) return;
    const now = Date.now();
    if (now - this.drawnAt <= STALL_MS) return;
    this.drawnAt = now;
    this.reset(this.epoch);
    this.resetDecoder();
    this.askKey();
  }

  reset(epoch) {
    this.epoch = epoch;
    this.next = null; // seq que toca decodificar; null = esperando una clave
    this.pending = new Map();
    clearTimeout(this.gapTimer);
    this.gapTimer = null;
  }

  push(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length <= HEADER || bytes[0] !== VERSION) return;
    this.onBytes?.(bytes.length);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const p = {
      key: (bytes[1] & 1) === 1,
      codec: bytes[2],
      epoch: bytes[3],
      seq: view.getUint32(4),
      ts: view.getUint32(8),
      data: bytes.subarray(HEADER),
    };
    if (p.epoch !== this.epoch) {
      this.reset(p.epoch);
      this.resetDecoder();
    }
    // Siguen llegando imágenes pero no se dibuja nada: se empieza de nuevo
    // desde la próxima clave.
    const now = Date.now();
    if (now - this.drawnAt > STALL_MS) {
      console.warn('video atascado: se reinicia el decodificador');
      this.drawnAt = now;
      this.reset(this.epoch);
      this.resetDecoder();
      this.askKey();
    }
    if (this.next !== null && p.seq < this.next) return; // vieja: ya se saltó
    // Esperando una clave, lo demás no sirve: no se acumula.
    if (this.next === null && !p.key && this.pending.size >= PENDING_MAX) return;
    this.pending.set(p.seq, p);
    this.drain();
  }

  drain() {
    if (this.next === null) {
      // Se empieza (o se sigue tras un hueco) por la clave más antigua.
      const key = [...this.pending.values()].filter((p) => p.key).sort((a, b) => a.seq - b.seq)[0];
      if (!key) {
        // Sin una clave delante, las demás no se pueden mostrar.
        this.pending.clear();
        this.askKey();
        return;
      }
      for (const seq of this.pending.keys()) if (seq < key.seq) this.pending.delete(seq);
      this.next = key.seq;
    }
    while (this.pending.has(this.next)) {
      const p = this.pending.get(this.next);
      this.pending.delete(this.next);
      this.next++;
      this.decode(p);
    }
    clearTimeout(this.gapTimer);
    this.gapTimer = this.pending.size ? setTimeout(() => this.skipGap(), GAP_WAIT_MS) : null;
  }

  // La imagen que falta no llegó: lo que dependa de ella no sirve.
  skipGap() {
    this.gapTimer = null;
    this.next = null;
    this.drain();
  }

  askKey() {
    const now = Date.now();
    if (now - (this.lastAsk || 0) < KEY_REQUEST_EVERY_MS) return;
    this.lastAsk = now;
    this.needKey();
  }

  resetDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.codecId = null;
  }

  decode(p) {
    if (!this.decoder || this.codecId !== p.codec) {
      const c = VIDEO_CODECS.find((x) => x.id === p.codec);
      if (!c || !p.key) {
        this.next = null;
        return;
      }
      this.resetDecoder();
      this.decoder = new VideoDecoder({
        output: (frame) => this.draw(frame),
        error: (err) => {
          console.warn('decoder', err);
          this.resetDecoder();
          this.next = null;
          this.askKey();
        },
      });
      const config = { codec: c.codec, optimizeForLatency: true };
      if (c.avc) config.avc = c.avc;
      this.decoder.configure(config);
      this.codecId = p.codec;
    }
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: p.ts * 1000, data: p.data }));
    } catch (err) {
      console.warn('decode', err);
      this.resetDecoder();
      this.next = null;
      this.askKey();
    }
  }

  draw(frame) {
    if (this.upscaler && this.drawEnhanced(frame)) {
      frame.close();
      this.drawnAt = Date.now();
      this.onFrame?.();
      return;
    }
    if (!this.ctx) this.ctx = this.plainContext();
    const { displayWidth: w, displayHeight: h } = frame;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(frame, 0, 0, w, h);
    frame.close();
    this.drawnAt = Date.now();
    this.onFrame?.();
  }

  // Con la GPU; al principio se mide, y si no da abasto (o se pierde el
  // contexto) se vuelve a dibujar como siempre.
  drawEnhanced(frame) {
    const measuring = this.drawTimes.length < MEASURE_FRAMES;
    const started = performance.now();
    let ok = false;
    try {
      ok = this.upscaler.draw(frame);
      if (ok && measuring) this.upscaler.finish();
    } catch (err) {
      console.warn('mejora de imagen', err);
    }
    if (ok && measuring) {
      this.drawTimes.push(performance.now() - started);
      if (this.drawTimes.length === MEASURE_FRAMES) {
        const avg = this.drawTimes.reduce((a, b) => a + b, 0) / MEASURE_FRAMES;
        // Unas 15 imágenes por segundo como mucho: la mitad de su tiempo.
        if (avg > (1000 / 15) * BUDGET) {
          console.warn(`mejora de imagen demasiado lenta: ${avg.toFixed(1)} ms`);
          ok = false;
        }
      }
    }
    if (!ok) this.upscaler = null;
    return ok;
  }

  // Un canvas que ya tuvo WebGL no admite un contexto 2D: se cambia por uno nuevo igual.
  plainContext() {
    let ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      const fresh = this.canvas.cloneNode(false);
      this.canvas.replaceWith(fresh);
      this.canvas = fresh;
      ctx = fresh.getContext('2d', { alpha: false });
    }
    this.canvas.dataset.ctx = '2d';
    return ctx;
  }

  stop() {
    clearInterval(this.watchdog);
    this.reset(null);
    this.resetDecoder();
  }
}
