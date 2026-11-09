// Service worker de Pasalo web: guarda la app (no los datos, que van en
// IndexedDB) para que abra rápido y sin conexión, como una app instalada.
// El build pone aquí la versión y la lista de archivos.

const VERSION = '__BUILD__';
const FILES = __FILES__;
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
