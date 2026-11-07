// Conexión a MongoDB, reutilizada entre invocaciones de la misma instancia.
// La URL sale de la variable de entorno MONGODB_URI (en Vercel: Settings →
// Environment Variables). MONGODB_DB elige la base de datos (por defecto
// "pasalo").

import { MongoClient } from 'mongodb';
import { setup } from './lobby.js';
import { setupStats } from './stats.js';

let ready = null;

export function database() {
  ready ||= (async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('falta la variable de entorno MONGODB_URI');
    // Pocas conexiones: cada instancia atiende pocas peticiones a la vez.
    const client = new MongoClient(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 8_000 });
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || 'pasalo');
    await setup(db);
    await setupStats(db);
    return db;
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}
