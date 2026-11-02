const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function normalizeCards(input) {
  const list = Array.isArray(input)
    ? input
    : input && Array.isArray(input.cards)
      ? input.cards
      : null;
  if (!list) {
    const err = new Error('El cuerpo debe ser { cards: [{ cardId, qty }] }');
    err.status = 400;
    throw err;
  }
  if (list.length > 20000) {
    const err = new Error('Demasiadas cartas');
    err.status = 400;
    throw err;
  }
  const byId = new Map();
  for (const row of list) {
    if (!row || typeof row !== 'object') {
      const err = new Error('Carta inválida');
      err.status = 400;
      throw err;
    }
    const cardId = String(row.cardId ?? '').trim();
    const qty = Number(row.qty);
    if (!CARD_ID.test(cardId) || !Number.isInteger(qty) || qty < 1 || qty > 99) {
      const err = new Error('cardId o qty inválidos');
      err.status = 400;
      throw err;
    }
    byId.set(cardId, qty);
  }
  return [...byId.entries()].map(([cardId, qty]) => ({ cardId, qty }));
}

export function pagesOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    const err = new Error('PAGES_ORIGIN no es una URL');
    err.status = 500;
    throw err;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    const err = new Error('PAGES_ORIGIN debe ser http o https');
    err.status = 500;
    throw err;
  }
  return url.origin;
}

export function userIdFromVerification(result) {
  if (!result || typeof result !== 'object') return null;
  if (Array.isArray(result.errors) && result.errors.length) return null;
  const payload = result.data && typeof result.data === 'object' ? result.data : result;
  return typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
}
