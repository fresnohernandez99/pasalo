// Puente con el backend, versión navegador: sustituye a `lib/tauri.js` de la
// app (el build de la web lo pone en su sitio). Mismo `invoke`, `listen` y
// `Channel` que Tauri, pero contra el backend en JavaScript y WASM de
// `web/backend/`. La interfaz no nota la diferencia.

import { errorText } from '../i18n/index.js';
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
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div style="padding:24px;font:16px system-ui">Pasalo no pudo arrancar en este navegador: ${String(err?.message || err)}</div>`,
  );
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
