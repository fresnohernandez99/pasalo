// Pruebas de la lógica del server contra un MongoDB de verdad (lo arranca
// mongodb-memory-server). El reloj es de mentira: las esperas largas no
// tardan.

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ONLINE_MS, WAIT_MS, handle, setup } from '../lib/lobby.js';

let mongo;
let client;
let db;
let clock;

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = client.db('prueba');
  await setup(db);
});

after(async () => {
  await client?.close();
  await mongo?.stop();
});

beforeEach(async () => {
  await db.collection('users').deleteMany({});
  await db.collection('requests').deleteMany({});
  clock = Date.parse('2026-11-05T12:00:00Z');
});

const now = () => new Date(clock);
// Cada espera avanza el reloj; `onSleep` deja cambiar cosas a mitad.
let onSleep = null;
const sleep = async (ms) => {
  clock += ms;
  if (onSleep) {
    const fn = onSleep;
    onSleep = null;
    await fn();
  }
};

const code = (c) => c.repeat(64);
const call = (action, body) => handle(db, action, body, { now, sleep });
const as = (user) => ({
  join: () => call('join', { ...user, token: `t-${user.id}` }),
  sync: (v = '') => call('sync', { id: user.id, token: `t-${user.id}`, v }),
  request: (to) => call('request', { id: user.id, token: `t-${user.id}`, to }),
  answer: (request, accept) => call('answer', { id: user.id, token: `t-${user.id}`, request, accept }),
  cancel: (request) => call('cancel', { id: user.id, token: `t-${user.id}`, request }),
  leave: () => call('leave', { id: user.id, token: `t-${user.id}` }),
});

const ana = as({ id: 'ana', name: 'Ana', platform: 'android', code: code('a') });
const beto = as({ id: 'beto', name: 'Beto', platform: 'macos', code: code('b') });
const carla = as({ id: 'carla', name: 'Carla', platform: 'windows', code: code('c') });

test('lista a los demás conectados, sin uno mismo', async () => {
  await ana.join();
  await beto.join();
  const state = await ana.sync();
  assert.deepEqual(state.users, [{ id: 'beto', name: 'Beto', platform: 'macos' }]);
  assert.deepEqual(state.requests, []);
});

test('quien deja de sincronizar desaparece de la lista', async () => {
  await ana.join();
  await beto.join();
  clock += ONLINE_MS + 1000;
  await ana.join(); // ana sigue viva, beto no
  assert.deepEqual((await ana.sync()).users, []);
  await assert.rejects(ana.request('beto'), { status: 404 });
});

test('solicitud aceptada: cada uno recibe el código del otro y se van del server', async () => {
  await ana.join();
  await beto.join();
  await carla.join();
  const { id } = await ana.request('beto');

  const forBeto = await beto.sync();
  assert.deepEqual(forBeto.requests, [{ id, from: { id: 'ana', name: 'Ana', platform: 'android' } }]);

  const { partner } = await beto.answer(id, true);
  assert.deepEqual(partner, { id: 'ana', name: 'Ana', platform: 'android', code: code('a') });

  const forAna = await ana.sync();
  assert.deepEqual(forAna.answers, [{ id, state: 'accepted', code: code('b') }]);
  await ana.leave();

  // Para los demás ya no están, y a ninguno se le puede escribir.
  assert.deepEqual((await carla.sync()).users, []);
  await assert.rejects(carla.request('ana'), { status: 404 });
  await assert.rejects(carla.request('beto'), { status: 404 });
});

test('sin versión, quien acepta se va del server', async () => {
  await ana.join();
  await beto.join();
  const { id } = await ana.request('beto');
  await handle(db, 'answer', { id: 'beto', token: 't-beto', request: id, accept: true }, { now, sleep, version: 0 });
  await assert.rejects(beto.sync(), { status: 401 });
});

const friends = (user, codes) => call('friends', { id: user, token: `t-${user}`, codes });
const ping = (user) => call('ping', { id: user, token: `t-${user}` });

test('amigos: libres con su id de ahora, ocupados mientras hablan con su pareja', async () => {
  await ana.join();
  await beto.join();
  await carla.join();
  assert.deepEqual((await friends('carla', [code('a'), code('b'), code('z')])).friends.sort((x, y) => x.id.localeCompare(y.id)), [
    { code: code('a'), id: 'ana', name: 'Ana', platform: 'android', busy: false },
    { code: code('b'), id: 'beto', name: 'Beto', platform: 'macos', busy: false },
  ]);

  const { id } = await ana.request('beto');
  await beto.answer(id, true);
  await ana.sync();
  // Los dos siguen en el server con `ping`: ocupados, fuera de la lista.
  clock += ONLINE_MS - 5000;
  await ping('ana');
  await ping('beto');
  clock += 10_000;
  const busy = (await friends('carla', [code('a'), code('b')])).friends;
  assert.deepEqual(busy.map((f) => [f.id, f.busy]).sort(), [['ana', true], ['beto', true]]);
  assert.deepEqual((await carla.sync()).users, []);
  await assert.rejects(carla.request('ana'), { status: 404 });

  // Al despedirse ya no salen.
  await ana.leave();
  assert.deepEqual((await friends('carla', [code('a')])).friends, []);
  // Y sin `ping` caducan.
  clock += ONLINE_MS;
  assert.deepEqual((await friends('carla', [code('b')])).friends, []);
});

test('la solicitud a un amigo lleva el código de quien la manda', async () => {
  await ana.join();
  await beto.join();
  const { id } = await call('request', { id: 'ana', token: 't-ana', to: 'beto', friend: true });
  assert.deepEqual((await beto.sync()).requests, [{ id, from: { id: 'ana', name: 'Ana', platform: 'android', code: code('a') } }]);
});

test('amigos: lista limitada y solo en v1', async () => {
  await ana.join();
  await assert.rejects(friends('ana', 'x'), { status: 400 });
  await assert.rejects(friends('ana', Array(201).fill(code('b'))), { status: 400 });
  const body = { id: 'ana', token: 't-ana', codes: [] };
  await assert.rejects(handle(db, 'friends', body, { now, sleep, version: 0 }), { status: 404 });
  await assert.rejects(handle(db, 'ping', body, { now, sleep, version: 0 }), { status: 404 });
});

test('aceptar cancela las demás solicitudes de los dos', async () => {
  await ana.join();
  await beto.join();
  await carla.join();
  const ab = await ana.request('beto');
  const cb = await carla.request('beto');
  await beto.answer(ab.id, true);
  const forCarla = await carla.sync();
  assert.deepEqual(forCarla.answers, [{ id: cb.id, state: 'cancelled' }]);
});

test('solicitud rechazada', async () => {
  await ana.join();
  await beto.join();
  const { id } = await ana.request('beto');
  await beto.answer(id, false);
  assert.deepEqual((await ana.sync()).answers, [{ id, state: 'declined' }]);
  assert.equal((await ana.sync()).users.length, 1, 'los dos siguen en el server');
});

test('solicitud a alguien que se va: cancelada si se despide, caducada si desaparece', async () => {
  await ana.join();
  await beto.join();
  await carla.join();
  const toBeto = await ana.request('beto');
  clock += 1000;
  const toCarla = await ana.request('carla');
  await beto.leave();
  clock += ONLINE_MS + 1000;
  await ana.join(); // ana sigue viva, carla dejó de sincronizar
  const { answers } = await ana.sync();
  assert.deepEqual(
    answers.sort((x, y) => x.state.localeCompare(y.state)),
    [
      { id: toBeto.id, state: 'cancelled' },
      { id: toCarla.id, state: 'expired' },
    ],
  );
});

test('retirar una solicitud la quita del otro lado', async () => {
  await ana.join();
  await beto.join();
  const { id } = await ana.request('beto');
  assert.equal((await beto.sync()).requests.length, 1);
  await ana.cancel(id);
  assert.deepEqual((await beto.sync()).requests, []);
  await assert.rejects(beto.answer(id, true), { status: 404 });
});

test('si ya te pidieron, no se cruza otra solicitud', async () => {
  await ana.join();
  await beto.join();
  await ana.request('beto');
  await assert.rejects(beto.request('ana'), { status: 409 });
});

test('sin novedades, sync espera y contesta solo la versión', async () => {
  await ana.join();
  const first = await ana.sync();
  const start = clock;
  const second = await ana.sync(first.v);
  assert.deepEqual(second, { v: first.v });
  assert.ok(clock - start >= WAIT_MS, 'debía esperar');
});

test('sync contesta en cuanto cambia algo', async () => {
  await ana.join();
  const first = await ana.sync();
  const start = clock;
  onSleep = () => beto.join();
  const second = await ana.sync(first.v);
  assert.equal(second.users.length, 1);
  assert.ok(clock - start < WAIT_MS);
});

test('token equivocado', async () => {
  await ana.join();
  await assert.rejects(call('sync', { id: 'ana', token: 'otro', v: '' }), { status: 401 });
  await assert.rejects(call('sync', { id: 'ana' }), { status: 400 });
});

test('nadie entra con el id de otro que sigue conectado', async () => {
  const opts = { now, sleep };
  await handle(db, 'join', { id: 'victima', token: 't1', name: 'Ana', platform: 'ios', code: 'c1' }, opts);
  await assert.rejects(
    handle(db, 'join', { id: 'victima', token: 'otro', name: 'Ana', platform: 'ios', code: 'c2' }, opts),
    (err) => err.status === 409,
  );
  // El mismo token (reentrar) sí, y cuando el otro ya se fue, también.
  await handle(db, 'join', { id: 'victima', token: 't1', name: 'Ana', platform: 'ios', code: 'c1' }, opts);
  clock += ONLINE_MS + 1000;
  await handle(db, 'join', { id: 'victima', token: 'otro', name: 'Ana', platform: 'ios', code: 'c2' }, opts);
});

test('tope de entradas por IP', async () => {
  const opts = { now, sleep };
  for (let i = 0; i < 10; i++) {
    await handle(db, 'join', { id: `ip-${i}`, token: 't', name: 'x', platform: 'ios', code: 'c', ipHash: 'h' }, opts);
  }
  await assert.rejects(
    handle(db, 'join', { id: 'ip-10', token: 't', name: 'x', platform: 'ios', code: 'c', ipHash: 'h' }, opts),
    (err) => err.status === 429,
  );
});

test('lista paginada con búsqueda', async () => {
  const opts = { now, sleep };
  const join = (id, name) => handle(db, 'join', { id, token: `t-${id}`, name, platform: 'ios', code: `c-${id}` }, opts);
  await join('yo', 'Yo');
  for (let i = 0; i < 25; i++) await join(`u${i}`, `Usuario ${String(i).padStart(2, '0')}`);
  await join('ana', 'Ana (casa)');
  const page = (body) => handle(db, 'users', { id: 'yo', token: 't-yo', ...body }, opts);

  const first = await page({ limit: 10 });
  assert.equal(first.total, 26);
  assert.equal(first.users.length, 10);
  assert.equal(first.users[0].name, 'Ana (casa)');
  assert.ok(!first.users.some((u) => u.id === 'yo'));
  const last = await page({ limit: 10, offset: 20 });
  assert.equal(last.users.length, 6);

  const found = await page({ q: 'usuario 1' });
  assert.equal(found.total, 10);
  // Los caracteres especiales se buscan tal cual (nada de expresiones).
  assert.equal((await page({ q: '(casa)' })).total, 1);
  assert.equal((await page({ q: '.*' })).total, 0);
  await assert.rejects(handle(db, 'users', { id: 'yo', token: 'mal' }, opts), (err) => err.status === 401);
});

test('una solicitud por segundo como mucho', async () => {
  await ana.join();
  await beto.join();
  await carla.join();
  await ana.request('beto');
  // Repetir la misma no cuenta: devuelve la que ya hay.
  await ana.request('beto');
  await assert.rejects(ana.request('carla'), { status: 429 });
  clock += 999;
  await assert.rejects(ana.request('carla'), { status: 429 });
  clock += 1;
  await ana.request('carla');
});

test('la API sin versión no tiene `users`; la v1 sí', async () => {
  await ana.join();
  const body = { id: 'ana', token: 't-ana' };
  await assert.rejects(handle(db, 'users', body, { now, sleep, version: 0 }), { status: 404 });
  assert.equal((await handle(db, 'users', body, { now, sleep, version: 1 })).total, 0);
});

test('multi: accepting keeps the other requests, stays listed and is never busy', async () => {
  const multiBeto = as({ id: 'beto', name: 'Beto', platform: 'macos', code: code('b'), multi: true });
  await ana.join();
  await multiBeto.join();
  await carla.join();
  const ab = await ana.request('beto');
  const cb = await carla.request('beto');
  const { partner } = await multiBeto.answer(ab.id, true);
  assert.equal(partner.id, 'ana');
  // Carla's request is still there and Beto still shows up for her.
  const forBeto = await multiBeto.sync();
  assert.deepEqual(forBeto.requests.map((r) => r.id), [cb.id]);
  const forCarla = await carla.sync();
  assert.ok(forCarla.users.some((u) => u.id === 'beto'));
  assert.equal(forCarla.answers.length, 0);
  // She is accepted too: Beto now chats with both.
  const second = await multiBeto.answer(cb.id, true);
  assert.equal(second.partner.id, 'carla');
  const friends = await call('friends', { id: 'ana', token: 't-ana', codes: [code('b')] });
  assert.equal(friends.friends[0].busy, false);
});

test('multi only from v1; the one who asked a multi user still pairs alone', async () => {
  await handle(db, 'join', { id: 'beto', token: 't-beto', name: 'Beto', platform: 'macos', code: code('b'), multi: true }, { now, sleep, version: 0 });
  assert.equal((await db.collection('users').findOne({ _id: 'beto' })).multi, false);
  const multiBeto = as({ id: 'beto', name: 'Beto', platform: 'macos', code: code('b'), multi: true });
  await multiBeto.join();
  await ana.join();
  await carla.join();
  const ab = await ana.request('beto');
  clock += 1000;
  const ac = await ana.request('carla');
  await multiBeto.answer(ab.id, true);
  // Ana isn't multi: her other request is cancelled and she leaves the list.
  const forCarla = await carla.sync();
  assert.ok(!forCarla.users.some((u) => u.id === 'ana'));
  assert.ok(!forCarla.requests.some((r) => r.id === ac.id));
});
