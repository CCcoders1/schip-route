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

export function makeCtx(state) {
  return {
    locations: new Map(state.locations.map((l) => [l.id, l])),
    deckIndex: new Map(state.decks.map((d, i) => [d.id, i])),
  };
}
export function orderSteps(steps, state, strategy) {
  const s = STRATEGIES[strategy];
  return s ? s.run(steps, makeCtx(state)) : [...steps];
}
