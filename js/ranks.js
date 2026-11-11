// Rangen (functies). Interne id's = de Engelse MARAD-namen + 'Stagiair'.
// 'Junior Officer' heet in de app '2nd Officer': taken met die tag horen gewoon bij 2nd Officer (alias, alleen in de JS-laag).
import { t } from './i18n.js';

export const RANK_IDS = ['Master', 'Chief Officer', '2nd Officer', 'Engineer', 'Junior engineer', 'Marof', 'Bosun', 'Stagiair'];
// v1.18: Bosun (ID: Serang) – geen eigen MARAD-functie in de gegevens; krijgt lijstjes zoals de andere rangen.
export const NO_MARAD = ['Bosun', 'Stagiair'];
export const MARAD_RANKS = RANK_IDS.filter((r) => !NO_MARAD.includes(r));
const ALIAS = { 'junior officer': '2nd Officer', '2nd officer': '2nd Officer', 'second officer': '2nd Officer', master: 'Master', 'chief officer': 'Chief Officer', engineer: 'Engineer', 'junior engineer': 'Junior engineer', marof: 'Marof', stagiair: 'Stagiair', bosun: 'Bosun', boatswain: 'Bosun', serang: 'Bosun', bootsman: 'Bosun', trainee: 'Stagiair', magang: 'Stagiair' };
export const RANK_ICON = { Master: '⚓', 'Chief Officer': '🧭', '2nd Officer': '🗺', Engineer: '🔧', 'Junior engineer': '🔩', Marof: '🪢', Bosun: '⚒️', Stagiair: '🎓' };

/** Eén rang normaliseren ('Junior Officer' → '2nd Officer'); onbekende namen blijven zoals ze zijn. */
export const normRank = (r) => (r == null ? r : ALIAS[String(r).trim().toLowerCase()] || String(r).trim());
/** Lijst normaliseren + ontdubbelen (een taak met beide tags telt één keer). */
export const normRanks = (xs) => [...new Set((xs || []).map(normRank).filter(Boolean))];

/** Gelokaliseerde rangnaam. */
export function rankLabel(r) {
  const id = normRank(r);
  const L = { Master: t('Kapitein'), 'Chief Officer': t('1e stuurman'), '2nd Officer': t('2e stuurman'), Engineer: t('Machinist'), 'Junior engineer': t('Junior machinist'), Marof: t('Marof'), Bosun: t('Bosun'), Stagiair: t('Stagiair') };
  return L[id] || id || '';
}
export const rankLabels = (xs) => normRanks(xs).map(rankLabel).join(', ');

/** MARAD-gegevens in het geheugen normaliseren (taken + vaste rondes). Idempotent. */
export function normMaint(m) {
  if (!m?.tasks) return m;
  for (const x of m.tasks) if (Array.isArray(x.rank)) x.rank = normRanks(x.rank);
  for (const d of m.fixedRounds || []) if (Array.isArray(d.ranks)) d.ranks = normRanks(d.ranks);
  return m;
}
