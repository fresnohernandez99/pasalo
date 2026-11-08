// Lógica del server de señalización de Pasalo. Solo presenta a los equipos:
// quién está conectado y quién quiere conectarse con quién. Cuando una
// solicitud se acepta, cada lado recibe el código de iroh del otro, los dos
// se van del server y desde ahí hablan directamente.
//
// Colecciones:
//   users     { _id, token, name, platform, code, seen, paired }
//   requests  { _id, from, to, fromName, fromPlatform, state, code, at }
// `state` de una solicitud: pending, accepted, declined, cancelled, expired.

import { createHash, randomUUID } from 'node:crypto';

/** Sin `sync` en este tiempo, un equipo deja de estar conectado. */
export const ONLINE_MS = 45_000;
/** Lo que espera un `sync` sin novedades antes de contestar. */
export const WAIT_MS = 20_000;
/** Cada cuánto se mira si hay novedades durante la espera. */
const POLL_MS = 1_500;
/** Solicitudes sin contestar que puede tener abiertas un equipo. */
const MAX_PENDING = 5;
/** Equipos por página en `users`. */
const MAX_PAGE = 50;
/** Tiempo mínimo entre dos solicitudes de un mismo equipo. */
const REQUEST_GAP_MS = 1000;
/** Equipos nuevos por IP y minuto. */
const MAX_JOINS_PER_IP = 10;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Crea los índices (es idempotente). Los TTL limpian solos lo abandonado. */
export async function setup(db) {
  await Promise.all([
    db.collection('users').createIndex({ seen: 1 }, { expireAfterSeconds: 120 }),
    db.collection('requests').createIndex({ at: 1 }, { expireAfterSeconds: 300 }),
    db.collection('requests').createIndex({ to: 1, state: 1 }),
    db.collection('requests').createIndex({ from: 1, state: 1 }),
  ]);
}

function text(value, max, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new HttpError(400, `${field} no válido`);
  }
  return value.trim();
}

/** Atiende `action` con el cuerpo `body` y devuelve lo que se contesta.
 *  `version` es la de la API (0 sin versión, 1 para /api/v1): cada acción
 *  nueva solo existe desde la suya. */
export async function handle(db, action, body, { now = () => new Date(), sleep = defaultSleep, version = 1 } = {}) {
  const users = db.collection('users');
  const requests = db.collection('requests');
  const id = text(body.id, 64, 'id');
  const token = text(body.token, 128, 'token');
  const online = () => ({ seen: { $gte: new Date(now().getTime() - ONLINE_MS) } });

  // Toda acción salvo `join` es de alguien que ya entró con ese token.
  async function me() {
    const user = await users.findOne({ _id: id, token });
    if (!user) throw new HttpError(401, 'sesión desconocida');
    return user;
  }

  async function cancelAll(who, except = null) {
    await requests.updateMany(
      { $or: [{ from: who }, { to: who }], state: 'pending', _id: { $ne: except } },
      { $set: { state: 'cancelled' } },
    );
  }

  switch (action) {
    case 'join': {
      // Nadie entra con el id de otro que sigue conectado (con otro token):
      // si no, cualquiera que viera la lista podría hacerse pasar por él.
      const existing = await users.findOne({ _id: id });
      if (existing && existing.token !== token && existing.seen >= new Date(now().getTime() - ONLINE_MS)) {
        throw new HttpError(409, 'id en uso');
      }
      // Tope de equipos nuevos por IP y minuto: una sola máquina no llena la lista.
      if (!existing && body.ipHash) {
        const recent = await users.countDocuments({ ip: body.ipHash, joined: { $gte: new Date(now().getTime() - 60_000) } });
        if (recent >= MAX_JOINS_PER_IP) throw new HttpError(429, 'demasiadas entradas');
      }
      const user = {
        token,
        name: text(body.name, 64, 'name'),
        platform: text(body.platform, 16, 'platform'),
        code: text(body.code, 64, 'code'),
        seen: now(),
        paired: false,
        ...(body.ipHash ? { ip: body.ipHash } : {}),
        ...(existing ? {} : { joined: now() }),
      };
      await users.updateOne({ _id: id }, { $set: user }, { upsert: true });
      return { ok: true };
    }

    case 'sync': {
      await me();
      await users.updateOne({ _id: id }, { $set: { seen: now() } });
      const deadline = now().getTime() + WAIT_MS;
      for (;;) {
        const state = await snapshot();
        if (state.v !== body.v || now().getTime() >= deadline) {
          // Sin cambios solo va la versión: lo demás el cliente ya lo tiene.
          return state.v === body.v ? { v: state.v } : state;
        }
        await sleep(POLL_MS);
      }
    }

    case 'request': {
      const user = await me();
      const to = text(body.to, 64, 'to');
      if (to === id) throw new HttpError(400, 'no puedes conectarte contigo');
      const target = await users.findOne({ _id: to, paired: false, ...online() });
      if (!target) throw new HttpError(404, 'ya no está conectado');
      const theirs = await requests.findOne({ from: to, to: id, state: 'pending' });
      if (theirs) throw new HttpError(409, 'ya te pidió conectarse: contesta su solicitud');
      const mine = await requests.findOne({ from: id, to, state: 'pending' });
      if (mine) return { id: mine._id };
      if ((await requests.countDocuments({ from: id, state: 'pending' })) >= MAX_PENDING) {
        throw new HttpError(429, 'demasiadas solicitudes sin contestar');
      }
      // Una solicitud por segundo como mucho: sin ráfagas para molestar.
      const t = now();
      const slot = await users.updateOne(
        { _id: id, token, $or: [{ lastRequest: { $exists: false } }, { lastRequest: { $lte: new Date(t.getTime() - REQUEST_GAP_MS) } }] },
        { $set: { lastRequest: t } },
      );
      if (!slot.matchedCount) throw new HttpError(429, 'espera un segundo entre solicitudes');
      const request = {
        _id: randomUUID(),
        from: id,
        to,
        fromName: user.name,
        fromPlatform: user.platform,
        state: 'pending',
        at: now(),
      };
      await requests.insertOne(request);
      return { id: request._id };
    }

    case 'cancel': {
      await me();
      await requests.updateOne(
        { _id: text(body.request, 64, 'request'), from: id, state: 'pending' },
        { $set: { state: 'cancelled' } },
      );
      return { ok: true };
    }

    case 'answer': {
      const user = await me();
      const request = await requests.findOne({ _id: text(body.request, 64, 'request'), to: id, state: 'pending' });
      if (!request) throw new HttpError(404, 'la solicitud ya no está');
      if (body.accept !== true) {
        await requests.updateOne({ _id: request._id }, { $set: { state: 'declined' } });
        return { ok: true };
      }
      const from = await users.findOne({ _id: request.from, paired: false, ...online() });
      if (!from) {
        await requests.updateOne({ _id: request._id }, { $set: { state: 'expired' } });
        throw new HttpError(404, 'ya no está conectado');
      }
      // Quien pidió recibe nuestro código en su próximo `sync`; nosotros nos
      // vamos ya. Desde ahora los dos solo están el uno para el otro.
      await requests.updateOne({ _id: request._id }, { $set: { state: 'accepted', code: user.code } });
      await users.updateOne({ _id: from._id }, { $set: { paired: true } });
      await cancelAll(id, request._id);
      await cancelAll(from._id, request._id);
      await users.deleteOne({ _id: id });
      return { partner: { id: from._id, name: from.name, platform: from.platform, code: from.code } };
    }

    // Una página de los que están en línea, con búsqueda por nombre. `sync`
    // sigue mandando la lista (hasta 200) para las versiones que no usan esto.
    case 'users': {
      if (version < 1) throw new HttpError(404, 'acción desconocida');
      await me();
      const q = typeof body.q === 'string' ? body.q.trim().slice(0, 64) : '';
      const offset = Number.isInteger(body.offset) && body.offset >= 0 ? Math.min(body.offset, 100_000) : 0;
      const limit = Number.isInteger(body.limit) ? Math.min(Math.max(body.limit, 1), MAX_PAGE) : MAX_PAGE;
      const filter = { _id: { $ne: id }, paired: false, ...online() };
      if (q) filter.name = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      const [list, total] = await Promise.all([
        users.find(filter, { projection: { name: 1, platform: 1 } }).collation({ locale: 'en', strength: 1 }).sort({ name: 1, _id: 1 }).skip(offset).limit(limit).toArray(),
        users.countDocuments(filter),
      ]);
      return { users: list.map((u) => ({ id: u._id, name: u.name, platform: u.platform })), total, offset };
    }

    case 'leave': {
      const { deletedCount } = await users.deleteOne({ _id: id, token });
      if (deletedCount) await cancelAll(id);
      return { ok: true };
    }

    default:
      throw new HttpError(404, 'acción desconocida');
  }

  // Lo que ve `id` ahora: equipos libres, solicitudes que le esperan y
  // respuestas a las suyas, con una versión para saber si cambió algo.
  async function snapshot() {
    const list = await users
      .find({ _id: { $ne: id }, paired: false, ...online() }, { projection: { name: 1, platform: 1 } })
      .sort({ name: 1 })
      .limit(200)
      .toArray();
    const visible = new Set(list.map((u) => u._id));
    // Las mías a alguien que ya no está caducan.
    const stale = await requests
      .find({ from: id, state: 'pending' }, { projection: { to: 1 } })
      .toArray();
    const gone = stale.filter((r) => !visible.has(r.to)).map((r) => r._id);
    if (gone.length) {
      await requests.updateMany({ _id: { $in: gone }, state: 'pending' }, { $set: { state: 'expired' } });
    }
    const incoming = await requests.find({ to: id, state: 'pending' }).sort({ at: 1 }).toArray();
    const answered = await requests
      .find({ from: id, state: { $ne: 'pending' } }, { projection: { state: 1, code: 1 } })
      .toArray();
    const state = {
      users: list.map((u) => ({ id: u._id, name: u.name, platform: u.platform })),
      requests: incoming
        .filter((r) => visible.has(r.from))
        .map((r) => ({ id: r._id, from: { id: r.from, name: r.fromName, platform: r.fromPlatform } })),
      answers: answered.map((r) => (r.code ? { id: r._id, state: r.state, code: r.code } : { id: r._id, state: r.state })),
    };
    const v = createHash('sha1').update(JSON.stringify(state)).digest('base64url').slice(0, 12);
    return { v, ...state };
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
