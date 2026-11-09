import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFrame, detectQuad, warpCanonical, axisAlignedCard, decideMatch, searchTop } from '../scanner/new-scan.js';

function image(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

test('rechaza la bandeja vacía y el fogonazo', () => {
  const dark = image(80, 120, () => [0, 0, 0]);
  const flash = image(80, 120, () => [255, 255, 255]);
  assert.equal(validateFrame(dark, null).ok, false);
  assert.equal(validateFrame(flash, null).ok, false);
  assert.match(validateFrame(dark, null).message, /quieta/);
});

test('encuentra el borde y endereza a 504×704', () => {
  const card = image(240, 360, (x, y) => {
    const inside = x >= 40 && x < 180 && y >= 50 && y < 246;
    if (!inside) return [0, 0, 0];
    const n = ((x * 17 + y * 13) % 50) + 80;
    return [n, 40 + (x % 30), 30 + (y % 40)];
  });
  const gate = validateFrame(card, null);
  assert.equal(gate.ok, true, `nitidez ${gate.sharp} media ${gate.mean}`);
  const quad = detectQuad(card);
  assert.ok(quad, 'no vio el cuadrilátero');
  const warped = warpCanonical(card, quad);
  assert.equal(warped.width, 504);
  assert.equal(warped.height, 704);
  let bright = 0;
  const mid = (352 * 504 + 252) * 4;
  for (let c = 0; c < 3; c++) bright += warped.data[mid + c];
  assert.ok(bright > 60, 'el centro enderezado salió negro');
});

test('no confirma sin margen y nunca añade sola', () => {
  const weak = decideMatch({
    top: [{ id: 'a', score: 0.6 }, { id: 'b', score: 0.58 }],
    bordered: true,
    model: true,
    ocrIds: [],
  });
  assert.equal(weak.pendingId, null);
  assert.ok(weak.suggestionIds.length > 0);
  const strong = decideMatch({
    top: [{ id: 'a', score: 0.91 }, { id: 'b', score: 0.8 }],
    bordered: true,
    model: true,
    ocrIds: [],
  });
  assert.equal(strong.pendingId, 'a');
  const noBorder = decideMatch({
    top: [{ id: 'a', score: 0.95 }, { id: 'b', score: 0.4 }],
    bordered: false,
    model: true,
    ocrIds: [],
  });
  assert.equal(noBorder.pendingId, null);
  const reprint = decideMatch({
    top: [{ id: 'art', score: 0.84 }, { id: 'reprint', score: 0.83 }],
    bordered: true,
    model: true,
    ocrIds: ['reprint'],
  });
  assert.equal(reprint.pendingId, 'reprint');
  const byNumber = decideMatch({
    top: [{ id: 'sm8-228', score: 0.65 }, { id: 'otra', score: 0.6 }],
    bordered: true,
    model: true,
    ocrIds: ['swsh11-109'],
  });
  assert.equal(byNumber.pendingId, 'swsh11-109');
  assert.equal(byNumber.suggestionIds[0], 'sm8-228');
  assert.match(byNumber.message, /número/);
});

test('una carta a sangre se toma como la carta, no como un recorte', () => {
  const card = image(180, 250, () => [190, 150, 70]);
  const quad = axisAlignedCard(card);
  assert.ok(quad, 'no recortó la carta a sangre');
  const warped = warpCanonical(card, quad);
  assert.equal(warped.width, 504);
  assert.equal(warped.height, 704);
});

test('el coseno int8 no se parte dos veces por 127', () => {
  const dim = 4;
  const bytes = new Int8Array([127, 0, 0, 0]);
  const query = new Float32Array([3, 0, 0, 0]);
  const top = searchTop(query, bytes, ['sola'], dim, 1);
  assert.ok(Math.abs(top[0].score - 1) < 0.02, `score ${top[0].score}`);
});

test('la búsqueda int8 devuelve el vector plantado', () => {
  const dim = 128;
  const ids = ['una', 'otra', 'tercera'];
  const bytes = new Int8Array(ids.length * dim);
  for (let i = 0; i < dim; i++) bytes[dim + i] = i < 8 ? 127 : 0;
  const query = new Float32Array(dim);
  for (let i = 0; i < 8; i++) query[i] = 1;
  const top = searchTop(query, bytes, ids, dim, 2);
  assert.equal(top[0].id, 'otra');
  assert.ok(top[0].score > top[1].score);
});
