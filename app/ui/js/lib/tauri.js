// Puente con Rust. `call` es `invoke` que además avisa del error en pantalla.

import { errorText } from '../i18n/index.js';
import { toast } from './toast.js';

const tauri = window.__TAURI__;

export const invoke = tauri.core.invoke;
export const listen = tauri.event.listen;
export const Channel = tauri.core.Channel;

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
