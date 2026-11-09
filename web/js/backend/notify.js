// Notificaciones en el navegador: las pone el service worker (en el iPhone,
// solo con Pasalo instalada en la pantalla de inicio) y al tocarlas, o sus
// botones de contestar y rechazar, avisa a la página (ver `sw.js`).

import { t } from '../../i18n/index.js';

const ICON = 'icons/icon-192.png';

const supported = () => 'Notification' in window && 'serviceWorker' in navigator;

/** El navegador solo deja pedir el permiso al tocar algo: se pide la primera vez. */
export function askPermission() {
  if (supported() && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

async function show(tag, title, options) {
  if (!supported() || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification(title, { tag, icon: ICON, badge: ICON, renotify: true, ...options });
}

async function close(tag) {
  if (!supported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  for (const n of (await reg?.getNotifications({ tag })) || []) n.close();
}

export const notifyCommands = {
  notify_message: ({ peer, name, text }) => show(`chat-${peer}`, name, { body: text, data: { action: 'open', peer } }),
  notify_call: ({ call, name, video, title }) =>
    show(`call-${call}`, name, {
      body: title,
      data: { action: 'focus', call },
      requireInteraction: true,
      vibrate: [800, 600, 800, 600, 800],
      actions: [
        { action: 'decline', title: t('notify.decline') },
        { action: 'answer', title: t(video ? 'notify.answer_video' : 'notify.answer') },
      ],
    }),
  notify_clear: async ({ call, peer }) => {
    if (call) await close(`call-${call}`);
    if (peer) await close(`chat-${peer}`);
  },
  notify_take: () => ({}),
  // La sección de permisos de Ajustes: aquí, solo las notificaciones (el
  // micrófono y la cámara los mira la página).
  permissions: () =>
    supported() ? [{ id: 'notifications', state: { granted: 'granted', denied: 'denied' }[Notification.permission] || 'ask' }] : [],
  permission_request: () => {},
};
