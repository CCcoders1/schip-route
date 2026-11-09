// Voorgestelde routes uit MARAD (pure functies, geen DOM; ook in Node bruikbaar).
// Groepen per functie (Rank) en interval: wekelijkse safety-ronde, wekelijkse machinekamerronde,
// wekelijkse/maandelijkse ronde per functie, draaiuren-onderhoud en achterstallig onderhoud.
import { status, isHours, todayISO } from './marad.js';

export const SAFETY_RE = /\b(safety|life ?(raft|boat|buoy|jacket|saving|line)|lsa\b|ffa\b|fire|extinguish|hydrant|hose|sprinkler|smoke|detect|alarm|breathing|scba|eebd|first aid|medical|medicine|emergenc|muster|rescue|immersion|survival|epirb|sart\b|co2\b|escape|fireman|evacuat|gas ?(detect|meter|monitor)|oxygen|stretcher|defibril|aed\b|pyrotech|flare|man overboard|mob\b|lifebuoy)/i;
export const MACH_RE = /\b(engine|machinery|generator|pump|compressor|purif|separator|boiler|bilge|fuel|lube|lubricat|cooling|exhaust|turbo|gear ?box|shaft|propul|thruster|hydraulic|steering|purifier|sewage|oily|incinerat|switchboard|battery|batteries|starting air|sea chest|valve|filter|tank)/i;

const ivDays = (iv) => (!iv?.n || !iv.unit || iv.unit === 'hours' ? null : iv.n * { days: 1, weeks: 7, months: 30.4, years: 365 }[iv.unit]);
export const isWeekly = (x) => { const d = ivDays(x.interval); return d != null && d <= 14; };
export const isMonthly = (x) => { const d = ivDays(x.interval); return d != null && d > 14 && d <= 31; };
const text = (x, comp) => [x.name, ...(comp?.path || [])].join(' » ');

/** Taken die in deze periode aan de beurt zijn. */
export function dueNow(kind, x, today = todayISO()) {
  const st = status(x, today);
  if (kind === 'overdue') return st === 'overdue';
  if (kind === 'hours') return st === 'overdue' || (x.dueInHours != null && x.interval?.n && x.dueInHours <= Math.max(50, x.interval.n * 0.1));
  if (kind === 'month') return st === 'overdue' || st === 'week' || st === 'month';
  return st === 'overdue' || st === 'week';
}

/** Definities. `ranks` = functies; een taak hoort bij de groep als hij minstens één van die functies heeft. */
function defs(ranks) {
  const out = [];
  const has = (r) => ranks.includes(r);
  const off = ['2nd Officer', 'Junior Officer'].filter(has);
  if (off.length) out.push({ kind: 'safety', period: 'week', ranks: off, test: (x, c) => isWeekly(x) && SAFETY_RE.test(text(x, c)) });
  const eng = ['Engineer', 'Junior engineer'].filter(has);
  if (eng.length) out.push({ kind: 'mk', period: 'week', ranks: eng, test: (x, c) => isWeekly(x) && (MACH_RE.test(text(x, c)) || /^[678]\b/.test(c?.group || '')) });
  for (const r of ranks) {
    out.push({ kind: 'week', period: 'week', ranks: [r], test: (x) => isWeekly(x) });
    out.push({ kind: 'month', period: 'month', ranks: [r], test: (x) => isMonthly(x) });
    out.push({ kind: 'hours', period: 'week', ranks: [r], test: (x) => isHours(x) });
    out.push({ kind: 'overdue', period: 'week', ranks: [r], test: (x) => status(x) === 'overdue' });
  }
  return out;
}
export const sugKey = (d) => d.kind + ':' + d.ranks.join('+');

/** Geeft [{ key, kind, period, ranks, tasks, due, overdue, nextDue, noLoc }] (lege of te kleine groepen weggelaten). */
export function suggestions(maint, { today = todayISO(), min = 2 } = {}) {
  if (!maint?.tasks) return [];
  const ranks = rankStats(maint).map((r) => r.rank);
  const res = [];
  for (const d of defs(ranks)) {
    const tasks = maint.tasks.filter((x) => x.rank.some((r) => d.ranks.includes(r)) && d.test(x, maint.components?.[x.componentId]));
    if (tasks.length < min) continue;
    const due = tasks.filter((x) => dueNow(d.kind, x, today));
    const dates = tasks.map((x) => x.dueDate).filter(Boolean).sort();
    res.push({ key: sugKey(d), kind: d.kind, period: d.period, ranks: d.ranks, tasks, due, overdue: tasks.filter((x) => status(x, today) === 'overdue').length, nextDue: dates.find((x) => x >= today) || dates[0] || null, noLoc: tasks.filter((x) => !x.locId).length });
  }
  // dubbele groepen (zelfde takenset) weglaten, bijzondere eerst
  const seen = new Set();
  return res.filter((s) => { const k = s.tasks.map((x) => x.id).sort().join(); if (seen.has(k)) return false; seen.add(k); return true; });
}
/** Taken van een groep opnieuw opzoeken (voor terugkerende sjablonen). */
export function findSuggestion(maint, key, opts) { return suggestions(maint, { ...opts, min: 0 }).find((s) => s.key === key) || null; }

/** Functies met aantallen: [{ rank, n, overdue }] gesorteerd op aantal. */
export function rankStats(maint) {
  const m = new Map();
  for (const x of maint?.tasks || []) for (const r of x.rank) { const o = m.get(r) || { rank: r, n: 0, overdue: 0 }; o.n++; if (status(x) === 'overdue') o.overdue++; m.set(r, o); }
  return [...m.values()].sort((a, b) => b.n - a.n || a.rank.localeCompare(b.rank));
}

/** Periodesleutel: week = ISO-jaar-week, maand = jjjj-mm. */
export function periodKey(period, d = new Date()) {
  if (period === 'month') return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return x.getUTCFullYear() + '-W' + String(Math.ceil(((x - y0) / 864e5 + 1) / 7)).padStart(2, '0');
}
