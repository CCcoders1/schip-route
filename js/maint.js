// Onderhoud (MARAD): overzicht als boom/lijst, koppeling aan locaties, route maken, afmelden.
// Belangrijk: de app schrijft NIET terug naar MARAD. Afmeldingen gaan naar de export "Afgemeld voor MARAD".
import { t, getLang, LOCALES } from './i18n.js';
import { parseMarad, mergeMarad, autoLocation, status, dueInDays, isHours, markDone, undoDone, todayISO, parseDate } from './marad.js';
import { suggestions, findSuggestion, rankStats, periodKey, fixedRounds } from './suggest.js';
import { normMaint, normRank, rankLabel, rankLabels, MARAD_RANKS, RANK_IDS } from './ranks.js';

let A; // helpers uit app.js
const F = { view: 'tree', st: 'all', loc: '', q: '' };
const sel = new Set();
const open = new Set();
let preview = null; // import in voorbereiding
let loaded = false, loading = null, busy = false;
const OBK = () => self.OutboxCore.kv;
const S = () => { A.save(); persist(); };
let pt = null;
/** Lokale MARAD-kopie naar IndexedDB (nooit localStorage). */
export function persist() {
  clearTimeout(pt);
  pt = setTimeout(() => { const m = M(); (m ? OBK().put('maint', m) : OBK().del('maint')).catch((e) => console.warn('MARAD opslaan', e)); }, 250);
}

const ORDER = { overdue: 0, week: 1, month: 2, later: 3, hours: 4, none: 5 };
const M = () => A.state.maint;
const comp = (task) => M()?.components?.[task.componentId];
const compText = (c) => (c ? c.path.join(' » ') : '');
const fmtD = (iso) => (iso ? new Date(iso + 'T12:00:00').toLocaleDateString(LOCALES[getLang()], { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fmtN = (n) => (n == null ? '—' : Number(n).toLocaleString(LOCALES[getLang()]));
const ddmmyyyy = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

export function ivText(iv) {
  if (!iv) return '—';
  if (!iv.n || !iv.unit) return iv.text || '—';
  if (iv.unit === 'hours') return t('op draaiuren (elke {n} u)', { n: fmtN(iv.n) });
  const U = { days: [t('dag'), t('dagen')], weeks: [t('week'), t('weken')], months: [t('maand'), t('maanden')], years: [t('jaar'), t('jaren')] }[iv.unit];
  return t('elke {n} {u}', { n: iv.n, u: iv.n === 1 ? U[0] : U[1] });
}
function dueText(task) {
  if (isHours(task)) {
    if (task.dueInHours == null) return task.appDone ? t('op draaiuren – urenstand invullen') : t('op draaiuren');
    return task.dueInHours < 0 ? t('{n} u te laat (MARAD)', { n: fmtN(-task.dueInHours) }) : t('nog {n} u (MARAD)', { n: fmtN(task.dueInHours) });
  }
  const d = dueInDays(task);
  if (d == null) return '—';
  return d < 0 ? t('{n} d te laat', { n: -d }) : d === 0 ? t('vandaag') : t('over {n} d', { n: d });
}
const STL = () => ({ overdue: t('Te laat'), week: t('Binnen 7 dagen'), month: t('Binnen 30 dagen'), later: t('Later'), hours: t('Op draaiuren'), none: t('Geen datum') });
const dot = (st) => `<span class="dot ${st}" title="${STL()[st]}"></span>`;
const sortKey = (x) => { const st = status(x); if (isHours(x)) return [ORDER[st] === 0 ? '0000' : '9998', x.name]; return [x.dueDate || '9999', x.name]; };
const byDue = (a, b) => { const ka = sortKey(a), kb = sortKey(b); return ka[0].localeCompare(kb[0]) || ka[1].localeCompare(kb[1]); };

export function initMaint(api) {
  A = api;
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('toggle', (e) => { const d = e.target; if (d.dataset?.node) { if (d.open) open.add(d.dataset.node); else open.delete(d.dataset.node); } }, true);
  $f('#fileMarad')?.addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) readFile(f); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'mPw') { e.preventDefault(); actions.mUnlock(); } });
  if (A.legacyMaint) migrateLegacy(A.legacyMaint);
  return { distLists, distRoute, tacticalOrder, byUrgency, rankOverview, rankRoundsHTML, view, actions, applyRun, applyPending, ensureMaint, runExtra, maradFields, persist, refreshTemplates, rankNames, templateInfo, sugCount, todayHTML, weekBoard, startFixed, needsReunlock, slimDefault, weekStats };
}
const $f = (s) => document.querySelector(s);

// ---------- data ----------
const knownLocIds = () => new Set(A.state.locations.map((l) => l.id));
const autoLoc = (task, c) => { const ids = knownLocIds(); return autoLocation(task, c, ids) || (task.locHint && ids.has(task.locHint) ? task.locHint : null); };
/** Versie van de versleutelde bundel die bij deze app hoort (vaste rondes + locatie-hints). */
export const BUNDLE_REV = 3;
export const needsReunlock = () => !!M()?.tasks && M().source === 'encrypted' && (M().bundleRev || 1) < BUNDLE_REV;
export const slimDefault = () => (A.state.settings.orderDir === 'av' ? 'slimAV' : 'slimVA');
// v1.3 bewaarde (onversleutelde begindata) in localStorage. Alleen bewaren als de gebruiker er zelf iets mee deed.
async function migrateLegacy(lm) {
  const own = !lm.initial || lm.signoffs?.length || lm.tasks?.some((x) => x.locManual || x.appDone);
  try { if (own && !(await OBK().get('maint'))) await OBK().put('maint', lm); } catch (e) { console.warn(e); }
  A.save(); // localStorage herschrijven zonder MARAD-gegevens
}
/** Laadt de lokale MARAD-kopie uit IndexedDB (als die er is). Zonder kopie: ontgrendelscherm of handmatige import. */
export function ensureMaint() {
  if (loaded) return Promise.resolve(M());
  return (loading ||= (async () => {
    try { const m = await OBK().get('maint'); if (m?.tasks && !A.state.maint) A.state.maint = normMaint(m); } catch (e) { console.warn('MARAD laden', e); }
    loaded = true;
    if (M()?.tasks) { relink(); afterLoad(false); }
    return M();
  })());
}

// nieuwe trefwoordregels ook toepassen op taken die nog geen locatie hebben (niet handmatig gekozen)
function relink() { let n = 0; for (const x of M().tasks) if (!x.locId && !x.locManual) { const l = autoLoc(x, comp(x)); if (l) { x.locId = l; n++; } } if (n) persist(); }
/** Na laden/ontgrendelen: wachtende rapporten afmelden en terugkerende sjablonen verversen. */
function afterLoad(announce = true) {
  const p = applyPending();
  const n = refreshTemplates();
  if (announce || n || p) { const msg = [p ? t('{n} MARAD-taken uit ontvangen rapporten afgemeld', { n: p }) : '', n ? t('🔁 {n} sjabloon-route(s) ververst', { n }) : ''].filter(Boolean).join(' · '); if (msg) setTimeout(() => A.toast(msg, 4000), 400); }
}
/** Rapporten die binnenkwamen toen MARAD vergrendeld was alsnog afmelden (dubbel wordt overgeslagen). */
export function applyPending() {
  if (!M()?.tasks) return 0; let n = 0;
  for (const run of A.state.runs) if (run.received && !run.maradApplied && run.results?.some((r) => r.marad || (r.fields || []).some((f) => f.type === 'oil' || f.type === 'oilinv'))) { const r = applyRun(run); run.maradDone = (run.maradDone || 0) + r.done; run.maradApplied = true; n += r.done; }
  if (n) A.save();
  return n;
}

// ---------- versleutelde meegeleverde export ----------
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function decryptBundle(enc, pw) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: enc.kdf.hash, salt: unb64(enc.kdf.salt), iterations: enc.kdf.iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(enc.iv) }, key, unb64(enc.ct)); // gooit bij fout wachtwoord
  let bytes = new Uint8Array(plain);
  if (enc.zip === 'gzip') bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return JSON.parse(new TextDecoder().decode(bytes));
}
const FKEY = 'schiproute.unlock';
const fails = () => { try { return JSON.parse(localStorage.getItem(FKEY)) || { n: 0 }; } catch { return { n: 0 }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function unlockHTML() {
  return `<section class="card unlock"><h2>${t('🔐 Voer wachtwoord in')}</h2><p class="muted">${t('De volledige MARAD-export zit versleuteld in de app. Na ontgrendelen staan de gegevens alleen op dit toestel en werken ze ook offline.')}</p>
    <input type="password" id="mPw" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${t('Wachtwoord')}" placeholder="${t('Wachtwoord')}">
    <p class="err" id="mPwErr" hidden></p>
    <button class="btn primary big" data-act="mUnlock" id="mPwBtn">${t('🔓 Ontgrendelen')}</button>
    <p class="muted small">${t('of')}</p><button class="btn" data-act="mImport">${t('📥 Zelf een MARAD-export importeren (.xlsx/.csv)')}</button></section>`;
}

async function loadXLSX() {
  if (self.XLSX) return self.XLSX;
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = './vendor/xlsx.mini.min.js'; s.onload = res; s.onerror = () => rej(new Error('SheetJS niet geladen')); document.head.appendChild(s); });
  return self.XLSX;
}
async function readFile(file) {
  try {
    const X = await loadXLSX();
    const buf = await file.arrayBuffer();
    let wb;
    if (/\.(csv|txt)$/i.test(file.name) || /csv|text\/plain/.test(file.type)) {
      // CSV: zelf decoderen (UTF-8, anders Windows-1252) zodat », – en ’ goed blijven.
      let txt; try { txt = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { txt = new TextDecoder('windows-1252').decode(buf); }
      wb = X.read(txt.replace(/^\ufeff/, ''), { type: 'string', raw: true });
    } else wb = X.read(buf, { type: 'array', raw: false });
    const name = wb.SheetNames.find((n) => /worklist/i.test(n)) || wb.SheetNames[0];
    const rows = X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: null });
    const parsed = parseMarad(rows);
    const dry = mergeMarad(JSON.parse(JSON.stringify(M() || null)), parsed, { autoLoc, file: file.name });
    preview = { parsed, file: file.name, dry };
    importSheet();
  } catch (e) {
    console.warn(e); A.toast(t('Kon het bestand niet lezen: {msg}', { msg: e.message }), 5000);
  }
}
function importSheet() {
  const m = M(); const li = m?.lastImport;
  let h = `<h2>${t('📥 MARAD-import')}</h2>`;
  h += `<p class="muted">${t('Exporteer in MARAD de Worklist (Excel) en kies dat bestand hier (.xlsx of .csv). Bestaande taken worden bijgewerkt (vervaldatum, interval, werkkaart), nieuwe toegevoegd. Niets wordt dubbel.')}</p>`;
  if (preview) {
    const p = preview.parsed, d = preview.dry;
    const dates = p.tasks.map((x) => x.dueDate).filter(Boolean).sort();
    const shipWarn = p.ship && A.state.shipName && p.ship.toLowerCase() !== A.state.shipName.toLowerCase();
    h += `<div class="card"><h3>${A.esc(preview.file)}</h3><p>🚢 <b>${A.esc(p.ship || '?')}</b></p>
      <p>${t('{n} taken · {c} componenten', { n: p.tasks.length, c: Object.keys(p.components).length })}</p>
      ${dates.length ? `<p>${t('Vervaldatums {a} – {b}', { a: fmtD(dates[0]), b: fmtD(dates[dates.length - 1]) })}</p>` : ''}
      <p><span class="tag ok">+ ${d.added} ${t('nieuw')}</span> <span class="tag">↻ ${d.updated} ${t('bijgewerkt')}</span> <span class="tag">= ${d.unchanged} ${t('ongewijzigd')}</span></p>
      ${shipWarn ? `<p class="warnbox">${t('Let op: dit bestand is van een ander schip ({ship}).', { ship: A.esc(p.ship) })}</p>` : ''}
      ${p.warnings.length ? `<p class="warnbox">${p.warnings.slice(0, 5).map(A.esc).join('<br>')}</p>` : ''}</div>
      <div class="stack"><button class="btn primary big" data-act="mDoImport">${t('Importeren')}</button><button class="btn ghost" data-act="mPickFile">${t('Ander bestand kiezen')}</button></div>`;
  } else {
    h += `<div class="stack"><button class="btn primary big" data-act="mPickFile">${t('Bestand kiezen (.xlsx / .csv)')}</button></div>`;
  }
  if (li) h += `<p class="muted small">${t('Laatste import: {file} · {date} · {n} taken', { file: A.esc(li.file || '—'), date: A.fmtDT(li.at), n: li.total })}${m.source === 'encrypted' ? ' · ' + t('(meegeleverde versleutelde export)') : ''}</p>`;
  if (m?.tasks && m.source !== 'encrypted') h += `<button class="btn ghost" data-act="mUnlockSheet">${t('🔐 Meegeleverde volledige export ontgrendelen')}</button>`;
  h += `<p class="infobox">${t('ℹ️ De app leest alleen uit MARAD en schrijft er niet naar terug. Afgemelde taken zet je zelf in MARAD (via de export "Afgemeld voor MARAD").')}</p>`;
  A.openSheet(h, { maradImport: true });
}

// ---------- afmelden ----------
export function maradFields(task) {
  const f = [
    { id: 'mdone', role: 'mDone', label: 'Uitgevoerd', type: 'check', required: true, tr: { en: { label: 'Carried out' }, id: { label: 'Dilaksanakan' } } },
    { id: 'mrem', role: 'mRem', label: 'Opmerking', type: 'text', tr: { en: { label: 'Remark' }, id: { label: 'Catatan' } } },
  ];
  if (isHours(task)) f.splice(1, 0, { id: 'mrh', role: 'mRh', label: 'Draaiurenstand', type: 'number', unit: 'h', tr: { en: { label: 'Running hours' }, id: { label: 'Jam kerja' } } });
  return f;
}
/** Verwerkt een afgeronde ronde (eigen of geïmporteerd rapport): gekoppelde MARAD-taken afmelden. */
export function applyRun(run) {
  const m = M(); const out = { done: 0, notDone: 0, missing: 0, dup: 0 };
  if (m?.tasks) out.oil = A.oilApply?.(run) || 0; // olie-registraties uit de ronde (idempotent)
  if (!m?.tasks) return out;
  for (const r of run.results || []) {
    const mid = r.marad?.id || r.marad;
    if (!mid) continue;
    const task = m.tasks.find((x) => x.id === mid);
    if (!task) { out.missing++; continue; }
    const fv = (role) => { const f = (r.fields || []).find((x) => x.role === role); return f ? r.values?.[f.id] : undefined; };
    if (r.status !== 'done' || fv('mDone') === false) { out.notDone++; continue; }
    const date = todayISO(new Date(r.at || run.finishedAt || Date.now()));
    // dubbel: zelfde ronde, of dezelfde taak op dezelfde dag al afgemeld
    if (m.signoffs.some((s) => s.taskId === task.id && (s.runId === run.id || s.doneDate === date))) { out.dup++; continue; }
    const remarks = [fv('mRem'), r.note].filter(Boolean).join(' · ');
    const rh = fv('mRh');
    m.signoffs.push(markDone(task, { date, by: run.by || A.state.settings.userName || '', remarks, runHours: rh === '' ? null : rh ?? null, runId: run.id, compText: compText(comp(task)) }));
    out.done++;
  }
  S();
  return out;
}
export function runExtra(step) {
  if (!step?.marad) return '';
  return `<p class="mtag">🔧 MARAD · ${A.esc(step.marad.comp || '')}${step.marad.interval ? ' · ' + A.esc(step.marad.interval) : ''}</p>${step.workCard ? `<details class="wcard"><summary>${t('📄 Werkkaart (MARAD)')}</summary><pre>${A.esc(step.workCard)}</pre></details>` : ''}`;
}

// ---------- weergave ----------
function filtered() {
  const m = M(); if (!m?.tasks) return [];
  const q = F.q.trim().toLowerCase();
  return m.tasks.filter((x) => {
    const st = status(x);
    if (F.st === 'overdue' && st !== 'overdue') return false;
    if (F.st === 'week' && !(st === 'overdue' || st === 'week')) return false;
    if (F.st === 'month' && !(st === 'overdue' || st === 'week' || st === 'month')) return false;
    if (!rankOk(x)) return false;
    if (F.loc === '__none' ? x.locId : F.loc && x.locId !== F.loc) return false;
    if (q && !(x.name.toLowerCase().includes(q) || compText(comp(x)).toLowerCase().includes(q))) return false;
    return true;
  }).sort(byDue);
}
function counts(tasks) { const c = { overdue: 0, week: 0, month: 0, later: 0, hours: 0, none: 0 }; for (const x of tasks) c[status(x)]++; return c; }
function taskRow(x) {
  const st = status(x); const l = A.loc(x.locId);
  return `<div class="mtask st-${st}"><label class="mchk"><input type="checkbox" data-msel="${x.id}" ${sel.has(x.id) ? 'checked' : ''} aria-label="${t('Selecteren')}"></label><div class="mt-body" data-act="mTask" data-id="${x.id}">${dot(st)}<b>${A.esc(x.name)}</b><small>${isHours(x) ? '' : fmtD(x.dueDate) + ' · '}<span class="due">${dueText(x)}</span> · ${ivText(x.interval)}</small><small>${l ? '📍 ' + A.esc(A.tx(l, 'name')) : `<span class="unl">📍 ${t('niet gekoppeld')}</span>`} · 👤 ${A.esc(rankLabels(x.rank) || '—')}${x.appDone ? ` · <span class="okc">✔ ${t('afgemeld {d}', { d: fmtD(x.appDone.date) })}</span>` : ''}</small></div></div>`;
}
function buildTree(tasks) {
  const root = { key: '', kids: new Map(), tasks: [] };
  for (const x of tasks) {
    const c = comp(x); const path = c ? c.path : ['—'];
    let n = root, key = '';
    for (const p of path) { key += '»' + p; if (!n.kids.has(p)) n.kids.set(p, { key, label: p, kids: new Map(), tasks: [] }); n = n.kids.get(p); }
    n.tasks.push(x);
  }
  const agg = (n) => { n.all = [...n.tasks]; for (const k of n.kids.values()) n.all.push(...agg(k)); return n.all; };
  agg(root);
  return root;
}
function nodeHTML(n, depth) {
  const c = counts(n.all);
  const worst = Object.keys(ORDER).find((k) => c[k]) || 'none';
  const kids = [...n.kids.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return `<details class="mnode d${Math.min(depth, 3)}" data-node="${A.esc(n.key)}" ${open.has(n.key) || F.q ? 'open' : ''}><summary>${dot(worst)}<span class="mlabel">${A.esc(n.label)}</span><span class="mcnt">${c.overdue ? `<b class="cr">${c.overdue}</b>` : ''}${c.week ? `<b class="co">${c.week}</b>` : ''}<i>${n.all.length}</i></span></summary>${kids.map((k) => nodeHTML(k, depth + 1)).join('')}${n.tasks.sort(byDue).map(taskRow).join('')}</details>`;
}
function listHTML() {
  const xs = filtered();
  if (F.view === 'tree') {
    const root = buildTree(xs);
    const groups = [...root.kids.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    return (groups.map((g) => nodeHTML(g, 0)).join('') || `<p class="empty">${t('Geen taken met dit filter.')}</p>`);
  }
  return xs.map(taskRow).join('') || `<p class="empty">${t('Geen taken met dit filter.')}</p>`;
}
function selbar() {
  return sel.size ? `<div class="selbar"><span>${t('{n} geselecteerd', { n: sel.size })}</span><button class="btn ok" data-act="mMakeRoute">${t('🧭 Maak route')}</button><button class="iconbtn" data-act="mSelClear" aria-label="${t('Selectie wissen')}">✕</button></div>` : '';
}
// ---------- functies (Rank) ----------
const DEFAULT_RANKS = MARAD_RANKS; // 'Junior Officer' = alias van '2nd Officer' (zie ranks.js)
/** Functienamen: uit de MARAD-gegevens (als ontgrendeld), anders een standaardlijst. */
export function rankNames() { const rs = rankStats(M()).map((r) => r.rank); return rs.length ? rs : DEFAULT_RANKS; }
const myRank = () => normRank(A.state.settings.myRank) || 'Engineer';
function rankSel() {
  const st = A.state.settings;
  if (!Array.isArray(st.rankSel)) { st.rankSel = M()?.tasks?.some((x) => x.rank.includes(myRank())) ? [myRank()] : []; A.save(); }
  return new Set(st.rankSel.map(normRank));
}
const rankOk = (x, rs = rankSel()) => !rs.size || x.rank.some((r) => rs.has(r));
function rankChips() {
  const rs = rankSel(); const my = myRank();
  return `<div class="chips rchips" role="group" aria-label="${t('Functie')}"><button class="chip ${rs.size ? '' : 'on'}" data-act="mRankAll">${t('Alle functies')}</button>${rankStats(M()).map((r) => `<button class="chip ${rs.has(r.rank) ? 'on' : ''}" data-act="mRank" data-v="${A.esc(r.rank)}" aria-pressed="${rs.has(r.rank)}">${r.rank === my ? '⭐ ' : ''}${A.esc(rankLabel(r.rank))} <i class="cn">${r.n}</i>${r.overdue ? `<b class="cr" title="${t('Te laat')}">${r.overdue}</b>` : ''}</button>`).join('')}</div>`;
}

export function view() {
  const m = M();
  let h = A.header(t('Onderhoud'));
  if (!loaded) { ensureMaint().then(() => A.render()); return h + `<p class="empty">${t('MARAD-gegevens laden…')}</p>`; }
  if (!m?.tasks) return h + unlockHTML();
  const rs = rankSel();
  const mine = m.tasks.filter((x) => rankOk(x, rs));
  const c = counts(mine);
  const open_ = m.signoffs.filter((s) => !s.enteredInMarad).length;
  h += `<p class="shipsub">🔧 MARAD · ${A.esc(m.ship || A.state.shipName)} · ${t('{n} taken', { n: m.tasks.length })} · ${t('import {d}', { d: A.fmtDT(m.lastImport?.at) })}</p>`;
  h += rankChips();
  h += `<div class="mstats"><button data-act="mQuick" data-v="overdue">${dot('overdue')}<b>${c.overdue}</b><small>${t('Te laat')}</small></button><button data-act="mQuick" data-v="week">${dot('week')}<b>${c.week}</b><small>${t('≤ 7 d')}</small></button><button data-act="mQuick" data-v="month">${dot('month')}<b>${c.month}</b><small>${t('≤ 30 d')}</small></button><button data-act="mQuick" data-v="all">${dot('later')}<b>${c.later}</b><small>${t('Later')}</small></button><button data-act="mQuick" data-v="all">${dot('hours')}<b>${c.hours}</b><small>${t('Draaiuren')}</small></button></div>`;
  if (rs.size) h += `<p class="muted small">👤 ${A.esc(rankLabels([...rs]))} · ${t('{n} van {m} taken', { n: mine.length, m: m.tasks.length })}</p>`;
  const vb = (k, lbl) => `<button class="${F.view === k ? 'on' : ''}" data-act="mView" data-v="${k}">${lbl}</button>`;
  h += `<div class="seg mviews">${vb('tree', t('🌳 Boom'))}${vb('list', t('☰ Lijst'))}${vb('sug', t('💡 Voorstel'))}${vb('week', t('📅 Week'))}${vb('done', t('✔ Afgemeld') + (open_ ? ` (${open_})` : ''))}</div>`;
  if (F.view === 'week') return h + weekHTML();
  if (F.view === 'done') return h + doneHTML();
  if (F.view === 'sug') return h + sugHTML();
  const stb = (k, lbl) => `<button class="${F.st === k ? 'on' : ''}" data-act="mSt" data-v="${k}">${lbl}</button>`;
  h += `<div class="seg mst">${stb('overdue', t('Te laat'))}${stb('week', t('7 dagen'))}${stb('month', t('30 dagen'))}${stb('all', t('Alles'))}</div>`;
  h += `<div class="mfilters"><input type="search" data-mf="q" value="${A.esc(F.q)}" placeholder="${t('🔍 Zoek taak of component')}"><select data-mf="loc"><option value="">${t('Alle locaties')}</option><option value="__none" ${F.loc === '__none' ? 'selected' : ''}>${t('— niet gekoppeld —')}</option>${A.state.locations.map((l) => `<option value="${l.id}" ${l.id === F.loc ? 'selected' : ''}>${A.esc(A.tx(l, 'name'))}</option>`).join('')}</select></div>`;
  h += `<p class="muted small">${t('7/30 dagen = inclusief te laat. Gesorteerd op vervaldatum.')} <span id="mCount"></span></p>`;
  h += `<div class="row msel"><button class="btn small" data-act="mSelVisible">${t('☑ Selecteer zichtbare')}</button><button class="btn small" data-act="mSelDue">${t('☑ Te laat + 7 dagen')}</button></div>`;
  h += `<div id="mList" class="mlist">${listHTML()}</div>`;
  h += `<div class="stack"><button class="btn" data-act="mImport">${t('📥 MARAD-import')}</button></div>`;
  h += `<div id="mSelbar">${selbar()}</div>`;
  return h;
}

// ---------- voorgestelde routes ----------
const KIND_ICON = { safety: '🦺', mk: '⚙️', week: '📅', month: '🗓', hours: '⏱', overdue: '⏰' };
const kIcon = (sg) => (sg.kind === 'fixed' ? sg.fixed.icon || '📌' : KIND_ICON[sg.kind]);
function sugName(sg) {
  if (sg.kind === 'fixed') return sg.fixed.name?.[getLang()] || sg.fixed.name?.nl || sg.fixed.id;
  const f = sg.ranks.map(rankLabel).join(' / ');
  return { safety: t('Wekelijkse safety-ronde – {f}', { f }), mk: t('Wekelijkse machinekamerronde – {f}', { f }), week: t('Wekelijkse ronde – {f}', { f }), month: t('Maandelijkse ronde – {f}', { f }), hours: t('Draaiuren-onderhoud – {f}', { f }), overdue: t('Achterstallig onderhoud – {f}', { f }) }[sg.kind];
}
const sugDesc = (sg) => (sg.kind === 'fixed' ? t('Vaste ronde · {p}', { p: periodLbl(sg.period) }) : { safety: t('Taken met interval ≤ 2 weken: safety, reddingsmiddelen, brandbestrijding, alarmen.'), mk: t('Taken met interval ≤ 2 weken in machinekamer en technische systemen.'), week: t('Alle taken met interval ≤ 2 weken.'), month: t('Alle taken met interval van een maand.'), hours: t('Taken op draaiuren (te laat of bijna aan de beurt).'), overdue: t('Alle taken die nu te laat zijn.') }[sg.kind]);
const periodLbl = (p) => (p === 'month' ? t('maandelijks') : p === '2w' ? t('elke 2 weken') : t('wekelijks'));
const periodNoun = (p) => (p === 'month' ? t('maand') : p === '2w' ? t('periode van 2 weken') : t('week'));
let SG = [];
let FX = { rounds: [], leftovers: null };
function allSug() { SG = suggestions(M(), { min: 3 }); FX = fixedRounds(M()); return SG; }
const sugBy = (k) => [...FX.rounds, ...SG].find((x) => x.key === k) || (allSug(), [...FX.rounds, ...SG].find((x) => x.key === k));
const rankFit = (x) => !rankSel().size || x.ranks.some((r) => rankSel().has(r));
export function sugCount() { return M()?.tasks ? allSug().filter(rankFit).length + FX.rounds.filter(rankFit).length : 0; }
const tplFor = (key) => (A.state.templates || []).find((x) => x.key === key);
function sugCard(sg) {
  const tp = tplFor(sg.key); const r = tp && A.state.routes.find((x) => x.id === tp.routeId);
  const near = sg.tasks.filter((x) => ['overdue', 'week'].includes(status(x))).length;
  return `<article class="card sug k-${sg.kind}" data-k="${A.esc(sg.key)}"><h3>${kIcon(sg)} ${A.esc(sugName(sg))}</h3><p class="muted small">👤 ${A.esc(rankLabels(sg.ranks))} · ${sugDesc(sg)}</p>
    <p class="sugstats"><span class="tag">${t('{n} taken', { n: sg.tasks.length })}</span> <span class="tag">${t('{n} nu aan de beurt', { n: sg.due.length })}</span>${sg.overdue ? ` <span class="tag warn">${t('{n} te laat', { n: sg.overdue })}</span>` : ''}${sg.kind !== 'hours' && sg.nextDue ? ` <small>· ${t('volgende: {d}', { d: fmtD(sg.nextDue) })}</small>` : ''}${near && near !== sg.due.length ? ` <small>· ${t('{n} binnen 7 d', { n: near })}</small>` : ''}</p>
    ${sg.noLoc ? `<p class="unl small">📍 ${t('{n} taken zonder locatie (kies er een bij Maak route of koppel ze in de lijst)', { n: sg.noLoc })}</p>` : ''}
    ${tp ? `<p class="okc small">🔁 ${t('Sjabloon actief ({p}) → route "{r}"', { p: periodLbl(tp.period), r: A.esc(r ? A.tx(r, 'name') : tp.name) })}${tp.assignee ? ' · 👤 ' + A.esc(tp.assignee) : ''}</p>` : ''}
    <div class="row"><button class="btn ok" data-act="sgRoute" data-k="${A.esc(sg.key)}">${t('🧭 Maak route')}</button><button class="btn" data-act="sgSend" data-k="${A.esc(sg.key)}">${t('📲 Stuur naar…')}</button></div>
    <div class="row"><button class="btn small ghost" data-act="sgShow" data-k="${A.esc(sg.key)}">${t('☰ Taken bekijken')}</button>${tp ? `<button class="btn small ghost" data-act="mTplStop" data-id="${tp.id}">${t('Sjabloon stoppen')}</button>` : `<button class="btn small ghost" data-act="sgRoute" data-k="${A.esc(sg.key)}" data-tpl="1">${t('🔁 Als terugkerend sjabloon')}</button>`}</div></article>`;
}
function fixedHTML() {
  const m = M();
  let h = `<h3 class="sec">📌 ${t('Vaste rondes')}</h3>`;
  if (!m.fixedRounds?.length) return h + `<div class="warnbox">${t('De vaste rondes zitten in de versleutelde gegevens. Ontgrendel één keer opnieuw om ze te laden (je afmeldingen blijven bewaard).')}<div class="row"><button class="btn primary small" data-act="mUnlockSheet">${t('🔐 Ontgrendelen')}</button></div></div>`;
  const xs = FX.rounds.filter(rankFit);
  h += `<p class="muted small">${t('Vaste rondes per functie en interval; elke taak zit in maar één vaste ronde. Getoond: {n} van {m} (functiefilter hierboven).', { n: xs.length, m: FX.rounds.length })}</p>`;
  h += xs.map(sugCard).join('') || `<p class="empty">${t('Geen vaste rondes voor deze functie(s). Kies "Alle functies".')}</p>`;
  const lo = FX.leftovers; const nLo = lo ? lo.week.length + lo['2w'].length + lo.month.length : 0;
  if (nLo) h += `<details class="auto"><summary>${t('Niet in een vaste ronde ({n} wekelijkse/2-wekelijkse/maandelijkse taken)', { n: nLo })}</summary><div class="mlist">${[...lo.week, ...lo['2w'], ...lo.month].sort(byDue).map(taskRow).join('')}</div></details>`;
  return h + `<h3 class="sec">💡 ${t('Overige voorstellen')}</h3>`;
}
function sugHTML() {
  const rs = rankSel();
  const xs = allSug().filter((x) => !rs.size || x.ranks.some((r) => rs.has(r)));
  let h = fixedHTML() + `<p class="infobox">${t('💡 Voorstellen op basis van functie (Rank) en interval. "Maak route" zet de taken die nu aan de beurt zijn op volgorde van locatie. Een sjabloon ververst de route elke week of maand met de taken die dan aan de beurt zijn.')}</p>`;
  if (!xs.length) return h + `<p class="empty">${t('Geen voorstellen voor deze functie(s). Kies "Alle functies".')}</p>`;
  return h + xs.map(sugCard).join('');
}
function sugTasksSheet(sg) {
  A.openSheet(`<h2>${kIcon(sg)} ${A.esc(sugName(sg))}</h2><p class="muted small">${t('{n} taken · {d} nu aan de beurt', { n: sg.tasks.length, d: sg.due.length })}</p><div class="mlist">${[...sg.tasks].sort(byDue).map(taskRow).join('')}</div><button class="btn ghost" data-act="closeSheet">${t('Sluiten')}</button>`);
}
const dueSoon = (sg) => sg.tasks.filter((x) => ['overdue', 'week'].includes(status(x)));
function pickSet(sg, k) { return k === 'all' ? sg.tasks : k === 'soon' ? dueSoon(sg) : sg.due; }
function commonLoc(tasks) { const c = {}; for (const x of tasks) if (x.locId && A.loc(x.locId)) c[x.locId] = (c[x.locId] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || A.state.locations[0]?.id || ''; }
/** Route-object uit MARAD-taken (nog niet opgeslagen). */
function buildRoute(tasks, { name, assignee = '', strategy = 'kortste', fallback = '', description = '' }) {
  const steps = tasks.map((x) => {
    const c = comp(x);
    return {
      id: A.rid(), locationId: A.loc(x.locId) ? x.locId : fallback || null, title: x.name,
      instruction: [c ? (c.code ? c.code + ' – ' : '') + c.name : '', ivText(x.interval), x.rank.length ? '👤 ' + rankLabels(x.rank) : ''].filter(Boolean).join(' · '),
      fields: maradFields(x), marad: { id: x.id, comp: c ? (c.code ? c.code + ' – ' : '') + c.name : '', interval: x.interval?.text || '', due: x.dueDate }, workCard: x.workCard || '',
    };
  });
  return { id: 'r-' + A.rid(), name, description: description || t('Uit MARAD: {n} taken', { n: steps.length }), assignee, createdAt: Date.now(), updatedAt: Date.now(), source: 'marad', steps: A.orderSteps(steps, A.state, strategy) };
}

// ---------- taken verdelen (lijsten → taken → ontvanger) ----------
/** Lijsten om te verdelen: vaste rondes (alle taken) + eigen routes. Taak-sleutel = MARAD-id of stap-id. */
export function distLists() {
  const m = M(); const out = [];
  if (m?.tasks) {
    allSug();
    for (const sg of FX.rounds) out.push({ key: sg.key, kind: 'fixed', icon: kIcon(sg), name: sugName(sg), period: periodLbl(sg.period), ranks: sg.ranks,
      tasks: [...sg.tasks].sort(byDue).map((x) => { const c = comp(x), l = A.loc(x.locId), st = status(x); return { key: x.id, title: x.name, sub: [c ? (c.code ? c.code + ' – ' : '') + c.name : '', l ? A.tx(l, 'name') : ''].filter(Boolean).join(' · '), ranks: x.rank, st, due: x.dueDate ? fmtD(x.dueDate) : '', soon: st === 'overdue' || st === 'week' || fixedDue0(sg.period, x), marad: x.id, dd: x.dueDate || '', loc: x.locId || '' }; }) });
  }
  for (const r of A.state.routes.filter((x) => !x.templateId && !x.importedAt && x.source !== 'dist' && x.steps.length)) {
    out.push({ key: 'r:' + r.id, kind: 'route', icon: '🧭', name: A.tx(r, 'name'), period: '', ranks: [], routeId: r.id,
      tasks: r.steps.map((st) => { const l = A.loc(st.locationId); const mx = st.marad?.id && m?.tasks?.find((y) => y.id === st.marad.id); return { key: st.id, title: A.tx(st, 'title'), sub: l ? A.tx(l, 'name') : '', ranks: mx ? mx.rank : [], st: mx ? status(mx) : 'none', due: mx?.dueDate ? fmtD(mx.dueDate) : '', soon: true, step: st.id, dd: mx?.dueDate || '' }; }) });
  }
  return out;
}
const fixedDue0 = (period, x) => { if (!x.dueDate) return false; return (new Date(x.dueDate) - new Date(todayISO())) / 864e5 <= ({ week: 7, '2w': 14, month: 31 }[period] || 7); };
/** Samengestelde route voor één ontvanger: MARAD-taken (met afmeldvelden) + stappen uit eigen routes. */
export function distRoute(items, { name, assignee = '' }) {
  const ids = new Set(items.filter((i) => i.marad).map((i) => i.marad));
  const tasks = (M()?.tasks || []).filter((x) => ids.has(x.id));
  const r = buildRoute(tasks, { name, assignee, strategy: slimDefault(), description: '' }); const extra = new Map();
  for (const i of items.filter((y) => y.step)) {
    const src = A.state.routes.find((x) => x.id === i.routeId)?.steps.find((y) => y.id === i.step); if (!src) continue;
    const id = A.rid(); r.steps.push({ ...JSON.parse(JSON.stringify(src)), id }); extra.set(id, { st: i.st, dd: i.dd });
  }
  r.steps = tacticalOrder(r.steps, extra);
  return r;
}
/** Urgentie: te laat → ≤ 7 d → ≤ 30 d → later → draaiuren → geen datum; binnen status op vervaldatum (meest te laat eerst). */
export const urgency = (x) => [ORDER[x.st] ?? 5, x.dd || '9999'];
export const byUrgency = (a, b) => { const ka = urgency(a), kb = urgency(b); return ka[0] - kb[0] || ka[1].localeCompare(kb[1]); };
/** Tactische looproute: slimme volgorde (voor→achter / achter→voor, elke plek één keer, machinekamer als één blok);
 *  binnen dezelfde plek eerst de te late taken. Klik- of selectievolgorde speelt geen rol. */
export function tacticalOrder(steps, extra = new Map()) {
  const tk = new Map((M()?.tasks || []).map((x) => [x.id, x]));
  const urg = (s) => { const x = s.marad?.id && tk.get(s.marad.id); if (x) return { st: status(x), dd: x.dueDate || '' }; return extra.get(s.id) || { st: 'none', dd: '' }; };
  // vaste beginvolgorde (urgentie, dan naam/ID) → uitkomst hangt niet af van de volgorde van aantikken
  const k0 = (s) => s.marad?.id || A.tx(s, 'title') + '|' + s.id;
  const pre = steps.map((s) => ({ s, u: urg(s), k: k0(s) })).sort((a, b) => byUrgency(a.u, b.u) || a.k.localeCompare(b.k)).map((o) => o.s);
  const ordered = A.orderSteps(pre, A.state, slimDefault());
  const out = []; let run = [];
  const flush = () => { out.push(...run.map((s, i) => ({ s, i, u: urg(s) })).sort((a, b) => byUrgency(a.u, b.u) || a.i - b.i).map((o) => o.s)); run = []; };
  for (const s of ordered) { if (run.length && run[0].locationId !== s.locationId) flush(); run.push(s); }
  flush();
  return out;
}

// ---------- rangen (overzicht + rangpagina) ----------
/** Per rang: aantal vaste rondes, taken en te-late taken (null = MARAD niet ontgrendeld). */
export function rankOverview() {
  const m = M(); const has = !!m?.tasks; if (has) allSug();
  const st = has ? rankStats(m) : [];
  return RANK_IDS.map((r) => { const x = st.find((y) => y.rank === r); return { rank: r, rounds: has ? FX.rounds.filter((sg) => sg.ranks.includes(r)).length : null, tasks: x?.n || 0, overdue: x?.overdue || 0 }; });
}
/** Vaste rondes van een rang als kaarten met één-tik delen (Stagiair: alle vaste rondes, om er één te geven). */
export function rankRoundsHTML(rank, { crew = false } = {}) {
  const m = M(); if (!m?.tasks) return '';
  allSug();
  const xs = (rank === 'Stagiair' ? FX.rounds : FX.rounds.filter((sg) => sg.ranks.includes(rank)))
    .map((sg) => ({ sg, soon: soonOf(sg), od: sg.tasks.filter((x) => status(x) === 'overdue').length }))
    .sort((a, b) => b.od - a.od || b.soon.length - a.soon.length);
  if (!xs.length) return `<p class="muted small">${t('Geen vaste rondes voor deze rang.')}</p>`;
  return xs.map(({ sg, soon, od }) => `<article class="card today k-fixed ${od ? 'has-od' : ''}" data-k="${A.esc(sg.key)}"><div class="thead"><h3>${kIcon(sg)} ${A.esc(sugName(sg))}</h3><p class="muted small">👤 ${A.esc(rankLabels(sg.ranks))} · ${periodLbl(sg.period)}</p></div>
      <p class="tcounts">${od ? `<span class="tag red">${t('{n} te laat', { n: od })}</span> ` : ''}<span class="tag orange">${t('{n} deze week', { n: Math.max(0, soon.length - od) })}</span> <small class="muted">${t('van {n} taken', { n: sg.tasks.length })}</small></p>
      ${crew ? `<button class="btn ok huge" data-act="tdStart" data-k="${A.esc(sg.key)}" ${soon.length ? '' : 'disabled'}>${t('▶ Start ronde')} <small>(${soon.length})</small></button>`
    : `<div class="row"><button class="btn primary" data-act="sgSend" data-k="${A.esc(sg.key)}" data-rank="${A.esc(rank)}">${t('📲 Stuur naar {rank}', { rank: A.esc(rankLabel(rank)) })}</button><button class="btn small ghost" data-act="sgShow" data-k="${A.esc(sg.key)}">${t('☰ Taken bekijken')}</button></div>`}</article>`).join('');
}

// ---------- Vandaag (startscherm Beheer) ----------
const soonOf = (sg) => sg.tasks.filter((x) => ['overdue', 'week'].includes(status(x)));
export function todayHTML(opts = {}) {
  const m = M(); if (!m?.tasks || A.isCrew?.()) return '';
  allSug();
  let h = '';
  if (needsReunlock()) h += `<div class="warnbox">${t('Er zijn bijgewerkte onderhoudsgegevens (vaste rondes en locaties). Ontgrendel één keer opnieuw om ze te laden – je afmeldingen blijven bewaard.')}<div class="row"><button class="btn primary small" data-act="mUnlockSheet">${t('🔐 Ontgrendelen')}</button></div></div>`;
  return h + boardHTML(opts);
}
// ---------- v1.14: weekbord (Deze week + Achterstallig pakket) ----------
/** Datum (jjjj-mm-dd) in Europe/Amsterdam – de weekgrens van het bord. */
export const amsToday = (d = new Date()) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); } catch { return todayISO(d); } };
/** ISO-week (ma–zo) rond een datum: { from, to, wk } */
function isoWeek(day) {
  const d = new Date(day + 'T12:00:00Z'); const wd = d.getUTCDay() || 7;
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - wd + 1); const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  return { from: isoD(mon), to: isoD(sun), wk: periodKey('week', new Date(day + 'T12:00:00')).split('-W')[1] };
}
/** Grootte van een hap werk: kort ≤ 10 · middag 11–25 · volle dag 26+ open taken. */
const sizeOf = (n) => (n <= 10 ? 'kort' : n <= 25 ? 'middag' : 'dag');
const SIZE = () => ({ kort: [t('kort'), 1], middag: [t('middag'), 2], dag: [t('volle dag'), 3] });
const PORD = { week: 0, '2w': 1, month: 2 };
/** Bord-indeling op basis van de bestaande vervaldatums (MARAD + afmeldingen in de app).
 *  - open = te laat, of vervaldatum t/m zondag van deze week · klaar = deze week afgemeld en niet opnieuw open
 *  - wekelijks: altijd Deze week (restjes van vorige week tellen mee op de kaart, niet in het pakket)
 *  - 2-wekelijks / maandelijks: Deze week als er een taak deze week vervalt (of de ronde deze week is afgerond);
 *    alleen nog taken van vóór deze week open → Achterstallig pakket. */
export function weekBoard(today = amsToday()) {
  const m = M(); if (!m?.tasks) return null;
  allSug();
  const w = isoWeek(today); const rs = rankSel();
  const doneIds = new Set(m.signoffs.filter((x) => x.doneDate >= w.from && x.doneDate <= w.to).map((x) => x.taskId));
  const isOpen = (x) => { const st = status(x, today); return st === 'overdue' || (!isHours(x) && !!x.dueDate && x.dueDate <= w.to); };
  const week = [], pkg = [];
  for (const sg of FX.rounds) {
    const tasks = sg.tasks.filter((x) => rankOk(x, rs)); if (!tasks.length) continue;
    const open = tasks.filter(isOpen), done = tasks.filter((x) => doneIds.has(x.id) && !isOpen(x));
    const thisWeek = open.filter((x) => !isHours(x) && x.dueDate >= w.from);
    const late = open.filter((x) => status(x, today) === 'overdue').length;
    const item = { key: sg.key, sg, name: sugName(sg), icon: kIcon(sg), period: sg.period, open: open.length, done: done.length, total: open.length + done.length, late };
    if (sg.period === 'week' || thisWeek.length || (!open.length && done.length)) week.push(item);
    else if (open.length) pkg.push(item);
  }
  const claimed = new Set(FX.rounds.flatMap((sg) => sg.tasks.map((x) => x.id)));
  const rest = m.tasks.filter((x) => !claimed.has(x.id) && rankOk(x, rs) && status(x, today) === 'overdue').length;
  week.sort((a, b) => (!a.open) - (!b.open) || (PORD[a.period] ?? 3) - (PORD[b.period] ?? 3) || b.late - a.late || a.name.localeCompare(b.name));
  pkg.sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
  return { ...w, today, week, pkg, rest, rs };
}
function boardHTML({ sent = [], busy = [], doneAfter = () => false } = {}) {
  const B = weekBoard(); if (!B) return '';
  const S_ = SIZE();
  const who = (key) => { // al bij iemand? (bestaande Taken verdelen + Voortgang-gegevens, geen tweede administratie)
    const xs = sent.filter((s) => s.list === key && !doneAfter(s.aid, s.ver));
    const b = xs.find((s) => busy.some((x) => x.route === s.routeId));
    if (b) return `<span class="wc-who busy">⏳ ${t('{name} is bezig', { name: A.esc(b.name || rankLabel(b.rank)) })}</span>`;
    return xs.length ? `<span class="wc-who">📤 ${t('bij {name}', { name: A.esc(xs.map((s) => s.name || rankLabel(s.rank)).join(', ')) })}</span>` : '';
  };
  const size = (n) => { const [l, k] = S_[sizeOf(n)]; return `<span class="wc-size" title="${t('Omvang')}"><i class="pips p${k}" aria-hidden="true"><b></b><b></b><b></b></i>${l}</span>`; };
  const dd = (iso, o) => new Date(iso + 'T12:00:00').toLocaleDateString(LOCALES[getLang()], o);
  const range = B.from.slice(0, 7) === B.to.slice(0, 7) ? `${dd(B.from, { day: 'numeric' })}–${dd(B.to, { day: 'numeric', month: 'short' })}` : `${dd(B.from, { day: 'numeric', month: 'short' })} – ${dd(B.to, { day: 'numeric', month: 'short' })}`;
  let h = `<section class="wboard" aria-label="${t('Weekbord')}">`;
  h += rankChips();
  // ---- Deze week ----
  const ready = B.week.filter((x) => !x.open).length;
  h += `<div class="wb-head"><h2>${t('Deze week')}</h2><span class="wb-range">${t('Week {w}', { w: B.wk })} · ${A.esc(range)}</span></div>`;
  if (B.week.length) h += `<div class="wb-bar" role="img" aria-label="${t('{a} van {b} rondes klaar', { a: ready, b: B.week.length })}"><span class="wb-meter"><i style="width:${Math.round((ready / B.week.length) * 100)}%"></i></span><small>${t('{a} van {b} rondes klaar', { a: ready, b: B.week.length })}</small></div>`;
  h += `<div class="wb-list">`;
  if (!B.week.length) h += `<p class="wb-empty">${B.rs.size ? t('Deze week niets gepland voor deze functie.') : t('Deze week niets gepland.')}</p>`;
  for (const x of B.week) {
    const fin = !x.open;
    const meta = fin ? (x.done ? t('{n} taken afgetekend', { n: x.done }) : t('niets aan de beurt'))
      : [(x.total === 1 ? t('1 taak') : t('{n} taken', { n: x.total })), x.done ? `${x.done}/${x.total}` : '', x.late ? `<span class="wc-late">${t('waarvan {n} al over tijd', { n: x.late })}</span>` : ''].filter(Boolean).join(' · ');
    h += `<button class="wcard ${fin ? 'done' : ''} ${x.late && !fin ? 'late' : ''}" data-act="distOpen" data-k="${A.esc(x.key)}" data-k-board="week">
      <span class="wc-ic" aria-hidden="true">${fin ? '✓' : x.icon}</span>
      <span class="wc-body"><b class="wc-name">${A.esc(x.name)}</b><span class="wc-meta">${meta}</span><span class="wc-per">${periodLbl(x.period)}${who(x.key) ? ' · ' : ''}${who(x.key)}</span></span>
      <span class="wc-side">${fin ? `<span class="wc-ok">${t('klaar')}</span>` : size(x.open)}</span>
      ${!fin && x.done ? `<span class="wc-prog" aria-hidden="true"><i style="width:${Math.round((x.done / x.total) * 100)}%"></i></span>` : ''}</button>`;
  }
  h += `</div>`;
  // ---- Achterstallig pakket ----
  const sum = B.pkg.reduce((a, x) => a + x.open, 0) + B.rest;
  h += `<div class="wb-head pkg"><h2>${t('Achterstallig pakket')}</h2><span class="wb-range">${sum ? t('{n} taken', { n: sum }) : ''}</span></div>`;
  if (sum) h += `<p class="wb-sub">${t('Extra inhaalwerk van vóór deze week – stapel voor stapel weg te werken.')}</p><div class="wb-bar warn"><small>${t('Achterstallig nog {n} taken', { n: sum })}</small></div>`;
  h += `<div class="wb-list">`;
  if (!sum) h += `<p class="wb-empty ok">${t('Niets achterstallig.')}</p>`;
  for (const x of B.pkg) h += `<button class="wcard pile" data-act="distOpen" data-k="${A.esc(x.key)}" data-k-board="pkg">
      <span class="wc-ic" aria-hidden="true">${x.icon}</span>
      <span class="wc-body"><b class="wc-name">${A.esc(x.name)}</b><span class="wc-meta">${periodLbl(x.period)}${x.done ? ' · ' + t('{n} deze week ingehaald', { n: x.done }) : ''}</span>${who(x.key) ? `<span class="wc-per">${who(x.key)}</span>` : ''}</span>
      <span class="wc-side"><span class="wc-count"><b>${x.open}</b><small>${t('te laat')}</small></span>${size(x.open)}</span></button>`;
  if (B.rest) h += `<button class="wcard pile rest" data-act="mQuickGo" data-v="overdue" data-k-board="rest">
      <span class="wc-ic" aria-hidden="true">🗂</span>
      <span class="wc-body"><b class="wc-name">${t('Overige taken')}</b><span class="wc-meta">${t('niet in een vaste ronde · via Onderhoud')}</span></span>
      <span class="wc-side"><span class="wc-count"><b>${B.rest}</b><small>${t('te laat')}</small></span>${size(B.rest)}</span></button>`;
  h += `</div></section>`;
  return h;
}
/** Vaste ronde starten vanaf Vandaag: gekoppelde route verversen (of aanmaken als terugkerend sjabloon) en de route-id teruggeven. */
export function startFixed(key) {
  allSug(); const sg = sugBy(key); if (!sg) return null;
  const tp0 = tplFor(key);
  if (tp0 && A.state.routes.some((r) => r.id === tp0.routeId)) { refreshTemplates(true, tp0.id); return tp0.routeId; }
  if (tp0) A.state.templates = A.state.templates.filter((x) => x !== tp0);
  const setK = soonOf(sg).length ? 'soon' : 'due';
  const o = { name: sugName(sg), assignee: '', strategy: slimDefault(), fallback: '' };
  const r = buildRoute(pickSet(sg, setK), o);
  const tp = { id: 'tp-' + A.rid(), key: sg.key, name: o.name, period: sg.period, set: setK, assignee: '', strategy: o.strategy, fallback: '', routeId: r.id, lastKey: periodKey(sg.period), lastRefresh: new Date().toISOString(), createdAt: new Date().toISOString() };
  (A.state.templates ||= []).push(tp); r.templateId = tp.id; r.description = tplDesc(tp, r.steps.length);
  A.state.routes.push(r); S();
  return r.id;
}
// ---------- weekoverzicht ----------
const isoD = (d) => d.toISOString().slice(0, 10);
function weekRange(off = 0) {
  const d = new Date(todayISO() + 'T12:00:00Z'); const day = d.getUTCDay() || 7;
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - day + 1 + off * 7);
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  return { from: isoD(mon), to: isoD(sun), key: periodKey('week', mon) };
}
export function weekStats(off = 0) {
  const m = M(); if (!m?.tasks) return null;
  const { from, to, key } = weekRange(off);
  const done = m.signoffs.filter((x) => x.doneDate >= from && x.doneDate <= to);
  const doneIds = new Set(done.map((x) => x.taskId));
  const rs = rankSel();
  const open_ = m.tasks.filter((x) => rankOk(x, rs) && !doneIds.has(x.id) && (status(x) === 'overdue' || (!isHours(x) && x.dueDate && x.dueDate <= to))).sort(byDue);
  return { from, to, key, done, open: open_, overdue: open_.filter((x) => status(x) === 'overdue').length, toEnter: m.signoffs.filter((x) => !x.enteredInMarad).length };
}
function weekHTML() {
  const w = weekStats(F.wk || 0);
  const by = new Map(); for (const x of w.done) { const k = x.by || t('ik'); if (!by.has(k)) by.set(k, []); by.get(k).push(x); }
  let h = `<div class="weeknav"><button class="iconbtn" data-act="mWeek" data-v="-1" aria-label="${t('Vorige week')}">◀</button><b>${t('Week {w}', { w: w.key.split('-W')[1] })}</b><small>${fmtD(w.from)} – ${fmtD(w.to)}</small><button class="iconbtn" data-act="mWeek" data-v="1" aria-label="${t('Volgende week')}" ${(F.wk || 0) >= 0 ? 'disabled' : ''}>▶</button></div>`;
  h += `<div class="mstats wstats"><div><b class="okc">${w.done.length}</b><small>${t('Gedaan')}</small></div><div><b>${w.open.length}</b><small>${t('Open')}</small></div><div><b class="cr">${w.overdue}</b><small>${t('Te laat')}</small></div><div><b>${w.toEnter}</b><small>${t('In MARAD in te voeren')}</small></div></div>`;
  h += `<section class="card"><h3>⬇ ${t('Export "Afgemeld voor MARAD"')}</h3><p class="muted small">${t('{n} afmeldingen nog in MARAD in te voeren (alle weken).', { n: w.toEnter })}</p><div class="row"><button class="btn primary" data-act="mExport" ${w.toEnter ? '' : 'disabled'}>${t('⬇ CSV "Afgemeld voor MARAD"')}</button><button class="btn" data-act="mEntered" ${w.toEnter ? '' : 'disabled'}>${t('✔ Alles ingevoerd in MARAD')}</button></div></section>`;
  h += `<h3 class="sec">✔ ${t('Gedaan deze week')} <small>(${w.done.length})</small></h3>`;
  if (!w.done.length) h += `<p class="muted small">${t('Nog niets afgemeld in deze week.')}</p>`;
  for (const [p, xs] of by) h += `<h4 class="odate">👤 ${A.esc(p)} <small>(${xs.length})</small></h4><ul class="signoffs">${xs.map((s) => `<li><b>${A.esc(s.task)}</b><small>✔ ${fmtD(s.doneDate)}${s.remarks ? ' · 📝 ' + A.esc(s.remarks) : ''}${s.enteredInMarad ? ' · ' + t('ingevoerd in MARAD') : ''}</small></li>`).join('')}</ul>`;
  h += `<h3 class="sec">⏳ ${t('Nog open deze week')} <small>(${w.open.length})</small>${rankSel().size ? ` <small>· 👤 ${A.esc(rankLabels([...rankSel()]))}</small>` : ''}</h3><div class="mlist">${w.open.slice(0, 40).map(taskRow).join('') || `<p class="okbox">${t('✔ Alles gedaan voor deze week.')}</p>`}</div>`;
  if (w.open.length > 40) h += `<p class="muted small">${t('+ {n} meer – zie Lijst', { n: w.open.length - 40 })}</p>`;
  return h;
}

function doneHTML() {
  const m = M(); const xs = [...m.signoffs].reverse();
  const openS = xs.filter((s) => !s.enteredInMarad), arch = xs.filter((s) => s.enteredInMarad);
  let h = `<p class="infobox">${t('ℹ️ De app schrijft niet terug naar MARAD. Voer deze afmeldingen zelf in MARAD in en zet ze daarna op "ingevoerd".')}</p>`;
  h += `<div class="row"><button class="btn primary" data-act="mExport" ${openS.length ? '' : 'disabled'}>${t('⬇ CSV "Afgemeld voor MARAD"')}</button><button class="btn" data-act="mEntered" ${openS.length ? '' : 'disabled'}>${t('✔ Alles ingevoerd in MARAD')}</button></div>`;
  const row = (s) => `<li><b>${A.esc(s.task)}</b><small>${A.esc(s.component)}</small><small>✔ ${fmtD(s.doneDate)}${s.by ? ' · 👤 ' + A.esc(s.by) : ''}${s.runHours != null ? ' · ⏱ ' + fmtN(s.runHours) + ' h' : ''}${s.nextDue ? ' · ' + t('volgende: {d}', { d: fmtD(s.nextDue) }) : ''}</small>${s.remarks ? `<p class="note">📝 ${A.esc(s.remarks)}</p>` : ''}${s.enteredInMarad ? `<small class="okc">${t('ingevoerd in MARAD')}</small>` : `<button class="btn small ghost" data-act="mUndo" data-id="${s.id}">${t('↶ Ongedaan maken')}</button>`}</li>`;
  h += `<h3 class="sec">${t('Nog in MARAD invoeren ({n})', { n: openS.length })}</h3><ul class="signoffs">${openS.map(row).join('') || `<li class="muted">${t('Niets af te melden. Taken uit een ronde of rapport verschijnen hier.')}</li>`}</ul>`;
  if (arch.length) h += `<details class="auto"><summary>${t('Al ingevoerd ({n})', { n: arch.length })}</summary><ul class="signoffs">${arch.slice(0, 50).map(row).join('')}</ul></details>`;
  return h;
}
function refreshList() {
  const el = $f('#mList'); if (el) el.innerHTML = listHTML();
  const sb = $f('#mSelbar'); if (sb) sb.innerHTML = selbar();
  const n = $f('#mCount'); if (n) n.textContent = t('({n} getoond)', { n: filtered().length });
}
function onInput(e) {
  const el = e.target;
  if (el.dataset?.mf) { F[el.dataset.mf] = el.value; refreshList(); }
}
function onChange(e) {
  const el = e.target;
  if (el.dataset?.msel) { if (el.checked) sel.add(el.dataset.msel); else sel.delete(el.dataset.msel); const sb = $f('#mSelbar'); if (sb) sb.innerHTML = selbar(); }
  if (el.id === 'mtLoc') { const x = M().tasks.find((y) => y.id === el.dataset.id); x.locId = el.value || null; x.locManual = true; S(); A.toast(t('Locatie gekoppeld')); }
}
function taskSheet(x) {
  const c = comp(x); const st = status(x);
  const hrs = isHours(x);
  let h = `<h2>${dot(st)} ${A.esc(x.name)}</h2><p class="muted small">${A.esc(compText(c))}</p>
    <dl class="mdl">
      <dt>${t('Status')}</dt><dd>${STL()[st]} · <b>${dueText(x)}</b></dd>
      ${hrs ? `<dt>${t('Vervalt bij')}</dt><dd>${x.dueRunHours != null ? fmtN(x.dueRunHours) + ' h' : '—'}</dd>` : `<dt>${t('Vervaldatum')}</dt><dd>${fmtD(x.dueDate)}${x.dueWeek ? ` (${t('week {n}', { n: x.dueWeek })})` : ''}</dd>`}
      <dt>${t('Interval')}</dt><dd>${ivText(x.interval)}</dd>
      <dt>${t('Laatst uitgevoerd')}</dt><dd>${hrs ? `${x.lastRunHours != null ? fmtN(x.lastRunHours) + ' h' : '—'}${x.lastDone ? ' · ' + fmtD(x.lastDone) : ''}` : fmtD(x.lastDone)}${x.daysAgo != null && !x.appDone ? ` (${hrs ? t('{n} u geleden', { n: fmtN(x.daysAgo) }) : t('{n} d geleden', { n: x.daysAgo })})` : ''}</dd>
      <dt>${t('Functie')}</dt><dd>${A.esc(rankLabels(x.rank) || '—')}</dd>
      ${x.taskType && x.taskType !== '0' ? `<dt>${t('Soort')}</dt><dd>${A.esc(x.taskType)}</dd>` : ''}
    </dl>`;
  if (hrs) h += `<p class="muted small">${t('Draaiuren-taken: de app rekent geen nieuwe vervaldatum uit, tenzij je bij afmelden de urenstand invult.')}</p>`;
  if (x.appDone) h += `<p class="okbox">${t('✔ In de app afgemeld op {d}', { d: fmtD(x.appDone.date) })}${x.appDone.nextDue ? ' · ' + t('volgende (berekend): {d}', { d: fmtD(x.appDone.nextDue) }) : ''}${x.appDone.nextRunHours ? ' · ' + t('volgende bij {n} h', { n: fmtN(x.appDone.nextRunHours) }) : ''}<br><small>${t('Nog invoeren in MARAD.')}</small></p>`;
  h += `<label>${t('📍 Locatie aan boord')}${A.locSelect(x.locId || '', `id="mtLoc" data-id="${x.id}"`, true)}</label>`;
  if (x.workCard) h += `<details class="wcard" open><summary>${t('📄 Werkkaart (MARAD)')}</summary><pre>${A.esc(x.workCard)}</pre></details>`;
  h += `<h3 class="sec">${t('Afmelden in de app')}</h3><div class="row"><label>${t('Datum')}<input type="date" id="mdDate" value="${todayISO()}"></label>${hrs ? `<label>${t('Urenstand')}<input type="number" inputmode="decimal" id="mdRh" placeholder="${x.lastRunHours ?? ''}"></label>` : ''}</div><label>${t('Opmerking')}<input id="mdRem"></label>
    <div class="stack"><button class="btn ok" data-act="mSignoff" data-id="${x.id}">${t('✔ Afmelden')}</button><button class="btn" data-act="mToggleSel" data-id="${x.id}">${sel.has(x.id) ? t('Uit selectie halen') : t('☑ Selecteren voor route')}</button></div>`;
  if (x.doneLog?.length) h += `<p class="muted small">${t('Historie in app:')} ${x.doneLog.map((d) => fmtD(d.date) + (d.by ? ' (' + A.esc(d.by) + ')' : '')).join(', ')}</p>`;
  A.openSheet(h, { mTask: x.id });
}
let MR = null; // context van "Route maken"
function makeRouteSheet(ctx = null) {
  // ctx: { sg, tpl } bij een voorstel, anders de selectie
  MR = ctx;
  const sg = ctx?.sg;
  const sets = sg ? [['due', t('Nu aan de beurt'), sg.due], ['soon', t('Te laat + 7 dagen'), dueSoon(sg)], ['all', t('Hele groep'), sg.tasks]].filter((x, i, arr) => x[2].length && arr.findIndex((y) => y[2].length === x[2].length) === i) : null;
  const tasks = sg ? (sets[0]?.[2] || []) : M().tasks.filter((x) => sel.has(x.id));
  const nUn = (sg ? sg.tasks : tasks).filter((x) => !A.loc(x.locId)).length;
  const locs = new Set(tasks.map((x) => x.locId).filter(Boolean)).size;
  const rk = sg ? sg.ranks : [];
  const cs = sortContacts(rk);
  const defName = sg ? sugName(sg) : t('Onderhoud {d}', { d: fmtD(todayISO()) });
  A.openSheet(`<h2>${t('🧭 Route maken uit onderhoud')}</h2>${sg ? `<p class="muted small">${kIcon(sg)} ${A.esc(sugName(sg))}</p>` : `<p>${t('{n} taken op {l} locaties', { n: tasks.length, l: locs })}</p>`}
    ${sets ? `<div class="flbl">${t('Welke taken?')}</div><div class="radios">${sets.map(([k, l, xs], i) => `<label class="switch"><input type="radio" name="mrSet" value="${k}" ${i ? '' : 'checked'}><span>${l} (${xs.length})</span></label>`).join('')}</div>` : ''}
    <label>${t('Naam')}<input id="mrName" value="${A.esc(defName)}"></label>
    <label>${t('Bestemd voor')}<select id="mrTo"><option value="">${t('— niemand / mezelf —')}</option>${cs.map((c) => `<option ${c.match && c === cs[0] ? 'selected' : ''} value="${A.esc(c.name)}">${c.match ? '⭐ ' : ''}${A.esc(c.name)}${c.func ? ' · ' + A.esc(c.func) : ''}</option>`).join('')}</select></label>
    <label>${t('Volgorde')}<select id="mrStrat">${Object.entries(A.STRATEGIES).map(([k, v]) => `<option value="${k}" ${k === (sg ? slimDefault() : 'kortste') ? 'selected' : ''}>${A.esc(v.label)}</option>`).join('')}</select></label>
    ${nUn ? `<div class="warnbox">${t('{n} taken hebben nog geen locatie. Kies een locatie voor deze taken:', { n: nUn })}${A.locSelect(commonLoc(sg ? sg.tasks : tasks), 'id="mrLoc"', true)}</div>` : ''}
    ${sg ? `<label class="switch"><input type="checkbox" id="mrTpl" ${ctx.tpl || sg.kind === 'fixed' ? 'checked' : ''}><span>${t('🔁 Terugkerend sjabloon: route elke {p} verversen met de taken die dan aan de beurt zijn', { p: periodNoun(sg.period) })}</span></label>` : ''}
    <p class="muted small">${t('Elke taak krijgt de velden "Uitgevoerd ja/nee" en "Opmerking" (bij draaiuren ook de urenstand). Na de ronde worden uitgevoerde taken afgemeld en komen ze in "Afgemeld voor MARAD".')}</p>
    <div class="row sticky"><button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button><button class="btn primary" data-act="mCreateRoute">${t('Route maken')}</button></div>`);
}
function createRoute() {
  const sg = MR?.sg; const setK = document.querySelector('input[name=mrSet]:checked')?.value || 'due';
  const tasks = sg ? pickSet(sg, setK) : M().tasks.filter((x) => sel.has(x.id));
  if (!tasks.length) return A.toast(t('Geen taken'));
  const o = { name: $f('#mrName').value.trim() || t('Onderhoud'), assignee: $f('#mrTo').value, strategy: $f('#mrStrat').value, fallback: $f('#mrLoc')?.value || '' };
  const r = buildRoute(tasks, o);
  if (sg && $f('#mrTpl')?.checked) {
    const tp = { id: 'tp-' + A.rid(), key: sg.key, name: o.name, period: sg.period, set: setK, assignee: o.assignee, strategy: o.strategy, fallback: o.fallback, routeId: r.id, lastKey: periodKey(sg.period), lastRefresh: new Date().toISOString(), createdAt: new Date().toISOString() };
    (A.state.templates ||= []).push(tp); r.templateId = tp.id; r.description = tplDesc(tp, r.steps.length);
  }
  A.state.routes.push(r); S(); if (!sg) sel.clear(); A.closeSheet(); MR = null;
  A.go('routes', { routeId: r.id }); A.toast(t('Route gemaakt met {n} taken', { n: r.steps.length }));
}
const tplDesc = (tp, n) => t('🔁 Sjabloon ({p}) · ververst {d} · {n} taken aan de beurt', { p: periodLbl(tp.period), d: A.fmtDT(tp.lastRefresh), n });
/** Terugkerende sjablonen: elke nieuwe week/maand de gekoppelde route vullen met de taken die dan aan de beurt zijn. */
export function refreshTemplates(force = false, onlyId = null) {
  const m = M(); if (!m?.tasks) return 0; let n = 0;
  for (const tp of A.state.templates || []) {
    if (onlyId && tp.id !== onlyId) continue;
    const key = periodKey(tp.period);
    const r0 = A.state.routes.find((x) => x.id === tp.routeId);
    if (!force && tp.lastKey === key && r0) continue;
    const sg = findSuggestion(m, tp.key); if (!sg) continue;
    tp.lastKey = key; tp.lastRefresh = new Date().toISOString();
    const r = buildRoute(pickSet(sg, tp.set), { name: tp.name, assignee: tp.assignee, strategy: tp.strategy, fallback: tp.fallback });
    r.id = tp.routeId; r.templateId = tp.id; r.description = tplDesc(tp, r.steps.length);
    if (r0) Object.assign(r0, { steps: r.steps, description: r.description, updatedAt: Date.now(), templateId: tp.id }); else A.state.routes.push(r);
    n++;
  }
  if (n) S();
  return n;
}
export function templateInfo(r) {
  const tp = r?.templateId && (A.state.templates || []).find((x) => x.id === r.templateId); if (!tp) return '';
  return `<section class="card tplcard"><p>🔁 <b>${t('Terugkerend sjabloon')}</b> · ${periodLbl(tp.period)}</p><p class="muted small">${t('Elke nieuwe {p} vult de app deze route opnieuw met de taken die dan aan de beurt zijn (na het openen van de app, als MARAD ontgrendeld is). Laatst ververst: {d}.', { p: periodNoun(tp.period), d: A.fmtDT(tp.lastRefresh) })}</p><div class="row"><button class="btn small" data-act="mTplRefresh" data-id="${tp.id}" ${M()?.tasks ? '' : 'disabled'}>${t('↻ Nu verversen')}</button><button class="btn small ghost" data-act="mTplStop" data-id="${tp.id}">${t('Sjabloon stoppen')}</button></div></section>`;
}
// ---------- versturen naar een persoon (direct in zijn app, via de koppeling) ----------
function sortContacts(ranks) {
  const rk = new Set((ranks || []).map((r) => normRank(r).toLowerCase()));
  return A.state.contacts.map((c) => ({ ...c, match: !!c.func && rk.has(normRank(c.func).toLowerCase()) })).sort((a, b) => b.match - a.match || !!b.inbox - !!a.inbox);
}
let SEND = null;
function sendSheet(sg, intended = '') {
  const tasks = sg.due.length ? sg.due : sg.tasks;
  const nUn = tasks.filter((x) => !A.loc(x.locId)).length;
  const cs = sortContacts(intended ? [intended] : sg.ranks);
  const ps = cs.filter((c) => c.inbox);
  SEND = { sg, tasks, id: 'r-' + A.rid(), intended: normRank(intended) || '' };
  A.openSheet(`<h2>${t('📤 Stuur naar…')}</h2><p><b>${A.esc(sugName(sg))}</b> · ${t('{n} taken', { n: tasks.length })}${intended ? ` · 🎖 ${t('voor {rank}', { rank: A.esc(rankLabel(intended)) })}` : ''}</p>
    ${nUn ? `<div class="warnbox">${t('{n} taken hebben nog geen locatie. Kies een locatie voor deze taken:', { n: nUn })}${A.locSelect(commonLoc(sg.tasks), 'id="sgLoc"', true)}</div>` : ''}
    ${ps.length ? `<div class="stack" id="sgList">${ps.map((c) => `<button class="btn ${c.match ? 'primary big' : ''}" data-act="sgApp" data-cid="${c.id}">🔗 ${c.match ? '⭐ ' : ''}${A.esc(c.name)}${c.func ? ` <small>· ${A.esc(rankLabel(normRank(c.func)) || c.func)}</small>` : ''}</button>`).join('')}</div>` : `<p class="warnbox">${t('Nog niemand gekoppeld. Versturen kan alleen naar iemand die gekoppeld is.')}</p>`}
    ${cs.some((c) => c.match && c.inbox) ? `<p class="muted small">⭐ ${t('= functie past bij deze route ({f}).', { f: A.esc(rankLabels(sg.ranks)) })}</p>` : ''}
    <div class="row"><button class="btn small" data-act="pairSheet">🔗 ${t('Iemand koppelen')}</button><button class="btn small ghost" data-act="closeSheet">${t('Annuleren')}</button></div>`, { sgSend: true });
}
function sendRoute(c) {
  const r = buildRoute(SEND.tasks, { name: sugName(SEND.sg), assignee: c?.name || '', fallback: $f('#sgLoc')?.value || '' });
  r.id = SEND.id; if (SEND.intended) r.intendedRank = SEND.intended; return r;
}
function saveSent(c, via) {
  const r = sendRoute(c);
  const i = A.state.routes.findIndex((x) => x.id === r.id);
  r.sentLog = [...(i >= 0 ? A.state.routes[i].sentLog || [] : []), { to: c?.name || '?', at: new Date().toISOString(), via }];
  if (i >= 0) A.state.routes[i] = r; else A.state.routes.push(r);
  S(); return r;
}
const csvH = ['component_code', 'component', 'taak', 'uitgevoerd_op', 'door', 'opmerking', 'draaiuren', 'volgende_vervaldatum_app', 'ronde'];
function exportDone() {
  const m = M(); const xs = m.signoffs.filter((s) => !s.enteredInMarad);
  const rows = [csvH.map((k) => t('csv:' + k))];
  for (const s of xs) { const task = m.tasks.find((x) => x.id === s.taskId); const c = task ? comp(task) : null; rows.push([c?.code || '', s.component, s.task, ddmmyyyy(s.doneDate), s.by, s.remarks, s.runHours ?? '', ddmmyyyy(s.nextDue), s.runId || t('handmatig')]); }
  const csv = '\ufeff' + rows.map((r) => r.map(A.csvCell).join(';')).join('\r\n');
  A.shareFile(`afgemeld-voor-marad-${todayISO()}.csv`, csv, 'text/csv', t('Afgemeld voor MARAD'), A.state.shipName);
}

export const actions = {
  mUnlockSheet: () => A.openSheet(unlockHTML()),
  mUnlock: async () => {
    const inp = $f('#mPw'), err = $f('#mPwErr'), btn = $f('#mPwBtn');
    if (busy || !inp) return; const pw = inp.value; if (!pw) return inp.focus();
    busy = true; btn.disabled = true; btn.textContent = t('Bezig…'); err.hidden = true;
    const f = fails(); const t0 = Date.now();
    // vertraging die oploopt na foute pogingen (ook over herstarts heen)
    const delay = f.n ? Math.min(1000 * 2 ** (f.n - 1), 15000) : 0;
    let data = null, msg = '';
    try {
      const r = await fetch('./data/marad.enc.json'); if (!r.ok) throw new Error('net');
      const enc = await r.json();
      try { data = await decryptBundle(enc, pw); } catch { msg = 'pw'; }
    } catch { msg = 'net'; }
    const wait = Math.max(600, delay) - (Date.now() - t0); if (wait > 0) await sleep(wait);
    busy = false;
    if (!data) {
      if (msg === 'pw') localStorage.setItem(FKEY, JSON.stringify({ n: f.n + 1, t: Date.now() }));
      inp.value = ''; btn.disabled = false; btn.textContent = t('🔓 Ontgrendelen'); err.hidden = false;
      err.textContent = msg === 'pw' ? t('Onjuist wachtwoord. Probeer het opnieuw.') + (f.n + 1 >= 2 ? ' ' + t('(volgende poging na {s} s)', { s: Math.min(2 ** f.n, 15) }) : '') : t('Kon de versleutelde gegevens niet laden (eerste keer online openen).');
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]); inp.focus(); return;
    }
    localStorage.removeItem(FKEY);
    await ensureMaint();
    const r = mergeMarad(M() || null, data, { autoLoc, file: data.file || 'marad-export' });
    A.state.maint = r.maint; A.state.maint.source = 'encrypted'; loaded = true; relink();
    S(); afterLoad(false); A.closeSheet(); A.go('onderhoud');
    A.toast(t('Ontgrendeld – {n} taken staan nu op dit toestel', { n: r.maint.tasks.length }), 4000);
  },
  mLock: async () => {
    const open_ = M()?.signoffs?.filter((x) => !x.enteredInMarad).length || 0;
    if (!confirm((open_ ? t('Let op: {n} afmeldingen zijn nog niet in MARAD ingevoerd en gaan verloren. Exporteer ze eerst.', { n: open_ }) + '\n\n' : '') + t('Lokale MARAD-kopie van dit toestel wissen? Daarna is het wachtwoord (of een nieuwe import) weer nodig.'))) return;
    A.state.maint = null; delete A.state.maint; sel.clear(); clearTimeout(pt);
    try { await OBK().del('maint'); } catch (e) { console.warn(e); }
    A.save(); A.render(); A.toast(t('Vergrendeld – lokale MARAD-kopie gewist'));
  },
  mView: (a) => { F.view = a.dataset.v; A.render(); },
  mRank: (a) => { const rs = rankSel(); const v = a.dataset.v; if (rs.has(v)) rs.delete(v); else rs.add(v); A.state.settings.rankSel = [...rs]; A.save(); sel.clear(); A.render(); },
  mRankAll: () => { A.state.settings.rankSel = []; A.save(); A.render(); },
  sgRoute: (a) => { const sg = sugBy(a.dataset.k); if (sg) makeRouteSheet({ sg, tpl: !!a.dataset.tpl }); },
  sgShow: (a) => { const sg = sugBy(a.dataset.k); if (sg) sugTasksSheet(sg); },
  sgSend: (a) => { const sg = sugBy(a.dataset.k); if (sg) sendSheet(sg, a.dataset.rank || ''); },
  sgApp: async (a) => { const c = A.state.contacts.find((x) => x.id === a.dataset.cid); if (!c?.inbox) return; const r = saveSent(c, 'app'); A.closeSheet(); A.render(); await A.deliverTo(r, c); },
  mTplRefresh: (a) => { const n = refreshTemplates(true, a.dataset.id); A.render(); A.toast(n ? t('Route ververst') : t('Niet gelukt – is MARAD ontgrendeld?')); },
  mTplStop: (a) => { if (!confirm(t('Sjabloon stoppen? De route zelf blijft bestaan.'))) return; const tp = (A.state.templates || []).find((x) => x.id === a.dataset.id); A.state.templates = (A.state.templates || []).filter((x) => x.id !== a.dataset.id); const r = tp && A.state.routes.find((x) => x.id === tp.routeId); if (r) delete r.templateId; S(); A.render(); },
  mSt: (a) => { F.st = a.dataset.v; A.render(); },
  mQuick: (a) => { F.st = a.dataset.v; F.view = 'list'; A.render(); },
  mQuickGo: (a) => { F.st = a.dataset.v; F.view = 'list'; A.go('onderhoud'); },
  mWeek: (a) => { F.wk = Math.min(0, (F.wk || 0) + +a.dataset.v); A.render(); },
  mWeekGo: () => { A.closeSheet?.(); F.view = 'week'; F.wk = 0; A.go('onderhoud'); },
  mImport: () => { preview = null; importSheet(); },
  mPickFile: () => $f('#fileMarad').click(),
  mDoImport: () => {
    const r = mergeMarad(M() || null, preview.parsed, { autoLoc, file: preview.file });
    A.state.maint = r.maint; loaded = true; S(); afterLoad(false); preview = null; A.closeSheet();
    A.toast(t('MARAD geïmporteerd: {a} nieuw, {u} bijgewerkt, {s} ongewijzigd', { a: r.added, u: r.updated, s: r.unchanged }), 4000);
    A.go('onderhoud');
  },
  mTask: (a) => taskSheet(M().tasks.find((x) => x.id === a.dataset.id)),
  mToggleSel: (a) => { const id = a.dataset.id; if (sel.has(id)) sel.delete(id); else sel.add(id); A.closeSheet(); refreshList(); },
  mSelClear: () => { sel.clear(); refreshList(); },
  mSelVisible: () => { for (const x of filtered()) sel.add(x.id); refreshList(); },
  mSelDue: () => { for (const x of M().tasks) { const st = status(x); if ((st === 'overdue' || st === 'week') && rankOk(x)) sel.add(x.id); } refreshList(); },
  mMakeRoute: () => makeRouteSheet(null),
  mCreateRoute: createRoute,
  mSignoff: (a) => {
    const x = M().tasks.find((y) => y.id === a.dataset.id);
    const rh = $f('#mdRh')?.value;
    M().signoffs.push(markDone(x, { date: $f('#mdDate').value || todayISO(), by: A.state.settings.userName || '', remarks: $f('#mdRem').value.trim(), runHours: rh ? +rh : null, compText: compText(comp(x)) }));
    S(); A.closeSheet(); A.render(); A.toast(t('Afgemeld – staat in "Afgemeld voor MARAD"'));
  },
  mUndo: (a) => {
    const m = M(); const s = m.signoffs.find((y) => y.id === a.dataset.id); if (!s || !confirm(t('Afmelding ongedaan maken?'))) return;
    const x = m.tasks.find((y) => y.id === s.taskId); if (x) undoDone(x, s);
    m.signoffs = m.signoffs.filter((y) => y !== s); S(); A.render();
  },
  mExport: exportDone,
  mEntered: () => { if (!confirm(t('Alle open afmeldingen markeren als ingevoerd in MARAD?'))) return; for (const s of M().signoffs) s.enteredInMarad = s.enteredInMarad || new Date().toISOString(); S(); A.render(); },
};
export { parseDate };
