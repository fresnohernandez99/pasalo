// El "backend" de Pasalo en el navegador: los mismos comandos y eventos que
// la app de Tauri (`app/src-tauri/src/`), para que la interfaz (`app/ui/`)
// funcione igual. Lo que en las apps hace Rust nativo aquí lo hace este
// código con iroh compilado a WASM.
//
// Diferencias con las apps:
// - No hay red local (el navegador no tiene UDP ni TCP): todo va por los
//   relays de iroh, y solo con equipos de otras redes conectados a internet.
// - Lo recibido no va a una carpeta: se guarda en el navegador y se ofrece
//   para guardarlo o compartirlo (ver web-ui.js).

import init, { Node, parse_code as parseCode } from '../pkg/pasalo_web.js';
import { VERSION } from '../version.js';
import { Lobby } from './lobby.js';
import { ALPN, Receiver, forgetReceived, manifest, probe, receivedFile, sendEntries, sendText } from './files.js';
import * as store from './store.js';
import { TALK_ALPN, Talk } from './talk.js';
import { PasaloError, SHORT, asError, cmdError, cmdFrom, mimeFor, sleep, timed, uuid } from './util.js';
import { VoiceCall } from './voice.js';

const DEFAULT_SERVER = 'https://pasalo-server.vercel.app';
/** Dominio de los enlaces (el mismo que abren las apps). */
const LINK_HOST = 'pasalo-server.vercel.app';
const RELAY_WAIT = 20_000;
const FIRST_CONTACT = 60_000;
const RECONNECT = 20_000;
const NAME_MAX = 64;

// ---------- eventos ----------

const listeners = new Map(); // nombre → Set(fn)

export function listen(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name)?.delete(fn);
}

export function emitRaw(name, payload) {
  for (const fn of listeners.get(name) || []) {
    try {
      fn({ event: name, payload });
    } catch (err) {
      console.error(err);
    }
  }
}

/** Un evento del núcleo: primero cambia el estado (como `net::on_event`) y luego va a la interfaz. */
function emit(event) {
  onEvent(event);
  emitRaw('pasalo', event);
}

// ---------- estado ----------

const s = {
  node: null,
  net: null,
  talk: null,
  receiver: null,
  deviceId: '',
  settings: { name: '', server: DEFAULT_SERVER },
  platform: '',
  mobile: false,
  lobby: null,
  joining: null,
  partner: null,
  voice: null,
  video: null, // { peer, sender }
  outgoing: new Map(), // id → { code, entries, job }
  picks: new Map(), // ruta inventada → lo elegido
  nextId: 1,
  link: null,
  images: new Map(), // ruta → URL
  wakeLock: null,
};

let receivedHandler = () => {};
let saveHandler = () => {};
/** Lo que se recibe completo se le pasa a `fn` (para ofrecer guardarlo). */
export function onReceived(fn) {
  receivedHandler = fn;
}
/** `fn(id)` guarda un archivo recibido (el botón de la tarjeta, en escritorio). */
export function onSave(fn) {
  saveHandler = fn;
}

function detectPlatform() {
  const ua = navigator.userAgent;
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/.test(ua) || touchMac) return { platform: 'ios', mobile: true, name: /iPad/.test(ua) || touchMac ? 'iPad' : 'iPhone' };
  if (/Android/.test(ua)) return { platform: 'android', mobile: true, name: 'Android' };
  if (/Mac/.test(ua)) return { platform: 'macos', mobile: false, name: 'Mac' };
  if (/Win/.test(ua)) return { platform: 'windows', mobile: false, name: 'Windows' };
  return { platform: 'linux', mobile: false, name: 'Linux' };
}

const local = () => ({ id: s.deviceId, name: s.settings.name, platform: s.platform });

/** Envoltorio del `Node` de iroh con lo que usan talk.js y files.js. */
class Net {
  constructor(node) {
    this.node = node;
    this.only = null;
  }

  parse(code) {
    return parseCode(String(code || '')) || null;
  }

  async connect(code, alpn) {
    try {
      return await this.node.connect(code, alpn, SHORT);
    } catch (err) {
      throw asError(err);
    }
  }

  allows(code) {
    return !this.only || this.only === code;
  }
}

async function acceptLoop() {
  for (;;) {
    const conn = await s.node.accept().catch(() => null);
    if (!conn) return;
    if (!s.net.allows(conn.remote)) {
      conn.close(1, 'ocupado');
      continue;
    }
    if (conn.alpn === TALK_ALPN) s.talk.accept(conn);
    else if (conn.alpn === ALPN) s.receiver.serve(conn);
    else conn.close(0, 'protocolo desconocido');
  }
}

/** Arranca todo. La interfaz espera a esto antes de cargar. */
export async function start() {
  await init();
  store.persist();
  const detected = detectPlatform();
  s.platform = detected.platform;
  s.mobile = detected.mobile;
  s.deviceId = (await store.kvGet('device_id')) || uuid();
  await store.kvSet('device_id', s.deviceId);
  s.settings = { name: detected.name, server: DEFAULT_SERVER, ...((await store.kvGet('settings')) || {}) };

  const secret = await store.kvGet('secret');
  s.node = await Node.start(secret || undefined);
  if (s.node.secret !== secret) await store.kvSet('secret', s.node.secret);
  s.net = new Net(s.node);
  s.talk = new Talk(s.net, emit);
  s.talk.setName(s.settings.name);
  await s.talk.init();
  s.receiver = new Receiver(emit, local, (files) => receivedHandler(files));
  acceptLoop();
  s.link = linkFromUrl(location.href);
  if (s.link) history.replaceState(null, '', location.pathname);
}

function saveSettings() {
  return store.kvSet('settings', s.settings);
}

// ---------- conexión (net.rs) ----------

const step = (name) => emitRaw('net_step', name);

async function reachInternet() {
  step('internet');
  await s.node.setInternet(true);
  step('relay');
  if (!(await s.node.online(RELAY_WAIT))) {
    await s.node.setInternet(false).catch(() => {});
    throw cmdError('no_relay');
  }
}

async function join() {
  if (s.lobby) return;
  if (s.joining) return s.joining;
  s.joining = (async () => {
    if (!s.settings.server) throw cmdError('no_server');
    await reachInternet();
    step('server');
    try {
      s.lobby = await Lobby.join(s.settings.server, local(), s.node.code, emit);
    } catch (err) {
      await s.node.setInternet(false).catch(() => {});
      throw cmdError('server', err.detail || String(err));
    }
  })().finally(() => (s.joining = null));
  return s.joining;
}

function dropPartner() {
  const partner = s.partner;
  if (!partner) return null;
  s.partner = null;
  stopWith(partner.code);
  s.talk.release(partner.code);
  s.receiver.only = null;
  s.net.only = null;
  return partner;
}

async function watchPartner(partner) {
  const released = await s.talk.hold(partner.code, FIRST_CONTACT, RECONNECT);
  if (released || s.partner?.code !== partner.code) return;
  console.warn(`la pareja ${partner.name} dejó de responder`);
  dropPartner();
  const online = await join().then(() => true, () => false);
  emit({ kind: 'partner_lost', code: partner.code, name: partner.name, online });
}

function onEvent(e) {
  if (e.kind === 'lobby_paired') {
    s.lobby = null;
    s.partner = { ...e.partner, code: s.net.parse(e.partner.code) || e.partner.code };
    e.partner = s.partner;
    s.receiver.only = s.partner.id;
    s.net.only = s.partner.code;
    watchPartner(s.partner);
  } else if (e.kind === 'signal' && e.signal?.kind === 'unpair') {
    if (s.partner?.code === e.peer) {
      dropPartner();
      s.node.setInternet(false).catch(() => {});
    }
  } else if (e.kind === 'talk_lost') {
    stopWith(e.peer);
  }
}

// ---------- llamadas (call.rs) ----------

function stopVoice() {
  const voice = s.voice;
  s.voice = null;
  voice?.stop(s.talk);
}

function stopVideo() {
  const video = s.video;
  s.video = null;
  if (video) s.talk.endVideo(video.peer);
}

function stopWith(peer) {
  const same = (other) => s.net.parse(other) === s.net.parse(peer);
  if (s.voice && same(s.voice.peer)) stopVoice();
  if (s.video && same(s.video.peer)) stopVideo();
}

async function wakeLock(on) {
  try {
    if (on && !s.wakeLock && navigator.wakeLock) {
      s.wakeLock = await navigator.wakeLock.request('screen');
      s.wakeLock.addEventListener('release', () => (s.wakeLock = null));
    } else if (!on && s.wakeLock) {
      await s.wakeLock.release();
      s.wakeLock = null;
    }
  } catch {}
}

// iOS suelta el bloqueo al pasar a segundo plano: al volver, se pide de nuevo.
let wantAwake = false;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantAwake) wakeLock(true);
});

// ---------- enlaces (links.rs) ----------

function linkFromUrl(text) {
  let url;
  try {
    url = new URL(String(text).trim());
  } catch {
    return null;
  }
  const ours =
    url.protocol === 'pasalo:' ||
    ((url.protocol === 'https:' || url.protocol === 'http:') && (url.hostname === LINK_HOST || url.origin === location.origin));
  if (!ours) return null;
  const code = (url.searchParams.get('c') || '').trim();
  if (!code || !s.net.parse(code)) return null;
  const name = (url.searchParams.get('n') || '').trim().slice(0, NAME_MAX);
  return { code, name };
}

// ---------- elegir archivos ----------

function pick({ multiple = true, directory = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (directory) input.webkitdirectory = true;
    input.style.display = 'none';
    document.body.append(input);
    const finish = (files) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish([...input.files]), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    input.click();
  });
}

/** Archivos soltados encima de la ventana, como rutas para la interfaz. */
export function rememberFiles(files) {
  return files.map((file) => remember({ kind: 'file', file }, file.name));
}

/** Lo elegido se guarda con una ruta inventada, que es lo que maneja la interfaz. */
function remember(item, name) {
  const path = `pick:${s.picks.size + 1}/${name}`;
  s.picks.set(path, item);
  return path;
}

// ---------- envíos ----------

function spawnSend(id) {
  const job = s.outgoing.get(id);
  if (!job || job.running) return;
  const run = { cancelled: false, conn: null };
  job.run = run;
  job.running = sendEntries(s.net, id, job.code, job.entries, local(), emit, run).finally(() => {
    if (job.run === run) job.running = null;
  });
}

function stopSend(job) {
  if (!job?.run) return;
  job.run.cancelled = true;
  job.run.conn?.close(0, 'pausado');
  job.running = null;
}

function targetCode(target) {
  const code = s.net.parse(target);
  if (!code) throw cmdError('invalid_target', target);
  return code;
}

// ---------- comandos ----------

const commands = {
  snapshot: () => ({
    name: s.settings.name,
    dir: '',
    port: 0,
    ips: [],
    code: s.node.code,
    mobile: s.mobile,
    peers: [],
    server: s.settings.server,
    online: !!s.lobby,
    direct: s.node.internet && !s.lobby && !s.partner,
    partner: s.partner,
    version: VERSION,
    web: true,
  }),
  refresh: () => {},
  local_addresses: () => [],
  local_network: () => null,
  keep_alive: ({ media }) => {
    wantAwake = media > 0;
    wakeLock(wantAwake);
  },
  set_name: async ({ name }) => {
    name = String(name || '').trim();
    if (!name) throw cmdError('empty_name');
    s.settings.name = name;
    await saveSettings();
    s.talk.setName(name);
  },
  choose_dir: () => null,
  open_dir: () => {},
  reveal: ({ path }) => saveHandler(path),
  set_server: async ({ server }) => {
    server = String(server || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(server)) throw cmdError('invalid_server', server);
    s.settings.server = server;
    await saveSettings();
  },
  check_update: () => ({ version: VERSION, newer: false, url: '', download: null }),
  open_release: ({ url }) => {
    window.open(url, '_blank', 'noopener');
  },

  pick_files: async () => {
    const files = await pick();
    return files.map((file) => remember({ kind: 'file', file }, file.name));
  },
  pick_folder: async () => {
    if (s.mobile) throw cmdError('mobile_files_only');
    const files = await pick({ directory: true });
    if (!files.length) return null;
    const name = (files[0].webkitRelativePath || '').split('/')[0] || 'carpeta';
    return remember({ kind: 'dir', name, files }, name);
  },
  send: ({ target, paths }) => {
    const picks = (paths || []).map((p) => s.picks.get(p)).filter(Boolean);
    if (!picks.length) throw cmdError('nothing_to_send');
    const code = targetCode(target);
    const id = s.nextId++;
    s.outgoing.set(id, { code, entries: manifest(picks), running: null, run: null });
    spawnSend(id);
    return id;
  },
  send_text: ({ target, text }) => sendText(s.net, targetCode(target), local(), text),
  probe: async ({ target }) => {
    try {
      return await probe(s.net, targetCode(target), local());
    } catch (err) {
      throw cmdError('connect_failed', asError(err).detail);
    }
  },
  transfer_decide: ({ id, accept }) => s.receiver.decide(id, accept),
  pause: ({ id }) => stopSend(s.outgoing.get(id)),
  resume: ({ id }) => spawnSend(id),
  forget: ({ id }) => {
    stopSend(s.outgoing.get(id));
    s.outgoing.delete(id);
  },
  cancel_incoming: ({ id }) => s.receiver.cancel(id),

  net_connect: async () => {
    if (s.partner) return;
    await join();
  },
  net_direct: () => reachInternet(),
  net_disconnect: async () => {
    const lobby = s.lobby;
    s.lobby = null;
    await lobby?.leave();
    const partner = s.partner;
    if (partner) {
      const bye = { call: '', kind: 'unpair', data: null };
      await timed(5000, s.talk.signal(partner.code, bye)).catch(() => {});
    }
    dropPartner();
    await s.node.setInternet(false);
  },
  lobby_request: ({ to }) => lobbyOr().request(to),
  lobby_cancel: ({ request }) => lobbyOr().cancel(request),
  lobby_answer: ({ request, accept }) => lobbyOr().answer(request, accept),

  link_take: () => {
    const link = s.link;
    s.link = null;
    return link;
  },
  link_parse: ({ text }) => linkFromUrl(text),
  link_mine: () => {
    const url = new URL(`https://${LINK_HOST}/`);
    url.searchParams.set('c', s.node.code);
    url.searchParams.set('n', s.settings.name);
    return url.toString();
  },

  chat_history: ({ peer }) => s.talk.history(peer),
  chat_send: ({ peer, text }) => {
    if (!String(text || '').trim()) throw cmdError('nothing_to_send');
    return s.talk.sendText(peer, text);
  },
  chat_send_image: ({ peer, data, ext }) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return s.talk.sendImage(peer, bytes, ext);
  },
  chat_image: async ({ path }) => {
    if (s.images.has(path)) return s.images.get(path);
    const blob = String(path).startsWith('media:') ? await store.getMedia(path.slice(6)) : null;
    if (!blob) throw cmdError('other', 'imagen no encontrada');
    const url = URL.createObjectURL(blob);
    s.images.set(path, url);
    return url;
  },

  call_signal: ({ peer, call, kind, data }) => s.talk.signal(peer, { call, kind, data: data ?? null }),
  voice_start: async ({ peer, mode }) => {
    stopVoice();
    const voice = await VoiceCall.start(s.talk, peer, mode);
    s.voice = voice;
  },
  voice_mode: ({ mode }) => s.voice?.setMode(mode),
  voice_mute: ({ muted }) => s.voice?.setMuted(muted),
  // El navegador no deja elegir entre altavoz y auricular.
  voice_speaker: () => {},
  voice_stop: () => stopVoice(),
  voice_stats: () => s.voice?.stats() ?? null,
  video_start: async ({ peer, frames }) => {
    stopVideo();
    const sender = await s.talk.openVideo(peer, (frame) => frames.onmessage?.(frame));
    s.video = { peer, sender };
  },
  video_send: (bytes) => s.video?.sender.send(bytes) ?? false,
  video_stop: () => stopVideo(),
};

function lobbyOr() {
  if (!s.lobby) throw cmdError('not_online');
  return s.lobby;
}

/** Como `invoke` de Tauri. Los errores salen como `{ code, detail }`. */
export function invoke(command, args = {}) {
  const fn = commands[command];
  if (!fn) return Promise.reject(cmdError('other', `comando desconocido: ${command}`));
  try {
    // Sin esperar antes de llamar: elegir archivos necesita seguir dentro del toque del usuario.
    return Promise.resolve(fn(args)).catch((err) => {
      throw toCmd(err);
    });
  } catch (err) {
    return Promise.reject(toCmd(err));
  }
}

function toCmd(err) {
  if (err && typeof err === 'object' && 'code' in err && !(err instanceof Error)) return err;
  return cmdFrom(err);
}

/** Lo recibido como `File`, para guardarlo. */
export async function receivedAsFile(id) {
  const meta = await store.getFile(id);
  if (!meta) return null;
  return receivedFile(id, mimeFor(meta.name));
}

export const forgetFile = forgetReceived;
export const pendingFiles = () => store.allFiles();

export { PasaloError, sleep };
