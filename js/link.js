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
  return { pairView, progressView, todayBanner, actions, pollInbox, handleMgrMsg, retry, deliver, progressEvent, pairedFor, chunkItems, pairSheet, doneAfter, paired, syncDone, busyList };
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
export function doneAfter(routeId, ver) { return A.state.runs.find((x) => x.routeId === routeId && x.received && x.finishedAt && new Date(x.finishedAt).getTime() >= (ver || 0)) || null; }
export async function deliver(r, c, sentKey, { quiet = false } = {}) {
  const st = ST(); const ver = Date.now();
  r.assignee = r.assignee || c.name;
  const pkg = pkgFor(r, c, ver);
  const items = await chunkItems(pkg, { kind: 'route', aid: r.id, ver, topic: c.inbox, server: c.inboxServer || 'https://ntfy.sh', title: `📋 ${tx(r, 'name')} · ${r.steps.length}`, by: st.userName || '' });
  const D = (A.state.dist ||= {}); D.sent ||= {};
  const s = (D.sent[sentKey] ||= {});
  Object.assign(s, { via: 'app', aid: r.id, ver, to: c.id, toName: c.name, pubAt: new Date().toISOString(), parts: items.length, ackVer: s.ackVer && s.ackVer >= ver ? s.ackVer : 0, ackAt: s.ackVer >= ver ? s.ackAt : null });
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
    if (doneAfter(r.id, s.ver)) continue; // al afgerond (rapport binnen) – niet opnieuw plaatsen
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
    if (!cur.at || e.at >= cur.at) P.runs[key] = { run: e.run, route: e.route, rn: e.rn, by: e.by, rank: e.rank, dev: e.dev, done: e.done, n: e.n, k: e.k, at: e.at, startedAt: e.run === cur.run ? (cur.startedAt || e.st) : (e.st || e.at) };
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

// ---------- bemanning: voortgang ----------
let lastPg = 0;
export async function progressEvent(k, arIn = null) {
  if (!A.isCrew()) return;
  const ar = arIn || A.state.activeRun; const topic = ar?.route.notifyTopic; if (!topic) return;
  if (k === 'step' && Date.now() - lastPg < 120000) { ar.pgDirty = true; return; }
  if (k === 'paused' && !ar.pgDirty) return;
  lastPg = Date.now(); ar.pgDirty = false;
  const st = ST(); const name = st.userName || '';
  const e = { id: 'pe-' + A.rid(), k, run: ar.id, route: ar.routeId, rn: tx(ar.route, 'name'), by: name, rank: normRank(st.myRank) || '', dev: st.deviceId, done: new Set(ar.results.map((x) => x.stepId)).size, n: ar.route.steps.length, at: new Date().toISOString(), st: ar.startedAt };
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
  return Object.values(P.runs).filter((x) => !closed(x) && Date.now() - new Date(x.at).getTime() < 20 * 3600e3)
    .map((x) => ({ ...x, done: Math.max(x.done || 0, signedOf(x).n) })).sort((a, b) => b.at.localeCompare(a.at));
}
/** Afgeronde rondes: rapporten/eigen rondes + 'afgerond'-meldingen waarvan het rapport nog onderweg is. */
const finished = () => {
  const rs = A.state.runs.filter((r) => r.finishedAt);
  const extra = Object.values(P.runs).filter((x) => x.k === 'done' && !rs.some((r) => r.id === x.run)).map((x) => ({ id: x.run, routeName: x.rn, by: x.by, finishedAt: x.at, results: [], pgDone: x.done || x.n || 0, received: { via: 'voortgang' } }));
  return [...rs, ...extra];
};
function counts(run) { const c = { done: run.pgDone || 0, problem: 0, skipped: 0 }; for (const x of run.results || []) c[x.status] = (c[x.status] || 0) + 1; return c; }
export function todayBanner() {
  const b = busyList().length; const td = dayKey(new Date().toISOString());
  const nT = finished().filter((r) => dayKey(r.finishedAt) === td).reduce((a, r) => a + counts(r).done, 0);
  return `<button class="card tap rankbanner progbanner" data-act="goProgress">📊 <b>${t('Voortgang')}</b><small>${t('{a} bezig · {b} taken vandaag afgerond', { a: b, b: nT })} · 👥 ${t('{n} gekoppeld', { n: paired().length })}</small></button>`;
}
export function progressView() {
  let h = A.header(t('Voortgang'), true) + `<p class="muted">${t('Wie waarmee bezig is en wat er is afgerond. Komt vanzelf binnen zodra de bemanning internet heeft.')}</p>`;
  h += `<div class="row"><button class="btn" data-act="ntfyPoll">🔄 ${t('Nu ophalen')}</button><button class="btn" data-act="pairSheet">🔗 ${t('Iemand koppelen')}</button></div>`;
  // bezig
  const bs = busyList();
  h += `<h3 class="sec">⏳ ${t('Bezig')} (${bs.length})</h3>`;
  h += bs.length ? `<div class="list">${bs.map((x) => `<article class="card pbusy"><button class="iconbtn pclear" data-act="pgClear" data-k="${esc(pkey(x))}" aria-label="${t('Niet meer bezig')}" title="${t('Niet meer bezig')}">✕</button><b>${RANK_ICON[x.rank] || '👤'} ${esc(x.by || '?')} · ${esc(x.rn || '')} · ${x.done}/${x.n}</b><span class="pbar"><i style="width:${x.n ? Math.round((x.done / x.n) * 100) : 0}%"></i></span><small>${t('gestart {a} · bijgewerkt {b}', { a: x.startedAt ? tm(x.startedAt) : '–', b: tm(x.at) })}</small></article>`).join('')}</div>` : `<p class="empty small">${t('Niemand is nu met een ronde bezig.')}</p>`;
  // onderweg (nog niet ontvangen)
  const pend = Object.values(A.state.dist?.sent || {}).filter((s) => s.via === 'app' && !(s.ackVer >= s.ver) && !doneAfter(s.aid, s.ver));
  if (pend.length) h += `<h3 class="sec">📬 ${t('Onderweg')} (${pend.length})</h3><div class="list">${pend.map((s) => { const r = A.state.routes.find((x) => x.id === s.aid); return `<article class="card ppend"><b>${esc(s.toName || '')} · ${esc(r ? tx(r, 'name') : '')} · ${t('{n} taken', { n: r?.steps.length || s.n || 0 })}</b><small>${t('geplaatst {d} – wacht tot {name} online is', { d: A.fmtDT(s.pubAt), name: esc(s.toName || '') })}</small></article>`; }).join('')}</div>`;
  // afgerond per dag
  const fr = finished().sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  const days = new Map(); for (const r of fr) { const k = dayKey(r.finishedAt); if (!days.has(k)) days.set(k, []); days.get(k).push(r); }
  const td = dayKey(new Date().toISOString());
  if (!days.has(td)) h += `<h3 class="sec pday" data-day="${td}">✅ ${t('Vandaag afgerond')} (0)</h3><p class="empty small">${t('Vandaag nog niets afgerond.')}</p>`;
  let nDays = 0;
  for (const [k, rs] of days) {
    if (++nDays > 14) break;
    const nT = rs.reduce((a, r) => a + counts(r).done, 0);
    h += `<h3 class="sec pday" data-day="${k}">${k === td ? '✅ ' + t('Vandaag afgerond') : '📅 ' + esc(dayLabel(k))} (${t('{n} taken', { n: nT })})</h3><div class="list">`;
    for (const r of rs) {
      const c = counts(r);
      h += `<details class="card prun"><summary><b>${esc(r.routeName || '')}</b><small>👤 ${esc(r.by || ST().userName || '')} · 🕒 ${tm(r.finishedAt)} · <span class="okc">✔ ${c.done}</span>${c.problem ? ` · ⚠ ${c.problem}` : ''}${c.skipped ? ` · ↷ ${c.skipped}` : ''}${r.received ? '' : ' · ' + t('eigen ronde')}</small></summary>
        <ol class="plain small">${(r.results || []).map((x) => `<li>${x.status === 'done' ? '✔' : x.status === 'problem' ? '⚠' : '↷'} ${esc(x.title || '')} <span class="muted">· ${x.at ? tm(x.at) : ''}</span></li>`).join('')}</ol></details>`;
    }
    h += '</div>';
  }
  // gekoppelde mensen
  const ps = paired().sort((a, b) => RANK_IDS.indexOf(normRank(a.func)) - RANK_IDS.indexOf(normRank(b.func)));
  h += `<h3 class="sec">👥 ${t('Gekoppelde mensen')} (${ps.length})</h3>`;
  h += ps.length ? `<div class="list">${ps.map((c) => `<article class="card pperson"><b>${RANK_ICON[normRank(c.func)] || '👤'} ${esc(c.name)}</b><small>${esc(rankLabel(normRank(c.func)))} · ${c.lastSeen ? t('laatst gezien {d}', { d: A.fmtDT(c.lastSeen) }) : t('nog niet gezien')}</small></article>`).join('')}</div>` : `<p class="muted small">${t('Nog niemand gekoppeld. Vraag iemand in zijn app: Meer → Koppelen met Beheer, en plak de code hier.')}</p>`;
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
