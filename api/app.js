import { normalizeCards } from './collection.js';

const MAX_BODY = 1_000_000;

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
    'access-control-allow-methods': 'GET, PUT, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-max-age': '600',
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
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

export function createApp({ pagesOrigin, verifySession, store }) {
  const origin = new URL(pagesOrigin).origin;
  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const cors = corsHeaders(req, origin);

    if (req.method === 'GET' && url.pathname === '/') {
      send(res, 200, { ok: true, service: 'album-api' });
      return;
    }

    if (req.method === 'OPTIONS' && url.pathname === '/api/collection') {
      if (!cors) {
        send(res, 403, { error: 'Origen no permitido' });
        return;
      }
      send(res, 204, undefined, cors);
      return;
    }

    if (url.pathname !== '/api/collection') {
      send(res, 404, { error: 'No encontrado' }, cors || {});
      return;
    }
    if (!cors) {
      send(res, 403, { error: 'Origen no permitido' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'PUT') {
      send(res, 405, { error: 'Método no permitido' }, cors);
      return;
    }

    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      send(res, 401, { error: 'Falta la sesión' }, cors);
      return;
    }
    const userId = await verifySession(token);
    if (!userId) {
      send(res, 401, { error: 'Sesión no válida' }, cors);
      return;
    }

    if (req.method === 'GET') {
      const cards = await store.get(userId);
      send(res, 200, { cards }, cors);
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
    await store.put(userId, cards);
    send(res, 200, { cards }, cors);
  };
}
