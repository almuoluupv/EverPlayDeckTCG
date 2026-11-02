import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from './app.js';
import { createDirectory } from './directory.js';
import { createMemoryDirectoryDeps } from './memory.js';
import { scrubLogText } from './plans.js';

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
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function appWith({ adminEmail = '', sessions }) {
  const directory = createDirectory({ ...createMemoryDirectoryDeps(), adminEmail });
  const app = createApp({
    pagesOrigin: 'https://almuoluupv.github.io',
    verifySession: async (token) => sessions[token] || null,
    store: directory,
  });
  return { app, directory };
}

test('el primer usuario no es admin si ADMIN_EMAIL apunta a otro correo', async () => {
  const { app } = appWith({
    adminEmail: 'dueno@example.com',
    sessions: {
      visitante: { userId: 'user_visitante', email: 'otra@example.com' },
      dueno: { userId: 'user_dueno', email: 'Dueno@Example.com', name: 'Dueño' },
    },
  });
  const server = await listen(app);
  try {
    const stranger = await request(server, {
      method: 'GET',
      path: '/api/admin',
      origin: 'https://almuoluupv.github.io',
      token: 'visitante',
    });
    assert.equal(stranger.status, 403);
    assert.equal(JSON.stringify(stranger.json).includes('user_'), false);

    const owner = await request(server, {
      method: 'GET',
      path: '/api/admin',
      origin: 'https://almuoluupv.github.io',
      token: 'dueno',
    });
    assert.equal(owner.status, 200);
    assert.equal(owner.json.users.length, 2);
    assert.equal(owner.json.plans.length, 3);
    assert.equal(owner.json.users.find((row) => row.userId === 'user_dueno').admin, true);
    assert.equal(owner.json.users.find((row) => row.userId === 'user_visitante').planId, 'gratis');

    const caps = await request(server, {
      method: 'PUT',
      path: '/api/admin/plans',
      origin: 'https://almuoluupv.github.io',
      token: 'dueno',
      body: {
        plans: [
          { id: 'gratis', maxCards: 2 },
          { id: 'coleccion', maxCards: 20 },
          { id: 'tienda', maxCards: 200 },
        ],
      },
    });
    assert.equal(caps.status, 200);
    assert.equal(caps.json.plans[0].maxCards, 2);

    const denied = await request(server, {
      method: 'PUT',
      path: '/api/admin/plans',
      origin: 'https://almuoluupv.github.io',
      token: 'visitante',
      body: { plans: caps.json.plans },
    });
    assert.equal(denied.status, 403);

    const over = await request(server, {
      method: 'PUT',
      path: '/api/collection',
      origin: 'https://almuoluupv.github.io',
      token: 'visitante',
      body: { cards: [{ cardId: 'sv05-1', qty: 2 }, { cardId: 'sv05-2', qty: 1 }] },
    });
    assert.equal(over.status, 403);
    assert.match(over.json.error, /2 cartas/);

    const ok = await request(server, {
      method: 'PUT',
      path: '/api/collection',
      origin: 'https://almuoluupv.github.io',
      token: 'visitante',
      body: { cards: [{ cardId: 'sv05-1', qty: 2 }] },
    });
    assert.equal(ok.status, 200);

    const promoted = await request(server, {
      method: 'PUT',
      path: '/api/admin/users',
      origin: 'https://almuoluupv.github.io',
      token: 'dueno',
      body: { userId: 'user_visitante', planId: 'coleccion' },
    });
    assert.equal(promoted.status, 200);

    const larger = await request(server, {
      method: 'PUT',
      path: '/api/collection',
      origin: 'https://almuoluupv.github.io',
      token: 'visitante',
      body: { cards: [{ cardId: 'sv05-1', qty: 2 }, { cardId: 'sv05-2', qty: 1 }] },
    });
    assert.equal(larger.status, 200);

    const logged = await request(server, {
      method: 'POST',
      path: '/api/client-errors',
      origin: 'https://almuoluupv.github.io',
      token: 'visitante',
      body: {
        message: 'falló Bearer sk_test_supersecret data:image/png;base64,AAAA',
        source: 'guardar',
        stack: 'mongodb+srv://user:password@cluster.example/album',
        path: '/EverPlayDeckTCG/',
      },
    });
    assert.equal(logged.status, 204);

    const review = await request(server, {
      method: 'GET',
      path: '/api/admin',
      origin: 'https://almuoluupv.github.io',
      token: 'dueno',
    });
    const entry = review.json.logs[0];
    assert.equal(entry.userId, 'user_visitante');
    assert.equal(entry.message.includes('sk_test_'), false);
    assert.equal(entry.message.includes('base64'), false);
    assert.equal(entry.stack.includes('password'), false);
    assert.equal(review.json.users.find((row) => row.userId === 'user_visitante').cards, 3);
  } finally {
    server.close();
  }
});

test('sin ADMIN_EMAIL el primer usuario que entra queda como admin', async () => {
  const { app } = appWith({
    sessions: {
      primero: { userId: 'user_primero', email: 'primero@example.com' },
      segundo: { userId: 'user_segundo', email: 'segundo@example.com' },
    },
  });
  const server = await listen(app);
  try {
    const first = await request(server, {
      method: 'GET',
      path: '/api/collection',
      origin: 'https://almuoluupv.github.io',
      token: 'primero',
    });
    assert.equal(first.json.isAdmin, true);
    const second = await request(server, {
      method: 'GET',
      path: '/api/admin',
      origin: 'https://almuoluupv.github.io',
      token: 'segundo',
    });
    assert.equal(second.status, 403);
  } finally {
    server.close();
  }
});

test('un usuario marcado en Clerk es admin aunque el correo no coincida', async () => {
  const { app } = appWith({
    adminEmail: 'otro@example.com',
    sessions: {
      marcado: { userId: 'user_marcado', email: 'google@example.com', markedAdmin: true },
    },
  });
  const server = await listen(app);
  try {
    const res = await request(server, {
      method: 'GET',
      path: '/api/admin',
      origin: 'https://almuoluupv.github.io',
      token: 'marcado',
    });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test('scrubLogText quita imágenes, jwt y claves', () => {
  const text = scrubLogText('fallo data:image/webp;base64,QUJD eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature pk_test_abc');
  assert.equal(text.includes('QUJD'), false);
  assert.equal(text.includes('eyJ'), false);
  assert.equal(text.includes('pk_test_'), false);
  assert.match(text, /fallo/);
});
