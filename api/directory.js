import {
  MAX_PLAN_MONTHS,
  PLAN_IDS,
  activeSubscription,
  addMonths,
  formatCode,
  generateCode,
  mergePlans,
  normalizeCode,
  planById,
  sumCardQty,
} from './plans.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function createDirectory({ users, albums, plans, logs, codes, adminEmail = '', now = () => new Date() }) {
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
      const current = now();
      const sub = activeSubscription(user || {}, current);
      if (user && sub.expired) {
        await users.updateOne({ userId }, { $set: { planId: 'gratis', planExpiresAt: null, updatedAt: current } });
      }
      const list = await readPlans();
      return {
        isAdmin: Boolean(user?.admin),
        plan: planById(list, sub.planId),
        planExpiresAt: isoDate(sub.planExpiresAt),
      };
    },
    async addLog(entry) {
      await logs.insert(entry);
      await logs.trim(200);
    },
    async listUsers() {
      const rows = await users.list();
      const list = [];
      const current = now();
      for (const row of rows) {
        const cards = await albums.get(row.userId);
        const sub = activeSubscription(row, current);
        if (sub.expired) {
          await users.updateOne({ userId: row.userId }, { $set: { planId: 'gratis', planExpiresAt: null, updatedAt: current } });
        }
        list.push({
          userId: row.userId,
          email: row.email || '',
          name: row.name || '',
          planId: sub.planId,
          planExpiresAt: isoDate(sub.planExpiresAt),
          admin: Boolean(row.admin),
          cards: sumCardQty(cards),
        });
      }
      return list;
    },
    async setUserPlan(userId, planId, months) {
      if (!PLAN_IDS.includes(planId)) httpError('Plan desconocido', 400);
      const user = await users.findOne({ userId });
      if (!user) httpError('Usuario no encontrado', 404);
      const current = now();
      let planExpiresAt = null;
      if (planId !== 'gratis') {
        const count = months === undefined || months === null || months === '' ? 1 : Number(months);
        if (!Number.isInteger(count) || count < 1 || count > MAX_PLAN_MONTHS) {
          httpError('Los meses tienen que estar entre 1 y 36', 400);
        }
        planExpiresAt = addMonths(current, count);
      }
      await users.updateOne({ userId }, { $set: { planId, planExpiresAt, updatedAt: current } });
      return { userId, planId, planExpiresAt: isoDate(planExpiresAt) };
    },
    async createCodes({ planId, months, count, createdBy }) {
      if (!codes) httpError('Códigos no disponibles', 500);
      if (!PLAN_IDS.includes(planId) || planId === 'gratis') httpError('Elige Colección o Tienda', 400);
      const span = Number(months);
      const howMany = count === undefined || count === null || count === '' ? 1 : Number(count);
      if (!Number.isInteger(span) || span < 1 || span > MAX_PLAN_MONTHS) {
        httpError('Los meses tienen que estar entre 1 y 36', 400);
      }
      if (!Number.isInteger(howMany) || howMany < 1 || howMany > 20) {
        httpError('Puedes generar entre 1 y 20 códigos', 400);
      }
      const created = [];
      const current = now();
      for (let i = 0; i < howMany; i += 1) {
        let stored = '';
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const candidate = generateCode();
          try {
            await codes.insertOne({
              code: candidate,
              planId,
              months: span,
              createdAt: current,
              createdBy: createdBy || '',
              redeemedAt: null,
              redeemedBy: '',
            });
            stored = candidate;
            break;
          } catch (err) {
            if (!err || err.code !== 11000) throw err;
          }
        }
        if (!stored) httpError('No se pudo generar el código', 500);
        created.push({ code: formatCode(stored), planId, months: span });
      }
      return created;
    },
    async listCodes() {
      if (!codes) return [];
      const rows = await codes.list(200);
      const known = new Map();
      for (const row of await users.list()) known.set(row.userId, row.email || '');
      return rows.map((row) => ({
        code: formatCode(row.code),
        planId: PLAN_IDS.includes(row.planId) ? row.planId : 'gratis',
        months: Number(row.months) || 0,
        createdAt: isoDate(row.createdAt),
        redeemedAt: isoDate(row.redeemedAt),
        redeemedBy: row.redeemedBy ? (known.get(row.redeemedBy) || '') : '',
      }));
    },
    async redeemCode(userId, rawCode) {
      if (!codes) httpError('Códigos no disponibles', 500);
      const code = normalizeCode(rawCode);
      if (!code) httpError('Ese código no es válido', 400);
      const user = await users.findOne({ userId });
      if (!user) httpError('Usuario no encontrado', 404);
      const current = now();
      const claimed = await codes.claim(code, userId, current);
      if (!claimed) httpError('Ese código no es válido o ya se usó', 400);
      try {
        const active = activeSubscription(user, current);
        const samePlan = active.planId === claimed.planId && active.planExpiresAt;
        const start = samePlan ? active.planExpiresAt : current;
        const planExpiresAt = addMonths(start, Number(claimed.months) || 0);
        await users.updateOne({ userId }, { $set: { planId: claimed.planId, planExpiresAt, updatedAt: current } });
        const list = await readPlans();
        return {
          isAdmin: Boolean(user.admin),
          plan: planById(list, claimed.planId),
          planExpiresAt: planExpiresAt.toISOString(),
        };
      } catch (err) {
        await codes.release(code);
        throw err;
      }
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
