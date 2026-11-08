// Server local para probar sin Vercel: `npm run dev` (puerto 3000, o PORT).
// Usa la misma función que en Vercel y sirve `public/` (la página de los
// enlaces y Pasalo web en /app/). Sin MONGODB_URI arranca un MongoDB en
// memoria (mongodb-memory-server, solo en desarrollo) que se borra al salir.

import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

if (!process.env.MONGODB_URI) {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  console.log('MongoDB en memoria');
}
const { default: handler } = await import('./api/[action].js');
const { default: handlerV1 } = await import('./api/v1/[action].js');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.tflite': 'application/octet-stream',
};
const PUBLIC = join(import.meta.dirname, 'public');
// Las mismas cabeceras que pone Vercel (vercel.json), para probar con ellas.
const HEADERS = JSON.parse(readFileSync(join(import.meta.dirname, 'vercel.json'), 'utf8')).headers || [];

function vercelHeaders(pathname, res) {
  for (const rule of HEADERS) {
    const pattern = new RegExp(`^${rule.source.replace(/\(\.\*\)/g, '.*')}$`);
    if (pattern.test(pathname)) for (const { key, value } of rule.headers) res.setHeader(key, value);
  }
}

function serveStatic(pathname, res) {
  let path = normalize(join(PUBLIC, decodeURIComponent(pathname)));
  if (!path.startsWith(PUBLIC)) return false;
  try {
    if (statSync(path).isDirectory()) path = join(path, 'index.html');
    statSync(path);
  } catch {
    return false;
  }
  vercelHeaders(pathname, res);
  res.setHeader('content-type', TYPES[extname(path)] || 'application/octet-stream');
  createReadStream(path).pipe(res);
  return true;
}

const port = Number(process.env.PORT || 3000);
createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname.startsWith('/api/v1/')) return handlerV1(req, res);
  if (pathname.startsWith('/api/')) return handler(req, res);
  if (req.method === 'GET' && serveStatic(pathname, res)) return;
  res.statusCode = 404;
  res.end();
}).listen(port, '0.0.0.0', () => console.log(`http://localhost:${port}/api/health`));
