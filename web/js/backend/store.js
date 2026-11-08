// Lo que se guarda en el navegador (IndexedDB): la identidad y los ajustes,
// el historial del chat con sus fotos y lo que se recibe (en trozos, para
// poder reanudar una recepción aunque se cierre la página).
//
// Almacenes:
//   kv      clave → valor (ajustes, clave de iroh, id del equipo)
//   chat    mensajes por id, con índice por equipo
//   media   fotos del chat por nombre (`<id>.<ext>`)
//   ledger  recepciones a medias por clave de transferencia (como `ledger.rs`)
//   parts   trozos recibidos: [pk, índice del archivo, n] → Blob
//   files   archivos recibidos completos, esperando a que se guarden

const DB = 'pasalo';
const VERSION = 1;

let opening = null;

function db() {
  opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('kv');
      d.createObjectStore('chat', { keyPath: 'id' }).createIndex('peer', 'peer');
      d.createObjectStore('media');
      d.createObjectStore('ledger', { keyPath: 'key' });
      d.createObjectStore('parts', { keyPath: ['pk', 'index', 'n'] });
      d.createObjectStore('files', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(store, mode, fn) {
  const tx = (await db()).transaction(store, mode);
  const result = fn(tx.objectStore(store));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transacción abortada'));
  });
  return result instanceof IDBRequest ? result.result : result;
}

const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
const put = (store, value, key) => run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)));
const del = (store, key) => run(store, 'readwrite', (s) => s.delete(key));

// ---------- ajustes ----------

export const kvGet = (key) => get('kv', key);
export const kvSet = (key, value) => put('kv', value, key);

// ---------- chat ----------

let order = 0;

/** Guarda un mensaje nuevo o su estado nuevo, sin cambiar su sitio en el historial. */
export async function saveMessage(message) {
  const before = await get('chat', message.id);
  const ord = before?.ord ?? Date.now() * 1000 + (order++ % 1000);
  await put('chat', { ...message, ord });
}

export const getMessage = (id) => get('chat', id);

export async function history(peer) {
  const list = await run('chat', 'readonly', (s) => s.index('peer').getAll(peer));
  return list.sort((a, b) => a.ord - b.ord).map(({ ord, ...m }) => m);
}

/** Borra todos los mensajes con `peer` y sus fotos y notas de voz. */
export async function wipeChat(peer) {
  const list = await run('chat', 'readonly', (s) => s.index('peer').getAll(peer));
  for (const m of list) {
    for (const path of [m.image, m.audio]) {
      if (typeof path === 'string' && path.startsWith('media:')) await del('media', path.slice(6));
    }
  }
  await run('chat', 'readwrite', (s) => {
    for (const m of list) s.delete(m.id);
  });
}

export async function pendingMessages() {
  const all = await run('chat', 'readonly', (s) => s.getAll());
  return all.filter((m) => m.outgoing && m.status === 'pending').map(({ ord, ...m }) => m);
}

export const putMedia = (name, blob) => put('media', blob, name);
export const getMedia = (name) => get('media', name);
export const deleteMedia = (name) => del('media', name);

// ---------- recepciones ----------

export const getLedger = (key) => get('ledger', key);
export const saveLedger = (ledger) => put('ledger', ledger);
export const deleteLedger = (key) => del('ledger', key);

const partRange = (pk, index) => IDBKeyRange.bound([pk, index, 0], [pk, index, Infinity]);

export async function addPart(pk, index, n, blob) {
  await put('parts', { pk, index, n, blob });
}

/** Trozos de un archivo, en orden. */
export async function parts(pk, index) {
  const list = await run('parts', 'readonly', (s) => s.getAll(partRange(pk, index)));
  return list.sort((a, b) => a.n - b.n);
}

export async function deleteParts(pk, index) {
  await run('parts', 'readwrite', (s) => s.delete(partRange(pk, index)));
}

/** Borra todos los trozos de una recepción. */
export async function deleteAllParts(pk) {
  await run('parts', 'readwrite', (s) => s.delete(IDBKeyRange.bound([pk, 0, 0], [pk, Infinity, Infinity])));
}

export const addFile = (file) => put('files', file);
export const getFile = (id) => get('files', id);
export const deleteFile = (id) => del('files', id);
export const allFiles = () => run('files', 'readonly', (s) => s.getAll());

/** Pide que el navegador no borre lo guardado si se queda sin espacio. */
export function persist() {
  navigator.storage?.persist?.().catch(() => {});
}
