// Lo que la interfaz necesita de más en el navegador:
// - Lo recibido: una hoja con «Guardar» (en el iPhone abre el menú de
//   compartir, desde donde se guarda en Archivos o en Fotos).
// - En Safari del iPhone, un aviso para añadir Pasalo a la pantalla de
//   inicio: así funciona como una app y el sistema no borra lo guardado.
// - Arrastrar y soltar archivos (en escritorio), como los eventos de Tauri.
// - El audio: iOS solo deja sonar lo que empezó con un toque.
// - El service worker, para abrir sin conexión y como app instalada.

import { currentLang } from '../i18n/index.js';
import { bytes } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { audioContext, unlockAudio } from './backend/voice.js';

const TEXT = {
  es: {
    received: 'Recibido',
    save: 'Guardar',
    save_all: 'Guardar todo',
    discard: 'Descartar',
    saved: 'Guardado',
    from: 'de {peer}',
    install_title: 'Instala Pasalo en el iPhone',
    install_body: 'Pulsa Compartir y luego «Añadir a pantalla de inicio». Así se abre como una app y no se pierden tus chats.',
    install_ok: 'Entendido',
    keep_open: 'Mantén Pasalo abierto: si bloqueas el teléfono o cambias de app, la conexión se pausa.',
  },
  en: {
    received: 'Received',
    save: 'Save',
    save_all: 'Save all',
    discard: 'Discard',
    saved: 'Saved',
    from: 'from {peer}',
    install_title: 'Install Pasalo on your iPhone',
    install_body: 'Tap Share and then “Add to Home Screen”. It opens like an app and your chats are kept.',
    install_ok: 'Got it',
    keep_open: 'Keep Pasalo open: locking the phone or switching apps pauses the connection.',
  },
  ru: {
    received: 'Получено',
    save: 'Сохранить',
    save_all: 'Сохранить всё',
    discard: 'Удалить',
    saved: 'Сохранено',
    from: 'от {peer}',
    install_title: 'Установите Pasalo на iPhone',
    install_body: 'Нажмите «Поделиться», затем «На экран „Домой“». Так Pasalo откроется как приложение и чаты сохранятся.',
    install_ok: 'Понятно',
    keep_open: 'Не закрывайте Pasalo: при блокировке телефона или переходе в другое приложение соединение приостанавливается.',
  },
};

function tx(key, params = {}) {
  const text = (TEXT[currentLang()] || TEXT.en)[key] ?? TEXT.en[key];
  return text.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? '');
}

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
let backend = null;

async function offer(files) {
  for (const meta of files) {
    if (ready.has(meta.id)) continue;
    const file = await backend.receivedAsFile(meta.id).catch(() => null);
    if (file) ready.set(meta.id, { meta, file });
  }
  render();
}

function render() {
  if (!sheet) {
    sheet = el('section', { class: 'web-received', 'aria-live': 'polite' });
    document.body.append(sheet);
  }
  sheet.hidden = ready.size === 0;
  if (!ready.size) return;
  const rows = [...ready.values()].map(({ meta }) =>
    el(
      'div',
      { class: 'web-received-row' },
      el('div', { class: 'web-received-info' },
        el('div', { class: 'web-received-name' }, meta.path || meta.name),
        el('div', { class: 'sub' }, `${bytes(meta.size)} · ${tx('from', { peer: meta.peer || '' })}`)),
      el('button', { class: 'icon-btn subtle', type: 'button', title: tx('discard'), 'aria-label': tx('discard'), onclick: () => discard(meta.id) }, '×'),
      el('button', { class: 'primary small', type: 'button', onclick: () => save([meta.id]) }, tx('save')),
    ),
  );
  const head = el('div', { class: 'web-received-head' }, el('strong', {}, `${tx('received')} (${ready.size})`));
  if (ready.size > 1) head.append(el('button', { class: 'ghost small', type: 'button', onclick: () => save([...ready.keys()]) }, tx('save_all')));
  sheet.replaceChildren(head, el('div', { class: 'web-received-list' }, ...rows));
}

async function discard(id) {
  ready.delete(id);
  render();
  await backend.forgetFile(id).catch(() => {});
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
  toast(tx('saved'));
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
    el('strong', {}, tx('install_title')),
    el('p', {}, tx('install_body')),
    el('button', { class: 'primary small', type: 'button', onclick: close }, tx('install_ok')),
  );
  document.body.append(box);
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

// ---------- arranque ----------

export function initWebUi(api) {
  backend = api;
  document.documentElement.classList.add('web');
  backend.onReceived(offer);
  backend.onSave((id) => save([id]));
  backend.pendingFiles().then(offer, () => {});
  dragAndDrop(backend.emitRaw, backend.rememberFiles);

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
  }

  const loaded = () => {
    installHint();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  };
  if (document.readyState === 'complete') loaded();
  else window.addEventListener('load', loaded, { once: true });

  // En el móvil, la primera vez que se sale a internet: la página tiene que seguir abierta.
  let warned = false;
  backend.listen('net_step', ({ payload }) => {
    if (payload !== 'relay' || warned || !isIos()) return;
    warned = true;
    toast(tx('keep_open'));
  });
}
