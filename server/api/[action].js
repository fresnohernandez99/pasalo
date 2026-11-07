// Única función del server: POST /api/<acción> con un JSON. Ver lib/lobby.js
// y, para las estadísticas de llamadas, lib/stats.js.
// GET /api/health comprueba que llega a la base de datos; GET /api/stats da
// el resumen de las estadísticas.

import { createHash } from 'node:crypto';
import { database } from '../lib/db.js';
import { HttpError, handle } from '../lib/lobby.js';
import { saveStats, statsSummary } from '../lib/stats.js';

export default async function handler(req, res) {
  const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
  // Pasalo web desde otro dominio (p. ej. una copia propia que usa este
  // server): no hay cookies, cada petición lleva su token.
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-max-age', '86400');
    res.statusCode = 204;
    return res.end();
  }
  try {
    const db = await database();
    if (req.method === 'GET' && action === 'health') {
      await db.command({ ping: 1 });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && action === 'stats') return send(res, 200, await statsSummary(db));
    if (req.method !== 'POST') throw new HttpError(405, 'usa POST');
    const limit = action === 'stats' ? 256 * 1024 : 16_384;
    const body = req.body && typeof req.body === 'object' ? req.body : await readJson(req, limit);
    if (action === 'stats') return send(res, 200, await saveStats(db, body));
    // La IP solo como hash, para el tope de entradas (nunca la que diga el cuerpo).
    body.ipHash = ipHash(req);
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

async function readJson(req, limit) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new HttpError(413, 'demasiado grande');
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new HttpError(400, 'JSON no válido');
  }
}

function ipHash(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req.socket?.remoteAddress || '';
  return ip ? createHash('sha256').update(`pasalo-ip:${ip}`).digest('hex').slice(0, 16) : '';
}
