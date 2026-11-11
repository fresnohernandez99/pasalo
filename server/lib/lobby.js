// Lógica del server de señalización de Pasalo. Solo presenta a los equipos:
// quién está conectado y quién quiere conectarse con quién. Cuando una
// solicitud se acepta, cada lado recibe el código de iroh del otro, los dos
// se van del server y desde ahí hablan directamente.
//
// Amigos (v1): cada app guarda los códigos de sus amigos y, al abrir
// Descubrir, pregunta cuáles están (`friends`). Los emparejados siguen en el
// server con `ping` mientras hablan, para que sus amigos los vean ocupados.
//
// Multi (v1): a device that joins with `multi` can chat with several people.
// Pairing doesn't take it off the list or make it busy, and accepting one
// request doesn't cancel its other ones; it keeps syncing.
//
// Colecciones:
//   users     { _id, token, name, platform, code, seen, paired, multi }
//   requests  { _id, from, to, fromName, fromPlatform, fromCode?, state, code, at }
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
/** Códigos por consulta de amigos. */
const MAX_FRIENDS = 200;

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
    db.collection('users').createIndex({ code: 1 }),
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
  // Who can still be asked: not paired, or paired but chatting with several.
  const free = () => ({ $or: [{ paired: false }, { multi: true }] });

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
        // Una pareja que vuelve tras perder la sesión sigue ocupada (v1).
        paired: version >= 1 && body.busy === true,
        multi: version >= 1 && body.multi === true,
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
      const target = await users.findOne({ _id: to, ...free(), ...online() });
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
        // A un amigo se le dice quién es: ya tiene su código guardado.
        ...(version >= 1 && body.friend === true ? { fromCode: user.code } : {}),
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
      const from = await users.findOne({ _id: request.from, ...free(), ...online() });
      if (!from) {
        await requests.updateOne({ _id: request._id }, { $set: { state: 'expired' } });
        throw new HttpError(404, 'ya no está conectado');
      }
      // Quien pidió recibe nuestro código en su próximo `sync`; nosotros nos
      // vamos ya. Desde ahora los dos solo están el uno para el otro.
      await requests.updateOne({ _id: request._id }, { $set: { state: 'accepted', code: user.code } });
      await users.updateOne({ _id: from._id }, { $set: { paired: true } });
      // Someone chatting with several keeps the rest of their requests.
      if (!user.multi) await cancelAll(id, request._id);
      if (!from.multi) await cancelAll(from._id, request._id);
      // Desde v1 los dos se quedan (fuera de la lista) con `ping`, para que
      // sus amigos los vean ocupados; antes se iban del todo.
      if (version >= 1) await users.updateOne({ _id: id }, { $set: { paired: true, seen: now() } });
      else await users.deleteOne({ _id: id });
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
      const filter = { _id: { $ne: id }, ...free(), ...online() };
      if (q) filter.name = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      const [list, total] = await Promise.all([
        users.find(filter, { projection: { name: 1, platform: 1 } }).collation({ locale: 'en', strength: 1 }).sort({ name: 1, _id: 1 }).skip(offset).limit(limit).toArray(),
        users.countDocuments(filter),
      ]);
      return { users: list.map((u) => ({ id: u._id, name: u.name, platform: u.platform })), total, offset };
    }

    // Cuáles de estos códigos (los amigos de quien pregunta) están en el
    // server: libres, con el id de su sesión para pedirles conectarse, u
    // ocupados con su pareja.
    case 'friends': {
      if (version < 1) throw new HttpError(404, 'acción desconocida');
      await me();
      if (!Array.isArray(body.codes) || body.codes.length > MAX_FRIENDS) throw new HttpError(400, 'codes no válido');
      const codes = body.codes.filter((c) => typeof c === 'string' && c.length <= 64);
      const list = await users
        .find({ _id: { $ne: id }, code: { $in: codes }, ...online() }, { projection: { code: 1, name: 1, platform: 1, paired: 1, multi: 1, seen: 1 } })
        .sort({ seen: -1 })
        .toArray();
      // Si un código tiene dos sesiones (una a punto de caducar), la más reciente.
      const seen = new Set();
      const friends = [];
      for (const u of list) {
        if (seen.has(u.code)) continue;
        seen.add(u.code);
        friends.push({ code: u.code, id: u._id, name: u.name, platform: u.platform, busy: !!u.paired && !u.multi });
      }
      return { friends };
    }

    // Una pareja sigue en el server mientras habla (ocupada para sus amigos).
    case 'ping': {
      if (version < 1) throw new HttpError(404, 'acción desconocida');
      await me();
      await users.updateOne({ _id: id }, { $set: { seen: now(), paired: true } });
      return { ok: true };
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
      .find({ _id: { $ne: id }, ...free(), ...online() }, { projection: { name: 1, platform: 1 } })
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
        .map((r) => ({
          id: r._id,
          from: { id: r.from, name: r.fromName, platform: r.fromPlatform, ...(r.fromCode ? { code: r.fromCode } : {}) },
        })),
      answers: answered.map((r) => (r.code ? { id: r._id, state: r.state, code: r.code } : { id: r._id, state: r.state })),
    };
    const v = createHash('sha1').update(JSON.stringify(state)).digest('base64url').slice(0, 12);
    return { v, ...state };
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
