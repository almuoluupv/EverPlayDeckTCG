import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from './app.js';

function listen(app) {
  const server = createServer((req, res) => {
    app(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(err.status || 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => server);
}

async function request(server, { method, path, origin, token, body }) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

test('la colección exige el origen de Pages y la sesión', async () => {
  const store = new Map();
  const app = createApp({
    pagesOrigin: 'http://127.0.0.1:43123',
    verifySession: async (token) => (token === 'buena' ? 'user_1' : token === 'otra' ? 'user_2' : null),
    store: {
      async get(userId) {
        return store.get(userId) || [];
      },
      async put(userId, cards) {
        store.set(userId, cards);
      },
    },
  });
  const server = await listen(app);
  try {
    const blocked = await request(server, {
      method: 'GET',
      path: '/api/collection',
      origin: 'https://otro.example',
      token: 'buena',
    });
    assert.equal(blocked.status, 403);

    const anon = await request(server, {
      method: 'GET',
      path: '/api/collection',
      origin: 'http://127.0.0.1:43123',
    });
    assert.equal(anon.status, 401);

    const empty = await request(server, {
      method: 'GET',
      path: '/api/collection',
      origin: 'http://127.0.0.1:43123',
      token: 'buena',
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, { cards: [] });
    assert.equal(empty.headers.get('access-control-allow-origin'), 'http://127.0.0.1:43123');

    const saved = await request(server, {
      method: 'PUT',
      path: '/api/collection',
      origin: 'http://127.0.0.1:43123',
      token: 'buena',
      body: { userId: 'user_2', cards: [{ cardId: 'A1-001', qty: 2 }] },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.cards, [{ cardId: 'A1-001', qty: 2 }]);
    assert.deepEqual(store.get('user_1'), [{ cardId: 'A1-001', qty: 2 }]);

    const other = await request(server, {
      method: 'GET',
      path: '/api/collection',
      origin: 'http://127.0.0.1:43123',
      token: 'otra',
    });
    assert.equal(other.status, 200);
    assert.deepEqual(other.json, { cards: [] });

    const otherSave = await request(server, {
      method: 'PUT',
      path: '/api/collection',
      origin: 'http://127.0.0.1:43123',
      token: 'otra',
      body: { userId: 'user_1', cards: [{ cardId: 'sv05-1', qty: 1 }] },
    });
    assert.equal(otherSave.status, 200);
    assert.deepEqual(store.get('user_2'), [{ cardId: 'sv05-1', qty: 1 }]);
    assert.deepEqual(store.get('user_1'), [{ cardId: 'A1-001', qty: 2 }]);
  } finally {
    server.close();
  }
});
