import { createServer } from 'node:http';
import { MongoClient } from 'mongodb';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { createApp } from './app.js';
import { createDirectory } from './directory.js';
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
  const adminEmail = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    throw new Error('ADMIN_EMAIL no es un correo');
  }
  return {
    secretKey,
    publishableKey,
    mongodbUri: env.MONGODB_URI.trim(),
    pagesOrigin: pagesOrigin(env.PAGES_ORIGIN.trim()),
    adminEmail,
  };
}

async function openDatabase(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const db = client.db('album');
    const albums = db.collection('albums');
    const users = db.collection('users');
    const plans = db.collection('plans');
    const logs = db.collection('errorLogs');
    await albums.createIndex({ userId: 1 }, { unique: true });
    await users.createIndex({ userId: 1 }, { unique: true });
    await logs.createIndex({ createdAt: -1 });
    return {
      users: {
        async findOne(filter) {
          return users.findOne(filter, { projection: { _id: 0 } });
        },
        async insertOne(doc) {
          await users.insertOne(doc);
        },
        async updateOne(filter, update) {
          await users.updateOne(filter, update);
        },
        async countDocuments(filter) {
          return users.countDocuments(filter);
        },
        async list() {
          return users.find({}, { projection: { _id: 0 } }).sort({ createdAt: 1 }).limit(500).toArray();
        },
      },
      albums: {
        async get(userId) {
          const doc = await albums.findOne({ userId }, { projection: { _id: 0, cards: 1 } });
          return Array.isArray(doc?.cards) ? doc.cards : [];
        },
        async put(userId, cards) {
          await albums.updateOne(
            { userId },
            { $set: { userId, cards, updatedAt: new Date() } },
            { upsert: true },
          );
        },
      },
      plans: {
        async load() {
          const doc = await plans.findOne({ _id: 'current' }, { projection: { plans: 1 } });
          return Array.isArray(doc?.plans) ? doc.plans : null;
        },
        async save(next) {
          await plans.updateOne({ _id: 'current' }, { $set: { plans: next } }, { upsert: true });
        },
      },
      logs: {
        async insert(entry) {
          await logs.insertOne(entry);
        },
        async latest(limit) {
          return logs.find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray();
        },
        async trim(keep) {
          const border = await logs.find({}, { projection: { createdAt: 1 } }).sort({ createdAt: -1 }).skip(keep).limit(1).toArray();
          if (border[0]?.createdAt) await logs.deleteMany({ createdAt: { $lt: border[0].createdAt } });
        },
      },
    };
  } catch (err) {
    await client.close().catch(() => {});
    const wrapped = new Error('No se pudo conectar a MongoDB');
    wrapped.status = 503;
    wrapped.causeName = err && (err.code || err.name) ? String(err.code || err.name) : 'error';
    throw wrapped;
  }
}

function profileFromClerkUser(user) {
  const primary = user?.primaryEmailAddress?.emailAddress
    || user?.emailAddresses?.find((row) => row.id === user.primaryEmailAddressId)?.emailAddress
    || user?.emailAddresses?.[0]?.emailAddress
    || '';
  return {
    email: String(primary || '').trim().toLowerCase(),
    name: [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim(),
    markedAdmin: user?.publicMetadata?.albumAdmin === true,
  };
}

export async function startServer({ env = process.env, verifyTokenImpl = verifyToken, clerkClient = null } = {}) {
  const cfg = assertEnv(env);
  const clerk = clerkClient || createClerkClient({ secretKey: cfg.secretKey });
  const known = new Map();
  let dbPromise = null;
  const database = () => {
    if (!dbPromise) {
      dbPromise = openDatabase(cfg.mongodbUri).catch((err) => {
        dbPromise = null;
        throw err;
      });
    }
    return dbPromise;
  };
  let directoryPromise = null;
  const directory = async () => {
    if (!directoryPromise) {
      directoryPromise = database().then((deps) => createDirectory({ ...deps, adminEmail: cfg.adminEmail }));
    }
    return directoryPromise;
  };

  async function verifySession(token) {
    let result;
    try {
      result = await verifyTokenImpl(token, {
        secretKey: cfg.secretKey,
        authorizedParties: [cfg.pagesOrigin],
      });
    } catch {
      return null;
    }
    const userId = userIdFromVerification(result);
    if (!userId) return null;
    const cached = known.get(userId);
    if (cached && Date.now() - cached.at < 60 * 1000) {
      return { userId, email: cached.email, name: cached.name, markedAdmin: cached.markedAdmin };
    }
    let extra = { email: '', name: '', markedAdmin: false };
    try {
      extra = profileFromClerkUser(await clerk.users.getUser(userId));
    } catch {
      extra = { email: '', name: '', markedAdmin: false };
    }
    known.set(userId, { ...extra, at: Date.now() });
    return { userId, ...extra };
  }

  const app = createApp({
    pagesOrigin: cfg.pagesOrigin,
    verifySession,
    store: {
      async touch(profile) {
        return (await directory()).touch(profile);
      },
      async get(userId) {
        return (await directory()).get(userId);
      },
      async put(userId, cards) {
        return (await directory()).put(userId, cards);
      },
      async account(userId) {
        return (await directory()).account(userId);
      },
      async addLog(entry) {
        return (await directory()).addLog(entry);
      },
      async listUsers() {
        return (await directory()).listUsers();
      },
      async setUserPlan(userId, planId) {
        return (await directory()).setUserPlan(userId, planId);
      },
      async getPlans() {
        return (await directory()).getPlans();
      },
      async setPlanCaps(input) {
        return (await directory()).setPlanCaps(input);
      },
      async listLogs(limit) {
        return (await directory()).listLogs(limit);
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
