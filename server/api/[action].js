// Única función del server: POST /api/<acción> con un JSON. Ver lib/lobby.js.
// GET /api/health comprueba que llega a la base de datos.

import { database } from '../lib/db.js';
import { HttpError, handle } from '../lib/lobby.js';

export default async function handler(req, res) {
  const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
  try {
    const db = await database();
    if (req.method === 'GET' && action === 'health') {
      await db.command({ ping: 1 });
      return send(res, 200, { ok: true });
    }
    if (req.method !== 'POST') throw new HttpError(405, 'usa POST');
    const body = req.body && typeof req.body === 'object' ? req.body : await readJson(req);
    return send(res, 200, await handle(db, action, body));
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    return send(res, err.status || 500, { error: err instanceof HttpError ? err.message : 'error interno' });
  }
}

function send(res, status, json) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(json));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new HttpError(413, 'demasiado grande');
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new HttpError(400, 'JSON no válido');
  }
}
