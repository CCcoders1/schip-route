import { t } from './i18n.js';
// Volgorde-strategieën voor taken. Hier kan later verdere automatisering bij
// (bijv. op basis van onderhoudsintervallen, prioriteit of echte looproutes).
// Elke strategie: (steps, ctx) => nieuwe array met dezelfde stappen.
// ctx = { locations: Map(id -> loc), deckIndex: Map(deckId -> index van boven) }

const pos = (s, ctx) => {
  const l = ctx.locations.get(s.locationId);
  if (!l) return { x: 50, z: 0, d: 99 };
  return { x: l.x ?? 50, z: l.z ?? 30, d: ctx.deckIndex.get(l.deck) ?? 99 };
};

export const STRATEGIES = {
  perDek: {
    get label() { return t('Per gebied (lijstvolgorde), achter → voor'); },
    run: (steps, ctx) => [...steps].sort((a, b) => {
      const pa = pos(a, ctx), pb = pos(b, ctx);
      return pa.d - pb.d || pa.x - pb.x;
    }),
  },
  kortste: {
    get label() { return t('Kortste looproute (schatting)'); },
    // Nearest-neighbour; hoogteverschil (trappen) telt zwaarder dan lopen over de lengte.
    run: (steps, ctx, startIdx = 0) => {
      if (steps.length < 3) return [...steps];
      const rest = [...steps];
      const out = [rest.splice(startIdx, 1)[0]];
      const cost = (a, b) => { const p = pos(a, ctx), q = pos(b, ctx); return Math.abs(p.x - q.x) + Math.abs(p.z - q.z) * 1.5; };
      while (rest.length) {
        const last = out[out.length - 1];
        let bi = 0, bc = Infinity;
        rest.forEach((s, i) => { const c = cost(last, s); if (c < bc) { bc = c; bi = i; } });
        out.push(rest.splice(bi, 1)[0]);
      }
      return out;
    },
  },
};

// Slimme volgorde: elke locatie maar één keer bezoeken; machinekamer-onderlocaties als één blok.
// Richting: 'va' = van voor (boeg) naar achter (hek), 'av' = omgekeerd. x: 0 = hek, 100 = boeg.
const isERDeck = (d) => d && (d.id === 'mk' || /machinekamer|engine ?room/i.test(d.name || ''));
export function smartOrder(steps, ctx, dir = 'va') {
  const sign = dir === 'av' ? 1 : -1;
  const L = (s) => ctx.locations.get(s.locationId);
  const blockOf = (l) => (isERDeck(ctx.decks?.get(l.deck)) ? 'deck:' + l.deck : 'loc:' + l.id);
  const blocks = new Map();
  steps.forEach((s, i) => {
    const l = L(s); const k = l ? blockOf(l) : 'none';
    if (!blocks.has(k)) blocks.set(k, { k, xs: [], locs: new Map() });
    const b = blocks.get(k);
    const lk = l ? l.id : 'none';
    if (l && !b.locs.has(lk)) b.xs.push(l.x ?? 50); // gemiddelde over de locaties (niet per taak)
    if (!b.locs.has(lk)) b.locs.set(lk, { x: l ? l.x ?? 50 : 0, z: l ? l.z ?? 0 : 0, first: i, steps: [] });
    b.locs.get(lk).steps.push(s);
  });
  const avg = (b) => (b.xs.length ? b.xs.reduce((a, x) => a + x, 0) / b.xs.length : null);
  const bs = [...blocks.values()].sort((a, b) => (a.k === 'none') - (b.k === 'none') || sign * (avg(a) - avg(b)));
  return bs.flatMap((b) => [...b.locs.values()].sort((a, c) => sign * (a.x - c.x) || a.z - c.z || a.first - c.first).flatMap((l) => l.steps));
}
STRATEGIES.slimVA = { get label() { return t('🧭 Slimme volgorde: voor → achter'); }, run: (steps, ctx) => smartOrder(steps, ctx, 'va') };
STRATEGIES.slimAV = { get label() { return t('🧭 Slimme volgorde: achter → voor'); }, run: (steps, ctx) => smartOrder(steps, ctx, 'av') };

export function makeCtx(state) {
  return {
    locations: new Map(state.locations.map((l) => [l.id, l])),
    deckIndex: new Map(state.decks.map((d, i) => [d.id, i])),
    decks: new Map(state.decks.map((d) => [d.id, d])),
  };
}
export function orderSteps(steps, state, strategy) {
  const s = STRATEGIES[strategy];
  return s ? s.run(steps, makeCtx(state)) : [...steps];
}
