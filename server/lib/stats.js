// Estadísticas de llamadas que los equipos suben a mano (Ajustes → Subir).
// Sirven para ver cuánto gasta y cuánto dura una llamada de verdad según el
// modo y la red. No se guarda con quién fue la llamada ni nombres: solo el
// equipo como un hash y los números de la llamada.
//
// Colección:
//   calls  { _id (id de la llamada + equipo), device, platform, version, media, role,
//            outcome, started, duration_ms, audio, video, sent, received, video_sent,
//            video_received, lost, recovered, blur, enhance, at }
// `blur`: se envió con el fondo desenfocado; `enhance`: la imagen que llegaba
// se mejoró en la GPU. Así se puede comparar consumo y calidad con y sin.

import { createHash } from 'node:crypto';
import { HttpError } from './lobby.js';

/** Lo que se sube como mucho de una vez. */
export const MAX_RECORDS = 100;
/** Se borran solas al año. */
const KEEP_SECONDS = 365 * 24 * 3600;

const MEDIA = ['voice', 'video'];
const ROLES = ['caller', 'callee'];
const OUTCOMES = ['completed', 'missed', 'declined', 'no_answer', 'busy', 'cancelled', 'failed', 'lost'];
const AUDIO = ['high', 'normal', 'low', 'minimum'];
const VIDEO = ['minimum', 'low', 'normal', 'high'];

export async function setupStats(db) {
  await db.collection('calls').createIndex({ at: 1 }, { expireAfterSeconds: KEEP_SECONDS });
}

function oneOf(value, list, field) {
  if (!list.includes(value)) throw new HttpError(400, `${field} no válido`);
  return value;
}

/** Un número entero entre 0 y `max` (los contadores no pueden ser negativos ni absurdos). */
function count(value, max, field) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `${field} no válido`);
  return Math.round(n);
}

/** Sí, no o sin dato (las versiones viejas no lo mandan). */
function flag(value, field) {
  if (value == null) return null;
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} no válido`);
  return value;
}

function clean(raw, device, platform, version) {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'registro no válido');
  const id = typeof raw.id === 'string' && /^[\w-]{1,80}$/.test(raw.id) ? raw.id : null;
  if (!id) throw new HttpError(400, 'id de llamada no válido');
  const started = count(raw.started, 8_000_000_000_000, 'started');
  const day = 24 * 3600 * 1000;
  return {
    _id: `${device}:${id}`,
    device,
    platform,
    version,
    media: oneOf(raw.media, MEDIA, 'media'),
    role: oneOf(raw.role, ROLES, 'role'),
    outcome: oneOf(raw.outcome, OUTCOMES, 'outcome'),
    started: new Date(started),
    duration_ms: count(raw.duration_ms, day, 'duration_ms'),
    audio: raw.audio == null ? null : oneOf(raw.audio, AUDIO, 'audio'),
    video: raw.video == null ? null : oneOf(raw.video, VIDEO, 'video'),
    sent: count(raw.sent, 1e12, 'sent'),
    received: count(raw.received, 1e12, 'received'),
    video_sent: count(raw.video_sent, 1e12, 'video_sent'),
    video_received: count(raw.video_received, 1e12, 'video_received'),
    lost: count(raw.lost, 1e9, 'lost'),
    recovered: count(raw.recovered, 1e9, 'recovered'),
    blur: flag(raw.blur, 'blur'),
    enhance: flag(raw.enhance, 'enhance'),
  };
}

/**
 * Guarda las llamadas de `body.calls`. Repetir una subida no duplica nada:
 * el id es el de la llamada y el equipo.
 */
export async function saveStats(db, body, now = () => new Date()) {
  const id = typeof body.device === 'string' && body.device.length <= 64 ? body.device : null;
  if (!id) throw new HttpError(400, 'device no válido');
  const platform = typeof body.platform === 'string' && /^[a-z]{1,16}$/.test(body.platform) ? body.platform : 'unknown';
  const version = typeof body.version === 'string' && /^[\w.+-]{1,24}$/.test(body.version) ? body.version : 'unknown';
  if (!Array.isArray(body.calls) || body.calls.length > MAX_RECORDS) throw new HttpError(400, 'calls no válido');
  // El id del equipo no se guarda tal cual: solo sirve para contar equipos.
  const device = createHash('sha256').update(`pasalo-stats:${id}`).digest('hex').slice(0, 16);
  const records = body.calls.map((raw) => clean(raw, device, platform, version));
  if (!records.length) return { saved: 0 };
  const at = now();
  await db.collection('calls').bulkWrite(
    records.map((r) => ({ updateOne: { filter: { _id: r._id }, update: { $set: { ...r, at } }, upsert: true } })),
    { ordered: false },
  );
  return { saved: records.length };
}

/** Resumen público por tipo de llamada y modo: cuántas, cuánto duran y cuánto gastan. */
export async function statsSummary(db) {
  const rows = await db
    .collection('calls')
    .aggregate([
      { $match: { outcome: { $in: ['completed', 'lost'] }, duration_ms: { $gt: 0 } } },
      {
        $group: {
          _id: { media: '$media', audio: '$audio', video: '$video', blur: '$blur', enhance: '$enhance' },
          calls: { $sum: 1 },
          devices: { $addToSet: '$device' },
          minutes: { $sum: { $divide: ['$duration_ms', 60_000] } },
          bytes: { $sum: { $add: ['$sent', '$received'] } },
          videoBytes: { $sum: '$video_sent' },
          lost: { $sum: '$lost' },
        },
      },
      { $sort: { calls: -1 } },
    ])
    .toArray();
  return {
    groups: rows.map((r) => ({
      media: r._id.media,
      audio: r._id.audio,
      video: r._id.video,
      blur: r._id.blur ?? null,
      enhance: r._id.enhance ?? null,
      calls: r.calls,
      devices: r.devices.length,
      minutes: Math.round(r.minutes * 10) / 10,
      // Consumo medio de la llamada (subida y bajada juntas).
      kbps: r.minutes ? Math.round((r.bytes * 8) / 1000 / (r.minutes * 60)) : 0,
      // Lo que manda cada lado de vídeo: lo que cambia con el desenfoque.
      video_up_kbps: r.minutes ? Math.round((r.videoBytes * 8) / 1000 / (r.minutes * 60)) : 0,
      lost: r.lost,
    })),
  };
}
