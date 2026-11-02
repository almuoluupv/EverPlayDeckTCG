export const PLAN_IDS = ['gratis', 'coleccion', 'tienda'];

export const DEFAULT_PLANS = [
  { id: 'gratis', name: 'Gratis', maxCards: 150 },
  { id: 'coleccion', name: 'Colección', maxCards: 2000 },
  { id: 'tienda', name: 'Tienda', maxCards: 20000 },
];

export function sumCardQty(cards) {
  if (!Array.isArray(cards)) return 0;
  return cards.reduce((total, row) => total + (row && Number.isInteger(row.qty) ? row.qty : 0), 0);
}

export function exceedsPlan(previous, next, maxCards) {
  const max = Number(maxCards);
  if (!Number.isInteger(max) || max < 1) return false;
  const after = sumCardQty(next);
  return after > max && after > sumCardQty(previous);
}

export function mergePlans(saved) {
  const byId = new Map();
  if (Array.isArray(saved)) {
    for (const row of saved) {
      if (row && PLAN_IDS.includes(row.id)) byId.set(row.id, row);
    }
  }
  return DEFAULT_PLANS.map((plan) => {
    const row = byId.get(plan.id);
    const max = row ? Number(row.maxCards) : plan.maxCards;
    const maxCards = Number.isInteger(max) && max >= 1 && max <= 100000 ? max : plan.maxCards;
    return { id: plan.id, name: plan.name, maxCards };
  });
}

export function planById(plans, id) {
  const list = mergePlans(plans);
  return list.find((plan) => plan.id === id) || list[0];
}

export function sessionProfile(value) {
  if (!value) return null;
  if (typeof value === 'string' && value) {
    return { userId: value, email: '', name: '', markedAdmin: false };
  }
  if (typeof value !== 'object' || typeof value.userId !== 'string' || !value.userId) return null;
  return {
    userId: value.userId,
    email: String(value.email || '').trim().toLowerCase(),
    name: String(value.name || '').trim().slice(0, 120),
    markedAdmin: value.markedAdmin === true,
  };
}

export function scrubLogText(value, max = 500) {
  let text = String(value ?? '');
  text = text.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[imagen]');
  text = text.replace(/__clerk_db_jwt=[^&\s#]+/gi, '__clerk_db_jwt=[omitido]');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [omitido]');
  text = text.replace(/\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]+\b/g, '[clave]');
  text = text.replace(/mongodb(?:\+srv)?:\/\/\S+/gi, 'mongodb://[omitido]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[jwt]');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, max);
}

export function sanitizeClientError(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const message = scrubLogText(input.message, 400);
  if (!message) return null;
  return {
    message,
    source: scrubLogText(input.source || 'cliente', 60) || 'cliente',
    stack: scrubLogText(input.stack || '', 1200),
    path: scrubLogText(input.path || '', 180),
  };
}
