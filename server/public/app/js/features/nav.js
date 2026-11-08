// Qué se ve: la pestaña de la pantalla principal y las pantallas que se abren
// encima (chat, ajustes). También el botón Atrás de Android.

import { $, $$ } from '../lib/dom.js';
import { isWide } from '../state.js';

/** Cosas que se cierran con Atrás, de la más alta a la más baja. Cada una devuelve si cerró algo. */
const closers = [];

/** `fn()` cierra lo suyo si está abierto y devuelve si lo hizo. Las registradas después van antes. */
export function onBack(fn) {
  closers.unshift(fn);
}

// Botón Atrás de Android (lo llama PasaloPlugin.kt): cierra lo de más arriba
// y dice si había algo. Si no, la app pasa al fondo sin perder nada.
window.pasaloBack = () => {
  const dialog = $('dialog[open]');
  if (dialog) {
    dialog.close();
    return true;
  }
  for (const fn of closers) if (fn()) return true;
  if (document.body.dataset.tab !== 'peers') {
    showTab('peers');
    return true;
  }
  return false;
};

let unseen = 0;

/**
 * Lo que queda debajo de una pantalla encima (Ajustes, la llamada) no se
 * puede tocar ni recorrer con el tabulador ni con un lector de pantalla.
 * `focus` es lo que recibe el foco al abrirse una.
 */
export function updateLayers(focus) {
  const call = !$('#call').hidden;
  const settings = !$('#settings').hidden || !$('#discover').hidden;
  const photo = !$('#photo-preview').hidden || !$('#once-viewer').hidden;
  $('.app').inert = call || settings || photo;
  $('#settings').inert = call;
  if (focus && !focus.hidden) focus.focus({ preventScroll: true });
}

export function showTab(tab) {
  document.body.dataset.tab = tab;
  for (const el of $$('.tab')) el.classList.toggle('on', el.dataset.tab === tab);
  for (const page of $$('.tab-page')) page.hidden = page.dataset.page !== tab;
  if (tab === 'transfers') {
    unseen = 0;
    $('#transfers-badge').hidden = true;
  }
}

/** Algo nuevo en las transferencias: si no se están viendo, se cuenta en su pestaña. */
export function noteTransfer() {
  if (document.body.dataset.tab === 'transfers') return;
  unseen++;
  $('#transfers-badge').textContent = unseen;
  $('#transfers-badge').hidden = false;
}

/** El panel de la derecha (en el móvil, una pantalla encima) con el chat abierto o no. */
export function setPaneOpen(open) {
  document.body.classList.toggle('pane-open', open);
}

$('.tabbar').addEventListener('click', (ev) => {
  const tab = ev.target.closest('.tab');
  if (tab) showTab(tab.dataset.tab);
});

export { isWide };
