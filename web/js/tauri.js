// Puente con el backend, versión navegador: sustituye a `lib/tauri.js` de la
// app (el build de la web lo pone en su sitio). Mismo `invoke`, `listen` y
// `Channel` que Tauri, pero contra el backend en JavaScript y WASM de
// `web/backend/`. La interfaz no nota la diferencia.

import { errorText, t } from '../i18n/index.js';
import { toast } from './toast.js';
import * as backend from '../web/backend/index.js';
import { initWebUi } from '../web/web-ui.js';

/** Canal de Tauri: el backend llama a `onmessage` con cada mensaje. */
export class Channel {
  constructor() {
    this.onmessage = null;
  }
}

export const invoke = backend.invoke;

export function listen(name, fn) {
  return Promise.resolve(backend.listen(name, fn));
}

try {
  await backend.start();
} catch (err) {
  console.error(err);
  // Sin HTML con el error dentro: solo texto.
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;z-index:100;display:grid;place-content:center;gap:12px;padding:24px;text-align:center;background:var(--bg);font:16px system-ui';
  const msg = document.createElement('p');
  msg.textContent = t('web.start_failed');
  const detail = document.createElement('small');
  detail.textContent = String(err?.message || err);
  const reload = document.createElement('button');
  reload.className = 'primary';
  reload.textContent = t('web.reload');
  reload.onclick = () => location.reload();
  box.append(msg, detail, reload);
  document.body.append(box);
  throw err;
}
initWebUi(backend);

export async function call(command, args) {
  try {
    return await invoke(command, args);
  } catch (err) {
    toast(errorText(err), true);
    throw err;
  }
}

/** Como `call`, pero devuelve `null` en vez de lanzar. */
export async function tryCall(command, args) {
  try {
    return await call(command, args);
  } catch {
    return null;
  }
}
