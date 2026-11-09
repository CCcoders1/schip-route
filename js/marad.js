// MARAD-import (Worklists-export) — pure functies, geen DOM. Ook bruikbaar in Node (tests / build).
// De app schrijft NIET terug naar MARAD: afgemelde taken komen in een export om zelf in MARAD in te voeren.

const clean = (v) => (v == null ? '' : String(v).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim());
const norm = (s) => clean(s).toLowerCase();

export function hash(s) { // FNV-1a 32-bit → base36
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

// dd/mm/yyyy (of dd-mm-yyyy, dd.mm.yyyy, yyyy-mm-dd, Excel-serial, Date) → 'yyyy-mm-dd'
export function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return iso(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === 'number' && v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 864e5)); return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
  const s = clean(v);
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return valid(y, +m[2], +m[1]); }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  return null;
}
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const valid = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? iso(y, m, d) : null);
// MARAD gebruikt ',' als duizendtal-scheiding ("128,185 hours", "1,000 hours") en '.' als decimaal ("0.00").
export const num = (v) => {
  if (typeof v === 'number') return v;
  let s = clean(v).replace(/\s*(hours?|uur|h)$/i, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  return s !== '' && !isNaN(s) ? +s : null;
};

// '1 weeks' / '3 months' / '500 hours' / '1 year' / '14 days' → { n, unit, text }
export function parseInterval(v) {
  const s = clean(v);
  const m = s.match(/(\d[\d,.]*)\s*(day|week|month|year|hour|uur|dag|wk|maand|jaar)/i);
  if (!m) return s ? { n: null, unit: null, text: s } : null;
  const u = m[2].toLowerCase();
  const unit = /^(day|dag)/.test(u) ? 'days' : /^(week|wk)/.test(u) ? 'weeks' : /^(month|maand)/.test(u) ? 'months' : /^(year|jaar)/.test(u) ? 'years' : 'hours';
  return { n: num(m[1]), unit, text: s };
}

const HEAD = {
  name: /^name$/i, jc: /^jc$/i, docs: /^docs$/i, image: /^image$/i, dueAt: /^due at$/i, week: /^week$/i,
  interval: /^interval$/i, dueIn: /^due in$/i, postponedUntil: /^postponed until$/i, postponedWith: /^postponed with$/i,
  duration: /^duration$/i, rank: /^rank$/i, taskType: /^task ?type$/i, costCode: /^cost ?code$/i, costs: /^costs$/i,
  dateRU: /^date\s*\/\s*ru$/i, daysAgo: /^days\s*\/\s*ru ago$/i,
};

/** rows: array van arrays (bijv. XLSX.utils.sheet_to_json(ws, {header:1, raw:false})).
 *  Geeft { ship, title, components: {id: {...}}, tasks: [...], warnings: [] } */
export function parseMarad(rows) {
  const warnings = [];
  let hi = rows.findIndex((r) => r && r.some((c) => HEAD.name.test(clean(c))) && r.some((c) => HEAD.dueAt.test(clean(c))));
  if (hi < 0) throw new Error('MARAD-kop niet gevonden (kolommen "Name" en "Due at").');
  const col = {}; let weeks = 0;
  rows[hi].forEach((c, i) => {
    const s = clean(c);
    for (const [k, re] of Object.entries(HEAD)) if (re.test(s)) {
      if (k === 'week') { col[weeks++ ? 'lastWeek' : 'dueWeek'] = i; } else if (col[k] == null) col[k] = i;
    }
  });
  const pre = rows.slice(0, hi).flat().map(clean).filter(Boolean);
  const title = pre[0] || '';
  const ship = pre[1] || '';
  const components = {}; const tasks = []; const seen = new Map();
  let exportInfo = '';
  let comp = null, last = null;
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const cells = row.map(clean);
    const compCell = cells.find((c) => /^component\s*:/i.test(c));
    if (compCell) {
      const path = compCell.replace(/^component\s*:\s*/i, '').split('»').map(clean).filter(Boolean);
      const id = 'c-' + hash(path.join(' » ').toLowerCase());
      const leaf = path[path.length - 1] || '';
      const m = leaf.match(/^([\d.]+)\s*-\s*(.*)$/);
      comp = components[id] ||= { id, path, code: m ? m[1] : '', name: m ? m[2] : leaf, group: path[0] || '' };
      last = null; continue;
    }
    const wcIdx = row.findIndex((c) => /^\s*work card\s*:/i.test(String(c ?? '')));
    if (wcIdx >= 0) {
      const txt = String(row[wcIdx]).replace(/\u00a0/g, ' ').replace(/^\s*work card\s*:\s*/i, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (last) last.workCard = txt; continue;
    }
    if (cells.some((c) => /^exported by marad/i.test(c))) { exportInfo = cells.filter(Boolean).join(' · '); continue; }
    let name = clean(row[col.name]);
    // robuust: taaknaam in een verschoven kolom (wel een vervaldatum/interval in de rij)
    if (!name && (clean(row[col.dueAt]) || parseInterval(row[col.interval])?.unit)) name = cells.slice(0, col.dueAt).find(Boolean) || '';
    if (!name) {
      // losse tekstregel onder een taak: opmerking bij laatste uitvoering ("Naam: tekst") of "Location work card: …"
      const note = cells.find(Boolean);
      if (last && note) (last.notes ||= []).push(note);
      continue;
    }
    if (!comp) { warnings.push(`Rij ${r + 1}: taak zonder component`); comp = components['c-none'] ||= { id: 'c-none', path: ['(zonder component)'], code: '', name: '(zonder component)', group: '(zonder component)' }; }
    const base = comp.path.join(' » ').toLowerCase() + '|' + name.toLowerCase();
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    const interval = parseInterval(row[col.interval]);
    const ru = row[col.dateRU];
    const hrs = interval?.unit === 'hours';
    const ruDate = hrs ? null : parseDate(ru);
    last = {
      id: 'm-' + hash(base + (n > 1 ? '#' + n : '')), source: 'marad', name, componentId: comp.id,
      dueDate: hrs ? null : parseDate(row[col.dueAt]), dueWeek: num(row[col.dueWeek]), interval,
      // draaiuren-taken: "Due at" = stand waarop hij vervalt, "Due in" = resterende uren, Date/RU = laatste stand
      dueRunHours: hrs ? num(row[col.dueAt]) : null,
      dueIn: hrs ? null : num(row[col.dueIn]), dueInHours: hrs ? num(row[col.dueIn]) : null, postponedUntil: parseDate(row[col.postponedUntil]),
      rank: clean(row[col.rank]).split(',').map(clean).filter(Boolean),
      taskType: clean(row[col.taskType]), costCode: clean(row[col.costCode]), duration: num(row[col.duration]),
      lastDone: ruDate, lastRunHours: hrs ? num(ru) : null, lastWeek: num(row[col.lastWeek]), daysAgo: num(row[col.daysAgo]),
      workCard: '', notes: [],
    };
    tasks.push(last);
  }
  if (!tasks.length) warnings.push('Geen taken gevonden.');
  return { ship, title, components, tasks, warnings, exportInfo };
}

// ---------- locatie-koppeling op trefwoorden ----------
const RULES = [
  ['l-emgen', /\bemerg\w*\b.*\b(gen|generator|harbour|diesel)|\bharbour gen|\bemergency (switch|power)/],
  ['l-boeg', /\bbow ?-?thruster|\bboegschroef/],
  ['l-co2', /\bco2\b|\bfm ?200\b|\bfire fighting systems w\/gas|\bhalon\b/],
  ['l-galley', /\bgall?e?y\b|\bmess ?room|\bkitchen\b|\bcooking\b|\bprovision|\bcold store|\bfridge|\bfreezer/],
  ['l-brug', /\bbridge\b|\bwheel ?house\b|\bnautical\b|\bnavigation\b|\bradar\b|\becdis\b|\bgmdss\b|\bvhf\b|\bais\b|\bcommunication\b|\bgyro|\bcompass/],
  ['l-mk-bal', /\bballast\b/],
  ['l-brug', /\bport state|\bvetting\b|\bpsc\b/],
  ['l-brug', /\b(fire|general|abandon ship|emergency) alarm|\balarm panel|\bfire detection/],
  ['l-achter', /\bgarbage|\bincinerat|\bwaste\b/],
  ['l-voor', /\bforebody|\bfore ?peak/],
  ['l-mk-hm', /\bhydraulic|\bhydr\./],
  ['l-mk-gen', /\bgenerator|\baggregat|\bae\b|\bpower production|\bswitchboard/],
  ['l-boeg', /\bbow\b/],
  ['l-mk-hm', /\bmain engine|\bpropulsion|\bgear ?box|\bdiesel engine|\bpropeller|\bshaft|\bengine|\bmachinery|\bcompressor|\bstarting air|\bfuel oil|\blube|\blubricat|\bcooling|\bbilge|\bpurif|\bseparator|\boil record|\boily water|\bboiler|\bpump|\bsea chest|\bexhaust|\bturbo/],
  ['l-ruim', /\bhold\b|\bholds\b|\bcargo\b|\bhatch|\bcoaming/],
  ['l-fc', /\bforecastle|\banchor|\bwindlass|\bchain locker|\bbak\b/],
  ['l-gw-sb', /\bgangway|\baccommodation ladder|\bpilot ladder/],
  ['l-toilet', /\btoilet|\bsanitary|\bsewage|\blaundry/],
  ['l-poop', /\bpoop\b|\bliferaft|\blife ?raft|\blifeboat|\brescue boat|\bdavit/],
  ['l-achter', /\bsteering gear|\brudder|\bstern\b|\baft\b|\bmooring winch(es)? aft/],
  ['l-voor', /\bfore\b|\bforward\b|\bdeck\b|\blights?\b|\blighting|\bmooring|\bwinch|\bcrane|\bmast\b|\bsignal/],
];
/** Geeft een locatie-id (uit de 16 standaardlocaties) of null. Kijkt eerst naar de taaknaam, dan componentpad van blad → stam. */
export function autoLocation(task, comp, knownIds) {
  const levels = [task.name, ...(comp ? [...comp.path].reverse() : [])];
  for (const lv of levels) {
    const s = norm(lv);
    for (const [id, re] of RULES) if (re.test(s) && (!knownIds || knownIds.has(id))) return id;
  }
  return null;
}

// ---------- datums / status ----------
export const todayISO = (d = new Date()) => iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
export function daysBetween(aISO, bISO) { return Math.round((Date.parse(bISO + 'T12:00:00Z') - Date.parse(aISO + 'T12:00:00Z')) / 864e5); }
export function addInterval(dateISO, iv) {
  if (!dateISO || !iv?.n || !iv.unit || iv.unit === 'hours') return null;
  const [y, m, d] = dateISO.split('-').map(Number);
  if (iv.unit === 'days' || iv.unit === 'weeks') { const x = new Date(Date.UTC(y, m - 1, d) + iv.n * (iv.unit === 'weeks' ? 7 : 1) * 864e5); return iso(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()); }
  const months = iv.unit === 'years' ? iv.n * 12 : iv.n;
  const tm = m - 1 + months; const ty = y + Math.floor(tm / 12); const mm = ((tm % 12) + 12) % 12;
  const dim = new Date(Date.UTC(ty, mm + 1, 0)).getUTCDate();
  return iso(ty, mm + 1, Math.min(d, dim));
}
export const isHours = (task) => task.interval?.unit === 'hours';
/** 'overdue' | 'week' | 'month' | 'later' | 'hours' (draaiuren zonder datum) | 'none' */
export function status(task, today = todayISO()) {
  if (isHours(task)) return task.dueInHours != null ? (task.dueInHours < 0 ? 'overdue' : 'hours') : 'hours';
  if (!task.dueDate) return 'none';
  const d = daysBetween(today, task.dueDate);
  return d < 0 ? 'overdue' : d <= 7 ? 'week' : d <= 30 ? 'month' : 'later';
}
export const dueInDays = (task, today = todayISO()) => (task.dueDate ? daysBetween(today, task.dueDate) : null);

// ---------- samenvoegen ----------
/** Voegt een parse-resultaat samen met bestaande onderhoudsdata (op component + naam).
 *  - nieuwe taken worden toegevoegd, bestaande bijgewerkt (vervaldatum, interval, rang, werkkaart…)
 *  - locatiekoppeling die de gebruiker zelf koos blijft staan
 *  - afmelding in de app die nieuwer is dan de laatste uitvoering volgens MARAD blijft leidend
 *  Geeft { maint, added, updated, unchanged } */
export function mergeMarad(maint, parsed, opts = {}) {
  const m = maint || { ship: '', tasks: [], components: {}, signoffs: [] };
  m.tasks ||= []; m.components ||= {}; m.signoffs ||= [];
  if (parsed.ship) m.ship = parsed.ship;
  if (parsed.fixedRounds) m.fixedRounds = parsed.fixedRounds;
  if (parsed.bundleRev) m.bundleRev = parsed.bundleRev; // vaste rondes (alleen uit de versleutelde bundel)
  Object.assign(m.components, parsed.components);
  const byId = new Map(m.tasks.map((x) => [x.id, x]));
  let added = 0, updated = 0, unchanged = 0;
  const now = opts.now || new Date().toISOString();
  for (const nt of parsed.tasks) {
    const cur = byId.get(nt.id);
    if (!cur) {
      const x = { ...nt, locId: opts.autoLoc ? opts.autoLoc(nt, parsed.components[nt.componentId]) : null, locManual: false, doneLog: [], importedAt: now, updatedAt: now };
      m.tasks.push(x); byId.set(x.id, x); added++; continue;
    }
    const appDone = cur.appDone; // { date, nextDue } van laatste afmelding in de app
    // MARAD heeft de afmelding al verwerkt als de laatste uitvoering (datum of urenstand) daar nieuwer is.
    const keepApp = appDone && (isHours(nt)
      ? !(nt.lastRunHours != null && nt.lastRunHours > (appDone.prevRunHours ?? -1))
      : (!nt.lastDone || nt.lastDone < appDone.date));
    const next = { ...nt };
    if (keepApp) for (const k of ['dueDate', 'lastDone', 'lastRunHours', 'dueRunHours', 'dueInHours']) next[k] = cur[k] ?? null;
    const fields = ['dueRunHours', 'dueInHours', 'dueDate', 'dueWeek', 'dueIn', 'postponedUntil', 'lastDone', 'lastRunHours', 'lastWeek', 'daysAgo', 'taskType', 'costCode', 'duration', 'workCard', 'notes'];
    const changed = fields.some((k) => JSON.stringify(cur[k] ?? null) !== JSON.stringify(next[k] ?? null)) || JSON.stringify(cur.interval) !== JSON.stringify(next.interval) || cur.rank.join() !== next.rank.join();
    Object.assign(cur, next, { locId: cur.locId, locManual: cur.locManual, doneLog: cur.doneLog || [], appDone: keepApp ? appDone : null, importedAt: now });
    if (!cur.locManual && !cur.locId && opts.autoLoc) cur.locId = opts.autoLoc(cur, parsed.components[cur.componentId]);
    if (changed) { cur.updatedAt = now; updated++; } else unchanged++;
  }
  m.importedAt = now; m.lastImport = { at: now, added, updated, unchanged, total: parsed.tasks.length, file: opts.file || '' };
  return { maint: m, added, updated, unchanged };
}

/** Taak afmelden in de app: zet laatste uitvoering en berekent de volgende vervaldatum (weken/maanden/dagen/jaren).
 *  Draaiuren-intervallen: alleen een volgende stand als runHours is ingevuld; geen datum. */
export function markDone(task, { date, by = '', remarks = '', runHours = null, runId = null, compText = '' }) {
  const d = date || todayISO();
  const prev = { dueDate: task.dueDate, lastDone: task.lastDone, lastRunHours: task.lastRunHours, dueRunHours: task.dueRunHours ?? null, dueInHours: task.dueInHours ?? null, appDone: task.appDone || null };
  task.lastDone = d;
  let nextDue = null, nextRunHours = null;
  if (isHours(task)) {
    task.dueInHours = null; // MARAD-stand is na afmelden niet meer geldig
    if (runHours != null && runHours !== '' && !isNaN(runHours)) { task.lastRunHours = +runHours; nextRunHours = +runHours + task.interval.n; task.dueRunHours = nextRunHours; }
    else task.dueRunHours = null;
    task.dueDate = null;
  } else {
    nextDue = addInterval(d, task.interval);
    task.dueDate = nextDue;
  }
  task.appDone = { date: d, nextDue, nextRunHours, prevRunHours: prev.lastRunHours ?? null };
  const entry = { id: 's-' + hash(task.id + d + Math.random()), taskId: task.id, component: compText, task: task.name, doneDate: d, by, remarks, runHours: runHours ?? null, nextDue, nextRunHours, runId, prev, enteredInMarad: false };
  (task.doneLog ||= []).push({ date: d, by, remarks, runHours, runId });
  return entry;
}
export function undoDone(task, entry) {
  Object.assign(task, entry.prev);
  task.doneLog = (task.doneLog || []).filter((x) => !(x.date === entry.doneDate && x.runId === entry.runId));
}
