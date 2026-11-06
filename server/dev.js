// Server local para probar sin Vercel: `npm run dev` (puerto 3000, o PORT).
// Usa la misma función que en Vercel. Sin MONGODB_URI arranca un MongoDB en
// memoria (mongodb-memory-server, solo en desarrollo) que se borra al salir.

import { createServer } from 'node:http';

if (!process.env.MONGODB_URI) {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  console.log('MongoDB en memoria');
}
const { default: handler } = await import('./api/[action].js');

const port = Number(process.env.PORT || 3000);
createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (!pathname.startsWith('/api/')) {
    res.statusCode = 404;
    return res.end();
  }
  handler(req, res);
}).listen(port, '0.0.0.0', () => console.log(`http://localhost:${port}/api/health`));
