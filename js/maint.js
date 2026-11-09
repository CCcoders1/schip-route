// Onderhoud (MARAD): overzicht als boom/lijst, koppeling aan locaties, route maken, afmelden.
// Belangrijk: de app schrijft NIET terug naar MARAD. Afmeldingen gaan naar de export "Afgemeld voor MARAD".
import { t, getLang, LOCALES } from './i18n.js';
import { parseMarad, mergeMarad, autoLocation, status, dueInDays, isHours, markDone, undoDone, todayISO, parseDate } from './marad.js';

let A; // helpers uit app.js
const F = { view: 'tree', st: 'all', rank: '', loc: '', q: '' };
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
  return { view, actions, applyRun, ensureMaint, runExtra, maradFields, persist };
}
const $f = (s) => document.querySelector(s);

// ---------- data ----------
const knownLocIds = () => new Set(A.state.locations.map((l) => l.id));
const autoLoc = (task, c) => autoLocation(task, c, knownLocIds());
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
    try { const m = await OBK().get('maint'); if (m?.tasks && !A.state.maint) A.state.maint = m; } catch (e) { console.warn('MARAD laden', e); }
    loaded = true; return M();
  })());
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
    if (F.rank && !x.rank.includes(F.rank)) return false;
    if (F.loc === '__none' ? x.locId : F.loc && x.locId !== F.loc) return false;
    if (q && !(x.name.toLowerCase().includes(q) || compText(comp(x)).toLowerCase().includes(q))) return false;
    return true;
  }).sort(byDue);
}
function counts(tasks) { const c = { overdue: 0, week: 0, month: 0, later: 0, hours: 0, none: 0 }; for (const x of tasks) c[status(x)]++; return c; }
function taskRow(x) {
  const st = status(x); const l = A.loc(x.locId);
  return `<div class="mtask st-${st}"><label class="mchk"><input type="checkbox" data-msel="${x.id}" ${sel.has(x.id) ? 'checked' : ''} aria-label="${t('Selecteren')}"></label><div class="mt-body" data-act="mTask" data-id="${x.id}">${dot(st)}<b>${A.esc(x.name)}</b><small>${isHours(x) ? '' : fmtD(x.dueDate) + ' · '}<span class="due">${dueText(x)}</span> · ${ivText(x.interval)}</small><small>${l ? '📍 ' + A.esc(A.tx(l, 'name')) : `<span class="unl">📍 ${t('niet gekoppeld')}</span>`} · 👤 ${A.esc(x.rank.join(', ') || '—')}${x.appDone ? ` · <span class="okc">✔ ${t('afgemeld {d}', { d: fmtD(x.appDone.date) })}</span>` : ''}</small></div></div>`;
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
export function view() {
  const m = M();
  let h = A.header(t('Onderhoud'));
  if (!loaded) { ensureMaint().then(() => A.render()); return h + `<p class="empty">${t('MARAD-gegevens laden…')}</p>`; }
  if (!m?.tasks) return h + unlockHTML();
  const c = counts(m.tasks);
  const open_ = m.signoffs.filter((s) => !s.enteredInMarad).length;
  h += `<p class="shipsub">🔧 MARAD · ${A.esc(m.ship || A.state.shipName)} · ${t('{n} taken', { n: m.tasks.length })} · ${t('import {d}', { d: A.fmtDT(m.lastImport?.at) })}</p>`;
  h += `<div class="mstats"><button data-act="mQuick" data-v="overdue">${dot('overdue')}<b>${c.overdue}</b><small>${t('Te laat')}</small></button><button data-act="mQuick" data-v="week">${dot('week')}<b>${c.week}</b><small>${t('≤ 7 d')}</small></button><button data-act="mQuick" data-v="month">${dot('month')}<b>${c.month}</b><small>${t('≤ 30 d')}</small></button><button data-act="mQuick" data-v="all">${dot('later')}<b>${c.later}</b><small>${t('Later')}</small></button><button data-act="mQuick" data-v="all">${dot('hours')}<b>${c.hours}</b><small>${t('Draaiuren')}</small></button></div>`;
  h += `<div class="seg mviews"><button class="${F.view === 'tree' ? 'on' : ''}" data-act="mView" data-v="tree">${t('🌳 Boom')}</button><button class="${F.view === 'list' ? 'on' : ''}" data-act="mView" data-v="list">${t('☰ Lijst')}</button><button class="${F.view === 'done' ? 'on' : ''}" data-act="mView" data-v="done">${t('✔ Afgemeld')}${open_ ? ` (${open_})` : ''}</button></div>`;
  if (F.view === 'done') return h + doneHTML();
  const ranks = [...new Set(m.tasks.flatMap((x) => x.rank))].sort();
  const stb = (k, lbl) => `<button class="${F.st === k ? 'on' : ''}" data-act="mSt" data-v="${k}">${lbl}</button>`;
  h += `<div class="seg mst">${stb('overdue', t('Te laat'))}${stb('week', t('7 dagen'))}${stb('month', t('30 dagen'))}${stb('all', t('Alles'))}</div>`;
  h += `<div class="mfilters"><input type="search" data-mf="q" value="${A.esc(F.q)}" placeholder="${t('🔍 Zoek taak of component')}"><select data-mf="rank"><option value="">${t('Alle functies')}</option>${ranks.map((r) => `<option ${r === F.rank ? 'selected' : ''}>${A.esc(r)}</option>`).join('')}</select><select data-mf="loc"><option value="">${t('Alle locaties')}</option><option value="__none" ${F.loc === '__none' ? 'selected' : ''}>${t('— niet gekoppeld —')}</option>${A.state.locations.map((l) => `<option value="${l.id}" ${l.id === F.loc ? 'selected' : ''}>${A.esc(A.tx(l, 'name'))}</option>`).join('')}</select></div>`;
  h += `<p class="muted small">${t('7/30 dagen = inclusief te laat. Gesorteerd op vervaldatum.')} <span id="mCount"></span></p>`;
  h += `<div class="row msel"><button class="btn small" data-act="mSelVisible">${t('☑ Selecteer zichtbare')}</button><button class="btn small" data-act="mSelDue">${t('☑ Te laat + 7 dagen')}</button></div>`;
  h += `<div id="mList" class="mlist">${listHTML()}</div>`;
  h += `<div class="stack"><button class="btn" data-act="mImport">${t('📥 MARAD-import')}</button></div>`;
  h += `<div id="mSelbar">${selbar()}</div>`;
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
      <dt>${t('Functie')}</dt><dd>${A.esc(x.rank.join(', ') || '—')}</dd>
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
function makeRouteSheet() {
  const tasks = M().tasks.filter((x) => sel.has(x.id));
  const nUn = tasks.filter((x) => !A.loc(x.locId)).length;
  const locs = new Set(tasks.map((x) => x.locId).filter(Boolean)).size;
  A.openSheet(`<h2>${t('🧭 Route maken uit onderhoud')}</h2><p>${t('{n} taken op {l} locaties', { n: tasks.length, l: locs })}</p>
    <label>${t('Naam')}<input id="mrName" value="${A.esc(t('Onderhoud {d}', { d: fmtD(todayISO()) }))}"></label>
    <label>${t('Bestemd voor')}<select id="mrTo"><option value="">${t('— niemand / mezelf —')}</option>${A.state.contacts.map((c) => `<option>${A.esc(c.name)}</option>`).join('')}</select></label>
    <label>${t('Volgorde')}<select id="mrStrat">${Object.entries(A.STRATEGIES).map(([k, v]) => `<option value="${k}">${A.esc(v.label)}</option>`).join('')}</select></label>
    ${nUn ? `<div class="warnbox">${t('{n} taken hebben nog geen locatie. Kies een locatie voor deze taken:', { n: nUn })}${A.locSelect(A.state.locations[0]?.id || '', 'id="mrLoc"', true)}</div>` : ''}
    <p class="muted small">${t('Elke taak krijgt de velden "Uitgevoerd ja/nee" en "Opmerking" (bij draaiuren ook de urenstand). Na de ronde worden uitgevoerde taken afgemeld en komen ze in "Afgemeld voor MARAD".')}</p>
    <div class="row sticky"><button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button><button class="btn primary" data-act="mCreateRoute">${t('Route maken')}</button></div>`);
}
function createRoute() {
  const tasks = M().tasks.filter((x) => sel.has(x.id));
  const fallback = $f('#mrLoc')?.value;
  const steps = tasks.map((x) => {
    const c = comp(x);
    const locationId = A.loc(x.locId) ? x.locId : fallback;
    return {
      id: A.rid(), locationId, title: x.name,
      instruction: [c ? (c.code ? c.code + ' – ' : '') + c.name : '', ivText(x.interval), x.rank.length ? '👤 ' + x.rank.join(', ') : ''].filter(Boolean).join(' · '),
      fields: maradFields(x), marad: { id: x.id, comp: c ? (c.code ? c.code + ' – ' : '') + c.name : '', interval: x.interval?.text || '', due: x.dueDate }, workCard: x.workCard || '',
    };
  });
  const r = { id: 'r-' + A.rid(), name: $f('#mrName').value.trim() || t('Onderhoud'), description: t('Uit MARAD: {n} taken', { n: steps.length }), assignee: $f('#mrTo').value, createdAt: Date.now(), updatedAt: Date.now(), source: 'marad', steps: A.orderSteps(steps, A.state, $f('#mrStrat').value) };
  A.state.routes.push(r); S(); sel.clear(); A.closeSheet();
  A.go('routes', { routeId: r.id }); A.toast(t('Route gemaakt met {n} taken', { n: steps.length }));
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
    A.state.maint = r.maint; A.state.maint.source = 'encrypted'; loaded = true;
    S(); A.closeSheet(); A.go('onderhoud');
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
  mSt: (a) => { F.st = a.dataset.v; A.render(); },
  mQuick: (a) => { F.st = a.dataset.v; F.view = 'list'; A.render(); },
  mImport: () => { preview = null; importSheet(); },
  mPickFile: () => $f('#fileMarad').click(),
  mDoImport: () => {
    const r = mergeMarad(M() || null, preview.parsed, { autoLoc, file: preview.file });
    A.state.maint = r.maint; loaded = true; S(); preview = null; A.closeSheet();
    A.toast(t('MARAD geïmporteerd: {a} nieuw, {u} bijgewerkt, {s} ongewijzigd', { a: r.added, u: r.updated, s: r.unchanged }), 4000);
    A.go('onderhoud');
  },
  mTask: (a) => taskSheet(M().tasks.find((x) => x.id === a.dataset.id)),
  mToggleSel: (a) => { const id = a.dataset.id; if (sel.has(id)) sel.delete(id); else sel.add(id); A.closeSheet(); refreshList(); },
  mSelClear: () => { sel.clear(); refreshList(); },
  mSelVisible: () => { for (const x of filtered()) sel.add(x.id); refreshList(); },
  mSelDue: () => { for (const x of M().tasks) { const st = status(x); if (st === 'overdue' || st === 'week') sel.add(x.id); } refreshList(); },
  mMakeRoute: makeRouteSheet,
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
