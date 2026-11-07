// Visor de las fotos de una sola vez. Abrirla la borra (`chat_once_open`):
// solo existe en memoria mientras se ve y desaparece al cerrar.
//
// Contra las capturas: en Android (FLAG_SECURE), macOS y Windows la ventana
// se protege mientras está abierta (`secure_view`) y sale en negro en
// capturas y grabaciones. En el navegador eso no existe: ahí la foto solo se
// ve mientras se mantiene pulsada, se tapa en cuanto la página pierde el
// foco, y lleva encima el nombre de quien la ve.

import { errorText, t } from '../i18n/index.js';
import { $ } from '../lib/dom.js';
import { invoke } from '../lib/tauri.js';
import { toast } from '../lib/toast.js';
import { app } from '../state.js';
import { onBack } from './nav.js';

let open = false;
const web = () => !!app.settings?.web;

export async function openOnce(peer, id) {
  if (open) return;
  open = true;
  // La protección va antes de que la foto exista en pantalla.
  await invoke('secure_view', { on: true }).catch(() => {});
  let url;
  try {
    url = await invoke('chat_once_open', { peer, id });
  } catch (err) {
    open = false;
    invoke('secure_view', { on: false }).catch(() => {});
    toast(errorText(err), true);
    return;
  }
  const viewer = $('#once-viewer');
  const img = $('#once-img');
  view = { scale: 1, x: 0, y: 0 };
  img.onload = () => {
    layout();
    apply();
  };
  img.src = url;
  $('#once-mark').textContent = `${app.settings?.name || ''} · ${new Date().toLocaleString()}  `.repeat(40);
  $('#once-hint').textContent = t(web() ? 'once.hold' : 'once.hint');
  viewer.classList.toggle('hold', web());
  viewer.classList.remove('showing');
  viewer.hidden = false;
}

export function closeOnce() {
  if (!open) return false;
  open = false;
  const img = $('#once-img');
  img.onload = null;
  img.removeAttribute('src');
  pointers.clear();
  gesture = null;
  $('#once-viewer').hidden = true;
  invoke('secure_view', { on: false }).catch(() => {});
  return true;
}

const viewer = $('#once-viewer');
// Ni menú (guardar imagen), ni arrastrarla, ni seleccionarla.
for (const type of ['contextmenu', 'dragstart', 'selectstart', 'copy']) {
  viewer.addEventListener(type, (ev) => ev.preventDefault());
}
$('#once-close').addEventListener('click', closeOnce);

// ---------- encajar, ampliar y mover ----------
// Igual que el visor de fotos (viewer.js): la foto se encaja en la ventana y
// se amplía con la rueda, pellizcando o con doble toque; ampliada, se mueve
// arrastrando.

const MAX_SCALE = 5;
const DOUBLE_TAP_MS = 300;
const img = $('#once-img');
let fit = { width: 0, height: 0, left: 0, top: 0 };
let view = { scale: 1, x: 0, y: 0 };
const pointers = new Map();
let gesture = null;
let lastTap = 0;

function layout() {
  const w = img.naturalWidth || 1;
  const h = img.naturalHeight || 1;
  const s = Math.min(innerWidth / w, innerHeight / h);
  fit = { width: w * s, height: h * s, left: (innerWidth - w * s) / 2, top: (innerHeight - h * s) / 2 };
  Object.assign(img.style, { width: `${fit.width}px`, height: `${fit.height}px`, left: `${fit.left}px`, top: `${fit.top}px` });
}

function apply() {
  img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  viewer.classList.toggle('zoomed', view.scale > 1.01);
}

/** Escala alrededor de un punto de la pantalla, que se queda donde está. */
function zoomAt(scale, px, py, from = view) {
  scale = Math.min(MAX_SCALE, Math.max(1, scale));
  const ux = (px - fit.left - from.x) / from.scale;
  const uy = (py - fit.top - from.y) / from.scale;
  view = { scale, x: px - fit.left - ux * scale, y: py - fit.top - uy * scale };
}

/** Sin huecos: si cabe, centrada; si no, sin bordes vacíos. */
function clamp() {
  const axis = (pos, size, start, screen) => {
    const scaled = size * view.scale;
    if (scaled <= screen) return (screen - scaled) / 2 - start;
    return Math.min(-start, Math.max(screen - start - scaled, pos));
  };
  view.x = axis(view.x, fit.width, fit.left, innerWidth);
  view.y = axis(view.y, fit.height, fit.top, innerHeight);
}

const center = () => {
  const [a, b] = [...pointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
};

viewer.addEventListener('pointerdown', (ev) => {
  if (ev.target.closest('#once-close')) return;
  // En el navegador: se ve solo mientras se mantiene pulsada.
  if (web()) viewer.classList.add('showing');
  try {
    viewer.setPointerCapture(ev.pointerId);
  } catch {}
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pointers.size === 2) gesture = { kind: 'pinch', start: { ...view }, ...center() };
  else if (pointers.size === 1) gesture = { kind: 'drag', start: { ...view }, x: ev.clientX, y: ev.clientY, moved: false };
});

viewer.addEventListener('pointermove', (ev) => {
  if (!pointers.has(ev.pointerId) || !gesture) return;
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (gesture.kind === 'pinch' && pointers.size === 2) {
    const c = center();
    zoomAt((gesture.start.scale * c.d) / gesture.d, c.x, c.y, gesture.start);
    view.x += c.x - gesture.x;
    view.y += c.y - gesture.y;
    apply();
  } else if (gesture.kind === 'drag') {
    const dx = ev.clientX - gesture.x;
    const dy = ev.clientY - gesture.y;
    if (Math.hypot(dx, dy) > 6) gesture.moved = true;
    if (gesture.start.scale > 1.01) {
      view = { ...gesture.start, x: gesture.start.x + dx, y: gesture.start.y + dy };
      clamp();
      apply();
    }
  }
});

function endPointer(ev) {
  if (web() && pointers.size <= 1) viewer.classList.remove('showing');
  if (!pointers.delete(ev.pointerId) || !gesture) return;
  if (gesture.kind === 'pinch') {
    if (pointers.size === 1) {
      const [p] = pointers.values();
      gesture = { kind: 'drag', start: { ...view }, x: p.x, y: p.y, moved: true };
      return;
    }
    clamp();
    apply();
    gesture = null;
    return;
  }
  const { moved } = gesture;
  gesture = null;
  if (moved) return;
  // Doble toque (o doble clic): amplía donde se tocó, o vuelve a encajarla.
  const now = Date.now();
  if (now - lastTap < DOUBLE_TAP_MS) {
    lastTap = 0;
    if (view.scale > 1.01) view = { scale: 1, x: 0, y: 0 };
    else zoomAt(2.5, ev.clientX, ev.clientY);
    clamp();
    apply();
    return;
  }
  lastTap = now;
}

viewer.addEventListener('pointerup', endPointer);
viewer.addEventListener('pointercancel', endPointer);
viewer.addEventListener('pointerleave', () => web() && !pointers.size && viewer.classList.remove('showing'));
viewer.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    zoomAt(view.scale * Math.exp(-ev.deltaY * 0.002), ev.clientX, ev.clientY);
    clamp();
    apply();
  },
  { passive: false },
);
addEventListener('resize', () => {
  if (!open) return;
  layout();
  clamp();
  apply();
});
// Si la página deja de verse (cambio de app, capturas del sistema que la
// sacan del foco), la foto se cierra: ya no se puede volver a ver.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) closeOnce();
});
window.addEventListener('blur', () => {
  if (web()) viewer.classList.remove('showing');
});

onBack(closeOnce);
