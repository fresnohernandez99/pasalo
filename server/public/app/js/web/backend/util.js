// Lo que comparten los protocolos: errores con el mismo `code` que el núcleo
// en Rust (la interfaz los traduce igual), esperas con límite y mensajes
// `u32` big-endian + JSON, como `protocol.rs` y `talk.rs`.

/** Lo que espera como mucho un paso que debería ser inmediato. */
export const SHORT = 30_000;
/** Lo que se espera a que el usuario acepte o rechace un envío. */
export const ASK = 120_000;
/** Esperas en las que el otro lado puede estar calculando hashes. */
export const LONG = 600_000;
/** Bloques de los archivos. */
export const CHUNK = 256 * 1024;

/** Error como `pasalo_core::Error`: `code` estable y `detail` para mostrar. */
export class PasaloError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

export const protocolError = (detail) => new PasaloError('protocol', detail);
export const unexpected = (what) => protocolError(`se esperaba el mensaje ${what}`);

/** Lo que lance cualquier cosa, como `PasaloError` (los de Rust llegan como texto). */
export function asError(err) {
  if (err instanceof PasaloError) return err;
  const text = String(err?.message ?? err);
  if (text === 'timeout') return new PasaloError('timeout');
  return new PasaloError('io', text);
}

/** Error tal como lo recibe la interfaz (`CmdError` en la app). */
export function cmdError(code, detail = '') {
  return { code, detail: String(detail ?? '') };
}

export function cmdFrom(err) {
  const e = asError(err);
  return cmdError(e.code, e.detail);
}

/** Los errores tras los que tiene sentido reconectar y reanudar. */
export const isRetryable = (e) => ['io', 'timeout', 'remote'].includes(e.code);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `promise`, o `PasaloError('timeout')` si no termina en `ms`. */
export function timed(ms, promise) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new PasaloError('timeout')), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** Promesa que se resuelve desde fuera. */
export function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function frameBytes(message) {
  const json = encoder.encode(JSON.stringify(message));
  const out = new Uint8Array(4 + json.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  return out;
}

export async function writeMsg(send, message) {
  try {
    await send.write(frameBytes(message), SHORT);
  } catch (err) {
    throw asError(err);
  }
}

export async function readMsg(reader, limit, max = 64 * 1024 * 1024) {
  const len = await reader.u32(limit);
  if (len > max) throw protocolError(`mensaje demasiado grande (${len} bytes)`);
  const data = await reader.exact(len, SHORT);
  try {
    return JSON.parse(decoder.decode(data));
  } catch (err) {
    throw protocolError(String(err.message || err));
  }
}

export function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Lectura con búfer de un `Recv`. Solo hay una lectura en vuelo a la vez:
 * quien llega mientras tanto espera a la misma. Así se puede vigilar si el
 * otro lado cierra (`fill`) sin perder lo que llegue luego.
 */
export class Reader {
  constructor(recv) {
    this.recv = recv;
    this.buf = new Uint8Array(0);
    this.pos = 0;
    this.eof = false;
    this.pending = null;
  }

  get available() {
    return this.buf.length - this.pos;
  }

  /** Lee más del stream. `false` al final. */
  fill() {
    if (this.eof) return Promise.resolve(false);
    this.pending ||= this.recv.read(CHUNK, LONG).then(
      (chunk) => {
        this.pending = null;
        if (!chunk) {
          this.eof = true;
          return false;
        }
        const rest = this.buf.subarray(this.pos);
        this.buf = rest.length ? concat([rest, chunk]) : chunk;
        this.pos = 0;
        return true;
      },
      (err) => {
        this.pending = null;
        throw asError(err);
      },
    );
    return this.pending;
  }

  async need(n, limit) {
    while (this.available < n) {
      if (!(await timed(limit, this.fill()))) throw new PasaloError('io', 'conexión cerrada (fin del stream)');
    }
  }

  async exact(n, limit = SHORT) {
    await this.need(n, limit);
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  async u32(limit = SHORT) {
    await this.need(4, limit);
    const value = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getUint32(0);
    this.pos += 4;
    return value;
  }

  /** Lo que haya, hasta `max` bytes (al menos uno). */
  async some(max, limit = SHORT) {
    await this.need(1, limit);
    const n = Math.min(max, this.available);
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** Uuid v4 (Safari viejo no tiene `crypto.randomUUID`). */
export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Tipo MIME por la extensión, para guardar o compartir lo recibido. */
export function mimeFor(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return (
    {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
      heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', mp4: 'video/mp4', m4v: 'video/mp4',
      mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
      ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', pdf: 'application/pdf',
      txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
      html: 'text/html', doc: 'application/msword', xls: 'application/vnd.ms-excel',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      apk: 'application/vnd.android.package-archive',
    }[ext] || 'application/octet-stream'
  );
}
