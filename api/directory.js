import { PLAN_IDS, mergePlans, planById, sumCardQty } from './plans.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

export function createDirectory({ users, albums, plans, logs, adminEmail = '' }) {
  const email = String(adminEmail || '').trim().toLowerCase();

  async function readPlans() {
    return mergePlans(await plans.load());
  }

  async function ensureUser(profile) {
    const now = new Date();
    const promote = profile.markedAdmin === true || (email && profile.email && profile.email === email);
    const existing = await users.findOne({ userId: profile.userId });
    if (!existing) {
      let admin = promote;
      if (!admin && !email) {
        admin = (await users.countDocuments({ admin: true })) === 0;
      }
      const doc = {
        userId: profile.userId,
        email: profile.email || '',
        name: profile.name || '',
        planId: 'gratis',
        admin,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await users.insertOne(doc);
        return doc;
      } catch (err) {
        if (!err || err.code !== 11000) throw err;
      }
    }
    const set = {
      email: profile.email || existing?.email || '',
      name: profile.name || existing?.name || '',
      updatedAt: now,
    };
    if (promote) set.admin = true;
    await users.updateOne({ userId: profile.userId }, { $set: set });
    return { ...(existing || {}), ...set, userId: profile.userId, planId: existing?.planId || 'gratis' };
  }

  return {
    async touch(profile) {
      return ensureUser(profile);
    },
    async get(userId) {
      const cards = await albums.get(userId);
      return Array.isArray(cards) ? cards : [];
    },
    async put(userId, cards) {
      await albums.put(userId, cards);
    },
    async account(userId) {
      const user = await users.findOne({ userId });
      const list = await readPlans();
      const plan = planById(list, user?.planId || 'gratis');
      return { isAdmin: Boolean(user?.admin), plan };
    },
    async addLog(entry) {
      await logs.insert(entry);
      await logs.trim(200);
    },
    async listUsers() {
      const rows = await users.list();
      const list = [];
      for (const row of rows) {
        const cards = await albums.get(row.userId);
        list.push({
          userId: row.userId,
          email: row.email || '',
          name: row.name || '',
          planId: PLAN_IDS.includes(row.planId) ? row.planId : 'gratis',
          admin: Boolean(row.admin),
          cards: sumCardQty(cards),
        });
      }
      return list;
    },
    async setUserPlan(userId, planId) {
      if (!PLAN_IDS.includes(planId)) httpError('Plan desconocido', 400);
      const user = await users.findOne({ userId });
      if (!user) httpError('Usuario no encontrado', 404);
      await users.updateOne({ userId }, { $set: { planId, updatedAt: new Date() } });
      return { userId, planId };
    },
    async getPlans() {
      return readPlans();
    },
    async setPlanCaps(input) {
      const current = await readPlans();
      const incoming = new Map();
      if (!Array.isArray(input)) httpError('Planes inválidos', 400);
      for (const row of input) {
        if (!row || !PLAN_IDS.includes(row.id)) httpError('Plan desconocido', 400);
        const max = Number(row.maxCards);
        if (!Number.isInteger(max) || max < 1 || max > 100000) httpError('El máximo de cartas no es válido', 400);
        incoming.set(row.id, max);
      }
      if (incoming.size !== PLAN_IDS.length) httpError('Faltan planes', 400);
      const next = current.map((plan) => ({ ...plan, maxCards: incoming.get(plan.id) }));
      await plans.save(next);
      return next;
    },
    async listLogs(limit = 80) {
      const rows = await logs.latest(Math.min(100, Math.max(1, limit)));
      const known = new Map();
      for (const row of await users.list()) known.set(row.userId, row.email || '');
      return rows.map((row) => ({
        message: row.message,
        source: row.source,
        stack: row.stack || '',
        path: row.path,
        userId: row.userId || '',
        email: known.get(row.userId) || '',
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt || ''),
      }));
    },
  };
}
