// En Android la app se mantiene viva (un servicio con su notificación y
// «Cerrar») mientras está en línea o en una llamada: si no, el sistema mata
// el proceso en segundo plano y se pierde la conexión.

import { invoke } from '../lib/tauri.js';
import { app } from '../state.js';

const MEDIA = { voice: 1, video: 2 };
const want = { online: false, media: 0 };
let applied = 'off';

function apply() {
  if (!app.settings?.mobile) return;
  const on = want.online || want.media > 0;
  const key = on ? String(want.media) : 'off';
  if (key === applied) return;
  applied = key;
  invoke('keep_alive', { on, media: want.media }).catch(() => {});
}

/** En línea (server, pareja o enlace) o no. */
export function keepOnline(online) {
  want.online = online;
  apply();
}

/** Llamada en marcha (`voice`, `video`) o ninguna (`null`). */
export function keepCall(media) {
  want.media = MEDIA[media] || 0;
  apply();
}
