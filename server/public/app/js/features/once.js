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
  img.removeAttribute('src');
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

// En el navegador: se ve solo mientras se mantiene pulsada.
viewer.addEventListener('pointerdown', (ev) => {
  if (!web() || ev.target.closest('#once-close')) return;
  viewer.classList.add('showing');
});
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  viewer.addEventListener(type, () => viewer.classList.remove('showing'));
}
// Si la página deja de verse (cambio de app, capturas del sistema que la
// sacan del foco), la foto se cierra: ya no se puede volver a ver.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) closeOnce();
});
window.addEventListener('blur', () => {
  if (web()) viewer.classList.remove('showing');
});

onBack(closeOnce);
