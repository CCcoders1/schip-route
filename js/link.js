// v1.12 Koppelen + direct plaatsen + voortgang – zonder accounts of inlog.
// Elk toestel heeft een eigen inbox-kanaal (settings.inboxTopic, anoniem ntfy). Beheer koppelt iemand één keer via een
// plakcode (naam, rang, inbox, server, toestel-id). Daarna gaan lijstjes als (gedeelde) berichten naar die inbox, via de
// bestaande outbox (offline: wachtrij). Bemanning haalt de eigen inbox op en importeert automatisch; stuurt een
// ontvangstbevestiging en voortgang (gestart / bezig) terug naar het meldingskanaal van Beheer.
import { t, tx, getLang, LOCALES } from './i18n.js';
import { RANK_IDS, RANK_ICON, normRank, rankLabel } from './ranks.js';
import { routePackage, encodePayload, decodePayload } from './share.js';

let A;
const esc = (s) => A.esc(s);
const ST = () => A.state.settings;
const CHUNK = 3000; // tekens per bericht (ntfy.sh: max. 4096 bytes per bericht; base64url = 1 byte per teken)
const REPUBLISH_MS = 6 * 3600e3; // ntfy.sh bewaart ±12 uur → na 6 uur zonder ontvangst opnieuw plaatsen
const GIVEUP_MS = 4 * 864e5;
let P = { seen: {}, runs: {} }; // voortgang (Beheer), in IndexedDB
let pLoaded = false;

export function initLink(api) {
  A = api;
  self.OutboxCore?.kv.get('progress').then((v) => { if (v) { P = { seen: v.seen || {}, runs: v.runs || {} }; if (dedupeRuns()) savePg(); } pLoaded = true; if (['voortgang', 'vandaag'].includes(A.view().tab)) A.render(); }).catch(() => { pLoaded = true; });
  return { pairView, progressView, todayBanner, actions, pollInbox, handleMgrMsg, retry, deliver, progressEvent, pairedFor, chunkItems, pairSheet, doneAfter, paired, syncDone, busyList, sentState, runIdsFor, progressPeople, reopenEvent, progressData: () => P };
}
/** Voortgang per persoon + ronde: één rij (nieuwe start / opnieuw versturen werkt die rij bij i.p.v. te stapelen). */
const pkey = (e) => String(e.dev || e.by || '?').toLowerCase() + '|' + (e.route || e.rn || '');
/** v1.13: oude opslag (per run-id) samenvoegen tot één rij per persoon + ronde (nieuwste telt). Geeft true als er iets veranderde. */
function dedupeRuns() {
  const out = {}; let ch = false;
  for (const [k, x] of Object.entries(P.runs)) {
    const nk = pkey(x); if (nk !== k) ch = true;
    if (!out[nk] || (x.at || '') > (out[nk].at || '')) { if (out[nk]) ch = true; out[nk] = x; } else ch = true;
  }
  P.runs = out; return ch;
}
const savePg = () => self.OutboxCore?.kv.put('progress', P).catch((e) => console.warn('progress', e));

// ---------- koppelcode ----------
const b64u = (str) => { const b = new TextEncoder().encode(str); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => { const r = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return new TextDecoder().decode(Uint8Array.from(r, (c) => c.charCodeAt(0))); };
export function pairCode() {
  const st = ST();
  return 'SRK1-' + b64u(JSON.stringify({ v: 1, name: String(st.userName || '').trim(), rank: normRank(st.myRank) || '', inbox: st.inboxTopic, server: st.inboxServer || 'https://ntfy.sh', dev: st.deviceId, lang: st.lang || 'nl' }));
}
export function parsePairCode(text) {
  const m = String(text || '').match(/SRK1-([A-Za-z0-9_-]{10,})/); if (!m) return null;
  let o; try { o = JSON.parse(unb64u(m[1])); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const name = String(o.name || '').trim().slice(0, 60), rank = normRank(o.rank);
  if (!name || !/^[A-Za-z0-9_-]{6,64}$/.test(o.inbox || '') || !/^https?:\/\/[^\s/]+/.test(o.server || '') || !/^[A-Za-z0-9_-]{3,40}$/.test(o.dev || '')) return null;
  return { name, rank: RANK_IDS.includes(rank) ? rank : '', inbox: o.inbox, server: String(o.server).replace(/\/+$/, ''), dev: o.dev, lang: o.lang || '' };
}
const paired = () => A.state.contacts.filter((c) => c.inbox);
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
/** Gekoppelde persoon voor een ontvanger (naam eerst; zonder naam: de enige gekoppelde met die rang). */
export function pairedFor(who) {
  const ps = paired();
  if (who.name) return ps.find((c) => same(c.name, who.name)) || null;
  const xs = ps.filter((c) => normRank(c.func) === who.rank);
  return xs.length === 1 ? xs[0] : null;
}
function addPaired(o) {
  const cs = A.state.contacts;
  let c = cs.find((x) => x.deviceId === o.dev) || cs.find((x) => same(x.name, o.name));
  if (!c) { c = { id: 'c-' + A.rid(), name: o.name, phone: '', email: '' }; cs.push(c); }
  Object.assign(c, { name: o.name, func: o.rank || c.func || '', inbox: o.inbox, inboxServer: o.server, deviceId: o.dev, pairedAt: new Date().toISOString() });
  A.save(); return c;
}
function seen(dev, name) {
  const c = A.state.contacts.find((x) => (dev && x.deviceId === dev) || (!dev && name && x.inbox && same(x.name, name)));
  if (c) { c.lastSeen = new Date().toISOString(); return true; } return false;
}

// ---------- berichten in stukken (ntfy-limiet) ----------
/* i18n-skip-start */
export async function chunkItems(pkg, { kind, aid, ver, topic, server, title, by = '' }) {
  const data = await encodePayload(pkg); const n = Math.max(1, Math.ceil(data.length / CHUNK)); const now = new Date().toISOString();
  return Array.from({ length: n }, (_, i) => ({
    id: 'm-' + A.rid(), kind: kind === 'route' ? 'lijst' : 'rapportdeel', createdAt: now, by, text: '', priority: kind === 'route' ? 3 : 1,
    title: n > 1 ? `${title} (${i + 1}/${n})` : title, tags: kind === 'route' ? ['package'] : ['card_index_dividers'],
    message: 'SRX1 ' + JSON.stringify({ a: aid, v: ver, i: i + 1, n, k: kind }) + '\n' + data.slice(i * CHUNK, (i + 1) * CHUNK),
    topic, server, chunk: { a: aid, v: ver, i: i + 1, n },
  }));
}
/* i18n-skip-end */
/** Stukken verzamelen; geeft het complete pakket terug zodra alle delen er zijn (anders null). */
async function takeChunk(m) {
  const txt = m.message || ''; const nl = txt.indexOf('\n'); if (!txt.startsWith('SRX1 ') || nl < 0) return null;
  let h; try { h = JSON.parse(txt.slice(5, nl)); } catch { return null; }
  if (!h?.a || !h.n || !h.i) return null;
  const C = (A.state.chunks ||= {}); const key = h.k + ':' + h.a + '@' + h.v;
  const e = (C[key] ||= { n: h.n, p: {}, at: Date.now(), k: h.k });
  e.p[h.i] = txt.slice(nl + 1);
  for (const [k, x] of Object.entries(C)) if (Date.now() - x.at > 3 * 864e5) delete C[k];
  if (Object.keys(e.p).length < e.n) { A.save(); return { partial: true }; }
  const data = Array.from({ length: e.n }, (_, i) => e.p[i + 1]).join('');
  delete C[key]; A.save();
  try { return { pkg: await decodePayload(data), h }; } catch (err) { console.warn('chunk', err); return null; }
}

// ---------- Beheer: direct plaatsen ----------
/** Pakket voor één ontvanger: het lijstje staat bij hem onder "Voor jou" (ook als dezelfde route naar meerdere mensen gaat). */
function pkgFor(r, c, ver) {
  const pkg = routePackage(A.state, r, c.name); pkg.asg = { id: r.id, ver, to: c.deviceId || '' };
  if (pkg.route) pkg.route.intendedName = c.name;
  return pkg;
}
/** Is deze opdracht na plaatsing al afgerond (rapport van de bemanning binnen)? */
export function doneAfter(routeId, ver, excl = null) { return A.state.runs.find((x) => x.routeId === routeId && x.received && x.finishedAt && new Date(x.finishedAt).getTime() >= (ver || 0) && !excl?.includes(x.id)) || null; }
/** v1.19: alle bekende ronde-id's van een lijstje (rapporten + voortgangsrijen) – bij opnieuw sturen tellen die niet meer mee. */
export function runIdsFor(routeId) { return [...new Set([...A.state.runs.filter((x) => x.routeId === routeId).map((x) => x.id), ...Object.values(P.runs).filter((x) => x.route === routeId).map((x) => x.run)].filter(Boolean))]; }
export async function deliver(r, c, sentKey, { quiet = false } = {}) {
  const st = ST(); const ver = Date.now();
  r.assignee = r.assignee || c.name;
  const pkg = pkgFor(r, c, ver);
  const items = await chunkItems(pkg, { kind: 'route', aid: r.id, ver, topic: c.inbox, server: c.inboxServer || 'https://ntfy.sh', title: `📋 ${tx(r, 'name')} · ${r.steps.length}`, by: st.userName || '' });
  const D = (A.state.dist ||= {}); D.sent ||= {};
  const s = (D.sent[sentKey] ||= {});
  Object.assign(s, { via: 'app', aid: r.id, ver, to: c.id, toName: c.name, pubAt: new Date().toISOString(), parts: items.length, ackVer: s.ackVer && s.ackVer >= ver ? s.ackVer : 0, ackAt: s.ackVer >= ver ? s.ackAt : null, pgAt: null, doneSent: 0 });
  A.save();
  await A.queueQuiet(items);
  if (!quiet) deliveredSheet(r, c, items.length);
  return items.length;
}
function deliveredSheet(r, c, n) {
  const on = navigator.onLine;
  A.openSheet(`<h2>📬 ${t('Wordt geplaatst bij {name}', { name: esc(c.name) })}</h2>
    <p><b>${esc(tx(r, 'name'))}</b> · ${t('{n} taken', { n: r.steps.length })}</p>
    <p class="${on ? 'okbox' : 'warnbox'}">${on ? t('Het lijstje komt automatisch in de app van {name}. {name} heeft internet nodig om het te ontvangen.', { name: esc(c.name) }) : t('📴 Geen internet: het lijstje staat in de outbox en gaat vanzelf weg zodra er verbinding is.')}</p>
    <p class="muted small">${t('Verstuurd in {n} bericht(en). Je ziet onder Voortgang wanneer het is ontvangen.', { n })}</p>
    <div class="stack"><button class="btn primary big" data-act="closeSheet">${t('OK')}</button></div>`);
}
/** Openstaande lijstjes (nog niet ontvangen) opnieuw plaatsen zolang ntfy ze mogelijk al heeft weggegooid. */
export async function retry(force = false) {
  const D = A.state.dist; if (!D?.sent || !navigator.onLine) return 0;
  let n = 0;
  for (const [k, s] of Object.entries(D.sent)) {
    if (s.via !== 'app' || (s.ackVer && s.ackVer >= s.ver)) continue;
    if (Date.now() - s.ver > GIVEUP_MS) continue;
    if (!force && Date.now() - new Date(s.pubAt).getTime() < REPUBLISH_MS) continue;
    const r = A.state.routes.find((x) => x.id === s.aid), c = A.state.contacts.find((x) => x.id === s.to);
    if (!r || !c?.inbox) continue;
    if (doneAfter(r.id, s.ver, s.reRuns)) continue; // al afgerond (rapport binnen) – niet opnieuw plaatsen
    const ver = s.ver; const pkg = pkgFor(r, c, ver);
    const items = await chunkItems(pkg, { kind: 'route', aid: r.id, ver, topic: c.inbox, server: c.inboxServer, title: `📋 ${tx(r, 'name')} · ${r.steps.length}`, by: ST().userName || '' });
    s.pubAt = new Date().toISOString(); s.tries = (s.tries || 0) + 1; A.save();
    await A.queueQuiet(items); n++;
  }
  return n;
}

/** Beheer → bemanning: welke taken van een geplaatst lijstje zijn al afgetekend (door wie dan ook, ook Beheer zelf).
 *  Zo verdwijnt het lijstje bij de volgende ophaalbeurt op het toestel van de bemanning uit het open werk. */
export async function syncDone() {
  const tasks = A.state.maint?.tasks; if (A.isCrew() || !tasks) return 0;
  const byId = new Map(tasks.map((x) => [x.id, x])); const items = [];
  for (const s of Object.values(A.state.dist?.sent || {})) {
    if (s.via !== 'app' || !s.aid || !s.to || Date.now() - s.ver > GIVEUP_MS * 2) continue;
    const r = A.state.routes.find((x) => x.id === s.aid), c = A.state.contacts.find((x) => x.id === s.to);
    if (!r || !c?.inbox) continue;
    const day = dayKey(new Date(s.ver).toISOString());
    const done = r.steps.filter((st) => { const tk = st.marad?.id && byId.get(st.marad.id); return tk?.appDone?.date >= day; }).map((st) => st.id);
    if (!done.length || done.length <= (s.doneSent || 0)) continue;
    s.doneSent = done.length; const all = done.length === r.steps.length;
    /* i18n-skip-start */
    items.push({ id: 'm-' + A.rid(), kind: 'afgerond', createdAt: new Date().toISOString(), by: ST().userName || '', text: '', priority: 1, tags: ['white_check_mark'],
      title: `✅ ${tx(r, 'name')}: ${done.length}/${r.steps.length} afgetekend`, message: 'SRD1 ' + JSON.stringify({ a: r.id, v: s.ver, d: done, all, at: new Date().toISOString() }), topic: c.inbox, server: c.inboxServer || 'https://ntfy.sh' });
    /* i18n-skip-end */
  }
  if (items.length) { A.save(); await A.queueQuiet(items); }
  return items.length;
}
// ---------- Beheer: berichten uit het eigen meldingskanaal ----------
/** true = bericht hoort bij koppelen/voortgang en is verwerkt (niet als gewone melding tonen). */
export async function handleMgrMsg(m) {
  const txt = m.message || '';
  if (txt.startsWith('SRA1 ')) {
    let e; try { e = JSON.parse(txt.slice(5).split('\n')[0]); } catch { return true; }
    for (const s of Object.values(A.state.dist?.sent || {})) if (s.aid === e.a && e.v > (s.ackVer || 0)) { s.ackVer = e.v; s.ackAt = e.at || new Date().toISOString(); }
    seen(e.dev, e.name); A.save(); return true;
  }
  if (txt.startsWith('SRP1 ')) {
    let e; try { e = JSON.parse(txt.slice(5).split('\n')[0]); } catch { return true; }
    if (!e?.id || P.seen[e.id]) return true;
    P.seen[e.id] = 1;
    const key = pkey(e); const cur = P.runs[key] || {};
    // nieuwere gebeurtenis (of een nieuwe start van dezelfde ronde) vervangt de rij – nooit een tweede rij
    // v1.18: elk bericht over een geplaatst lijstje telt als "ontvangen" (ook als de ontvangstbevestiging nog onderweg is)
    for (const s_ of Object.values(A.state.dist?.sent || {})) if (s_.via === 'app' && s_.aid === e.route && new Date(e.at).getTime() >= (s_.ver || 0) - 6e4 && !(s_.pgAt >= e.at)) s_.pgAt = e.at;
    if (e.ro && typeof e.ro === 'object') crewReopen(e);
    if (!cur.at || e.at >= cur.at) P.runs[key] = { run: e.run, route: e.route, rn: e.rn, by: e.by, rank: e.rank, dev: e.dev, done: e.done, n: e.n, k: e.k, at: e.at, startedAt: e.run === cur.run ? (cur.startedAt || e.st) : (e.st || e.at), ...(Array.isArray(e.rs) ? { rs: e.rs.slice(0, 120) } : e.run === cur.run && cur.rs ? { rs: cur.rs } : {}) };
    seen(e.dev, e.by); A.save(); savePg(); return true;
  }
  if (txt.startsWith('SRX1 ')) {
    const r = await takeChunk(m);
    if (r?.pkg?.kind === 'report') { seen(null, r.pkg.by); await A.autoImportReport(r.pkg, 'ntfy', true); }
    return true;
  }
  return false;
}

// ---------- bemanning: eigen inbox ophalen ----------
let inboxBusy = false;
export async function pollInbox(manual = false) {
  const st = ST();
  if (inboxBusy || !A.isCrew() || !st.inboxTopic) return 0;
  if (!navigator.onLine) { if (manual) A.toast(t('Geen internet')); return 0; }
  inboxBusy = true; let got = 0;
  try {
    const base = (st.inboxServer || 'https://ntfy.sh').replace(/\/+$/, '');
    const r = await fetch(`${base}/${encodeURIComponent(st.inboxTopic)}/json?poll=1&since=${encodeURIComponent(st.inboxPollId || '24h')}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('ntfy ' + r.status);
    const msgs = (await r.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((m) => m?.event === 'message');
    for (const m of msgs) {
      if ((m.message || '').startsWith('SRD1 ')) { if (applyDone(m.message)) got++; continue; }
      const c = await takeChunk(m);
      if (c?.pkg?.kind === 'route' && c.pkg.asg) { if (await receive(c.pkg)) got++; }
    }
    if (msgs.length) st.inboxPollId = msgs[msgs.length - 1].id;
    st.inboxPolledAt = new Date().toISOString(); A.save();
    if (got) { A.render(); } else if (manual) A.toast(t('Geen nieuwe lijstjes'));
  } catch (e) { console.warn('inbox', e); if (manual) A.toast(t('Ophalen lukte niet: {msg}', { msg: e.message }), 4000); }
  finally { inboxBusy = false; }
  return got;
}
/** Bemanning: Beheer meldt dat taken uit een lijstje al zijn afgetekend (ook als Beheer het zelf deed). */
function applyDone(txt) {
  let e; try { e = JSON.parse(txt.slice(5).split('\n')[0]); } catch { return false; }
  const r = A.state.routes.find((x) => x.id === e?.a); if (!r || (r.asgVer && e.v < r.asgVer)) return false;
  const ids = new Set([...(r.stepsDone || []), ...(e.d || [])].filter((id) => r.steps.some((s) => s.id === id)));
  const before = (r.stepsDone || []).length + (r.doneAt ? 1 : 0);
  r.stepsDone = [...ids];
  if ((e.all || ids.size >= r.steps.length) && !r.doneAt) {
    r.doneAt = e.at || new Date().toISOString(); r.doneBy = 'beheer';
    const ar = A.state.activeRun; if (ar?.routeId === r.id && !ar.results?.length) A.state.activeRun = null; // nog niets ingevuld: lopende ronde is overbodig
    const pr = A.state.parkedRuns?.[r.id]; if (pr && !pr.results?.length) delete A.state.parkedRuns[r.id];
  }
  A.save(); return r.stepsDone.length + (r.doneAt ? 1 : 0) > before;
}
async function receive(pkg) {
  const st = ST(); const { id: aid, ver } = pkg.asg;
  const R = (st.recvAsg ||= {});
  const dup = R[aid] && R[aid] >= ver;
  if (!dup) {
    const r = A.importPackage(pkg, false); r.via = 'inbox'; r.asgVer = ver;
    R[aid] = ver; st.inboxLastAt = new Date().toISOString(); A.save();
    A.toast(t('📋 Nieuw lijstje: {name} · {n} taken', { name: tx(r, 'name'), n: r.steps.length }), 4000);
  }
  // ontvangstbevestiging (ook bij een herhaalde plaatsing, zodat Beheer stopt met opnieuw plaatsen)
  const AK = (st.ackSent ||= {}); const ak = aid + '@' + ver;
  if (!AK[ak] || Date.now() - AK[ak] > 3600e3) {
    const topic = pkg.notify?.topic; if (topic) {
      AK[ak] = Date.now(); A.save();
      const name = st.userName || '';
      /* i18n-skip-start */
      await A.queueQuiet([{ id: 'm-' + A.rid(), kind: 'ack', createdAt: new Date().toISOString(), by: name, text: '', priority: 1, tags: ['white_check_mark'],
        title: `✅ ${name}: ${tx(pkg.route, 'name')} ontvangen`, message: 'SRA1 ' + JSON.stringify({ a: aid, v: ver, dev: st.deviceId, name, rank: normRank(st.myRank) || '', at: new Date().toISOString() }),
        topic, server: pkg.notify.server || 'https://ntfy.sh' }]);
      /* i18n-skip-end */
    }
  }
  return !dup;
}

// ---------- v1.21: Beheer – taak heropend door de bemanning ----------
function crewReopen(e) {
  const ro = e.ro; if (!ro.step || !e.route) return;
  const hits = Object.entries(A.state.dist?.sent || {}).filter(([, s]) => s.via === 'app' && s.aid === e.route);
  const at = e.at || new Date().toISOString(); let inMarad = false, rec = null;
  if (ro.marad && A.MT?.reopenSignoffs) {
    const m = A.state.maint; const es = (m?.signoffs || []).filter((x) => x.taskId === ro.marad && (!ro.run || x.runId === ro.run || x.runId === ro.nrun));
    inMarad = es.some((x) => x.enteredInMarad);
    if (es.length) rec = A.MT.reopenSignoffs([ro.marad], es.map((x) => x.doneDate).sort()[0], { reason: t('Heropend door {name} (bemanning)', { name: e.by || '?' }), sentKey: hits[0]?.[0] || '', to: e.by || '', route: e.route });
    if (rec) Object.assign(rec, { via: 'crew', crewBy: e.by || '', step: ro.step, run: ro.run || '' });
  }
  for (const [, s] of hits) {
    if (ro.run && ro.run !== ro.nrun && !(s.reRuns ||= []).includes(ro.run)) s.reRuns.push(ro.run);
    (s.crewReopen ||= {})[ro.step] = { by: e.by || '', at, inMarad, rec: rec?.id || null };
  }
  const run = A.state.runs.find((x) => x.id === ro.run); const rr = run?.results?.find((x) => x.stepId === ro.step);
  if (rr) rr.reopened = { by: e.by || '', at };
  if (inMarad) A.toast(t('↩ {name} heeft een taak heropend die al in MARAD is ingevoerd – zet hem daar ook terug.', { name: e.by || '?' }), 6000);
}

// ---------- bemanning: voortgang ----------
let lastPg = 0, pgT = 0; const PG_MS = 20000;
/** v1.21: bemanning heeft één taak heropend → zelfde voortgangsbericht (SRP1) met `ro`; oudere Beheer-versies zien gewoon een "bezig"-stand. */
export function reopenEvent(ar, ro) { if (!ar) return; ar.pgDirty = true; ar.pgRo = ro; return progressEvent('paused', ar); }
export async function progressEvent(k, arIn = null) {
  if (!A.isCrew()) return;
  const ar = arIn || A.state.activeRun; const topic = ar?.route.notifyTopic; if (!topic) return;
  // v1.18: tussenstand hooguit elke 20 s, maar de laatste stand gaat altijd mee (achteraf), zodat Beheer niet op 0/x blijft staan
  if (k === 'step' && Date.now() - lastPg < PG_MS) { ar.pgDirty = true; clearTimeout(pgT); const id = ar.id; pgT = setTimeout(() => { const cur = A.state.activeRun; if (cur?.id === id && cur.pgDirty) progressEvent('step'); }, PG_MS - (Date.now() - lastPg) + 50); return; }
  if (k === 'paused' && !ar.pgDirty) return;
  lastPg = Date.now(); ar.pgDirty = false;
  const st = ST(); const name = st.userName || '';
  const e = { id: 'pe-' + A.rid(), k, run: ar.id, route: ar.routeId, rn: tx(ar.route, 'name'), by: name, rank: normRank(st.myRank) || '', dev: st.deviceId, done: new Set(ar.results.map((x) => x.stepId)).size, n: ar.route.steps.length, at: new Date().toISOString(), st: ar.startedAt };
  // v1.21: welke taken al gedaan zijn (compact: [stap, d/p/s, sec na start]) – oudere Beheer-versies negeren dit veld
  const t0 = new Date(ar.startedAt || e.at).getTime(); const seenS = new Set();
  e.rs = ar.results.filter((x) => x.stepId && !seenS.has(x.stepId) && seenS.add(x.stepId)).slice(-90).map((x) => [x.stepId, String(x.status || 'd')[0], Math.round((new Date(x.at || e.at).getTime() - t0) / 1000)]);
  if (ar.pgRo) { e.ro = ar.pgRo; delete ar.pgRo; } // v1.21: één taak heropend door de bemanning
  /* i18n-skip-start */
  await A.queueQuiet([{ id: 'm-' + A.rid(), kind: 'voortgang', createdAt: e.at, by: name, text: '', priority: 1, tags: ['hourglass'],
    title: `⏳ ${name}: ${e.rn} ${e.done}/${e.n}`, message: 'SRP1 ' + JSON.stringify(e), topic, server: ar.route.notifyServer || 'https://ntfy.sh' }]);
  /* i18n-skip-end */
}

// ---------- schermen ----------
function dayKey(iso) { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); }
function dayLabel(k) {
  const td = dayKey(new Date().toISOString()), y = dayKey(new Date(Date.now() - 864e5).toISOString());
  if (k === td) return t('Vandaag'); if (k === y) return t('Gisteren');
  return new Date(k + 'T12:00:00').toLocaleDateString(LOCALES[getLang()], { weekday: 'long', day: 'numeric', month: 'long' });
}
const tm = (iso) => new Date(iso).toLocaleTimeString(LOCALES[getLang()], { hour: '2-digit', minute: '2-digit' });
/** Aantal taken van die ronde dat in Beheer al is afgetekend sinds de start (door de bemanning óf door Beheer zelf). */
function signedOf(x) {
  const rt = A.state.routes.find((r) => r.id === x.route); const tasks = A.state.maint?.tasks;
  if (!rt || !tasks) return { n: 0, all: false };
  const ids = rt.steps.map((s) => s.marad?.id).filter(Boolean); if (!ids.length) return { n: 0, all: false };
  const day = dayKey(x.startedAt || x.at); const byId = new Map(tasks.map((t_) => [t_.id, t_]));
  const n = ids.filter((id) => byId.get(id)?.appDone?.date >= day).length;
  return { n, all: n === rt.steps.length };
}
/** Afgerond of afgebroken? (afgerond-melding, rapport binnen, of alle taken al afgetekend) */
function closed(x) {
  if (x.k === 'done' || x.k === 'aborted') return true;
  const st = x.startedAt || x.at;
  if (A.state.runs.some((r) => r.id === x.run || (r.routeId === x.route && r.finishedAt && r.finishedAt >= st && (!x.by || !r.by || same(r.by, x.by))))) return true;
  return signedOf(x).all;
}
export function busyList() {
  const open = Object.values(P.runs).filter((x) => !closed(x) && Date.now() - new Date(x.at).getTime() < 20 * 3600e3);
  // v1.18: één toestel heeft maar één lopende ronde – een oudere "bezig"-rij van hetzelfde toestel is onderbroken (niet bezig)
  const top = new Map(); for (const x of open) { const d = String(x.dev || x.by || '?').toLowerCase(); if (!top.has(d) || x.at > top.get(d).at) top.set(d, x); }
  return [...top.values()].map((x) => ({ ...x, done: Math.max(x.done || 0, signedOf(x).n) })).sort((a, b) => b.at.localeCompare(a.at));
}
/** v1.18: één stand per verstuurd lijstje (dist.sent), met dezelfde sleutel als Verstuurde lijstjes:
 *  onderweg → ontvangen → bezig → afgerond. Zo tellen Voortgang en Verstuurde lijstjes altijd hetzelfde. */
export function sentState(s) {
  if (!s) return { st: 'none' };
  if (s.via === 'self') return { st: 'self' };
  if (s.via !== 'app') return { st: 'legacy' };
  const r = A.state.routes.find((x) => x.id === s.aid); const n = r?.steps.length || s.n || 0; const ver = s.ver || 0;
  const ex = s.reRuns || null; // v1.19: rondes van vóór het opnieuw sturen tellen niet mee
  const rows = Object.values(P.runs).filter((x) => x.route === s.aid && new Date(x.at).getTime() >= ver - 6e4 && !ex?.includes(x.run)).sort((a, b) => b.at.localeCompare(a.at));
  const fin = doneAfter(s.aid, ver, ex);
  if (fin) return { st: 'done', at: fin.finishedAt, by: fin.by || s.toName, n };
  const dr = rows.find((x) => x.k === 'done'); if (dr) return { st: 'done', at: dr.at, by: dr.by || s.toName, n };
  if (r && n) { const sg = signedOf({ route: s.aid, startedAt: new Date(ver).toISOString() }); if (sg.all) return { st: 'done', at: null, by: '', n, signed: true }; }
  const b = busyList().find((x) => x.route === s.aid && new Date(x.at).getTime() >= ver - 6e4 && !ex?.includes(x.run));
  if (b) return { st: 'busy', row: b, done: b.done, n };
  const last = rows[0];
  if ((s.ackVer && s.ackVer >= ver) || s.pgAt || last) return { st: 'recv', at: s.ackAt || s.pgAt || last?.at, row: last || null, done: Math.max(last?.done || 0, r ? signedOf({ route: s.aid, startedAt: new Date(ver).toISOString() }).n : 0), n };
  return { st: 'pending', n };
}
/** v1.19: knop "Opnieuw sturen" (of de markering "opnieuw gestuurd") onder een afgeronde ronde van een verstuurd lijstje. */
function reopenFor(run) {
  if (!run.routeId) return '';
  const hit = Object.entries(A.state.dist?.sent || {}).find(([, s]) => (s.aid || s.routeId) === run.routeId && s.list && s.rank); if (!hit) return '';
  const [k, s] = hit;
  if (s.reRuns?.includes(run.id)) return `<p class="small prun-ro">↩ ${t('Opnieuw gestuurd {d}', { d: A.fmtDT(s.reopened?.at || s.pubAt || s.at) })}${s.reopened?.n ? ' · ' + t('{n} taken', { n: s.reopened.n }) : ''}</p>`;
  const ok = s.via === 'self' ? !!run.finishedAt && run.finishedAt >= s.at : s.via === 'app' && sentState(s).st === 'done';
  return ok ? `<div class="prun-act"><button class="btn small reopenbtn" data-act="distReopen" data-k="${esc(k)}">↩ ${t('Opnieuw sturen')}</button></div>` : '';
}
const sentRows = () => Object.entries(A.state.dist?.sent || {}).filter(([, s]) => s.list && s.rank).map(([k, s]) => ({ k, s, x: sentState(s) }));
/** Afgeronde rondes: rapporten/eigen rondes + 'afgerond'-meldingen waarvan het rapport nog onderweg is. */
const finished = () => {
  const rs = A.state.runs.filter((r) => r.finishedAt);
  const extra = Object.values(P.runs).filter((x) => x.k === 'done' && !rs.some((r) => r.id === x.run)).map((x) => ({ id: x.run, routeId: x.route, routeName: x.rn, by: x.by, finishedAt: x.at, results: [], pgDone: x.done || x.n || 0, received: { via: 'voortgang' } }));
  return [...rs, ...extra];
};
function counts(run) { const c = { done: run.pgDone || 0, problem: 0, skipped: 0 }; for (const x of run.results || []) c[x.status] = (c[x.status] || 0) + 1; return c; }
export function todayBanner() {
  const b = busyList().length; const td = dayKey(new Date().toISOString());
  const nT = finished().filter((r) => dayKey(r.finishedAt) === td).reduce((a, r) => a + counts(r).done, 0);
  return `<button class="card tap rankbanner progbanner" data-act="goProgress">📊 <b>${t('Voortgang')}</b><small>${t('{a} bezig · {b} taken vandaag afgerond', { a: b, b: nT })} · 👥 ${t('{n} gekoppeld', { n: paired().length })}</small></button>`;
}
// ---------- v1.21: Voortgang per persoon (overzicht → tab per persoon, per taak gedaan / nog te doen) ----------
const PG_ORDER = ['busy', 'recv', 'pending', 'legacy', 'done'];
const PG_ST = () => ({ pending: ['📬', t('Onderweg')], recv: ['📥', t('Ontvangen')], busy: ['⏳', t('Bezig')], done: ['✅', t('Klaar')], legacy: ['⚪', t('Niet in de app')] });
const todayKey = () => dayKey(new Date().toISOString());
const pidOf = (name, rank) => (String(name || '').trim() ? 'n:' + String(name).trim().toLowerCase() : 'r:' + (normRank(rank) || '?'));
const locOf = (id) => A.state.locations?.find((l) => l.id === id) || null;
const RS = { d: 'done', p: 'problem', s: 'skipped' };
const isDone = (st) => st === 'done' || st === 'problem';
function valsOf(x) {
  const out = []; let rem = '';
  for (const f of x?.fields || []) {
    const v = x.values?.[f.id]; if (v == null || v === '' || f.type === 'check' || f.role === 'mDone') continue;
    if (f.role === 'mRem') { rem = String(v); continue; }
    out.push(`${tx(f, 'label')}: ${v}${f.unit ? ' ' + f.unit : ''}`);
  }
  return { vals: out, rem };
}
/** Per stap van een lijstje: gedaan (✔/⚠/↷, tijd, waardes, opmerking) of nog te doen – uit rapporten, eigen rondes,
 *  live voortgang (v1.21-telefoons sturen de gedane stappen mee) en MARAD-afmeldingen. */
function stepStates(r, sinceISO, ex, cro) {
  const since = new Date(sinceISO || 0).getTime() - 6e4; ex = ex || [];
  const res = new Map();
  const put = (x, by) => { if (!x?.stepId) return; const p = res.get(x.stepId); if (!p || String(x.at || '') >= String(p.at || '') || (p.live && !x.live)) res.set(x.stepId, { ...x, by: x.by || by || '' }); };
  for (const row of Object.values(P.runs).filter((x) => x.route === r.id && x.rs && x.k !== 'aborted' && new Date(x.at).getTime() >= since && !ex.includes(x.run)).sort((a, b) => a.at.localeCompare(b.at))) {
    const t0 = new Date(row.startedAt || row.at).getTime();
    for (const [id, c, sec] of row.rs) put({ stepId: id, status: RS[c] || 'done', at: new Date(t0 + (+sec || 0) * 1000).toISOString(), live: true }, row.by);
  }
  for (const ar of [A.state.parkedRuns?.[r.id], A.state.activeRun?.routeId === r.id ? A.state.activeRun : null]) for (const x of ar?.results || []) put(x, ar.by || ST().userName);
  for (const run of A.state.runs.filter((x) => x.routeId === r.id && x.finishedAt && new Date(x.finishedAt).getTime() >= since && !ex.includes(x.id)).sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))) for (const x of run.results || []) put(x, run.by);
  const day = dayKey(sinceISO || new Date().toISOString()); const tasks = A.state.maint?.tasks || []; const byId = new Map(tasks.map((x) => [x.id, x]));
  const byMarad = new Map([...res.values()].filter((x) => x.marad?.id).map((x) => [x.marad.id, x]));
  return r.steps.map((st, i) => {
    const x = res.get(st.id) || (st.marad?.id && byMarad.get(st.marad.id)) || null;
    const tk = st.marad?.id && byId.get(st.marad.id); const ad = tk?.appDone;
    const so = ad?.date && ad.date >= day ? { date: ad.date, ...((tk.doneLog || []).filter((z) => z.date === ad.date).at(-1) || {}) } : null;
    let status = x?.status || 'todo'; if (so && !isDone(status)) status = 'done';
    const { vals, rem } = valsOf(x); const l = locOf(st.locationId);
    return { id: st.id, i, title: tx(st, 'title') || st.title || '', loc: l ? tx(l, 'name') : '', li: l ? A.state.locations.indexOf(l) : 999, status,
      at: x?.at || null, day: x?.at ? dayKey(x.at) : so?.date || null, by: x?.by || so?.by || '', vals, note: x?.note || '', rem: rem || so?.remarks || '',
      tnote: st.note || '', custom: !!st.custom || st.source === 'custom', marad: !!st.marad?.id, signed: !!so, live: !!x?.live,
      ro: status === 'todo' && cro?.[st.id] ? cro[st.id] : null };
  });
}
function selfSt(s, r, tasks) {
  if (A.state.runs.some((x) => x.routeId === r.id && x.finishedAt && x.finishedAt >= s.at && !s.reRuns?.includes(x.id))) return 'done';
  if (tasks.length && tasks.every((x) => x.status !== 'todo')) return 'done';
  if (A.state.activeRun?.routeId === r.id || A.state.parkedRuns?.[r.id] || tasks.some((x) => x.status !== 'todo')) return 'busy';
  return 'recv';
}
/** Model voor één dag: personen met hun lijstjes en taken. Zelfde lijstjes als "Verstuurde lijstjes" (dist.sent). */
export function progressPeople(day) {
  day = day || todayKey(); const td = todayKey(); const me = ST().userName || '';
  const people = new Map(); const routeIds = new Set(); const sinceOf = new Map(); const reRuns = new Set();
  const P_ = (key, name, rank, self) => { if (!people.has(key)) people.set(key, { key, name, rank: normRank(rank) || rank || '', self: !!self, lists: [] }); return people.get(key); };
  for (const [k, s] of Object.entries(A.state.dist?.sent || {})) {
    if (!s.list || !s.rank) continue;
    const self = s.via === 'self'; const rid_ = self ? s.routeId : s.via === 'app' ? s.aid : s.routeId; const r = A.state.routes.find((x) => x.id === rid_);
    if (rid_) routeIds.add(rid_); if (s.aid) routeIds.add(s.aid); if (s.routeId) routeIds.add(s.routeId);
    const since = self ? s.at : s.via === 'app' ? new Date(s.ver || Date.parse(s.pubAt || s.at)).toISOString() : s.at;
    for (const id of [rid_, s.aid, s.routeId].filter(Boolean)) if (!sinceOf.has(id) || since < sinceOf.get(id)) sinceOf.set(id, since);
    for (const x of s.reRuns || []) reRuns.add(x);
    const tasks = r ? stepStates(r, since, s.reRuns, s.crewReopen) : [];
    const x = self ? { st: r ? selfSt(s, r, tasks) : 'recv' } : sentState(s);
    const st = x.st === 'self' ? 'recv' : x.st;
    const n = r ? r.steps.length : s.n || 0;
    const nd = tasks.filter((y) => isDone(y.status)).length; const live = st === 'done' && !tasks.length ? n : Math.max(nd, x.done || 0);
    const sentDay = dayKey(s.pubAt || s.at); const finDay = st === 'done' && x.at ? dayKey(x.at) : null;
    const doneDays = new Set(tasks.map((y) => y.day).filter(Boolean));
    if (!((day === td && st !== 'done') || sentDay === day || finDay === day || doneDays.has(day))) continue;
    const at = [s.ackAt, s.pgAt, x.at, x.row?.at, ...tasks.map((y) => y.at)].filter(Boolean).sort().at(-1) || s.pubAt || s.at;
    const p = self ? P_('self', me, 'self', true) : P_(pidOf(s.toName || s.name, s.rank), s.toName || s.name || rankLabel(normRank(s.rank)), s.rank);
    p.lists.push({ k, s, r, name: r ? tx(r, 'name') : s.listName || '', st, n, done: Math.min(n, live), tasks, at, note: s.note || r?.note || '', rest: s.list === 'fx-overig', custom: s.list === 'eigen', row: x.row || null, self });
  }
  // afgeronde rondes zonder verstuurd lijstje (eigen ronde of een ronde die iemand zelf startte)
  for (const run of finished().filter((x) => x.finishedAt && dayKey(x.finishedAt) === day && !reRuns.has(x.id) && (!routeIds.has(x.routeId) || new Date(x.finishedAt).getTime() < new Date(sinceOf.get(x.routeId) || 0).getTime() - 6e4))) {
    const own = !run.received; const p = own ? P_('self', me, 'self', true) : P_(pidOf(run.by), run.by || '?', run.rank || '');
    const tasks = (run.results || []).map((x, i) => { const { vals, rem } = valsOf(x); return { id: x.stepId || 'x' + i, i, title: x.title || '', loc: x.locName || '', li: 999, status: x.status, at: x.at, day: x.at ? dayKey(x.at) : day, by: run.by || '', vals, note: x.note || '', rem, tnote: '', custom: false, marad: !!x.marad, signed: false }; });
    const n = Math.max(tasks.length, run.pgDone || 0);
    p.lists.push({ k: 'run:' + run.id, s: null, r: null, run, name: run.routeName || '', st: 'done', n, done: Math.max(tasks.filter((y) => isDone(y.status)).length, run.pgDone || 0), tasks, at: run.finishedAt, note: '', own });
  }
  // bezig met een ronde die niet via Taken verdelen kwam
  for (const b of busyList().filter((x) => !routeIds.has(x.route) && day === td)) {
    const p = P_(pidOf(b.by), b.by || '?', b.rank); const r = A.state.routes.find((x) => x.id === b.route);
    p.lists.push({ k: 'busy:' + pkey(b), s: null, r, name: b.rn || '', st: 'busy', n: b.n || 0, done: b.done || 0, tasks: r ? stepStates(r, b.startedAt || b.at) : [], at: b.at, note: '', row: b });
  }
  // zelf afgevinkt (Beheer) zonder lijstje
  const inSelf = new Set((people.get('self')?.lists || []).flatMap((l) => (l.r?.steps || []).map((st) => st.marad?.id).filter(Boolean)));
  const mine = (A.state.maint?.signoffs || []).filter((x) => !x.runId && x.doneDate === day && !inSelf.has(x.taskId) && (x.via === 'zelf' || same(x.by, me)));
  if (mine.length) {
    const p = P_('self', me, 'self', true);
    p.lists.push({ k: 'zelf:' + day, s: null, r: null, name: t('Zelf afgevinkt'), st: 'done', n: mine.length, done: mine.length, at: day + 'T12:00:00', note: '', zelf: true,
      tasks: mine.map((x, i) => ({ id: x.id, i, title: x.task || '', loc: x.component || '', li: 999, status: 'done', at: null, day, by: x.by || me, vals: x.runHours != null ? [t('Draaiuren: {n}', { n: x.runHours })] : [], note: '', rem: x.remarks || '', tnote: '', custom: false, marad: true, signed: true })) });
  }
  const out = [...people.values()].map((p) => {
    const n = p.lists.reduce((a, l) => a + l.n, 0), done = p.lists.reduce((a, l) => a + l.done, 0);
    const st = PG_ORDER.find((x) => p.lists.some((l) => l.st === x)) || 'done';
    const at = p.lists.map((l) => l.at).filter(Boolean).sort().at(-1) || '';
    p.lists.sort((a, b) => PG_ORDER.indexOf(a.st) - PG_ORDER.indexOf(b.st) || String(b.at).localeCompare(String(a.at)));
    return { ...p, n, done, st, at, rounds: p.lists.length };
  });
  return out.sort((a, b) => PG_ORDER.indexOf(a.st) - PG_ORDER.indexOf(b.st) || (a.self - b.self) || String(b.at).localeCompare(String(a.at)));
}
const nR = (n) => (n === 1 ? t('1 ronde') : t('{n} rondes', { n }));
const pct = (d, n) => (n ? Math.round((d / n) * 100) : 0);
const whoLine = (p) => p.self ? `🙋 ${t('Ikzelf')}${p.name ? ' · ' + esc(p.name) : ''}` : `${RANK_ICON[p.rank] || '👤'} ${esc(p.name)}`;
const rankLine = (p) => p.self ? t('Eigen lijstjes en afvinkingen') : esc(rankLabel(p.rank) || '');
const atLbl = (at) => (at && at.length > 10 ? tm(at) : '');
function taskLi(x, l) {
  const ic = x.status === 'done' ? '✔' : x.status === 'problem' ? '⚠' : x.status === 'skipped' ? '↷' : '○';
  const meta = [x.at ? '🕒 ' + tm(x.at) + (x.day && x.day !== todayKey() ? ' · ' + esc(dayLabel(x.day)) : '') : x.signed && x.day ? '✔ ' + esc(dayLabel(x.day)) : '', x.loc ? '📍 ' + esc(x.loc) : '', l ? '🧭 ' + esc(l.name) : ''].filter(Boolean).join(' · ');
  return `<li class="pt pt-${x.status === 'todo' ? 'todo' : x.status} ${isDone(x.status) ? 'pt-ok' : ''}" data-step="${esc(x.id)}" data-st="${x.status}"><span class="pt-ic">${ic}</span><div class="pt-b"><b>${esc(x.title)}${x.custom ? ` <span class="tag ctag">✏️ ${t('Eigen taak')}</span>` : ''}${x.ro ? ` <span class="tag rotag">↩ ${t('heropend door {name}', { name: esc(x.ro.by || t('bemanning')) })}</span>` : ''}</b>${x.ro?.inMarad ? `<small class="pt-warn">⚠ ${t('Stond al in MARAD ingevoerd – zet hem daar ook terug.')}</small>` : ''}${meta ? `<small>${meta}</small>` : ''}${x.vals.length ? `<small class="pt-v">📏 ${x.vals.map(esc).join(' · ')}</small>` : ''}${x.note ? `<small class="pt-n">💬 ${esc(x.note)}</small>` : ''}${x.rem ? `<small class="pt-n">📝 ${esc(x.rem)}</small>` : ''}${x.tnote ? `<small class="pt-tn">📌 ${esc(x.tnote)}</small>` : ''}</div></li>`;
}
function listActs(l) {
  let h = '';
  if (l.st === 'busy' && l.row && P.runs[pkey(l.row)]) h += `<button class="iconbtn pclear" data-act="pgClear" data-k="${esc(pkey(l.row))}" aria-label="${t('Niet meer bezig')}" title="${t('Niet meer bezig')}">✕</button>`;
  return h;
}
function reopenOf(l) {
  if (l.k.startsWith('zelf:') || l.k.startsWith('busy:')) return '';
  if (l.run) return reopenFor(l.run);
  const s = l.s; if (!s || l.st !== 'done' || !l.r) return '';
  return `<div class="prun-act"><button class="btn small reopenbtn" data-act="distReopen" data-k="${esc(l.k)}">↩ ${t('Opnieuw sturen')}</button></div>`;
}
function listCard(l, flat) {
  const SL = PG_ST(); const [ic, lb] = SL[l.st] || SL.done; const unk = l.done - l.tasks.filter((y) => isDone(y.status)).length;
  const sub = [l.rest ? '🗂 ' + t('Overige taken') : '', l.custom ? '✏️ ' + t('Eigen taak') : '', l.own ? t('eigen ronde') : '', l.zelf ? t('zonder lijstje') : '', l.at && l.at.length > 10 ? t('laatst {d}', { d: tm(l.at) }) : ''].filter(Boolean).join(' · ');
  let h = `<section class="card plist st-${l.st}" data-k="${esc(l.k)}" data-st="${l.st}">${listActs(l)}<div class="pl-head"><b>${esc(l.name)}</b><span class="pdot st-${l.st}">${ic} ${lb}</span></div>
    <div class="pl-cnt"><span class="pbar"><i style="width:${pct(l.done, l.n)}%"></i></span><b>${t('{a} van {b}', { a: l.done, b: l.n })}</b></div>${sub ? `<small class="muted">${sub}</small>` : ''}
    ${l.note ? `<p class="pl-note">📝 ${esc(l.note)}</p>` : ''}`;
  if (l.s?.reopened) h += `<p class="small prun-ro">↩ ${t('Opnieuw gestuurd {d}', { d: A.fmtDT(l.s.reopened.at || l.s.pubAt || l.s.at) })}${l.s.reopened.n ? ' · ' + t('{n} taken', { n: l.s.reopened.n }) : ''}</p>`;
  if (unk > 0) h += `<p class="small muted pl-unk">⏳ ${t('{n} gedaan volgens de telefoon – welke precies komt met het rapport', { n: unk })}</p>`;
  if (!flat) h += l.tasks.length ? `<ul class="ptasks">${l.tasks.map((x) => taskLi(x)).join('')}</ul>` : `<p class="small muted">${t('{n} taken', { n: l.n })}</p>`;
  return h + reopenOf(l) + '</section>';
}
function personTab(p) {
  const mode = ['todo', 'walk', 'group'].includes(ST().pgMode) ? ST().pgMode : 'todo';
  const all = p.lists.flatMap((l) => l.tasks.map((x) => ({ x, l })));
  const nTodo = all.filter((y) => y.x.status === 'todo').length, nProb = all.filter((y) => y.x.status === 'problem').length, nSkip = all.filter((y) => y.x.status === 'skipped').length;
  let h = `<section class="card phero st-${p.st}" data-p="${esc(p.key)}"><div class="ph-who"><h2>${whoLine(p)}</h2><small>${rankLine(p)}</small></div>
    <div class="ph-big"><b class="ph-n">${p.done}</b><span>${t('van {n} taken gedaan', { n: p.n })}</span></div>
    <span class="pbar big"><i style="width:${pct(p.done, p.n)}%"></i></span>
    <div class="ph-chips"><span class="ps-chip st-done">✔ ${t('{n} gedaan', { n: p.done })}</span><span class="ps-chip st-pending">○ ${t('{n} te doen', { n: Math.max(0, p.n - p.done) })}</span>${nProb ? `<span class="ps-chip st-busy">⚠ ${nProb}</span>` : ''}${nSkip ? `<span class="ps-chip">↷ ${nSkip}</span>` : ''}<span class="ps-chip">🧭 ${nR(p.rounds)}</span></div></section>`;
  h += `<div class="seg pmode" role="tablist">${[['todo', '☰ ' + t('Te doen eerst')], ['walk', '🚶 ' + t('Looproute')], ['group', '🗂 ' + t('Per ronde')]].map(([k, l]) => `<button class="${mode === k ? 'on' : ''}" data-act="pgMode" data-m="${k}" aria-pressed="${mode === k}">${l}</button>`).join('')}</div>`;
  if (mode === 'group') return h + `<div class="list">${p.lists.map((l) => listCard(l, false)).join('')}</div>`;
  const sorted = mode === 'walk' ? all.sort((a, b) => a.x.li - b.x.li || p.lists.indexOf(a.l) - p.lists.indexOf(b.l) || a.x.i - b.x.i)
    : all.sort((a, b) => (a.x.status === 'todo' ? 0 : 1) - (b.x.status === 'todo' ? 0 : 1) || (a.x.status === 'todo' ? p.lists.indexOf(a.l) - p.lists.indexOf(b.l) || a.x.i - b.x.i : String(b.x.at || b.x.day).localeCompare(String(a.x.at || a.x.day))));
  const unk = p.lists.reduce((a, l) => a + Math.max(0, l.done - l.tasks.filter((y) => isDone(y.status)).length), 0);
  h += unk ? `<p class="small muted pl-unk">⏳ ${t('{n} gedaan volgens de telefoon – welke precies komt met het rapport', { n: unk })}</p>` : '';
  h += sorted.length ? `<ul class="ptasks flat">${sorted.map(({ x, l }) => taskLi(x, p.lists.length > 1 && !(l.custom && l.tasks.length === 1) ? l : null)).join('')}</ul>` : '';
  void nTodo;
  // lijstjes kort (stand, opnieuw sturen, ✕)
  h += `<h3 class="sec">🧭 ${t('Rondes')} (${p.rounds})</h3><div class="list">${p.lists.map((l) => listCard(l, true)).join('')}</div>`;
  return h;
}
export function progressView() {
  const v = A.view(); const td = todayKey(); const day = v.pgDay && v.pgDay <= td ? v.pgDay : td;
  const people = progressPeople(day); let tab = v.pgTab || 'all'; let cur = people.find((p) => p.key === tab);
  if (!cur) tab = 'all';
  let h = A.header(t('Voortgang'), true);
  h += `<div class="row ptools"><button class="btn" data-act="ntfyPoll">🔄 ${t('Nu ophalen')}</button><button class="btn" data-act="pairSheet">🔗 ${t('Iemand koppelen')}</button></div>`;
  h += `<div class="pdaysw"><button class="iconbtn" data-act="pgDay" data-d="-1" aria-label="${t('Vorige dag')}">‹</button><b data-day="${day}">${esc(dayLabel(day))}</b><button class="iconbtn" data-act="pgDay" data-d="1" ${day >= td ? 'disabled' : ''} aria-label="${t('Volgende dag')}">›</button>${day !== td ? `<button class="btn small" data-act="pgDay" data-d="0">${t('Vandaag')}</button>` : ''}</div>`;
  h += `<div class="ptabs" role="tablist"><button class="ptab ${tab === 'all' ? 'on' : ''}" data-act="pgTab" data-p="all">👥 ${t('Alle')}</button>${people.map((p) => `<button class="ptab st-${p.st} ${tab === p.key ? 'on' : ''}" data-act="pgTab" data-p="${esc(p.key)}"><span class="pdot-s st-${p.st}"></span>${p.self ? '🙋 ' + t('Ikzelf') : esc(p.name)} <small>${p.done}/${p.n}</small></button>`).join('')}</div>`;
  if (cur) return h + personTab(cur) + `<div class="stack xport"><button class="btn" data-act="stateExport">📦 ${t('Stand exporteren')}</button></div>`;
  // overzicht: één kaart per persoon
  const SL = PG_ST();
  h += people.length ? `<div class="list pcards">${people.map((p) => `<button class="card tap pcard st-${p.st}" data-act="pgTab" data-p="${esc(p.key)}"><div class="pc-top"><b class="pc-name">${whoLine(p)}<small>${rankLine(p)}</small></b><span class="pdot st-${p.st}">${SL[p.st][0]} ${SL[p.st][1]}</span></div>
      <div class="pc-cnt"><b>${t('{a} van {b} taken', { a: p.done, b: p.n })}</b></div>
      <span class="pbar big"><i style="width:${pct(p.done, p.n)}%"></i></span>
      <small class="muted">🧭 ${nR(p.rounds)}${p.at && p.at.length > 10 ? ' · ' + t('laatst {d}', { d: atLbl(p.at) }) : ''}</small></button>`).join('')}</div>`
    : `<p class="empty">${day === td ? t('Vandaag heeft nog niemand taken. Verstuur lijstjes via Taken verdelen.') : t('Op deze dag zijn geen taken gedaan.')}</p>`;
  // v1.18: verstuurde lijstjes – zelfde telling als "Verstuurde lijstjes"
  const SR = sentRows().filter((y) => y.x.st !== 'self'); const cnt = { pending: 0, recv: 0, busy: 0, done: 0, legacy: 0 };
  for (const y of SR) cnt[y.x.st] = (cnt[y.x.st] || 0) + 1;
  const SL2 = { pending: ['📬', t('Onderweg')], recv: ['📥', t('Ontvangen')], busy: ['⏳', t('Bezig')], done: ['✅', t('Afgerond')], legacy: ['⚪', t('Niet in de app')] };
  const nSelf = sentRows().filter((y) => y.x.st === 'self').length;
  if (SR.length) {
    h += `<section class="card psum"><div class="ps-top"><b>📤 ${t('Verstuurde lijstjes')}: ${SR.length}</b>${nSelf ? `<small class="muted">🙋 ${t('+ {n} voor mezelf (Rondes → Vandaag)', { n: nSelf })}</small>` : ''}</div>
      <div class="ps-chips">${Object.entries(SL2).filter(([k]) => cnt[k] || k !== 'legacy').map(([k, [ic, l]]) => `<span class="ps-chip st-${k}" data-st="${k}">${ic} ${l} <b>${cnt[k] || 0}</b></span>`).join('')}</div>
      <details><summary>${t('Per lijstje')}</summary><ul class="ps-rows">${SR.sort((a, b) => ['busy', 'recv', 'pending', 'done', 'legacy'].indexOf(a.x.st) - ['busy', 'recv', 'pending', 'done', 'legacy'].indexOf(b.x.st)).map(({ k, s, x }) => { const r = A.state.routes.find((y) => y.id === (s.aid || s.routeId)); return `<li class="ps-row st-${x.st}"><span>${SL2[x.st][0]} <b>${esc(s.toName || s.name || rankLabel(s.rank))}</b> · ${esc(r ? tx(r, 'name') : s.listName || '')}</span><small>${x.st === 'busy' || (x.st === 'recv' && x.done) ? `${x.done}/${x.n}` : t('{n} taken', { n: x.n || 0 })}</small>${x.st === 'done' && r ? `<button class="btn small reopenbtn" data-act="distReopen" data-k="${esc(k)}">↩ ${t('Opnieuw sturen')}</button>` : ''}</li>`; }).join('')}</ul></details></section>`;
  }
  // gekoppelde mensen (zonder taken op deze dag apart)
  const ps = paired().sort((a, b) => RANK_IDS.indexOf(normRank(a.func)) - RANK_IDS.indexOf(normRank(b.func)));
  const busyKeys = new Set(people.map((p) => p.key));
  h += `<details class="ppaired"><summary>👥 ${t('Gekoppelde mensen')} (${ps.length})${ps.some((c) => !busyKeys.has(pidOf(c.name, c.func))) ? ' · ' + t('{n} zonder taken', { n: ps.filter((c) => !busyKeys.has(pidOf(c.name, c.func))).length }) : ''}</summary>`;
  h += ps.length ? `<div class="list">${ps.map((c) => `<article class="card pperson"><b>${RANK_ICON[normRank(c.func)] || '👤'} ${esc(c.name)}</b><small>${esc(rankLabel(normRank(c.func)))} · ${c.lastSeen ? t('laatst gezien {d}', { d: A.fmtDT(c.lastSeen) }) : t('nog niet gezien')}</small></article>`).join('')}</div>` : `<p class="muted small">${t('Nog niemand gekoppeld. Vraag iemand in zijn app: Meer → Koppelen met Beheer, en plak de code hier.')}</p>`;
  h += '</details>';
  // v1.20: volledige stand als bestand (voor eigen analyse / privé delen)
  h += `<div class="stack xport"><button class="btn" data-act="stateExport">📦 ${t('Stand exporteren')}</button><small class="muted">${t('Alle gegevens in één bestand (zonder kanalen of codes). Alleen privé delen.')}</small></div>`;
  return h;
}
export function pairSheet() {
  A.openSheet(`<h2>🔗 ${t('Iemand koppelen')}</h2><p class="muted">${t('Laat de ander in zijn app openen: Meer → Koppelen met Beheer → Kopieer koppelcode. Plak die code hier. Eén keer koppelen is genoeg; daarna komen lijstjes zonder WhatsApp in zijn app.')}</p>
    <label>${t('Koppelcode')}<textarea id="pairIn" rows="4" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="SRK1-…"></textarea></label>
    <div class="stack"><button class="btn" data-act="pairPaste">📋 ${t('Plakken')}</button><button class="btn primary big" data-act="pairDo">🔗 ${t('Koppelen')}</button><button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button></div>`, { pair: true });
}
export function pairView() {
  const st = ST(); const code = pairCode(); const need = !String(st.userName || '').trim();
  let h = A.header(t('Koppelen met Beheer'), true);
  if (!A.isCrew()) h += `<p class="warnbox">${A.state.maint ? t('Dit is het Beheer-toestel (onderhoud ontgrendeld). Koppel hier geen bemanning; gebruik op dit toestel Voortgang → Iemand koppelen.') : t('Dit toestel staat nog op Beheer. Bij het kopiëren van de code wordt het een bemanningstoestel: je ziet dan alleen de lijstjes die je krijgt.')}</p>`;
  h += `<section class="card"><p>${t('Laat de beheerder deze code in zijn app plakken (Voortgang → Iemand koppelen). Daarna komen lijstjes automatisch in jouw app – zonder WhatsApp. Je hebt internet nodig om ze te ontvangen.')}</p>
    ${need ? `<p class="warnbox">${t('Vul eerst je naam en rang in.')}</p><button class="btn primary" data-act="profileEdit">👤 ${t('Profiel')}</button>` : `<p><b>${RANK_ICON[normRank(st.myRank)] || '👤'} ${esc(st.userName)}</b> · ${esc(rankLabel(normRank(st.myRank)))}</p>
    <textarea id="pairCode" class="paircode" rows="4" readonly>${esc(code)}</textarea>
    <div class="stack"><button class="btn primary big" data-act="pairCopy">📋 ${t('Kopieer koppelcode')}</button></div>`}</section>`;
  h += `<section class="card"><h3>📥 ${t('Ontvangen lijstjes')}</h3><p class="muted small">${st.inboxLastAt ? t('Laatste lijstje ontvangen: {d}', { d: A.fmtDT(st.inboxLastAt) }) : t('Nog geen lijstje via de app ontvangen.')}${st.inboxPolledAt ? ' · ' + t('laatst gekeken {d}', { d: A.fmtDT(st.inboxPolledAt) }) : ''}</p><button class="btn" data-act="inboxPoll">🔄 ${t('Nu ophalen')}</button></section>`;
  return h;
}

/** Koppelcode gedeeld op een niet-Beheer-toestel → bemanningsmodus (alleen eigen lijstjes, inbox ophalen). */
function toCrew() { if (A.isCrew() || A.state.maint) return; A.state.settings.mode = 'bemanning'; A.save(); setTimeout(() => A.go('koppelen'), 50); }
export const actions = {
  pgTab: (a) => { A.go('voortgang', { pgTab: a.dataset.p, pgDay: A.view().pgDay }); },
  pgDay: (a) => { const d = +a.dataset.d; const td = dayKey(new Date().toISOString()); let k = A.view().pgDay || td;
    if (!d) k = td; else { const x = new Date(k + 'T12:00:00'); x.setDate(x.getDate() + d); k = dayKey(x.toISOString()); if (k > td) k = td; }
    A.go('voortgang', { pgDay: k, pgTab: A.view().pgTab }); },
  pgMode: (a) => { ST().pgMode = a.dataset.m; A.save(); A.render(); },
  pgClear: (a) => { const x = P.runs[a.dataset.k]; if (x) { x.k = 'aborted'; savePg(); A.render(); } },
  goProgress: () => { A.closeSheet(); A.go('voortgang'); },
  goPair: () => { A.closeSheet(); A.go('koppelen'); },
  pairSheet: () => pairSheet(),
  pairPaste: async () => { try { const s = await navigator.clipboard.readText(); if (s) document.querySelector('#pairIn').value = s; } catch { A.toast(t('Plakken lukte niet – houd het veld ingedrukt en kies Plak.'), 4000); } },
  pairDo: () => {
    const o = parsePairCode(document.querySelector('#pairIn')?.value);
    if (!o) return A.toast(t('Dat is geen geldige koppelcode.'), 3500);
    const c = addPaired(o); A.closeSheet(); A.render();
    A.toast(t('{name} gekoppeld ✔', { name: c.name }), 3500);
  },
  pairCopy: () => { A.copyText(pairCode()); toCrew(); },
  inboxPoll: () => pollInbox(true).then(() => A.render()),
  distRedeliver: async (a) => { const s = A.state.dist?.sent?.[a.dataset.k]; const r = s && A.state.routes.find((x) => x.id === s.aid); const c = s && A.state.contacts.find((x) => x.id === s.to); if (r && c) { await deliver(r, c, a.dataset.k); A.render(); } },
};
