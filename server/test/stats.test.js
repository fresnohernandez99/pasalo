// Pruebas de las estadísticas de llamadas contra un MongoDB de verdad.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MAX_RECORDS, saveStats, setupStats, statsSummary } from '../lib/stats.js';

let mongo;
let client;
let db;

before(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = client.db('prueba');
  await setupStats(db);
});

after(async () => {
  await client?.close();
  await mongo?.stop();
});

const call = (id, extra = {}) => ({
  id, media: 'voice', role: 'caller', outcome: 'completed', started: Date.now(), duration_ms: 60_000,
  audio: 'normal', video: null, sent: 100_000, received: 95_000, video_sent: 0, video_received: 0, lost: 2, recovered: 1,
  ...extra,
});

test('guarda, no duplica al repetir y no guarda el id del equipo tal cual', async () => {
  const body = { device: 'equipo-1', platform: 'ios', version: '1.0.1', calls: [call('a'), call('b')] };
  assert.deepEqual(await saveStats(db, body), { saved: 2 });
  assert.deepEqual(await saveStats(db, body), { saved: 2 });
  const docs = await db.collection('calls').find().toArray();
  assert.equal(docs.length, 2);
  assert.ok(docs.every((d) => d.device !== 'equipo-1' && d.device.length === 16));
  const summary = await statsSummary(db);
  assert.equal(summary.groups[0].calls, 2);
  assert.equal(summary.groups[0].devices, 1);
  assert.equal(summary.groups[0].minutes, 2);
});

test('rechaza lo que no cuadra', async () => {
  const base = { device: 'x', platform: 'ios', version: '1' };
  const bad = [
    { ...base, calls: [call('c', { outcome: 'hack' })] },
    { ...base, calls: [call('c', { sent: -1 })] },
    { ...base, calls: [call('c', { id: { $gt: '' } })] },
    { ...base, calls: [call('c', { media: 'fax' })] },
    { ...base, calls: [call('c', { blur: 'sí' })] },
    { ...base, calls: Array.from({ length: MAX_RECORDS + 1 }, (_, i) => call(`n${i}`)) },
    { ...base, device: { $ne: null }, calls: [] },
  ];
  for (const body of bad) await assert.rejects(saveStats(db, body), (err) => err.status === 400);
});

test('separa con y sin desenfoque', async () => {
  await db.collection('calls').deleteMany({});
  const video = (id, blur, kb) =>
    call(id, { media: 'video', video: 'normal', blur, enhance: true, video_sent: kb * 1000, sent: kb * 1000, received: kb * 1000 });
  await saveStats(db, { device: 'v', platform: 'android', version: '1', calls: [video('x', true, 700), video('y', false, 1000)] });
  const { groups } = await statsSummary(db);
  const by = Object.fromEntries(groups.map((g) => [String(g.blur), g]));
  assert.ok(by.true.video_up_kbps < by.false.video_up_kbps);
  assert.equal(by.true.enhance, true);
});
