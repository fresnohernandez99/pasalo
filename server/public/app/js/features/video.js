// Vídeo de las videollamadas: la cámara se comprime aquí con WebCodecs y
// cada imagen viaja por la conexión de iroh (`video_send`), la misma que la
// voz, así que llega siempre que llegue la voz. Lo que viene del otro lado
// sale por un Channel de Tauri y se dibuja en un <canvas>.
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
  constructor({ stream, codec, mode, send, onBytes, onCameraLost, onBlurSlow }) {
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
    await this.video.play().catch(() => {});
  }

  /** Desenfoque del fondo (un `BackgroundBlur`) o ninguno (`null`). */
  setBlur(blur) {
    this.blur = blur;
    this.blurTimes = [];
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
    if (!paused) this.needKey = true;
  }

  configure(width, height) {
    const m = VIDEO_MODES[this.mode];
    const config = {
      codec: this.codec.codec,
      width,
      height,
      bitrate: m.kbps * 1000,
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
    if (!track || track.readyState === 'ended') {
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
    // Si el compresor va atrasado, esta imagen sobra.
    if (this.encoder.encodeQueueSize > 1) return;
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
        this.onBlurSlow?.();
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
        if (!sent) this.needKey = true;
      },
      () => (this.needKey = true),
    );
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
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
    this.reset(null);
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
    this.pending.set(p.seq, p);
    this.drain();
  }

  drain() {
    if (this.next === null) {
      // Se empieza (o se sigue tras un hueco) por la clave más antigua.
      const key = [...this.pending.values()].filter((p) => p.key).sort((a, b) => a.seq - b.seq)[0];
      if (!key) {
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
    return ctx;
  }

  stop() {
    this.reset(null);
    this.resetDecoder();
  }
}
