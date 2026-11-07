// Envío y recepción de archivos con el protocolo de `protocol.rs`
// (`pasalo/1`), el mismo que las apps:
//
//   emisor  Hello → Offer → (Accept | Reject) → datos + FileEnd… → Done → Result
//
// Este lado no anuncia `zstd`, así que los datos van siempre en crudo en los
// dos sentidos. Lo recibido se guarda por trozos en IndexedDB (ver store.js):
// si se corta, el emisor vuelve a ofrecer lo mismo y se sigue desde el último
// trozo guardado. Cada archivo se verifica con BLAKE3.

import { Hasher } from '../pkg/pasalo_web.js';
import * as store from './store.js';
import {
  ASK, CHUNK, LONG, PasaloError, Reader, SHORT, asError, deferred, isRetryable, readMsg, sleep, timed, unexpected,
  writeMsg,
} from './util.js';

export const ALPN = 'pasalo/1';
const PROTOCOL_VERSION = 1;
const PROGRESS_EVERY = 100;
/** Lo recibido se guarda en trozos de este tamaño. */
const PART = 4 * 1024 * 1024;
const LEDGER_EVERY = 1000;
const MAX_TEXT = 64 * 1024;
const MAX_ITEMS = 100_000;

/** Progreso como mucho cada 100 ms. */
class Progress {
  constructor(emit, id, done, total) {
    Object.assign(this, { emit, id, done, total, last: performance.now() });
    this.send();
  }

  add(n) {
    this.done += n;
    if (performance.now() - this.last >= PROGRESS_EVERY) {
      this.last = performance.now();
      this.send();
    }
  }

  send() {
    this.emit({ kind: 'progress', id: this.id, done_bytes: this.done, total_bytes: this.total });
  }
}

function hello(local) {
  return { type: 'hello', version: PROTOCOL_VERSION, device_id: local.id, name: local.name, platform: local.platform, features: [] };
}

/** Ruta relativa separada por `/` sin trampas (`..`, vacíos…), como `split_safe`. */
function splitSafe(path) {
  const parts = path.split('/');
  if (!parts.length || parts.some((p) => !p || p === '.' || p === '..' || p.includes('\0') || p.includes('\\'))) return null;
  return parts;
}

function numbered(name, isDir, n) {
  const dot = name.lastIndexOf('.');
  return !isDir && dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/**
 * Lista de lo que se envía a partir de lo elegido: `File`s sueltos o una
 * carpeta (archivos con `webkitRelativePath`). Cada entrada es `{ item, file }`.
 */
export function manifest(picks) {
  const entries = [];
  const roots = new Set();
  const unique = (base, isDir) => {
    let name = base;
    for (let n = 1; roots.has(name); n++) name = numbered(base, isDir, n);
    roots.add(name);
    return name;
  };
  const mtime = (file) => Math.floor((file.lastModified || 0) / 1000);
  for (const pick of picks) {
    if (pick.kind === 'file') {
      const file = pick.file;
      entries.push({ item: { path: unique(file.name, false), size: file.size, mtime: mtime(file), is_dir: false }, file });
      continue;
    }
    const root = unique(pick.name, true);
    const dirs = new Set([root]);
    const files = [];
    for (const file of pick.files) {
      const rel = (file.webkitRelativePath || file.name).split('/').slice(1);
      if (!rel.length) continue;
      for (let i = 1; i < rel.length; i++) dirs.add([root, ...rel.slice(0, i)].join('/'));
      files.push({ path: [root, ...rel].join('/'), file });
    }
    for (const dir of [...dirs].sort()) entries.push({ item: { path: dir, size: 0, mtime: 0, is_dir: true }, file: null });
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const { path, file } of files) entries.push({ item: { path, size: file.size, mtime: mtime(file), is_dir: false }, file });
  }
  return entries;
}

/** Bytes de un `File` entre `from` y `to`. */
async function slice(file, from, to) {
  return new Uint8Array(await file.slice(from, to).arrayBuffer());
}

/** Hash BLAKE3 de los primeros `len` bytes, listo para seguir con el resto. */
async function hashPrefix(file, len) {
  const hasher = new Hasher();
  for (let at = 0; at < len; at += CHUNK) hasher.update(await slice(file, at, Math.min(len, at + CHUNK)));
  return hasher;
}

// ---------- enviar ----------

/**
 * Envía `entries` a `code`. `job.cancelled` lo para sin avisar (pausar o
 * cancelar); `job.conn` es la conexión en curso, para cortarla.
 */
export async function sendEntries(net, id, code, entries, local, emit, job, maxRetries = 30) {
  for (let attempt = 0; ; attempt++) {
    if (job.cancelled) return;
    try {
      const wire = await sendOnce(net, id, code, entries, local, emit, job);
      if (job.cancelled) return;
      emit({ kind: 'transfer_finished', id, direction: 'outgoing', saved: [], wire_bytes: wire });
      return;
    } catch (err) {
      if (job.cancelled) return;
      const e = asError(err);
      const willRetry = isRetryable(e) && attempt < maxRetries;
      emit({
        kind: 'transfer_failed', id, direction: 'outgoing', error: e.message, code: e.code, detail: e.detail, will_retry: willRetry,
      });
      if (!willRetry) return;
      await sleep(Math.min(1000 * 2 ** Math.min(attempt + 1, 4), 10_000));
    }
  }
}

async function open(net, code, job) {
  const conn = await net.connect(code, ALPN);
  if (job) job.conn = conn;
  const [send, recv] = await conn.openBi(SHORT).catch((err) => {
    conn.close(0, '');
    throw asError(err);
  });
  return { conn, send, reader: new Reader(recv) };
}

async function handshake(send, reader, local) {
  await writeMsg(send, hello(local));
  const msg = await readMsg(reader, SHORT);
  if (msg.type === 'hello') return { name: msg.name, platform: msg.platform };
  if (msg.type === 'reject') throw new PasaloError('rejected', msg.reason);
  throw unexpected('hello');
}

async function readResult(reader) {
  const msg = await readMsg(reader, LONG);
  if (msg.type === 'result') {
    if (msg.error) throw new PasaloError('remote', msg.error);
    return;
  }
  if (msg.type === 'reject') throw new PasaloError('rejected', msg.reason);
  throw unexpected('result');
}

async function sendOnce(net, id, code, entries, local, emit, job) {
  const { conn, send, reader } = await open(net, code, job);
  try {
    const greeting = await handshake(send, reader, local);
    const peer = greeting.name;
    await writeMsg(send, { type: 'offer', items: entries.map((e) => e.item), text: null });
    emit({ kind: 'transfer_waiting', id, peer });
    const answer = await readMsg(reader, LONG);
    if (answer.type === 'reject') throw new PasaloError('rejected', answer.reason);
    if (answer.type !== 'accept') throw unexpected('accept');
    const states = answer.items;
    if (states.length !== entries.length) throw new PasaloError('protocol', 'la respuesta no corresponde a la oferta');

    const files = entries.filter((e) => !e.item.is_dir);
    const total = files.reduce((n, e) => n + e.item.size, 0);
    let resumed = 0;
    entries.forEach((e, i) => {
      if (e.item.is_dir) return;
      resumed += states[i].state === 'skip' ? e.item.size : Math.min(states[i].offset, e.item.size);
    });
    const roots = entries.filter((e) => !e.item.path.includes('/')).map((e) => e.item.path);
    emit({ kind: 'transfer_started', id, direction: 'outgoing', peer, roots, files: files.length, total_bytes: total, resumed_bytes: resumed });

    const progress = new Progress(emit, id, resumed, total);
    let raw = 0;
    for (let i = 0; i < entries.length; i++) {
      const { item, file } = entries[i];
      const state = states[i];
      if (state.state !== 'from' || !file) continue;
      if (state.offset > item.size) throw new PasaloError('protocol', `desplazamiento no válido para ${item.path}`);
      const hash = await sendFile(send, file, state.offset, item.size, progress, job);
      raw += item.size - state.offset;
      await writeMsg(send, { type: 'file_end', index: i, hash });
    }
    progress.send();
    await writeMsg(send, { type: 'done' });
    await readResult(reader);
    return raw;
  } finally {
    conn.close(0, '');
  }
}

async function sendFile(send, file, offset, size, progress, job) {
  if (file.size !== size) throw new PasaloError('local', `${file.name} cambió de tamaño durante el envío`);
  const hasher = offset ? await hashPrefix(file, offset) : new Hasher();
  // Se lee el siguiente bloque mientras sale el anterior.
  let next = offset < size ? slice(file, offset, Math.min(size, offset + CHUNK)) : null;
  for (let at = offset; at < size; ) {
    let data;
    try {
      data = await next;
    } catch (err) {
      throw new PasaloError('local', String(err?.message || err));
    }
    const end = at + data.length;
    next = end < size ? slice(file, end, Math.min(size, end + CHUNK)) : null;
    if (job.cancelled) throw new PasaloError('superseded');
    hasher.update(data);
    try {
      await send.write(data, SHORT);
    } catch (err) {
      throw asError(err);
    }
    progress.add(data.length);
    at = end;
  }
  const hash = hasher.hex();
  hasher.free();
  return hash;
}

/** Envía un texto suelto (a equipos sin chat). */
export async function sendText(net, code, local, text) {
  const { conn, send, reader } = await open(net, code, null);
  try {
    await handshake(send, reader, local);
    await writeMsg(send, { type: 'offer', items: [], text });
    const msg = await readMsg(reader, SHORT);
    if (msg.type === 'reject') throw new PasaloError('rejected', msg.reason);
    if (msg.type !== 'accept') throw unexpected('accept');
    await writeMsg(send, { type: 'done' });
    await readResult(reader);
  } finally {
    conn.close(0, '');
  }
}

/** Se presenta sin enviar nada y devuelve cómo se llama el otro. */
export async function probe(net, code, local) {
  const { conn, send, reader } = await open(net, code, null);
  try {
    const greeting = await handshake(send, reader, local);
    await writeMsg(send, { type: 'done' });
    await readResult(reader);
    return greeting;
  } finally {
    conn.close(0, '');
  }
}

// ---------- recibir ----------

/**
 * Recibe lo que llega por `pasalo/1`. Cada envío nuevo de archivos se le
 * pregunta al usuario (`transfer_request`) y se contesta con `decide`.
 */
export class Receiver {
  constructor(emit, local, onFiles) {
    this.emit = emit;
    this.local = local; // () => { id, name, platform }
    this.onFiles = onFiles; // archivos recibidos completos, para guardarlos
    this.only = null; // device_id del único equipo del que se recibe
    this.slots = new Map(); // clave → { gen, running, abort, conn }
    this.decisions = new Map(); // id → resolve(bool)
    this.keys = new Map(); // id → clave
    this.cancelled = new Set();
  }

  decide(id, accept) {
    const resolve = this.decisions.get(id);
    if (!resolve) return false;
    this.decisions.delete(id);
    resolve(accept);
    return true;
  }

  /** Cancela una recepción: corta la sesión, borra lo recibido y rechaza los reintentos. */
  cancel(id) {
    const key = this.keys.get(id);
    if (!key) return false;
    this.keys.delete(id);
    this.cancelled.add(key);
    const slot = this.slots.get(key);
    (async () => {
      if (slot) {
        slot.gen++;
        slot.abort?.resolve();
        slot.conn?.close(0, 'cancelado');
        await slot.running?.catch(() => {});
      }
      const ledger = await store.getLedger(key);
      if (ledger) {
        await store.deleteAllParts(ledger.pk);
        for (const index of ledger.done) await store.deleteFile(`${ledger.pk}/${index}`);
        await store.deleteLedger(key);
      }
    })().catch(() => {});
    return true;
  }

  /** Atiende una conexión entrante de `pasalo/1`. */
  async serve(conn) {
    let pair;
    try {
      pair = await timed(SHORT, conn.acceptBi());
    } catch {
      conn.close(0, '');
      return;
    }
    if (!pair) return;
    const [send, recv] = pair;
    const started = { id: null };
    try {
      await this.session(conn, send, new Reader(recv), started);
    } catch (err) {
      const e = asError(err);
      console.debug('recepción fallida', e);
      if (started.id !== null) {
        this.emit({
          kind: 'transfer_failed', id: started.id, direction: 'incoming', error: e.message, code: e.code, detail: e.detail, will_retry: false,
        });
      }
    }
    // Se deja que el emisor cierre: cerrar ya podría perder la última respuesta.
    send.finish();
    await timed(SHORT, conn.waitClosed()).catch(() => conn.close(0, ''));
  }

  async session(conn, send, reader, started) {
    const local = this.local();
    // Lo primero que manda cualquiera: pequeño.
    const first = await readMsg(reader, SHORT, 16 * 1024);
    if (first.type !== 'hello') throw unexpected('hello');
    const { version, device_id: deviceId, name: peer } = first;
    await writeMsg(send, hello(local));

    if (version !== PROTOCOL_VERSION) {
      const reason = `versión de protocolo ${version} no soportada`;
      await writeMsg(send, { type: 'reject', reason });
      throw new PasaloError('rejected', reason);
    }

    const offer = await readMsg(reader, SHORT);
    if (offer.type === 'done') return writeMsg(send, { type: 'result', error: null });
    if (offer.type !== 'offer') throw unexpected('offer');
    if (offer.text != null) {
      if (String(offer.text).length > MAX_TEXT) {
        await writeMsg(send, { type: 'reject', reason: 'too_large' });
        throw new PasaloError('rejected', 'too_large');
      }
      await writeMsg(send, { type: 'accept', items: [] });
      this.emit({ kind: 'text_received', from: peer, text: offer.text });
      const done = await readMsg(reader, SHORT);
      if (done.type !== 'done') throw unexpected('done');
      return writeMsg(send, { type: 'result', error: null });
    }

    const items = offer.items || [];
    const rel = items.map((item) => splitSafe(item.path));
    // Tamaños de verdad (enteros, sin pasarse) y una suma que no se desborde.
    const sizes = items.every((i) => Number.isSafeInteger(i.size) && i.size >= 0);
    const total = sizes ? items.reduce((n, i) => n + i.size, 0) : NaN;
    if (rel.some((r) => !r) || !Number.isSafeInteger(total) || items.length > MAX_ITEMS) {
      const reason = 'la oferta contiene rutas no válidas';
      await writeMsg(send, { type: 'reject', reason });
      throw new PasaloError('rejected', reason);
    }

    const keyHasher = new Hasher();
    keyHasher.update(new TextEncoder().encode(`${deviceId}\0${JSON.stringify(items)}`));
    const key = keyHasher.hex().slice(0, 32);
    keyHasher.free();
    if (this.cancelled.has(key)) {
      await writeMsg(send, { type: 'reject', reason: 'cancelled' });
      throw new PasaloError('rejected', 'cancelled');
    }

    // Una sola sesión por transferencia: si el emisor reconecta, la nueva
    // corta la vieja y espera a que suelte lo que estaba guardando.
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { gen: 0, running: null, abort: null, conn: null };
      this.slots.set(key, slot);
    }
    const gen = ++slot.gen;
    slot.abort?.resolve();
    slot.conn?.close(0, 'sustituida');
    const previous = slot.running;
    const finished = deferred();
    const abort = deferred();
    await previous?.catch(() => {});
    if (slot.gen !== gen) throw new PasaloError('superseded');
    Object.assign(slot, { running: finished.promise, abort, conn });
    try {
      await this.receive({ send, reader, items, rel, key, deviceId, peer, started, check: () => slot.gen === gen, abort });
    } finally {
      finished.resolve();
      if (slot.gen === gen) Object.assign(slot, { running: null, abort: null, conn: null });
    }
  }

  async receive({ send, reader, items, rel, key, deviceId, peer, started, check, abort }) {
    // Mismo id en todos los intentos de la misma transferencia.
    const id = parseInt(key.slice(0, 12), 16);
    const superseded = abort.promise.then(() => {
      throw new PasaloError('superseded');
    });
    superseded.catch(() => {});
    const guard = (promise) => Promise.race([promise, superseded]);

    let ledger = await store.getLedger(key);
    const resuming = !!ledger;
    if (!resuming) {
      const roots = [...new Set(rel.map((r) => r[0]))];
      const files = items.filter((i) => !i.is_dir).length;
      const total = items.reduce((n, i) => n + i.size, 0);
      const answer = await this.ask(id, { kind: 'transfer_request', id, peer, roots, files, total_bytes: total }, reader, guard);
      if (answer === 'gone') {
        this.emit({ kind: 'request_closed', id, reason: 'cancelled' });
        throw new PasaloError('io', 'el emisor se fue');
      }
      if (answer !== 'accepted') {
        if (answer === 'timeout') this.emit({ kind: 'request_closed', id, reason: 'timeout' });
        await writeMsg(send, { type: 'reject', reason: answer });
        throw new PasaloError('rejected', answer);
      }
      ledger = { key, pk: `${key}:${Date.now()}`, peer, device: deviceId, roots: {}, done: [], items };
      for (const r of rel) ledger.roots[r[0]] = r[0];
      await store.saveLedger(ledger);
    }

    const states = [];
    const prefixes = [];
    let total = 0;
    let resumed = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.is_dir) {
        states.push({ state: 'skip' });
        prefixes.push(null);
        continue;
      }
      total += item.size;
      if (ledger.done.includes(i)) {
        resumed += item.size;
        states.push({ state: 'skip' });
        prefixes.push(null);
        continue;
      }
      const stored = await store.parts(ledger.pk, i);
      let offset = stored.reduce((n, p) => n + p.blob.size, 0);
      if (offset > item.size) {
        await store.deleteParts(ledger.pk, i);
        offset = 0;
      }
      let hasher = null;
      if (offset) {
        hasher = new Hasher();
        for (const p of stored) hasher.update(new Uint8Array(await p.blob.arrayBuffer()));
      }
      resumed += offset;
      states.push({ state: 'from', offset });
      prefixes.push({ hasher, parts: stored.length });
    }

    await writeMsg(send, { type: 'accept', items: states });
    started.id = id;
    this.keys.set(id, key);
    this.emit({
      kind: 'transfer_started', id, direction: 'incoming', peer, roots: Object.values(ledger.roots),
      files: items.filter((i) => !i.is_dir).length, total_bytes: total, resumed_bytes: resumed,
    });

    const progress = new Progress(this.emit, id, resumed, total);
    let wire = 0;
    const errors = [];
    const received = [];
    let savedAt = performance.now();
    for (let i = 0; i < items.length; i++) {
      const state = states[i];
      if (state.state !== 'from') continue;
      const item = items[i];
      const { hasher, parts } = prefixes[i] || { hasher: null, parts: 0 };
      const h = hasher || new Hasher();
      wire += await this.receiveFile(reader, guard, check, ledger.pk, i, parts, item.size - state.offset, h, progress);
      const end = await guard(readMsg(reader, LONG));
      if (end.type !== 'file_end') throw unexpected('file_end');
      if (end.index !== i) throw new PasaloError('protocol', `se esperaba el archivo ${i} y llegó el ${end.index}`);
      const hash = h.hex();
      h.free();
      if (hash === end.hash) {
        ledger.done.push(i);
        const file = {
          id: `${ledger.pk}/${i}`, pk: ledger.pk, index: i, name: item.path.split('/').pop(), path: item.path,
          size: item.size, mtime: item.mtime, peer, ts: Date.now(),
        };
        await store.addFile(file);
        received.push(file);
        if (performance.now() - savedAt >= LEDGER_EVERY) {
          await store.saveLedger(ledger);
          savedAt = performance.now();
        }
      } else {
        await store.deleteParts(ledger.pk, i);
        errors.push(`${item.path}: el contenido recibido no coincide`);
      }
    }
    progress.send();

    const done = await readMsg(reader, SHORT);
    if (done.type !== 'done') throw unexpected('done');
    if (errors.length) {
      await store.saveLedger(ledger);
      const error = errors.join('; ');
      await writeMsg(send, { type: 'result', error });
      if (received.length) this.onFiles(received);
      throw new PasaloError('remote', error);
    }
    await store.deleteLedger(key);
    this.keys.delete(id);
    await writeMsg(send, { type: 'result', error: null });
    // Lo recibido antes (en otro intento) también se ofrece para guardar.
    const all = [];
    for (const index of ledger.done) {
      const file = await store.getFile(`${ledger.pk}/${index}`);
      if (file) all.push(file);
    }
    this.emit({ kind: 'transfer_finished', id, direction: 'incoming', saved: all.map((f) => f.id), wire_bytes: wire });
    this.onFiles(all);
  }

  /** Recibe `left` bytes del archivo `index` y los va guardando. Devuelve los bytes leídos. */
  async receiveFile(reader, guard, check, pk, index, firstPart, left, hasher, progress) {
    let n = firstPart;
    let pending = [];
    let pendingBytes = 0;
    let read = 0;
    const flush = async () => {
      if (!pendingBytes) return;
      const blob = new Blob(pending);
      pending = [];
      pendingBytes = 0;
      await store.addPart(pk, index, n++, blob);
    };
    // El emisor puede tardar en mandar el primer byte si está hasheando su prefijo.
    let limit = LONG;
    try {
      while (left > 0) {
        if (!check()) throw new PasaloError('superseded');
        const data = await guard(reader.some(Math.min(left, CHUNK), limit));
        limit = SHORT;
        hasher.update(data);
        pending.push(data);
        pendingBytes += data.length;
        left -= data.length;
        read += data.length;
        progress.add(data.length);
        if (pendingBytes >= PART) await flush();
      }
    } finally {
      // También si falló: lo guardado es lo que se reanuda luego. Una sesión
      // sustituida no escribe: la nueva ya contó lo que había.
      if (check()) await flush().catch(() => {});
    }
    return read;
  }

  /** Pregunta al usuario: `accepted`, `declined`, `timeout` o `gone` (el emisor cerró). */
  async ask(id, request, reader, guard) {
    const answer = new Promise((resolve) => this.decisions.set(id, resolve));
    this.emit(request);
    let timer;
    try {
      return await guard(
        Promise.race([
          answer.then((ok) => (ok ? 'accepted' : 'declined')),
          // El emisor no manda nada hasta la respuesta: si llega algo (o cierra), se fue.
          reader.fill().then(() => 'gone', () => 'gone'),
          new Promise((resolve) => (timer = setTimeout(() => resolve('timeout'), ASK))),
        ]),
      );
    } finally {
      clearTimeout(timer);
      if (this.decisions.has(id)) this.decisions.delete(id);
    }
  }
}

/** El archivo recibido `id` (de `store.files`) como `File`. */
export async function receivedFile(id, type) {
  const file = await store.getFile(id);
  if (!file) return null;
  const parts = await store.parts(file.pk, file.index);
  return new File(parts.map((p) => p.blob), file.name, { type, lastModified: (file.mtime || 0) * 1000 || Date.now() });
}

/** Borra un archivo recibido (ya guardado o descartado). */
export async function forgetReceived(id) {
  const file = await store.getFile(id);
  if (!file) return;
  await store.deleteParts(file.pk, file.index);
  await store.deleteFile(id);
}
