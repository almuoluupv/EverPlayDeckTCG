import { createServer } from 'node:http';
import { MongoClient } from 'mongodb';
import { verifyToken } from '@clerk/backend';
import { createApp } from './app.js';
import { pagesOrigin, userIdFromVerification } from './collection.js';

const REQUIRED = ['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY', 'MONGODB_URI', 'PAGES_ORIGIN'];

export function assertEnv(env = process.env) {
  const missing = REQUIRED.filter((key) => !String(env[key] || '').trim());
  if (missing.length) {
    const err = new Error('Faltan variables de entorno: ' + missing.join(', '));
    err.missing = missing;
    throw err;
  }
  const publishableKey = env.CLERK_PUBLISHABLE_KEY.trim();
  const secretKey = env.CLERK_SECRET_KEY.trim();
  if (!/^pk_(test|live)_/.test(publishableKey)) {
    throw new Error('CLERK_PUBLISHABLE_KEY no tiene el formato pk_test_ o pk_live_');
  }
  if (!/^sk_(test|live)_/.test(secretKey)) {
    throw new Error('CLERK_SECRET_KEY no tiene el formato sk_test_ o sk_live_');
  }
  return {
    secretKey,
    publishableKey,
    mongodbUri: env.MONGODB_URI.trim(),
    pagesOrigin: pagesOrigin(env.PAGES_ORIGIN.trim()),
  };
}

async function albumsCollection(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const albums = client.db('album').collection('albums');
    await albums.createIndex({ userId: 1 }, { unique: true });
    return albums;
  } catch (err) {
    await client.close().catch(() => {});
    const wrapped = new Error('No se pudo conectar a MongoDB');
    wrapped.status = 503;
    wrapped.causeName = err && (err.code || err.name) ? String(err.code || err.name) : 'error';
    throw wrapped;
  }
}

export async function startServer({ env = process.env, verifyTokenImpl = verifyToken } = {}) {
  const cfg = assertEnv(env);
  let albumsPromise = null;
  const albums = () => {
    if (!albumsPromise) {
      albumsPromise = albumsCollection(cfg.mongodbUri).catch((err) => {
        albumsPromise = null;
        throw err;
      });
    }
    return albumsPromise;
  };

  const app = createApp({
    pagesOrigin: cfg.pagesOrigin,
    verifySession: async (token) => {
      try {
        const result = await verifyTokenImpl(token, {
          secretKey: cfg.secretKey,
          authorizedParties: [cfg.pagesOrigin],
        });
        return userIdFromVerification(result);
      } catch {
        return null;
      }
    },
    store: {
      async get(userId) {
        const collection = await albums();
        const doc = await collection.findOne({ userId }, { projection: { _id: 0, cards: 1 } });
        return Array.isArray(doc?.cards) ? doc.cards : [];
      },
      async put(userId, cards) {
        const collection = await albums();
        await collection.updateOne(
          { userId },
          { $set: { userId, cards, updatedAt: new Date() } },
          { upsert: true },
        );
      },
    },
  });

  const port = Number(env.PORT) || 8787;
  const server = createServer((req, res) => {
    app(req, res).catch((err) => {
      const status = Number(err.status) || 500;
      console.error('request failed', status, err.name || 'Error');
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: status === 500 ? 'Error interno' : err.message }));
    });
  });

  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  console.log(`API escuchando en 0.0.0.0:${port}`);
  return { server, port };
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('server.js');
if (isDirectRun) {
  startServer().catch((err) => {
    console.error(err && err.message ? err.message : 'No se pudo arrancar la API');
    if (err && err.causeName) console.error(err.causeName);
    process.exit(1);
  });
}
