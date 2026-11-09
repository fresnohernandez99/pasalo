// Lo que la interfaz necesita de más en el navegador:
// - Lo recibido: una hoja con «Guardar» (en el iPhone abre el menú de
//   compartir, desde donde se guarda en Archivos o en Fotos).
// - En Safari del iPhone, un aviso para añadir Pasalo a la pantalla de
//   inicio: así funciona como una app y el sistema no borra lo guardado.
// - Arrastrar y soltar archivos (en escritorio), como los eventos de Tauri.
// - El audio: iOS solo deja sonar lo que empezó con un toque.
// - El teclado del iPhone y el gesto Atrás del navegador.
// - El service worker, para abrir sin conexión y como app instalada.

import { t } from '../i18n/index.js';
import { on } from '../lib/bus.js';
import { bytes } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { askPermission } from './backend/notify.js';
import { audioContext, unlockAudio } from './backend/voice.js';

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

// ---------- lo recibido ----------

/** id → { meta, file (File, ya preparado para poder compartirlo al tocar) } */
const ready = new Map();
let sheet = null;
let collapsed = false;
let backend = null;

async function offer(files) {
  for (const meta of files) {
    if (ready.has(meta.id)) continue;
    const file = await backend.receivedAsFile(meta.id).catch(() => null);
    if (file) ready.set(meta.id, { meta, file });
  }
  collapsed = false;
  render();
}

function render() {
  if (!sheet) {
    sheet = el('section', { class: 'web-received', 'aria-live': 'polite' });
    document.body.append(sheet);
  }
  sheet.hidden = ready.size === 0;
  document.body.classList.toggle('has-received', ready.size > 0);
  if (!ready.size) {
    document.documentElement.style.setProperty('--sheet-h', '0px');
    return;
  }
  const rows = [...ready.values()].map(({ meta }) =>
    el(
      'div',
      { class: 'web-received-row' },
      el('div', { class: 'web-received-info' },
        el('div', { class: 'web-received-name' }, meta.path || meta.name),
        el('div', { class: 'sub' }, `${bytes(meta.size)} · ${t('web.from', { peer: meta.peer || '' })}`)),
      el('button', { class: 'icon-btn small subtle', type: 'button', title: t('web.discard'), 'aria-label': t('web.discard'), onclick: () => discard([meta.id]) }, '×'),
      el('button', { class: 'primary small', type: 'button', onclick: () => save([meta.id]) }, t('btn.save')),
    ),
  );
  const toggle = el(
    'button',
    { class: 'ghost small', type: 'button', 'aria-expanded': String(!collapsed), onclick: () => ((collapsed = !collapsed), render()) },
    t(collapsed ? 'web.expand' : 'web.collapse'),
  );
  const head = el('div', { class: 'web-received-head' }, el('strong', {}, `${t('web.received')} (${ready.size})`), toggle);
  const actions = el('div', { class: 'web-received-actions' });
  if (ready.size > 1) {
    actions.append(
      el('button', { class: 'ghost small', type: 'button', onclick: () => discard([...ready.keys()]) }, t('web.discard_all')),
      el('button', { class: 'primary small', type: 'button', onclick: () => save([...ready.keys()]) }, t('web.save_all')),
    );
  }
  const body = collapsed ? [] : [el('div', { class: 'web-received-list' }, ...rows), actions];
  sheet.replaceChildren(head, ...body);
  // Lo de debajo (la lista, el botón +) deja sitio a la hoja.
  requestAnimationFrame(() => document.documentElement.style.setProperty('--sheet-h', `${sheet.offsetHeight + 12}px`));
}

async function discard(ids) {
  for (const id of ids) ready.delete(id);
  render();
  for (const id of ids) await backend.forgetFile(id).catch(() => {});
}

/** Guarda: con el menú de compartir si se puede (iPhone, Android) o descargándolo. */
async function save(ids) {
  const entries = ids.map((id) => ready.get(id)).filter(Boolean);
  if (!entries.length) return;
  const files = entries.map((e) => e.file);
  // Sin esperar nada antes: compartir tiene que ir dentro del toque.
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      download(files);
    }
  } else {
    download(files);
  }
  for (const id of ids) ready.delete(id);
  render();
  toast(t('web.saved'));
  // Un poco después, por si la descarga todavía lee del archivo.
  setTimeout(() => ids.forEach((id) => backend.forgetFile(id).catch(() => {})), 60_000);
}

function download(files) {
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const a = el('a', { href: url, download: file.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

// ---------- instalar en el iPhone ----------

// Dentro de la lista y no flotando: no tapa la cabecera ni los botones.
function installHint() {
  if (!isIos() || standalone()) return;
  try {
    if (localStorage.getItem('webInstallHint')) return;
  } catch {}
  const close = () => {
    box.remove();
    try {
      localStorage.setItem('webInstallHint', '1');
    } catch {}
  };
  const box = el(
    'div',
    { class: 'web-install' },
    el('strong', { 'data-i18n': 'web.install_title' }, t('web.install_title')),
    el('p', { 'data-i18n': 'web.install_body' }, t('web.install_body')),
    el('button', { class: 'primary small', type: 'button', 'data-i18n': 'web.install_ok', onclick: close }, t('web.install_ok')),
  );
  (document.querySelector('.home-body') || document.body).prepend(box);
}

// ---------- arrastrar y soltar ----------

// La interfaz escucha los eventos de Tauri (`tauri://drag-*`) con la posición
// en píxeles físicos y las rutas: aquí se fabrican con lo que da el navegador.
function dragAndDrop(emitRaw, remember) {
  const ratio = () => window.devicePixelRatio || 1;
  const position = (ev) => ({ x: ev.clientX * ratio(), y: ev.clientY * ratio() });
  let depth = 0;
  window.addEventListener('dragenter', (ev) => {
    if (!ev.dataTransfer?.types?.includes('Files')) return;
    ev.preventDefault();
    if (depth++ === 0) emitRaw('tauri://drag-enter', { position: position(ev) });
  });
  window.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types?.includes('Files')) return;
    ev.preventDefault();
    emitRaw('tauri://drag-over', { position: position(ev) });
  });
  window.addEventListener('dragleave', () => {
    if (depth && --depth === 0) emitRaw('tauri://drag-leave', {});
  });
  window.addEventListener('drop', (ev) => {
    if (!ev.dataTransfer?.files?.length) return;
    ev.preventDefault();
    depth = 0;
    const paths = remember([...ev.dataTransfer.files]);
    emitRaw('tauri://drag-drop', { position: position(ev), paths });
  });
}

// ---------- teclado y Atrás ----------

// En el iPhone el teclado no encoge la página: se mide con visualViewport y
// se le dice a la interfaz con `--kb` (como hace el plugin de Android).
function keyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    const root = document.documentElement.style;
    root.setProperty('--kb', `${kb}px`);
    // Con el teclado fuera, la zona de la barra de inicio no hace falta.
    root.setProperty('--nav', kb > 0 ? '0px' : 'env(safe-area-inset-bottom, 0px)');
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}

// El gesto Atrás (Android, o Safari fuera de la app instalada) cerraba la
// página entera. Se deja una entrada de historial de reserva: Atrás cierra lo
// que esté abierto (chat, ajustes, foto…) como en la app de Android; si no
// hay nada, se sale de verdad.
function backGesture() {
  history.replaceState({ pasalo: 'base' }, '');
  history.pushState({ pasalo: 'top' }, '');
  window.addEventListener('popstate', () => {
    if (window.pasaloBack?.()) {
      history.pushState({ pasalo: 'top' }, '');
    } else {
      history.back();
    }
  });
  // Escape en escritorio, igual (los diálogos ya se cierran solos con él).
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !document.querySelector('dialog[open]')) window.pasaloBack?.();
  });
}

// ---------- versión nueva ----------

// El service worker sirve la versión guardada; si al abrir hay una nueva, se
// instala por detrás y toma el control. Entonces se recarga, pero nunca en
// mitad de una llamada o de un envío: se espera a que acaben.
function registerWorker() {
  const hadWorker = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(
    (reg) => {
      // Al volver a la app (el iPhone la deja abierta días), se mira si hay otra.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    },
    () => {},
  );
  // Lo tocado en una notificación (ver sw.js).
  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data?.type === 'pasalo-notification') window.pasaloNotification?.(ev.data);
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // La primera instalación también cambia de controlador: ahí no hay nada que recargar.
    if (hadWorker) reloadWhenIdle();
  });
}

function busy() {
  const call = document.getElementById('call');
  const live = document.querySelector('.tcard.request, .tcard.waiting, .tcard.connecting, .tcard.active, .tcard.retrying');
  return (call && !call.hidden) || !!live;
}

function reloadWhenIdle() {
  if (busy()) {
    setTimeout(reloadWhenIdle, 10_000);
    return;
  }
  location.reload();
}

// ---------- descargar la app ----------

const REPO = 'fresnohernandez99/pasalo';
const RELEASES = `https://github.com/${REPO}/releases/latest`;

/** El archivo de la última versión que sirve en este sistema (como `is_our_asset` en la app). */
function ourAsset(name) {
  const ua = navigator.userAgent;
  if (/Android/.test(ua)) return name.endsWith('arm64-v8a.apk');
  if (/Mac/.test(ua)) return name.endsWith('.dmg');
  if (/Win/.test(ua)) return name.endsWith('-setup.exe');
  return name.endsWith('.AppImage');
}

function platformName() {
  const ua = navigator.userAgent;
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Win/.test(ua)) return 'Windows';
  return 'Linux';
}

// En Ajustes → Acerca de. En el iPhone no hay app: se explica que esta web,
// en la pantalla de inicio, es la app.
function getApp() {
  const row = document.getElementById('get-app-row');
  if (!row) return;
  row.hidden = false;
  const fill = () => {
    document.getElementById('get-app-text').textContent = isIos() ? t('web.no_ios_app') : t('web.app_for', { platform: platformName() });
    document.getElementById('get-app').hidden = isIos();
  };
  fill();
  on('lang', fill);
  document.getElementById('get-app').addEventListener('click', async () => {
    // La pestaña se abre ya (dentro del toque) y luego se le pone la descarga.
    const tab = window.open('about:blank', '_blank');
    let url = RELEASES;
    try {
      const release = await (await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)).json();
      url = release.assets?.find((a) => ourAsset(a.name))?.browser_download_url || release.html_url || RELEASES;
    } catch {}
    if (tab) tab.location.href = url;
    else location.href = url;
  });
}

// ---------- arranque ----------

export function initWebUi(api) {
  backend = api;
  document.documentElement.classList.add('web');
  backend.onReceived(offer);
  backend.onSave((id) => save([id]));
  backend.pendingFiles().then(offer, () => {});
  dragAndDrop(backend.emitRaw, backend.rememberFiles);
  keyboard();

  // El timbre de la interfaz crea su propio AudioContext: se le da el de la
  // página, que ya se desbloqueó con el primer toque.
  const Native = window.AudioContext || window.webkitAudioContext;
  if (Native) {
    window.AudioContext = function AudioContext() {
      return audioContext();
    };
  }
  for (const type of ['pointerdown', 'touchend', 'keydown']) {
    window.addEventListener(type, unlockAudio, { capture: true, passive: true });
    // Las notificaciones de mensajes y llamadas: el permiso, al primer toque.
    window.addEventListener(type, askPermission, { capture: true, passive: true, once: true });
  }

  const loaded = () => {
    installHint();
    backGesture();
    getApp();
    // Sin red local, añadir es por código o enlace.
    const input = document.getElementById('manual-ip');
    if (input) input.dataset.i18nPlaceholder = 'peers.add_placeholder_web';
    if (input) input.placeholder = t('peers.add_placeholder_web');
    if ('serviceWorker' in navigator) registerWorker();
  };
  if (document.readyState === 'complete') loaded();
  else window.addEventListener('load', loaded, { once: true });

  on('lang', render);

  // En el móvil, la primera vez que se sale a internet: la página tiene que
  // seguir abierta. Un poco después, para que no lo pisen los avisos de conectar.
  let warned = false;
  backend.listen('net_step', ({ payload }) => {
    if (payload !== 'relay' || warned || !isIos()) return;
    warned = true;
    setTimeout(() => toast(t('web.keep_open')), 4000);
  });
}
