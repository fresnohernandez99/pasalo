// Visor de fotos del chat. La foto crece desde su miniatura hasta ocupar la
// pantalla (y vuelve a ella al cerrar). Se amplía pellizcando, con doble toque
// o con la rueda; ampliada se mueve con el dedo, y sin ampliar se cierra
// deslizándola hacia abajo.

import { $ } from '../lib/dom.js';
import { onBack } from './nav.js';

const viewer = $('#viewer');
const img = $('#viewer-img');
const backdrop = $('.viewer-bg', viewer);

const MAX_SCALE = 5;
const DOUBLE_TAP_MS = 300;
const DISMISS_PX = 120;
const EASE = 'transform .28s cubic-bezier(.2, .8, .2, 1)';

let source = null; // la miniatura
let fit = null; // { left, top, width, height } de la foto encajada en pantalla
let view = { scale: 1, x: 0, y: 0 };
const pointers = new Map();
let gesture = null;
let lastTap = 0;

function apply(animate = false) {
  img.style.transition = animate ? EASE : 'none';
  img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

/** La transformación que pone la foto encima de la miniatura. */
function overThumb() {
  const r = source.getBoundingClientRect();
  return { scale: r.width / fit.width, x: r.left - fit.left, y: r.top - fit.top };
}

function layout() {
  const w = img.naturalWidth || 1;
  const h = img.naturalHeight || 1;
  const vw = innerWidth;
  const vh = innerHeight;
  const s = Math.min(vw / w, vh / h);
  fit = { width: w * s, height: h * s, left: (vw - w * s) / 2, top: (vh - h * s) / 2 };
  Object.assign(img.style, { width: `${fit.width}px`, height: `${fit.height}px`, left: `${fit.left}px`, top: `${fit.top}px` });
}

export function openViewer(thumb) {
  source = thumb;
  img.src = thumb.src;
  viewer.hidden = false;
  layout();
  view = overThumb();
  apply();
  backdrop.style.opacity = 0;
  thumb.style.visibility = 'hidden';
  // Al siguiente fotograma, a pantalla completa.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      view = { scale: 1, x: 0, y: 0 };
      apply(true);
      backdrop.style.transition = 'opacity .28s';
      backdrop.style.opacity = 1;
      viewer.classList.add('open');
    }),
  );
}

export function closeViewer() {
  if (viewer.hidden) return false;
  viewer.classList.remove('open');
  const visible = source?.isConnected && source.getBoundingClientRect().height > 0;
  if (visible) {
    view = overThumb();
    apply(true);
  } else {
    img.style.transition = 'opacity .2s';
    img.style.opacity = 0;
  }
  backdrop.style.opacity = 0;
  setTimeout(() => {
    viewer.hidden = true;
    img.style.opacity = '';
    if (source) source.style.visibility = '';
    source = null;
  }, 280);
  return true;
}

onBack(closeViewer);
$('#viewer-close').addEventListener('click', closeViewer);
addEventListener('resize', () => {
  if (viewer.hidden) return;
  layout();
  view = { scale: 1, x: 0, y: 0 };
  apply();
});

// ---------- zoom y movimiento ----------

/** Escala alrededor de un punto de la pantalla, que se queda donde está. */
function zoomAt(scale, px, py, from = view) {
  scale = Math.min(MAX_SCALE, Math.max(0.5, scale));
  const ux = (px - fit.left - from.x) / from.scale;
  const uy = (py - fit.top - from.y) / from.scale;
  view = { scale, x: px - fit.left - ux * scale, y: py - fit.top - uy * scale };
}

/** Que la foto ampliada no deje huecos: si cabe, centrada; si no, sin bordes vacíos. */
function clamp() {
  if (view.scale < 1) view = { scale: 1, x: 0, y: 0 };
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
  if (ev.target.closest('#viewer-close')) return;
  viewer.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pointers.size === 2) {
    gesture = { kind: 'pinch', start: { ...view }, ...center() };
  } else if (pointers.size === 1) {
    gesture = { kind: 'drag', start: { ...view }, x: ev.clientX, y: ev.clientY, moved: false, onImage: ev.target === img };
  }
});

viewer.addEventListener('pointermove', (ev) => {
  if (!pointers.has(ev.pointerId) || !gesture) return;
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (gesture.kind === 'pinch' && pointers.size === 2) {
    const c = center();
    zoomAt((gesture.start.scale * c.d) / gesture.d, c.x, c.y, gesture.start);
    // Mover los dos dedos también desplaza.
    view.x += c.x - gesture.x;
    view.y += c.y - gesture.y;
    apply();
  } else if (gesture.kind === 'drag') {
    const dx = ev.clientX - gesture.x;
    const dy = ev.clientY - gesture.y;
    if (Math.hypot(dx, dy) > 6) gesture.moved = true;
    if (gesture.start.scale > 1.01) {
      view = { ...gesture.start, x: gesture.start.x + dx, y: gesture.start.y + dy };
    } else {
      // Sin ampliar, arrastrar hacia abajo (o arriba) va cerrando.
      view = { scale: 1 - Math.min(Math.abs(dy) / 2000, 0.15), x: dx * 0.3, y: dy };
      backdrop.style.transition = 'none';
      backdrop.style.opacity = 1 - Math.min(Math.abs(dy) / 400, 0.8);
    }
    apply();
  }
});

function endPointer(ev) {
  if (!pointers.delete(ev.pointerId) || !gesture) return;
  if (gesture.kind === 'pinch') {
    // Al levantar un dedo, el otro sigue moviendo desde donde está.
    if (pointers.size === 1) {
      const [p] = pointers.values();
      gesture = { kind: 'drag', start: { ...view }, x: p.x, y: p.y, moved: true };
      return;
    }
    clamp();
    apply(true);
    gesture = null;
    return;
  }
  const { start, moved, onImage } = gesture;
  gesture = null;
  if (start.scale <= 1.01 && moved) {
    if (Math.abs(view.y) > DISMISS_PX) {
      closeViewer();
      return;
    }
    view = { scale: 1, x: 0, y: 0 };
    backdrop.style.transition = 'opacity .2s';
    backdrop.style.opacity = 1;
    apply(true);
    return;
  }
  if (moved) {
    clamp();
    apply(true);
    return;
  }
  // Un toque: doble toque amplía o vuelve; un toque fuera de la foto cierra.
  const now = Date.now();
  if (now - lastTap < DOUBLE_TAP_MS) {
    lastTap = 0;
    if (view.scale > 1.01) view = { scale: 1, x: 0, y: 0 };
    else zoomAt(2.5, ev.clientX, ev.clientY);
    clamp();
    apply(true);
    return;
  }
  lastTap = now;
  if (!onImage && view.scale <= 1.01) {
    setTimeout(() => lastTap === now && closeViewer(), DOUBLE_TAP_MS);
  }
}

viewer.addEventListener('pointerup', endPointer);
viewer.addEventListener('pointercancel', endPointer);

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
