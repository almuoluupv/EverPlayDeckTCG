import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from './app.js';
import { createDirectory } from './directory.js';
import { createMemoryDirectoryDeps } from './memory.js';
import { addMonths, formatCode, normalizeCode } from './plans.js';

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

test('addMonths conserva el día y recorta fin de mes', () => {
  assert.equal(addMonths(new Date('2026-01-15T12:00:00.000Z'), 2).toISOString(), '2026-03-15T12:00:00.000Z');
  assert.equal(addMonths(new Date('2026-01-31T00:00:00.000Z'), 1).toISOString(), '2026-02-28T00:00:00.000Z');
  assert.equal(normalizeCode(' k7mp-q2rx '), 'K7MPQ2RX');
  assert.equal(formatCode('K7MPQ2RX'), 'K7MP-Q2RX');
  assert.equal(normalizeCode('OOOO-1111'), '');
});

test('un código de un solo uso cambia el plan hasta que vencen los meses', async () => {
  let now = new Date('2026-01-15T12:00:00.000Z');
  const directory = createDirectory({
    ...createMemoryDirectoryDeps(),
    adminEmail: 'dueno@example.com',
    now: () => now,
  });
  const app = createApp({
    pagesOrigin: 'https://almuoluupv.github.io',
    verifySession: async (token) => ({
      dueno: { userId: 'user_dueno', email: 'dueno@example.com', name: 'Dueño' },
      visitante: { userId: 'user_visitante', email: 'visita@example.com', name: 'Visita' },
      otro: { userId: 'user_otro', email: 'otro@example.com' },
    }[token] || null),
    store: directory,
  });
  const server = await listen(app);
  const origin = 'https://almuoluupv.github.io';
  try {
    const denied = await request(server, {
      method: 'POST',
      path: '/api/admin/codes',
      origin,
      token: 'visitante',
      body: { planId: 'tienda', months: 3, count: 1 },
    });
    assert.equal(denied.status, 403);
    assert.equal(JSON.stringify(denied.json).includes('K7'), false);

    const gratis = await request(server, {
      method: 'POST',
      path: '/api/admin/codes',
      origin,
      token: 'dueno',
      body: { planId: 'gratis', months: 1, count: 1 },
    });
    assert.equal(gratis.status, 400);

    const made = await request(server, {
      method: 'POST',
      path: '/api/admin/codes',
      origin,
      token: 'dueno',
      body: { planId: 'coleccion', months: 2, count: 2 },
    });
    assert.equal(made.status, 200);
    assert.equal(made.json.created.length, 2);
    assert.equal(made.json.created[0].months, 2);
    assert.equal(made.json.created[0].planId, 'coleccion');
    assert.match(made.json.created[0].code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const unused = made.json.codes.filter((row) => !row.redeemedAt);
    assert.equal(unused.length, 2);

    const bad = await request(server, {
      method: 'POST',
      path: '/api/redeem',
      origin,
      token: 'visitante',
      body: { code: 'ZZZZ-ZZZZ' },
    });
    assert.equal(bad.status, 400);

    const redeemed = await request(server, {
      method: 'POST',
      path: '/api/redeem',
      origin,
      token: 'visitante',
      body: { code: made.json.created[0].code.toLowerCase() },
    });
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.json.plan.id, 'coleccion');
    assert.equal(redeemed.json.plan.maxCards, 2000);
    assert.equal(redeemed.json.planExpiresAt, '2026-03-15T12:00:00.000Z');
    assert.equal(redeemed.json.isAdmin, false);

    const again = await request(server, {
      method: 'POST',
      path: '/api/redeem',
      origin,
      token: 'otro',
      body: { code: made.json.created[0].code },
    });
    assert.equal(again.status, 400);

    const stacked = await request(server, {
      method: 'POST',
      path: '/api/redeem',
      origin,
      token: 'visitante',
      body: { code: made.json.created[1].code },
    });
    assert.equal(stacked.status, 200);
    assert.equal(stacked.json.planExpiresAt, '2026-05-15T12:00:00.000Z');

    const album = await request(server, {
      method: 'GET',
      path: '/api/collection',
      origin,
      token: 'visitante',
    });
    assert.equal(album.json.plan.id, 'coleccion');
    assert.equal(album.json.planExpiresAt, '2026-05-15T12:00:00.000Z');

    const review = await request(server, {
      method: 'GET',
      path: '/api/admin',
      origin,
      token: 'dueno',
    });
    const used = review.json.codes.filter((row) => row.redeemedAt);
    assert.equal(used.length, 2);
    assert.equal(used.every((row) => row.redeemedBy === 'visita@example.com'), true);
    assert.equal(JSON.stringify(review.json.codes).includes('user_'), false);

    now = new Date('2026-05-15T12:00:00.001Z');
    const expired = await request(server, {
      method: 'GET',
      path: '/api/collection',
      origin,
      token: 'visitante',
    });
    assert.equal(expired.json.plan.id, 'gratis');
    assert.equal(expired.json.planExpiresAt, null);

    const over = await request(server, {
      method: 'PUT',
      path: '/api/collection',
      origin,
      token: 'visitante',
      body: { cards: [{ cardId: 'sv05-1', qty: 99 }, { cardId: 'sv05-2', qty: 52 }] },
    });
    assert.equal(over.status, 403);
    assert.match(over.json.error, /150 cartas/);
  } finally {
    server.close();
  }
});
