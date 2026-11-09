// Notificaciones del sistema de los mensajes y las llamadas que llegan con la
// app en segundo plano (o sin mirarla). Cada plataforma las pone a su manera
// (`notify_*`: Android, escritorio o el service worker de la web); al tocar
// una, o sus botones de contestar y rechazar, se llama a `pasaloNotification`.

import { t } from '../i18n/index.js';
import { invoke, listen } from '../lib/tauri.js';

/** Si se está mirando la app: entonces basta con lo que sale en pantalla. */
const watching = () => !document.hidden && document.hasFocus();

/** Lo que llama cada acción: `open(peer)`, `answer(call)` y `decline(call)`. */
const handlers = {};

export function onNotification(action, fn) {
  handlers[action] = fn;
}

window.pasaloNotification = ({ action, peer, call } = {}) => {
  handlers[action]?.(action === 'open' ? peer : call);
};
// En escritorio llega como evento (ver notify.rs).
listen('pasalo_notification', ({ payload }) => window.pasaloNotification(payload));

/** Resumen de un mensaje del chat para la notificación. */
function preview(message) {
  if (message.once) return t('notify.once');
  if (message.image) return t('notify.photo');
  if (message.audio) return t('notify.voice');
  return message.text || '';
}

export function notifyMessage(message, name) {
  if (watching()) return;
  invoke('notify_message', { peer: message.peer, name, text: preview(message) }).catch(() => {});
}

/** Llamada entrante: suena y se contesta desde la notificación. */
export function notifyCall({ id, peer, media }) {
  if (watching()) return;
  invoke('notify_call', {
    call: id,
    peer: peer.code,
    name: peer.name,
    video: media === 'video',
    title: t(media === 'video' ? 'call.incoming_video' : 'call.incoming_voice'),
    answer: t(media === 'video' ? 'notify.answer_video' : 'notify.answer'),
    decline: t('notify.decline'),
  }).catch(() => {});
}

/** Un aviso suelto de `peer` (una invitación a jugar, p. ej.). */
export function notifyText(peer, text) {
  if (watching()) return;
  invoke('notify_message', { peer: peer.code, name: peer.name, text }).catch(() => {});
}

/** Siempre, como en el teléfono: la llamada pudo sonar con la pantalla bloqueada y nadie verla. */
export function notifyMissed({ peer, media }) {
  invoke('notify_message', { peer: peer.code, name: peer.name, text: t(media === 'video' ? 'notify.missed_video' : 'notify.missed_voice') }).catch(() => {});
}

/** Quita la de la llamada `call` o las del chat con `peer` (al abrirlo). */
export function clearNotification({ call = null, peer = null }) {
  invoke('notify_clear', { call, peer }).catch(() => {});
}
