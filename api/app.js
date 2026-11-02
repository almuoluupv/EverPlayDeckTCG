import { createHash } from 'node:crypto';
import { normalizeCards } from './collection.js';
import { exceedsPlan, sanitizeClientError, sessionProfile } from './plans.js';

const MAX_BODY = 1_000_000;
const ERROR_BODY = 8_000;
const recentErrors = new Map();

function send(res, status, body, extra = {}) {
  const headers = { 'cache-control': 'no-store', ...extra };
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  headers['content-type'] = 'application/json; charset=utf-8';
  res.writeHead(status, headers);
  res.end(JSON.stringify(body ?? {}));
}

function corsHeaders(req, origin) {
  const requestOrigin = req.headers.origin;
  if (!requestOrigin || requestOrigin !== origin) return null;
  return {
    'access-control-allow-origin': requestOrigin,
    vary: 'Origin',
    'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '600',
  };
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        const err = new Error('Cuerpo demasiado grande');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function bearer(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function allowError(key) {
  const now = Date.now();
  const hits = (recentErrors.get(key) || []).filter((at) => now - at < 10 * 60 * 1000);
  if (hits.length >= 30) {
    recentErrors.set(key, hits);
    return false;
  }
  hits.push(now);
  recentErrors.set(key, hits);
  return true;
}

async function defaultAccount() {
  return { isAdmin: false, plan: { id: 'gratis', name: 'Gratis', maxCards: 150 } };
}

export function createApp({ pagesOrigin, verifySession, store }) {
  const origin = new URL(pagesOrigin).origin;

  async function accountOf(userId) {
    if (typeof store.account === 'function') return store.account(userId);
    return defaultAccount();
  }

  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const cors = corsHeaders(req, origin);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/') {
      send(res, 200, { ok: true, service: 'album-api' });
      return;
    }

    if (req.method === 'OPTIONS' && path.startsWith('/api/')) {
      if (!cors) {
        send(res, 403, { error: 'Origen no permitido' });
        return;
      }
      send(res, 204, undefined, cors);
      return;
    }

    if (!path.startsWith('/api/')) {
      send(res, 404, { error: 'No encontrado' }, cors || {});
      return;
    }
    if (!cors) {
      send(res, 403, { error: 'Origen no permitido' });
      return;
    }

    if (req.method === 'POST' && path === '/api/client-errors') {
      const token = bearer(req);
      const key = token
        ? `t:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`
        : `ip:${req.socket?.remoteAddress || 'local'}`;
      if (!allowError(key)) {
        send(res, 429, { error: 'Demasiados avisos' }, cors);
        return;
      }
      const raw = await readBody(req, ERROR_BODY);
      let parsed;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        send(res, 400, { error: 'JSON inválido' }, cors);
        return;
      }
      const clean = sanitizeClientError(parsed);
      if (!clean) {
        send(res, 400, { error: 'Aviso vacío' }, cors);
        return;
      }
      let userId = '';
      if (token) {
        const profile = sessionProfile(await verifySession(token));
        if (profile) {
          userId = profile.userId;
          if (typeof store.touch === 'function') await store.touch(profile);
        }
      }
      if (typeof store.addLog === 'function') {
        await store.addLog({ ...clean, userId, createdAt: new Date() });
      }
      send(res, 204, undefined, cors);
      return;
    }

    const profile = sessionProfile(await verifySession(bearer(req)));
    if (!bearer(req)) {
      send(res, 401, { error: 'Falta la sesión' }, cors);
      return;
    }
    if (!profile) {
      send(res, 401, { error: 'Sesión no válida' }, cors);
      return;
    }
    if (typeof store.touch === 'function') await store.touch(profile);

    if (path === '/api/collection') {
      if (req.method !== 'GET' && req.method !== 'PUT') {
        send(res, 405, { error: 'Método no permitido' }, cors);
        return;
      }
      const account = await accountOf(profile.userId);
      if (req.method === 'GET') {
        const cards = await store.get(profile.userId);
        send(res, 200, { cards, plan: account.plan, isAdmin: account.isAdmin }, cors);
        return;
      }
      const raw = await readBody(req);
      let parsed;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        send(res, 400, { error: 'JSON inválido' }, cors);
        return;
      }
      const cards = normalizeCards(parsed);
      const previous = await store.get(profile.userId);
      if (exceedsPlan(previous, cards, account.plan.maxCards)) {
        send(res, 403, {
          error: `Tu plan ${account.plan.name} permite guardar ${account.plan.maxCards} cartas.`,
        }, cors);
        return;
      }
      await store.put(profile.userId, cards);
      send(res, 200, { cards, plan: account.plan, isAdmin: account.isAdmin }, cors);
      return;
    }

    if (!path.startsWith('/api/admin')) {
      send(res, 404, { error: 'No encontrado' }, cors);
      return;
    }
    const account = await accountOf(profile.userId);
    if (!account.isAdmin) {
      send(res, 403, { error: 'No autorizado' }, cors);
      return;
    }

    if (req.method === 'GET' && path === '/api/admin') {
      const [plans, users, logs] = await Promise.all([
        store.getPlans(),
        store.listUsers(),
        store.listLogs(80),
      ]);
      send(res, 200, { plans, users, logs }, cors);
      return;
    }

    if (req.method === 'PUT' && path === '/api/admin/plans') {
      const raw = await readBody(req);
      let parsed;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        send(res, 400, { error: 'JSON inválido' }, cors);
        return;
      }
      const plans = await store.setPlanCaps(parsed.plans);
      send(res, 200, { plans }, cors);
      return;
    }

    if (req.method === 'PUT' && path === '/api/admin/users') {
      const raw = await readBody(req);
      let parsed;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        send(res, 400, { error: 'JSON inválido' }, cors);
        return;
      }
      const saved = await store.setUserPlan(String(parsed.userId || ''), String(parsed.planId || ''));
      send(res, 200, saved, cors);
      return;
    }

    send(res, 404, { error: 'No encontrado' }, cors);
  };
}
