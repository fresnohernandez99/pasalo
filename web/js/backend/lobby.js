// Cliente del server de conexión (`server/`), como `lobby.rs`: entra con el
// código de iroh, espera novedades con `sync` (hasta 20 s por petición) y
// lleva las solicitudes. Al aceptarse una, los dos salen de la lista y solo
// hacen `ping` (ocupados para sus amigos) hasta `leave`.

import { PasaloError, sleep } from './util.js';

const SYNC_WAIT = 20_000;
/** Cada cuánto avisa una pareja de que sigue ocupada (el server la olvida a los 45 s). */
const PING_EVERY = 25_000;

export class Lobby {
  constructor(base, me, code, emit, multi = false) {
    this.base = base.trim().replace(/\/+$/, '');
    this.me = me; // { id, name, platform }
    this.code = code;
    this.emit = emit;
    const random = crypto.getRandomValues(new Uint8Array(32));
    this.token = [...random].map((b) => b.toString(16).padStart(2, '0')).join('');
    this.incoming = new Map(); // id → usuario
    this.outgoing = new Map(); // id → usuario
    this.left = false;
    this.paired = false; // emparejado: ya solo se hace `ping`
    // Several partners at once: pairing never stops the `sync` loop.
    this.multi = multi;
  }

  /** Entra y se queda escuchando hasta `leave` o hasta emparejarse. */
  static async join(base, me, code, emit, multi = false) {
    const lobby = new Lobby(base, me, code, emit, multi);
    await lobby.enter();
    lobby.run();
    return lobby;
  }

  /** A un amigo (`friend`) se le dice quién es. */
  async request(to, friend = false) {
    const created = await this.post('request', { to: to.id, friend });
    this.outgoing.set(created.id, to);
    return created.id;
  }

  /** Una página de los que están en línea, con búsqueda por nombre. */
  users(q, offset, limit) {
    return this.post('users', { q, offset, limit });
  }

  /** Cuáles de estos códigos (los amigos) están en el server, libres u ocupados. */
  async friends(codes) {
    return (await this.post('friends', { codes })).friends;
  }

  async cancel(request) {
    this.outgoing.delete(request);
    await this.post('cancel', { request });
  }

  async answer(request, accept) {
    // Se quita antes: un `sync` en vuelo que ya no la trae no debe contarla como retirada.
    const from = this.incoming.get(request);
    this.incoming.delete(request);
    let reply;
    try {
      reply = await this.post('answer', { request, accept });
    } catch (err) {
      if (from) this.incoming.set(request, from);
      throw err;
    }
    if (accept && reply.partner) {
      this.pair(reply.partner);
      return reply.partner;
    }
    return null;
  }

  async leave() {
    if (this.left) return;
    this.left = true;
    await this.post('leave', {}).catch(() => {});
  }

  enter() {
    return this.post('join', { name: this.me.name, platform: this.me.platform, code: this.code, busy: this.paired, multi: this.multi });
  }

  pair(partner) {
    if (!this.multi) this.paired = true;
    this.emit({ kind: 'lobby_paired', partner });
  }

  /** Emparejado: solo se avisa de que se sigue (ocupado) hasta salir. */
  async keepBusy() {
    while (!this.left) {
      await sleep(PING_EVERY);
      if (this.left) return;
      try {
        await this.post('ping', {});
      } catch (err) {
        const detail = String(err.detail);
        // El server nos olvidó (p. ej. un corte largo): se vuelve a entrar, ocupado.
        if (detail.startsWith('401') && !this.left) await this.enter().catch(() => {});
        // Un server sin `ping` (anterior a los amigos): no hay a quién avisar.
        if (detail.startsWith('404')) return;
      }
    }
  }

  async run() {
    let v = '';
    let fails = 0;
    while (!this.left) {
      if (this.paired) return this.keepBusy();
      let reply;
      try {
        reply = await this.post('sync', { v });
      } catch (err) {
        if (this.left || this.paired) continue;
        this.emit({ kind: 'lobby_error', detail: err.detail || String(err) });
        fails++;
        await sleep(5000 * 2 ** Math.min(fails, 3));
        // Si el server nos olvidó (caducó la sesión), se vuelve a entrar.
        if (String(err.detail).startsWith('401')) await this.enter().catch(() => {});
        v = '';
        continue;
      }
      if (this.left || this.paired) continue;
      if (fails) {
        fails = 0;
        this.emit({ kind: 'lobby_error', detail: '' });
      }
      v = reply.v;
      if (reply.users) this.emit({ kind: 'lobby_users', users: reply.users });
      if (reply.requests) this.updateIncoming(reply.requests);
      for (const answer of reply.answers || []) {
        const to = this.outgoing.get(answer.id);
        if (!to) continue;
        this.outgoing.delete(answer.id);
        if (answer.state === 'accepted' && answer.code) {
          this.pair({ id: to.id, name: to.name, platform: to.platform, code: answer.code });
          if (this.multi) continue;
          break;
        }
        this.emit({ kind: 'lobby_answer', request: answer.id, accepted: false, reason: answer.state });
      }
    }
  }

  updateIncoming(requests) {
    const now = new Map(requests.map((r) => [r.id, r.from]));
    for (const id of this.incoming.keys()) if (!now.has(id)) this.emit({ kind: 'lobby_request_gone', request: id });
    for (const [id, from] of now) if (!this.incoming.has(id)) this.emit({ kind: 'lobby_request', request: id, from });
    this.incoming = now;
  }

  async post(action, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), action === 'sync' ? SYNC_WAIT + 15_000 : 20_000);
    let response;
    let text;
    try {
      response = await fetch(`${this.base}/api/v1/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, id: this.me.id, token: this.token }),
        signal: controller.signal,
        cache: 'no-store',
      });
      text = await response.text();
    } catch (err) {
      throw new PasaloError('server', err?.name === 'AbortError' ? 'timed out' : String(err?.message || err));
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    if (!response.ok) throw new PasaloError('server', `${response.status} ${json?.error || ''}`.trim());
    if (!json) throw new PasaloError('server', 'invalid response');
    return json;
  }
}
