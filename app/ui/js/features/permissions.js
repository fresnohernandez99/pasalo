// Permisos. Android 17+ pide permiso para la red local: sin él no se ve
// ningún equipo. Si falta, un aviso en la lista de equipos lo explica y lo
// pide (o abre los ajustes de la app si ya se negó para siempre). Al volver a
// la app se mira otra vez.
//
// Además, en Ajustes están todos, con para qué es cada uno: el estado, y un
// botón para pedirlo o, si ya se negó, para abrir los ajustes del sistema.

import { t } from '../i18n/index.js';
import { on } from '../lib/bus.js';
import { $, esc, setHtml } from '../lib/dom.js';
import { invoke } from '../lib/tauri.js';
import { app, isMobile } from '../state.js';

async function check(ask = false) {
  const granted = await invoke('local_network', { ask }).catch(() => null);
  // `null`: este sistema no lo necesita.
  $('#perm-banner').hidden = granted !== false;
  checkStorage();
}

// Up to Android 10, received files only reach the public Downloads folder
// with the storage permission: it is asked once at start, and the backend
// switches to that folder as soon as it can (`storage_public`).
let storageAsked = false;
async function checkStorage() {
  const ok = await invoke('storage_public').catch(() => null);
  if (ok !== false || storageAsked) return;
  storageAsked = true;
  const state = (await invoke('permissions').catch(() => [])).find((p) => p.id === 'storage')?.state;
  if (state !== 'ask') return;
  await invoke('permission_request', { id: 'storage' }).catch(() => {});
  // The system dialog doesn't always hide the page: look again for a while.
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (await invoke('storage_public').catch(() => null)) return;
  }
}

export function initPermissions() {
  check();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}

$('#perm-allow').addEventListener('click', () => check(true));

// ---------- la sección de Ajustes ----------

const native = () => isMobile() && !app.settings?.web;

/** Micrófono y cámara fuera de Android: los pide la propia página. */
async function mediaState(id) {
  try {
    const status = await navigator.permissions.query({ name: id });
    return { granted: 'granted', denied: 'denied' }[status.state] || 'ask';
  } catch {
    return 'ask';
  }
}

async function permissionList() {
  const list = await invoke('permissions').catch(() => []);
  if (!native()) {
    for (const id of ['microphone', 'camera']) list.push({ id, state: await mediaState(id) });
  }
  return list;
}

export async function renderPermissions() {
  const list = await permissionList();
  const web = !!app.settings?.web;
  setHtml(
    $('#perm-list'),
    list
      .map(({ id, state }) => {
        // En el navegador, lo bloqueado solo se cambia en los ajustes del sitio.
        const button =
          state === 'granted' || (web && state === 'denied')
            ? ''
            : `<button class="${state === 'ask' ? 'primary' : 'ghost'} small" type="button" data-perm="${esc(id)}">${esc(t(state === 'ask' ? 'perm.allow' : 'perm.settings'))}</button>`;
        return `
          <div class="perm-row">
            <div class="perm-text">
              <strong>${esc(t(`perm.${id}`))}</strong>
              <small class="sub">${esc(t(`perm.${id}_why`))}</small>
              <span class="perm-state ${state}">${esc(t(`perm.state_${state}`))}</span>
            </div>
            ${button}
          </div>`;
      })
      .join(''),
  );
  $('#perm-hint').textContent = t(web ? 'perm.hint_web' : 'perm.hint');
}

async function request(id, state) {
  if (!native() && (id === 'microphone' || id === 'camera') && state === 'ask') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(id === 'microphone' ? { audio: true } : { video: true });
      for (const track of stream.getTracks()) track.stop();
    } catch {}
  } else if (app.settings?.web && id === 'notifications') {
    await Notification.requestPermission().catch(() => {});
  } else {
    await invoke('permission_request', { id }).catch(() => {});
  }
  renderPermissions();
}

$('#perm-list').addEventListener('click', async (ev) => {
  const id = ev.target.closest('[data-perm]')?.dataset.perm;
  if (!id) return;
  const state = (await permissionList()).find((p) => p.id === id)?.state;
  request(id, state);
});

// Al volver de los ajustes del sistema (o del diálogo de Android), al día.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#settings').hidden) renderPermissions();
});
window.addEventListener('focus', () => {
  if (!$('#settings').hidden) renderPermissions();
});
on('lang', () => {
  if (!$('#settings').hidden) renderPermissions();
});
