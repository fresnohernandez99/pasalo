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

  // Para los demás ya no están, y a beto ya no se le puede escribir.
  assert.deepEqual((await carla.sync()).users, []);
  await assert.rejects(beto.sync(), { status: 401 });
  await assert.rejects(carla.request('ana'), { status: 404 });
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
