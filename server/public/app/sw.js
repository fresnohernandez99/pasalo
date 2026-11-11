// Service worker de Pasalo web: guarda la app (no los datos, que van en
// IndexedDB) para que abra rápido y sin conexión, como una app instalada.
// El build pone aquí la versión y la lista de archivos.

const VERSION = "960268020597";
const FILES = ["./", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "index.html", "js/features/befriend.js", "js/features/blur.js", "js/features/call.js", "js/features/chat.js", "js/features/chats.js", "js/features/friends.js", "js/features/game.js", "js/features/games/connect4.js", "js/features/games/index.js", "js/features/games/rps.js", "js/features/games/tictactoe.js", "js/features/keepalive.js", "js/features/lobby.js", "js/features/nav.js", "js/features/notify.js", "js/features/once.js", "js/features/peers.js", "js/features/permissions.js", "js/features/photo-preview.js", "js/features/recorder.js", "js/features/settings.js", "js/features/share.js", "js/features/transfers.js", "js/features/upscale.js", "js/features/video.js", "js/features/viewer.js", "js/i18n/en.js", "js/i18n/es.js", "js/i18n/index.js", "js/i18n/ru.js", "js/legacy.js", "js/lib/bus.js", "js/lib/dom.js", "js/lib/format.js", "js/lib/icons.js", "js/lib/images.js", "js/lib/tauri.js", "js/lib/toast.js", "js/main.js", "js/state.js", "js/theme.js", "js/web/backend/files.js", "js/web/backend/index.js", "js/web/backend/lobby.js", "js/web/backend/notify.js", "js/web/backend/store.js", "js/web/backend/talk.js", "js/web/backend/util.js", "js/web/backend/voice-worklet.js", "js/web/backend/voice.js", "js/web/pkg/pasalo_web.js", "js/web/pkg/pasalo_web_bg.wasm", "js/web/version.js", "js/web/web-ui.js", "manifest.webmanifest", "styles/base.css", "styles/call.css", "styles/chat.css", "styles/home.css", "styles/screens.css", "styles/tokens.css", "styles/viewer.css", "styles/web.css"];
const CACHE = `pasalo-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pasalo-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  // Solo la app: el server de conexión (/api) y lo demás van directos.
  if (event.request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      // La página se pide sin la consulta (?c=… de los enlaces).
      const key = url.pathname === scope.pathname ? 'index.html' : event.request;
      const hit = await cache.match(key, { ignoreSearch: true });
      return hit || fetch(event.request);
    }),
  );
});

// Al tocar una notificación (o sus botones), la página hace lo suyo: abrir el
// chat, contestar o rechazar. Salvo al rechazar, la app pasa al frente.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const message = { type: 'pasalo-notification', action: event.action || data.action, peer: data.peer, call: data.call };
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const client = clients[0];
      if (message.action !== 'decline') {
        if (client) await client.focus().catch(() => {});
        else await self.clients.openWindow(self.registration.scope);
      }
      client?.postMessage(message);
    }),
  );
});
