import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCards, pagesOrigin, userIdFromVerification } from './collection.js';

test('normalizeCards acepta el cuerpo { cards } y descarta duplicados', () => {
  const cards = normalizeCards({
    cards: [
      { cardId: 'sv05-12', qty: 1 },
      { cardId: 'A1-001', qty: 2 },
      { cardId: 'sv05-12', qty: 4 },
    ],
  });
  assert.deepEqual(cards, [
    { cardId: 'sv05-12', qty: 4 },
    { cardId: 'A1-001', qty: 2 },
  ]);
});

test('normalizeCards rechaza cantidades y cuerpos rotos', () => {
  assert.throws(() => normalizeCards({ nope: [] }), /cuerpo/);
  assert.throws(() => normalizeCards({ cards: [{ cardId: 'ok', qty: 0 }] }), /qty/);
  assert.throws(() => normalizeCards({ cards: [{ cardId: '../x', qty: 1 }] }), /cardId/);
});

test('pagesOrigin se queda con el origen', () => {
  assert.equal(pagesOrigin('https://alumno.github.io/album/'), 'https://alumno.github.io');
  assert.throws(() => pagesOrigin('github.io'), /URL/);
});

test('userIdFromVerification lee sub y un error de Clerk', () => {
  assert.equal(userIdFromVerification({ sub: 'user_1' }), 'user_1');
  assert.equal(userIdFromVerification({ data: { sub: 'user_2' } }), 'user_2');
  assert.equal(userIdFromVerification({ errors: [new Error('no')] }), null);
  assert.equal(userIdFromVerification(null), null);
});
