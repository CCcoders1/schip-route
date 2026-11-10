// Olie: voorraad per opslaglocatie, bijvullen, leveringen, inventaris, verbruik per machine en urenstanden.
// Stamdata (soorten + merk-aliassen, machines, monstercodes, urentellers) komt ALLEEN uit de versleutelde bundel
// (maint.oilRef) of – bij de bemanning – uit een gedeelde route (route.oilRef). Voorraad en historie staan in maint.oil (IndexedDB).
// Elke registratie heeft een unieke id: dubbel ontvangen (ntfy + rapport + link) wordt maar één keer verwerkt.
import { t, getLang, LOCALES } from './i18n.js';
import { hooks } from './share.js';

let A;
const F = { v: 'voorraad', mach: '' };
let draft = null; // invoer in een sheet
const LOCDEF = [
  { id: 'bunker', icon: '🛢', locId: 'l-mk-bal', nl: 'Bunkertanks', en: 'Bunker tanks', id_: 'Tangki bunker' },
  { id: 'mk', icon: '⚙️', locId: 'l-mk-hm', nl: 'Machinekamer', en: 'Engine room', id_: 'Kamar mesin' },
  { id: 'store', icon: '📦', locId: 'l-fc', nl: 'Oil store (forecastle)', en: 'Oil store (forecastle)', id_: 'Gudang oli (akil)' },
];
const locName = (l, lang = getLang()) => (lang === 'en' ? l.en : lang === 'id' ? l.id_ : l.nl);
export const LOCS = () => LOCDEF.map((l) => ({ ...l, name: locName(l) }));
const LOC = (id) => LOCS().find((l) => l.id === id);
export const PACKS = () => ({ bulk: [t('Bulk (tank)'), null], ibc: [t('IBC 1000 L'), 1000], vat: [t('Vat 208 L'), 208], can: [t('Can 20 L'), 20], los: [t('Los / anders'), null] });
const CATS = () => ({ olie: t('Olie'), vet: t('Vet'), overig: t('Overig'), flessen: t('Monsterflessen'), mob2t: t('MOB 2-takt (losse items)') });
const M = () => A.state.maint;
const $f = (s) => document.querySelector(s);
const esc = (s) => A.esc(s);
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const byDate = (a, b) => (a.date || '').localeCompare(b.date || '') || (a.at || '').localeCompare(b.at || '');
const fmtL = (n) => (n == null ? '—' : Number(n).toLocaleString(LOCALES[getLang()], { maximumFractionDigits: 1 }));
const fmtD = (iso) => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString(LOCALES[getLang()], { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);

export function initOil(api) {
  A = api;
  hooks.beforePackage = (r) => { if (r.steps?.some((s) => (s.fields || []).some((f) => f.type === 'oil' || f.type === 'oilinv')) && M()?.oilRef) r.oilRef = buildRef(); };
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  return { view, actions, fieldHTML, fmtValue, applyRun, ingest, hasRef, flushPending, crewCard, summary };
}

// ---------- data ----------
function ST() {
  const m = M(); if (!m?.oilRef) return null;
  m.oil ||= { stock: {}, events: [], applied: {}, hours: {}, min: {}, extra: [], listAdj: {} };
  if (m.oil.seeded !== (m.oilRef.rev || 1)) {
    m.oil.seeded = m.oilRef.rev || 1;
    for (const h of m.oilRef.hours || []) for (const x of [...(h.history || []), { date: h.date, value: h.value }]) addHours(h.id, x.value, x.date, 'MARAD', 'start', true, m.oil);
    for (const ev of m.oilRef.events || []) applyEv(ev, true);
  }
  return m.oil;
}
export function ref() { return M()?.oilRef || A.state.activeRun?.route?.oilRef || crewRef(); }
function crewRef() { const rs = (A.state.routes || []).filter((r) => r.oilRef).sort((a, b) => (b.oilRef.at || '').localeCompare(a.oilRef.at || '')); return rs[0]?.oilRef || null; }
export const hasRef = () => !!ref();
const oils = () => [...(ref()?.oils || []), ...(ST()?.extra || [])];
const oilById = (id) => oils().find((o) => o.id === id);
const machines = () => ref()?.machines || [];
const mach = (id) => machines().find((x) => x.id === id);
const hoursDefs = () => ref()?.hours || [];
export const oilName = (o) => (o ? (o.alias || [o.name]).filter(Boolean).join(' / ') : '?');
const short = (o) => (o ? o.alias?.[0] || o.name || '?' : '?');
const findOil = (name) => { const n = String(name || '').trim().toLowerCase(); return n ? oils().find((o) => (o.alias || []).some((a) => a.toLowerCase() === n)) || oils().find((o) => (o.alias || []).some((a) => a.toLowerCase().includes(n) || n.includes(a.toLowerCase()))) : null; };
const findMach = (name) => { const n = String(name || '').trim().toLowerCase(); return n ? machines().find((m) => m.name.toLowerCase() === n) || machines().find((m) => m.name.toLowerCase().includes(n) || n.includes(m.name.toLowerCase())) : null; };
function ensureOil(x) {
  if (x.oilId && oilById(x.oilId)) return x.oilId;
  const f = findOil(x.oilName || x.name); if (f) return f.id;
  const s = ST(); const id = 'n-' + slug(x.oilName || x.name || 'onbekend');
  if (!s.extra.some((o) => o.id === id)) s.extra.push({ id, alias: [x.oilName || x.name || '?'], cat: 'olie', unit: 'L', rob: null, target: null, isNew: true });
  return id;
}
function locEntries(oilId) { const s = ST(); return LOCS().map((l) => ({ l, e: s.stock[l.id]?.[oilId] })).filter((x) => x.e); }
export function total(o) {
  const es = locEntries(o.id);
  if (es.length) return { liters: es.reduce((a, x) => a + (+x.e.liters || 0), 0), src: 'loc' };
  if (o.rob == null) return { liters: null, src: 'none' };
  return { liters: Math.max(0, o.rob + (ST().listAdj[o.id] || 0)), src: 'list' };
}
const minOf = (o) => ST().min[o.id] ?? o.target ?? null;
function addHours(hid, value, date, by, src, exported = false, s = ST()) {
  if (!hid || value == null || value === '' || isNaN(value)) return;
  const r = (s.hours[hid] ||= []);
  if (r.some((y) => y.date === date && +y.value === +value)) return;
  r.push({ id: 'h-' + A.rid(), date, value: +value, by: by || '', src, exported }); r.sort(byDate);
}
const lastHours = (hid) => (ST()?.hours[hid] || []).at(-1) || null;
function applyEv(ev0, init = false) {
  const s = ST(); if (!s || !ev0?.id || s.applied[ev0.id]) return false;
  const ev = { ...ev0 }; s.applied[ev.id] = ev.at || true;
  if (ev.kind === 'refill') {
    if (!ev.machineId && ev.machineName) ev.machineId = findMach(ev.machineName)?.id || null;
    if (!ev.oilId) ev.oilId = mach(ev.machineId)?.oilId || findOil(ev.oilName)?.id || null;
    ev.liters = +ev.liters || 0;
    if (!ev.noDeduct && ev.oilId) {
      const e = ev.fromLoc && s.stock[ev.fromLoc]?.[ev.oilId];
      const es = locEntries(ev.oilId);
      if (e) { e.liters = Math.max(0, (+e.liters || 0) - ev.liters); ev.deducted = ev.fromLoc; }
      else if (!es.length) { s.listAdj[ev.oilId] = (s.listAdj[ev.oilId] || 0) - ev.liters; ev.deducted = 'list'; }
      else { const big = es.sort((a, b) => b.e.liters - a.e.liters)[0]; big.e.liters = Math.max(0, big.e.liters - ev.liters); ev.deducted = big.l.id; }
    }
    const m = mach(ev.machineId); if (ev.hours && m?.hoursId) addHours(m.hoursId, ev.hours, ev.date, ev.by, 'bijvulling');
  } else if (ev.kind === 'delivery') {
    ev.oilId = ensureOil(ev);
    const e = ((s.stock[ev.loc] ||= {})[ev.oilId] ||= { liters: 0 });
    e.liters = (+e.liters || 0) + (+ev.liters || 0); if (ev.pack) e.pack = ev.pack; e.at = ev.date; e.by = ev.by;
  } else if (ev.kind === 'inv') {
    const st = (s.stock[ev.loc] ||= {});
    if (ev.full) for (const k of Object.keys(st)) if (!(k in (ev.items || {}))) delete st[k];
    for (const [oid, v] of Object.entries(ev.items || {})) st[oid] = { liters: +v.liters || 0, pack: v.pack || '', n: v.n ?? null, at: ev.date, by: ev.by };
    for (const no of ev.newOils || []) { if (!no.name) continue; const oid = ensureOil({ oilName: no.name }); st[oid] = { liters: +no.liters || 0, pack: no.pack || '', n: no.n ?? null, at: ev.date, by: ev.by }; }
  } else if (ev.kind === 'set') {
    const st = (s.stock[ev.loc] ||= {});
    if (ev.remove) delete st[ev.oilId]; else st[ev.oilId] = { ...(st[ev.oilId] || {}), liters: +ev.liters || 0, pack: ev.pack || '', n: ev.n ?? null, at: ev.date, by: ev.by };
  } else if (ev.kind === 'hours') addHours(ev.hid, ev.value, ev.date, ev.by, ev.src || 'app');
  s.events.push(ev); if (!init) A.persist();
  return true;
}
/** Registraties verwerken (uit ntfy, rapport, link). Geeft het aantal nieuwe terug. */
export function ingest(evs) { if (!ST()) return 0; let n = 0; for (const ev of [...(evs || [])].sort((a, b) => (a.at || '').localeCompare(b.at || ''))) if (applyEv(ev)) n++; return n; }
/** Olie-registraties uit een afgeronde ronde (velden 'oil' en 'oilinv'). */
export function applyRun(run) {
  const evs = [...(run.oilEvents || [])];
  for (const r of run.results || []) for (const f of r.fields || []) if (f.type === 'oil' || f.type === 'oilinv') { const v = r.values?.[f.id]; for (const e of Array.isArray(v) ? v : v ? [v] : []) if (e?.id) evs.push(e); }
  return evs.length ? ingest(evs) : 0;
}
export function flushPending() {
  const p = A.state.oilPending; if (!p?.length || !ST()) return 0;
  let n = 0; for (const pkg of p) n += ingest(pkg.oilEvents); A.state.oilPending = []; A.save(); return n;
}
function buildRef() {
  const s = ST(); const assign = {}; for (const l of LOCS()) assign[l.id] = Object.keys(s.stock[l.id] || {});
  return { at: new Date().toISOString(), oils: oils().map((o) => ({ id: o.id, alias: o.alias, cat: o.cat, unit: o.unit, bulk: !!o.bulk })), machines: machines().map((m) => ({ id: m.id, name: m.name, oilId: m.oilId, hoursId: m.hoursId || null, samples: m.samples || [] })), hours: hoursDefs().map((h) => ({ id: h.id, name: h.name, last: lastHours(h.id)?.value ?? null })), assign };
}

// ---------- verbruik ----------
function hoursAt(hid, date) {
  const r = ST().hours[hid] || []; if (!r.length) return null;
  const x = Date.parse(date); const ex = r.find((y) => y.date === date); if (ex) return ex.value;
  for (let i = 1; i < r.length; i++) { const a = r[i - 1], b = r[i], ta = Date.parse(a.date), tb = Date.parse(b.date); if (x > ta && x < tb) return Math.round(a.value + ((b.value - a.value) * (x - ta)) / (tb - ta)); }
  return null;
}
export function usage(mid) {
  const m = mach(mid);
  const evs = (ST()?.events || []).filter((e) => e.kind === 'refill' && e.machineId === mid).sort(byDate);
  const pts = evs.map((e) => { let h = e.hours != null && e.hours !== '' ? +e.hours : null, est = false; if (h == null && m?.hoursId) { h = hoursAt(m.hoursId, e.date); est = h != null; } return { id: e.id, date: e.date, liters: +e.liters, h, est, by: e.by, from: e.deducted || e.fromLoc || '' }; });
  const rates = [];
  for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; if (a.h != null && b.h != null && b.h > a.h) { b.rate = (b.liters / (b.h - a.h)) * 100; rates.push(b.rate); } }
  pts.forEach((p, i) => { const w = pts.slice(0, i + 1).filter((x) => x.rate != null).slice(-3); p.ma = w.length && p.rate != null ? w.reduce((s, x) => s + x.rate, 0) / w.length : null; });
  const days = pts.length > 1 ? (Date.parse(pts.at(-1).date) - Date.parse(pts[0].date)) / 864e5 : 0;
  const perWeek = days >= 1 ? pts.slice(1).reduce((s, p) => s + p.liters, 0) / (days / 7) : null;
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  let warn = null;
  if (rates.length >= 2) { const pa = avg(rates.slice(0, -1)), last = rates.at(-1); if (pa > 0 && last > pa * 1.5) warn = { last, prev: pa, pct: Math.round((last / pa - 1) * 100) }; }
  return { m, pts, rates, perWeek, avgRate: avg(rates), lastRate: rates.at(-1) ?? null, warn, total: pts.reduce((s, p) => s + p.liters, 0) };
}
function chartSVG(u) {
  const pts = u.pts; if (!pts.length) return '';
  const W = 340, H = 180, pl = 36, pr = 40, pt = 14, pb = 28, iw = W - pl - pr, ih = H - pt - pb;
  const t0 = Date.parse(pts[0].date), t1 = Date.parse(pts.at(-1).date), span = t1 - t0;
  const X = (d) => (span > 0 ? pl + ((Date.parse(d) - t0) / span) * iw : pl + iw / 2);
  const lmax = Math.max(...pts.map((p) => p.liters)) * 1.2 || 1;
  const rp = pts.filter((p) => p.rate != null); const rmax = Math.max(0.01, ...rp.map((p) => Math.max(p.rate, p.ma || 0))) * 1.2;
  const YL = (v) => pt + ih - (v / lmax) * ih, YR = (v) => pt + ih - (v / rmax) * ih;
  const bw = Math.max(6, Math.min(22, iw / (pts.length * 2)));
  // tijd-evenredig, maar met minimale tussenruimte zodat bijvullingen op dezelfde dag niet over elkaar vallen
  const xs = pts.map((p) => X(p.date)); const gap = bw + 3;
  for (let i = 1; i < xs.length; i++) xs[i] = Math.max(xs[i], xs[i - 1] + gap);
  if (xs.length > 1 && xs.at(-1) > pl + iw) { const a = xs[0], k = (pl + iw - a) / (xs.at(-1) - a); for (let i = 0; i < xs.length; i++) xs[i] = a + (xs[i] - a) * k; }
  const XP = new Map(pts.map((p, i) => [p, xs[i]]));
  let g = `<line x1="${pl}" y1="${pt + ih}" x2="${pl + iw}" y2="${pt + ih}" class="ax"/>`;
  g += pts.map((p) => `<rect x="${(XP.get(p) - bw / 2).toFixed(1)}" y="${YL(p.liters).toFixed(1)}" width="${bw}" height="${(pt + ih - YL(p.liters)).toFixed(1)}" class="bar"><title>${fmtD(p.date)}: ${fmtL(p.liters)} L</title></rect>`).join('');
  if (rp.length) {
    g += `<polyline points="${rp.map((p) => `${XP.get(p).toFixed(1)},${YR(p.rate).toFixed(1)}`).join(' ')}" class="rate"/>` + rp.map((p) => `<circle cx="${XP.get(p).toFixed(1)}" cy="${YR(p.rate).toFixed(1)}" r="3.5" class="rate"><title>${fmtL(p.rate)} L/100 h</title></circle>`).join('');
    const mp = rp.filter((p) => p.ma != null); if (mp.length > 1) g += `<polyline points="${mp.map((p) => `${XP.get(p).toFixed(1)},${YR(p.ma).toFixed(1)}`).join(' ')}" class="ma"/>`;
    g += `<text x="${W - 2}" y="${pt + 4}" text-anchor="end" class="lbl r">${fmtL(rmax / 1.2)}</text><text x="${W - 2}" y="${pt + ih}" text-anchor="end" class="lbl r">0</text><text x="${W - 2}" y="${H - 2}" text-anchor="end" class="lbl r">L/100 h</text>`;
  }
  g += `<text x="2" y="${pt + 4}" class="lbl">${fmtL(lmax / 1.2)} L</text><text x="2" y="${pt + ih}" class="lbl">0</text>`;
  g += `<text x="${pl}" y="${H - 6}" class="lbl">${fmtD(pts[0].date)}</text>${pts.length > 1 ? `<text x="${pl + iw}" y="${H - 6}" text-anchor="end" class="lbl">${fmtD(pts.at(-1).date)}</text>` : ''}`;
  return `<svg class="oilchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${t('Verbruik')}">${g}</svg><p class="legend"><span class="olg bar"></span>${t('liters per bijvulling')} ${rp.length ? `<span class="olg rate"></span>${t('L per 100 draaiuren')} ${rp.length > 1 ? `<span class="olg ma"></span>${t('gemiddelde (3)')}` : ''}` : ''}</p>`;
}
function usageHint(u) {
  const withH = u.pts.filter((p) => p.h != null).length;
  if (!u.pts.length) return t('Nog geen bijvullingen geregistreerd.');
  if (!u.m?.hoursId) return u.pts.length < 2 ? t('Eén bijvulling geregistreerd. Na de volgende bijvulling verschijnt het verbruik per week (deze machine heeft geen urenteller).') : '';
  if (u.rates.length === 0) return withH < 2 ? t('Nog te weinig gegevens: het verbruik per 100 draaiuren verschijnt na 2 bijvullingen mét urenstand ({n} van 2).', { n: withH }) : t('De urenstanden tussen de bijvullingen zijn gelijk – nog geen verbruik te berekenen.');
  if (u.rates.length < 3) return t('Trend wordt betrouwbaarder na 3 of meer bijvullingen met urenstand.');
  return '';
}

// ---------- weergave ----------
export function view() {
  const m = M(); let h = A.header(t('Olie'));
  if (!m?.tasks) return h + `<section class="card"><h3>🔐 ${t('Onderhoud ontgrendelen')}</h3><p class="muted small">${t('De olielijst zit in de versleutelde scheepsgegevens. Ontgrendel om voorraad en verbruik te zien.')}</p><button class="btn primary big" data-act="mUnlockSheet">${t('Ontgrendelen')}</button></section>`;
  if (!m.oilRef) return h + `<p class="warnbox">${t('Er zijn bijgewerkte onderhoudsgegevens (vaste rondes en locaties). Ontgrendel één keer opnieuw om ze te laden – je afmeldingen blijven bewaard.')}</p><button class="btn primary big" data-act="mUnlockSheet">${t('Ontgrendelen')}</button>`;
  flushPending();
  const low = oils().filter((o) => { const tt = total(o).liters, mn = minOf(o); return mn != null && tt != null && tt < mn; }).length;
  const warn = machines().filter((x) => usage(x.id).warn).length;
  h += `<div class="row2 oilacts"><button class="btn primary big" data-act="oilRefill">🛢 ${t('Olie bijgevuld')}</button><button class="btn big" data-act="oilDelivery">📦 ${t('Levering ontvangen')}</button></div>
    <div class="row2 oilacts"><button class="btn" data-act="oilInvMenu">📋 ${t('Inventaris tellen')}</button><button class="btn" data-act="oilInvRoute">📲 ${t('Inventaris-ronde maken')}</button></div>`;
  if (F.v !== 'log') { const last = refillLog().slice(0, 3); if (last.length) h += `<section class="card rlogcard"><div class="ohead"><h3>🧾 ${t('Laatst bijgevuld')}</h3><button class="btn small ghost" data-act="oilV" data-v="log">${t('Alles ({n})', { n: refillLog().length })} ›</button></div><ul class="rlog">${last.map(logItem).join('')}</ul></section>`; }
  const segs = [['voorraad', '📊 ' + t('Voorraad') + (low ? ` <span class="nb">${low}</span>` : '')], ['log', '🧾 ' + t('Bijgevuld')], ['locaties', '📍 ' + t('Per locatie')], ['verbruik', '📈 ' + t('Verbruik') + (warn ? ` <span class="nb">${warn}</span>` : '')], ['bestel', '🛒 ' + t('Bestellijst')], ['uren', '⏱ ' + t('Urenstanden')]];
  h += `<div class="seg wrap oilseg">${segs.map(([k, v]) => `<button class="${F.v === k ? 'on' : ''}" data-act="oilV" data-v="${k}">${v}</button>`).join('')}</div>`;
  h += { voorraad: stockHTML, log: logHTML, locaties: locsHTML, verbruik: usageHTML, bestel: orderHTML, uren: hoursHTML }[F.v]();
  return h;
}
// ---------- lijst "bijgevuld en hoeveel" ----------
function refillLog() {
  const evs = ST() ? ST().events : A.state.oilLog || [];
  return evs.filter((e) => e.kind === 'refill').sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.at || '').localeCompare(a.at || ''));
}
const hhmm = (e) => { if (!e.at || e.by === 'startdata') return ''; const d = new Date(e.at); const loc = new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); return loc === e.date ? d.toLocaleTimeString(LOCALES[getLang()], { hour: '2-digit', minute: '2-digit' }) : ''; };
function logItem(e, opt = {}) {
  const m = mach(e.machineId), o = oilById(e.oilId), tm = hhmm(e);
  const from = e.deducted === 'list' ? t('van lijstvoorraad') : e.deducted ? t('uit {loc}', { loc: LOC(e.deducted)?.name || e.deducted }) : e.noDeduct ? t('niet afgetrokken') : '';
  return `<li class="rlog"><span class="rl-l"><b>${fmtL(e.liters)}</b><small>L</small></span><span class="rl-b">${opt.noMach ? '' : `<b>${esc(m?.name || e.machineName || '?')}</b>`}
    <small>🧴 ${esc(o ? short(o) : e.oilName || '?')}${e.hours ? ` · ⏱ ${fmtL(e.hours)} h` : ''}</small>
    <small>${opt.noDay ? (tm ? '🕒 ' + tm : '') : '📅 ' + fmtD(e.date) + (tm ? ' ' + tm : '')}${e.by && e.by !== 'startdata' ? ' · 👤 ' + esc(e.by) : e.by === 'startdata' ? ' · ' + t('startgegevens') : ''}${from ? ' · 📦 ' + esc(from) : ''}</small>
    ${e.note ? `<span class="rl-n">📝 ${esc(e.note)}</span>` : ''}</span></li>`;
}
function dayLabel(d) {
  const td = today(); const y = new Date(Date.now() - 864e5 - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  if (d === td) return t('Vandaag'); if (d === y) return t('Gisteren');
  return new Date(d + 'T12:00:00').toLocaleDateString(LOCALES[getLang()], { weekday: 'long', day: 'numeric', month: 'long' });
}
function logHTML() {
  const xs = refillLog(); const by = F.logBy || 'dag';
  let h = `<div class="seg"><button class="${by === 'dag' ? 'on' : ''}" data-act="oilLogBy" data-v="dag">📅 ${t('Per dag')}</button><button class="${by === 'machine' ? 'on' : ''}" data-act="oilLogBy" data-v="machine">🔧 ${t('Per machine')}</button></div>`;
  if (!xs.length) return h + `<p class="infobox">${t('Nog geen bijvullingen geregistreerd.')}</p>`;
  const groups = new Map();
  for (const e of xs) { const k = by === 'dag' ? e.date || '' : e.machineId || e.machineName || '?'; (groups.get(k) || groups.set(k, []).get(k)).push(e); }
  for (const [k, es] of groups) {
    const sum = es.reduce((a, e) => a + (+e.liters || 0), 0);
    const title = by === 'dag' ? dayLabel(k) : mach(k)?.name || k;
    h += `<section class="card rlogday"><div class="ohead"><h3>${by === 'dag' ? '📅' : '🔧'} ${esc(title)}</h3><span class="oiltot">${fmtL(sum)} L</span></div><p class="small muted">${es.length === 1 ? t('1 bijvulling') : t('{n} bijvullingen', { n: es.length })}</p><ul class="rlog">${es.map((e) => logItem(e, by === 'dag' ? { noDay: true } : { noMach: true })).join('')}</ul></section>`;
  }
  return h;
}
function stockHTML() {
  const s = ST(); const stale = oils().some((o) => total(o).src === 'list');
  let h = stale ? `<p class="infobox small">${t('Grijze getallen komen uit de (verouderde) olielijst. Zodra een locatie geteld is, telt de app de locaties op.')}</p>` : '';
  for (const [cat, label] of Object.entries(CATS())) {
    const xs = oils().filter((o) => (o.cat || 'olie') === cat); if (!xs.length) continue;
    h += `<h3 class="sec">${esc(label)}</h3><div class="list">`;
    for (const o of xs) {
      const tt = total(o), mn = minOf(o), lowc = mn != null && tt.liters != null && tt.liters < mn;
      const ms = machines().filter((x) => x.oilId === o.id);
      const per = locEntries(o.id).map((x) => `${x.l.icon} ${esc(x.l.name)} ${fmtL(x.e.liters)}`).join(' · ');
      h += `<article class="card oil ${lowc ? 'low' : ''}" data-act="oilDetail" data-o="${o.id}"><div class="ohead"><b>${esc(short(o))}</b><span class="oiltot ${tt.src === 'list' ? 'stale' : ''}">${fmtL(tt.liters)} ${esc(o.unit || 'L')}</span></div>
        ${o.alias?.length > 1 ? `<small class="alias">${o.alias.slice(1).map(esc).join(' · ')}</small>` : ''}
        <p class="small">${mn != null ? `${lowc ? '🔴' : '🟢'} ${t('min/max (lijst)')}: ${fmtL(mn)} ${esc(o.unit || 'L')}` : `<span class="muted">${t('geen minimum')}</span>`}${o.bulk ? ` · <span class="tag">${t('bulk')}</span>` : ''}${tt.src === 'list' ? ` · <span class="muted">${t('lijst, verouderd')}</span>` : ''}${o.isNew ? ` · <span class="tag warn">${t('nieuw')}</span>` : ''}</p>
        ${per ? `<p class="small">${per}</p>` : `<p class="small muted">${t('Nog niet aan een locatie toegewezen')}</p>`}
        ${ms.length ? `<p class="small muted">🔧 ${ms.length} ${ms.length === 1 ? t('machine') : t('machines')}${ms.some((x) => x.samples?.length) ? ' · 🧪 ' + [...new Set(ms.flatMap((x) => x.samples || []))].join(', ') : ''}</p>` : ''}</article>`;
    }
    h += `</div>`;
  }
  return h;
}
function locsHTML() {
  const s = ST(); let h = `<p class="muted small">${t('Tik op "+ Toewijzen" om aan te klikken welke soorten op een locatie staan. Tik op een regel om liters of verpakking aan te passen.')}</p>`;
  for (const l of LOCS()) {
    const st = s.stock[l.id] || {}; const ids = Object.keys(st);
    const sum = ids.reduce((a, k) => a + (+st[k].liters || 0), 0);
    h += `<section class="card oilloc"><div class="ohead"><h3>${l.icon} ${esc(l.name)}</h3><span class="oiltot">${fmtL(sum)} L</span></div>
      ${ids.length ? `<ul class="oillist">${ids.map((k) => { const o = oilById(k), e = st[k]; const pk = PACKS()[e.pack]; return `<li data-act="oilSet" data-loc="${l.id}" data-o="${k}"><span><b>${esc(short(o))}</b><small>${pk ? esc(pk[0]) + (e.n ? ' × ' + e.n : '') + ' · ' : ''}${e.at ? fmtD(e.at) : ''}${e.by ? ' · 👤 ' + esc(e.by) : ''}</small></span><b>${fmtL(e.liters)} L</b></li>`; }).join('')}</ul>` : `<p class="muted small">${t('Nog leeg – wijs soorten toe of tel de inventaris.')}</p>`}
      <div class="row"><button class="btn small" data-act="oilAssign" data-loc="${l.id}">+ ${t('Toewijzen')}</button><button class="btn small" data-act="oilInv" data-loc="${l.id}">📋 ${t('Tellen')}</button></div></section>`;
  }
  return h;
}
function usageHTML() {
  const ms = machines(); const withData = ms.filter((x) => usage(x.id).pts.length), rest = ms.filter((x) => !usage(x.id).pts.length);
  let h = `<p class="muted small">${t('Verbruik = liters bijgevuld ÷ draaiuren sinds de vorige bijvulling. Zonder urenstand schat de app de uren uit de urenstanden (≈).')}</p>`;
  if (!withData.length) h += `<p class="infobox">${t('Nog geen bijvullingen geregistreerd.')}</p>`;
  for (const x of withData) h += machCard(x, F.mach === x.id || withData.length <= 3);
  if (rest.length) h += `<details class="auto"><summary>${t('Machines zonder bijvullingen ({n})', { n: rest.length })}</summary><ul class="locs">${rest.map((x) => `<li><span>${esc(x.name)}<small> · ${esc(short(oilById(x.oilId)))}${x.samples?.length ? ' · 🧪 ' + x.samples.join(', ') : ''}</small></span><button class="btn small" data-act="oilRefill" data-m="${x.id}">🛢 ${t('Bijvullen')}</button></li>`).join('')}</ul></details>`;
  return h;
}
function machCard(x, open) {
  const u = usage(x.id); const hint = usageHint(u);
  return `<section class="card mach ${u.warn ? 'warnc' : ''}"><div class="ohead"><h3>🔧 ${esc(x.name)}</h3>${x.samples?.length ? `<span class="tag">🧪 ${x.samples.join(', ')}</span>` : ''}</div>
    <p class="small muted">${esc(oilName(oilById(x.oilId)))}${x.vol ? ` · ${t('systeeminhoud')} ${fmtL(x.vol)} L` : ''}</p>
    <div class="mstats wstats"><div><b>${u.lastRate != null ? fmtL(u.lastRate) : '—'}</b><small>${t('L/100 h (laatste)')}</small></div><div><b>${u.avgRate != null ? fmtL(u.avgRate) : '—'}</b><small>${t('L/100 h (gem.)')}</small></div><div><b>${u.perWeek != null ? fmtL(u.perWeek) : '—'}</b><small>${t('L per week')}</small></div><div><b>${fmtL(u.total)}</b><small>${t('L totaal')}</small></div></div>
    ${u.warn ? `<p class="warnbox">⚠ ${t('Verbruik flink gestegen: {a} L/100 h, was gemiddeld {b} (+{p}%). Controleer op lekkage of slijtage.', { a: fmtL(u.warn.last), b: fmtL(u.warn.prev), p: u.warn.pct })}</p>` : ''}
    ${chartSVG(u)}${hint ? `<p class="muted small">ℹ️ ${esc(hint)}</p>` : ''}
    <details ${open ? 'open' : ''}><summary>${t('Historie ({n})', { n: u.pts.length })}</summary><table class="otab"><tr><th>${t('Datum')}</th><th>L</th><th>${t('Uren')}</th><th>L/100 h</th><th>👤</th></tr>${[...u.pts].reverse().map((p) => `<tr><td>${fmtD(p.date)}</td><td>${fmtL(p.liters)}</td><td>${p.h != null ? (p.est ? '≈ ' : '') + fmtL(p.h) : '—'}</td><td>${p.rate != null ? fmtL(p.rate) : '—'}</td><td>${esc(p.by || '')}</td></tr>`).join('')}</table></details>
    <button class="btn small" data-act="oilRefill" data-m="${x.id}">🛢 ${t('Bijvullen')}</button></section>`;
}
function orderItems() {
  return oils().map((o) => { const tt = total(o), mn = minOf(o); if (mn == null || tt.liters == null || tt.liters >= mn) return null; const need = mn - tt.liters; return { o, have: tt.liters, min: mn, need, cans: !o.bulk && o.unit === 'L' ? Math.ceil(need / 20) : null, stale: tt.src === 'list' }; }).filter(Boolean);
}
/* i18n-skip-start */
function orderText() {
  const xs = orderItems(); const sh = A.state.shipName;
  return [`🛒 Bestellijst olie – ${sh} – ${fmtD(today())}`, '', ...xs.map((x) => `• ${oilName(x.o)}: ${fmtL(x.need)} L${x.cans ? ` (≈ ${x.cans} × can 20 L)` : x.o.bulk ? ' (bulk)' : ''} – voorraad ${fmtL(x.have)} L, min ${fmtL(x.min)} L`), '', xs.some((x) => x.stale) ? '⚠ Voorraad deels uit de oude olielijst – na inventaris opnieuw controleren.' : '', `👤 ${A.state.settings.userName || ''}`].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n').trim();
}
/* i18n-skip-end */
function orderHTML() {
  const xs = orderItems();
  let h = `<p class="muted small">${t('Alles onder het minimum uit de olielijst, aangevuld tot dat minimum. Merknamen: alle bekende aliassen.')}</p>`;
  if (!xs.length) return h + `<p class="okbox">✔ ${t('Alles boven het minimum.')}</p>`;
  h += `<div class="list">${xs.map((x) => `<article class="card oil low"><div class="ohead"><b>${esc(short(x.o))}</b><span class="oiltot">${fmtL(x.need)} L</span></div><small class="alias">${x.o.alias.slice(1).map(esc).join(' · ')}</small><p class="small">${t('voorraad {a} L · min {b} L', { a: fmtL(x.have), b: fmtL(x.min) })}${x.cans ? ` · ≈ ${x.cans} × ${t('Can 20 L')}` : x.o.bulk ? ` · ${t('bulk')}` : ''}${x.stale ? ` · <span class="muted">${t('lijst, verouderd')}</span>` : ''}</p></article>`).join('')}</div>`;
  h += `<pre class="summary" id="orderTxt">${esc(orderText())}</pre><div class="row2"><button class="btn big" data-act="oilOrderCopy">📋 ${t('Kopiëren')}</button></div>`;
  return h;
}
function hoursHTML() {
  const s = ST(); const open = Object.values(s.hours).flat().filter((x) => !x.exported).length;
  let h = `<p class="muted small">${t('Vul de urenstand in zoals op de teller. De app schrijft niet naar MARAD: exporteer de lijst en neem hem over in MARAD.')}</p>`;
  h += `<div class="list">${hoursDefs().map((d) => { const r = s.hours[d.id] || [], last = r.at(-1), prev = r.at(-2); const perDay = last && prev && last.date !== prev.date ? (last.value - prev.value) / ((Date.parse(last.date) - Date.parse(prev.date)) / 864e5) : null;
    return `<article class="card hrs"><div class="ohead"><b>⏱ ${esc(d.name)}</b><span class="oiltot">${last ? fmtL(last.value) + ' h' : '—'}</span></div><p class="small muted">${last ? t('stand {d}', { d: fmtD(last.date) }) + (last.by ? ' · 👤 ' + esc(last.by) : '') : ''}${prev ? ' · ' + t('vorige {v} h op {d}', { v: fmtL(prev.value), d: fmtD(prev.date) }) : ''}${perDay != null ? ' · ≈ ' + fmtL(perDay) + ' ' + t('h/dag') : ''}</p>
      <div class="hrsrow"><input type="number" inputmode="numeric" id="hv-${d.id}" placeholder="${last ? last.value : ''}"><input type="date" id="hd-${d.id}" value="${today()}"><button class="btn small primary" data-act="oilHoursSave" data-h="${d.id}">${t('Opslaan')}</button></div></article>`; }).join('')}</div>`;
  h += `<section class="card"><h3>⬇ ${t('Export "Urenstanden voor MARAD"')}</h3><p class="muted small">${t('{n} urenstanden nog in MARAD in te voeren.', { n: open })}</p><div class="row"><button class="btn primary" data-act="oilHoursExport" ${open ? '' : 'disabled'}>${t('⬇ CSV "Urenstanden voor MARAD"')}</button><button class="btn" data-act="oilHoursEntered" ${open ? '' : 'disabled'}>${t('✔ Alles ingevoerd in MARAD')}</button></div></section>`;
  return h;
}
/** Bemanningsscherm: altijd een duidelijke olie-knop (ook buiten een ronde). */
export function crewCard() {
  const log = (A.state.oilLog || []).slice(-3).reverse();
  return `<section class="card oilcrew"><h2>🛢 ${t('Olie')}</h2><button class="btn primary huge" data-act="oilRefill">🛢 ${t('Olie bijgevuld')}</button><div class="row2"><button class="btn" data-act="oilInvMenu">📋 ${t('Inventaris')}</button><button class="btn" data-act="oilDelivery">📦 ${t('Levering')}</button></div>
    ${log.length ? `<h3 class="sec">🧾 ${t('Laatst bijgevuld')}</h3><ul class="rlog">${log.map((e) => (e.kind === 'refill' ? logItem(e) : `<li class="rlog"><span class="rl-b"><small>${esc(summary(e).short)} · ${A.fmtDT(e.at)}</small></span></li>`)).join('')}</ul>` : ''}</section>`;
}
/* i18n-skip-start */
/** Tekst voor ntfy-melding en lijst (Nederlands, zoals de overige meldingen). */
export function summary(e) {
  const o = oilById(e.oilId) || (e.oilName ? { alias: [e.oilName] } : null), m = mach(e.machineId), L = LOCDEF.find((l) => l.id === (e.fromLoc || e.loc));
  if (e.kind === 'refill') { const s = `${fmtL(e.liters)} L ${short(o)} → ${m?.name || e.machineName || '?'}`; return { short: '🛢 ' + s, title: `🛢 Olie bijgevuld: ${s} – ${e.by || ''}`, text: [`🛢 ${fmtL(e.liters)} L bijgevuld`, `🔧 Machine: ${m?.name || e.machineName || '?'}`, `🧴 Olie: ${o ? oilName(o) : '?'}`, e.hours ? `⏱ Urenstand: ${e.hours} h` : '', `📦 Van: ${L ? L.nl : 'automatisch (meeste voorraad)'}`, e.note ? `📝 ${e.note}` : ''].filter(Boolean).join('\n') }; }
  if (e.kind === 'delivery') { const s = `${fmtL(e.liters)} L ${short(o)} → ${L?.nl || '?'}`; return { short: '📦 ' + s, title: `📦 Olie geleverd: ${s} – ${e.by || ''}`, text: `📦 Levering: ${fmtL(e.liters)} L ${o ? oilName(o) : e.oilName || '?'}\n📍 Locatie: ${L?.nl || '?'}` }; }
  if (e.kind === 'inv') { const n = Object.keys(e.items || {}).length + (e.newOils || []).length; const sum = Object.values(e.items || {}).reduce((a, v) => a + (+v.liters || 0), 0) + (e.newOils || []).reduce((a, v) => a + (+v.liters || 0), 0); const s = `${L?.nl || '?'}: ${n} soorten, ${fmtL(sum)} L`; return { short: '📋 ' + s, title: `📋 Olie-inventaris ${s} – ${e.by || ''}`, text: `📋 Inventaris ${L?.nl || '?'}\n` + Object.entries(e.items || {}).map(([k, v]) => `• ${short(oilById(k))}: ${fmtL(v.liters)} L`).concat((e.newOils || []).map((v) => `• NIEUW ${v.name}: ${fmtL(v.liters)} L`)).join('\n') }; }
  if (e.kind === 'hours') return { short: `⏱ ${e.value} h`, title: `⏱ Urenstand ${e.value} h – ${e.by || ''}`, text: `⏱ ${e.value} h` };
  return { short: e.kind, title: e.kind, text: '' };
}
/* i18n-skip-end */

// ---------- velden in een ronde ----------
export function fieldHTML(f, v) {
  if (f.type === 'oilinv') {
    const n = v ? Object.keys(v.items || {}).length + (v.newOils || []).length : 0;
    return `<div class="fld oilfld" data-fid="${f.id}"><span class="flbl">📋 ${esc(A.tx(f, 'label'))}</span>${v ? `<p class="okc">✔ ${t('{n} soorten geteld', { n })}</p>` : ''}<button class="btn big ${v ? '' : 'primary'}" data-act="oilRunInv" data-fid="${f.id}" data-loc="${f.loc || ''}">${v ? t('Lijst aanpassen') : t('Lijst invullen')}</button></div>`;
  }
  const xs = Array.isArray(v) ? v : [];
  return `<div class="fld oilfld" data-fid="${f.id}"><span class="flbl">🛢 ${esc(A.tx(f, 'label'))}</span>${xs.map((e) => `<p class="okc">✔ ${esc(summary(e).short)}</p>`).join('')}<button class="btn big" data-act="oilRunRefill" data-fid="${f.id}">🛢 ${xs.length ? t('Nog een bijvulling') : t('Bijvulling registreren')}</button></div>`;
}
export function fmtValue(f, v) {
  if (f.type === 'oilinv') return v ? summary(v).short : '—';
  return Array.isArray(v) && v.length ? v.map((e) => summary(e).short).join('; ') : '—';
}

// ---------- sheets ----------
const machOpts = (sel) => { const ms = [...machines()].sort((a, b) => a.name.localeCompare(b.name)); return `<option value="">— ${t('kies machine')} —</option>` + ms.map((m) => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join(''); };
const locOpts = (sel, oilId, none = true) => (none ? `<option value="">${t('onbekend / niet aftrekken')}</option>` : '') + LOCS().map((l) => { const has = oilId && (M()?.oil ? ST().stock[l.id]?.[oilId] : (ref()?.assign?.[l.id] || []).includes(oilId)); return `<option value="${l.id}" ${l.id === sel ? 'selected' : ''}>${l.icon} ${esc(l.name)}${has ? ' ✓' : ''}</option>`; }).join('');
const oilOpts = (sel) => `<option value="">— ${t('kies oliesoort')} —</option>` + oils().map((o) => `<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${esc(oilName(o))}</option>`).join('') + `<option value="__new">+ ${t('Nieuwe soort…')}</option>`;
const packOpts = (sel) => Object.entries(PACKS()).map(([k, [lbl]]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(lbl)}</option>`).join('');
function bestLoc(oilId) {
  if (!oilId) return '';
  if (M()?.oil) { const es = locEntries(oilId).sort((a, b) => b.e.liters - a.e.liters); return es[0]?.l.id || ''; }
  const a = ref()?.assign || {}; return LOCS().find((l) => (a[l.id] || []).includes(oilId))?.id || '';
}
/** Laatst gebruikte machines (snelle keuze). */
function recentMachines(n = 4) {
  const evs = (ST() ? ST().events : A.state.oilLog || []).filter((e) => e.kind === 'refill' && e.machineId && !e.noDeduct);
  const out = []; for (const e of [...evs].reverse()) { if (!out.includes(e.machineId) && mach(e.machineId)) out.push(e.machineId); if (out.length >= n) break; }
  return out;
}
const oilLine = (m) => (m?.oilId && oilById(m.oilId) ? oilInfo(m) : m ? `<label>${t('Welke olie? (niet bekend voor deze machine)')}<select id="orO">${oilOpts('')}</select></label>` : t('Kies de machine – de olie komt er automatisch bij.'));
/** Snelle aantekening: machine → liters → (optioneel) notitie. Urenstand, locatie en datum onder "Meer". */
function refillSheet(ctx) {
  const r = ref(); draft = { kind: 'refill', ctx };
  const m0 = ctx.m ? mach(ctx.m) : null; const rec = recentMachines();
  A.openSheet(`<h2>🛢 ${t('Olie bijgevuld')}</h2><p class="muted small">${t('Snelle aantekening: machine, liters, klaar.')}</p>
    ${r ? `${rec.length ? `<div class="flbl">${t('Recent')}</div><div class="qchips">${rec.map((id) => `<button class="chip ${id === m0?.id ? 'on' : ''}" data-act="oilQM" data-m="${id}">🔧 ${esc(mach(id).name)}</button>`).join('')}</div>` : ''}
      <label>${t('Machine')}<select id="orM">${machOpts(m0?.id)}</select></label><div id="orOil" class="infobox small">${oilLine(m0)}</div>`
      : `<p class="warnbox small">${t('Nog geen olielijst op dit toestel. Vraag de beheerder om de olie-inventaris-route (die komt via de koppeling in je app); tot die tijd kun je machine en olie zelf typen.')}</p><label>${t('Machine')}<input id="orMt" autocomplete="off"></label><label>${t('Oliesoort')}<input id="orOt" autocomplete="off"></label>`}
    <label>${t('Liters')}<input id="orL" class="bignum" type="number" inputmode="decimal" step="any" min="0" placeholder="0"></label>
    <div class="qchips">${[5, 10, 20, 40].map((v) => `<button class="chip" data-act="oilQL" data-v="${v}">${v} L</button>`).join('')}</div>
    <label>${t('Aantekening (optioneel)')}<input id="orN" maxlength="140" autocomplete="off" placeholder="${t('bijv. lekje bij filter, na olieverversing…')}"></label>
    <details id="orMore" class="auto"><summary>${t('Meer: urenstand, locatie, datum')}</summary>
      <label>${t('Urenstand (optioneel)')}<input id="orH" type="number" inputmode="numeric" placeholder="${m0?.hoursId ? hrsPH(m0.hoursId) : ''}"></label>
      <label>${t('Van welke locatie?')}<select id="orFrom">${locOpts(bestLoc(m0?.oilId), m0?.oilId)}</select></label>
      <p class="muted small">${t('Niets kiezen is goed: de app trekt het automatisch af van de locatie met de meeste van deze olie.')}</p>
      <label>${t('Datum')}<input id="orD" type="date" value="${today()}"></label></details>
    <div class="row sticky"><button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button><button class="btn primary big" data-act="oilRefillSave">✔ ${t('Opslaan')}</button></div>`);
}
const hrsPH = (hid) => { const v = M()?.oil ? lastHours(hid)?.value : hoursDefs().find((h) => h.id === hid)?.last; return v != null ? t('laatst: {v} h', { v }) : ''; };
function oilInfo(m) { const o = oilById(m.oilId); return `🧴 <b>${esc(short(o))}</b>${o?.alias?.length > 1 ? `<br><small>${o.alias.slice(1).map(esc).join(' · ')}</small>` : ''}${m.samples?.length ? `<br><small>🧪 ${t('monstercode')} ${m.samples.join(', ')}</small>` : ''}`; }
function deliverySheet(ctx) {
  draft = { kind: 'delivery', ctx };
  A.openSheet(`<h2>📦 ${t('Levering ontvangen')}</h2>
    ${hasRef() ? `<label>${t('Oliesoort')}<select id="odO">${oilOpts('')}</select></label><label id="odNewL" hidden>${t('Naam nieuwe soort')}<input id="odNew"></label>` : `<label>${t('Oliesoort')}<input id="odNew"></label>`}
    <label>${t('Naar locatie')}<select id="odLoc">${locOpts('store', null, false)}</select></label>
    <div class="row2"><label>${t('Verpakking')}<select id="odP">${packOpts('can')}</select></label><label>${t('Aantal')}<input id="odN" type="number" inputmode="numeric" min="0"></label></div>
    <label>${t('Liters')}<input id="odL" type="number" inputmode="decimal" step="any" min="0"></label>
    <label>${t('Datum')}<input id="odD" type="date" value="${today()}"></label>
    <div class="row sticky"><button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button><button class="btn primary" data-act="oilDelSave">${t('Opslaan')}</button></div>`);
}
function invSheet(loc, ctx, prev) {
  const L = LOC(loc);
  const items = {};
  if (prev) Object.assign(items, JSON.parse(JSON.stringify(prev.items || {})));
  else if (M()?.oil) for (const [k, e] of Object.entries(ST().stock[loc] || {})) items[k] = { pack: e.pack || '', n: e.n ?? '', liters: e.liters };
  else for (const k of ref()?.assign?.[loc] || []) items[k] = { pack: '', n: '', liters: '' };
  draft = { kind: 'inv', loc, ctx, items, newOils: prev ? JSON.parse(JSON.stringify(prev.newOils || [])) : [] };
  A.openSheet(`<h2>📋 ${t('Inventaris')}: ${L.icon} ${esc(L.name)}</h2><p class="muted small">${t('Tik aan wat hier staat en vul liters of het aantal verpakkingen in. Niet aangetikt = staat hier niet.')}</p>
    <div id="oilInvList">${invRows()}</div>
    <div class="row sticky"><button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button><button class="btn primary" data-act="oilInvSave">${t('Opslaan')}</button></div>`);
}
function invRows() {
  const d = draft; const rows = oils().map((o) => {
    const it = d.items[o.id]; const on = !!it;
    return `<div class="invrow ${on ? 'on' : ''}"><button class="invtog" data-act="oilInvTog" data-o="${o.id}"><span class="box">${on ? '✔' : ''}</span><span><b>${esc(short(o))}</b>${o.alias?.length > 1 ? `<small>${o.alias.slice(1).map(esc).join(' · ')}</small>` : ''}</span></button>
      ${on ? `<div class="invin"><select data-oi="${o.id}" data-k="pack">${`<option value="">${t('verpakking')}</option>` + packOpts(it.pack)}</select><input data-oi="${o.id}" data-k="n" type="number" inputmode="numeric" min="0" placeholder="${t('aantal')}" value="${it.n ?? ''}"><input data-oi="${o.id}" data-k="liters" type="number" inputmode="decimal" step="any" min="0" placeholder="L" value="${it.liters ?? ''}"></div>` : ''}</div>`;
  }).join('');
  const nw = d.newOils.map((x, i) => `<div class="invrow on new"><div class="invin"><input data-ni="${i}" data-k="name" placeholder="${t('Naam nieuwe soort')}" value="${esc(x.name || '')}"><select data-ni="${i}" data-k="pack">${`<option value="">${t('verpakking')}</option>` + packOpts(x.pack)}</select><input data-ni="${i}" data-k="n" type="number" inputmode="numeric" placeholder="${t('aantal')}" value="${x.n ?? ''}"><input data-ni="${i}" data-k="liters" type="number" inputmode="decimal" step="any" placeholder="L" value="${x.liters ?? ''}"></div></div>`).join('');
  return rows + nw + `<button class="btn small" data-act="oilInvNew">+ ${t('Nieuwe soort')}</button>`;
}
function onInput(e) {
  const el = e.target; if (!draft) return;
  if (el.dataset.oi || el.dataset.ni) {
    const it = el.dataset.oi ? draft.items[el.dataset.oi] : draft.newOils[+el.dataset.ni]; if (!it) return;
    it[el.dataset.k] = el.value;
    if (el.dataset.k === 'n' || el.dataset.k === 'pack') { const sz = PACKS()[it.pack]?.[1]; if (sz && it.n !== '' && it.n != null) { it.liters = +it.n * sz; const li = el.parentElement.querySelector('[data-k=liters]'); if (li) li.value = it.liters; } }
  }
  if (el.id === 'odN' || el.id === 'odP') { const sz = PACKS()[$f('#odP').value]?.[1], n = $f('#odN').value; if (sz && n) $f('#odL').value = +n * sz; }
}
function onChange(e) {
  const el = e.target;
  if (el.id === 'orM') { const m = mach(el.value); $f('#orOil').innerHTML = oilLine(m); document.querySelectorAll('[data-act=oilQM]').forEach((b) => b.classList.toggle('on', b.dataset.m === el.value)); $f('#orFrom').innerHTML = locOpts(bestLoc(m?.oilId), m?.oilId); $f('#orH').placeholder = m?.hoursId ? hrsPH(m.hoursId) : t('geen urenteller'); }
  if (el.id === 'odO') $f('#odNewL').hidden = el.value !== '__new';
  if (el.dataset?.oi || el.dataset?.ni) onInput(e);
}
function who() { const st = A.state.settings; return st.userName || (A.isCrew() ? t('bemanning') : t('beheer')); }
/** Een registratie afhandelen: in Beheer direct verwerken; bij de bemanning via outbox/ntfy naar Beheer. */
async function dispatch(ev, ctx = {}) {
  const ar = A.state.activeRun;
  if (ctx.run && ar) {
    const s = ar.route.steps[ar.idx]; const vals = (ar.values[s.id] ||= {});
    if (ev.kind === 'inv') vals[ctx.fid] = ev; else (vals[ctx.fid] ||= []).push(ev);
    A.save();
  }
  A.closeSheet();
  if (ST()) { applyEv(ev); A.toast(t('Verwerkt: {s}', { s: summary(ev).short }), 3500); }
  else await A.sendOil(ev, summary(ev));
  if (ctx.run && ar) A.renderRun(); else A.render();
}
const evBase = (kind) => ({ id: `oe-${kind}-${Date.now().toString(36)}-${A.rid()}`, kind, at: new Date().toISOString(), by: who() });
export const actions = {
  oilV: (a) => { F.v = a.dataset.v; A.render(); },
  oilRefill: (a) => refillSheet({ m: a.dataset.m }),
  oilQM: (a) => { const s_ = $f('#orM'); if (!s_) return; s_.value = a.dataset.m; s_.dispatchEvent(new Event('change', { bubbles: true })); $f('#orL')?.focus(); },
  oilQL: (a) => { const i = $f('#orL'); if (i) { i.value = a.dataset.v; i.dispatchEvent(new Event('input', { bubbles: true })); } },
  oilLogBy: (a) => { F.logBy = a.dataset.v; A.render(); },
  oilRunRefill: (a) => refillSheet({ run: true, fid: a.dataset.fid }),
  oilRefillSave: () => {
    const L = +$f('#orL').value, mid = $f('#orM')?.value || null, mt = $f('#orMt')?.value.trim();
    if (!mid && !mt) return A.toast(t('Kies de machine'));
    if (!(L > 0)) { $f('#orL').focus(); return A.toast(t('Vul het aantal liters in')); }
    const m = mach(mid); const h = $f('#orH').value; const oSel = $f('#orO')?.value; const oid = m?.oilId || (oSel && oSel !== '__new' ? oSel : null);
    if (A.askProfile?.(() => actions.oilRefillSave())) return;
    const note = ($f('#orN')?.value || '').trim();
    const ev = { ...evBase('refill'), machineId: mid, machineName: m?.name || mt, oilId: oid, oilName: oid ? short(oilById(oid)) : $f('#orOt')?.value.trim() || '', liters: L, hours: h === '' ? null : +h, fromLoc: $f('#orFrom').value || null, date: $f('#orD').value || today(), ...(note ? { note } : {}) };
    dispatch(ev, draft?.ctx);
  },
  oilDelivery: () => deliverySheet({}),
  oilDelSave: () => {
    const sel = $f('#odO')?.value || '', nm = $f('#odNew')?.value.trim() || '', L = +$f('#odL').value;
    if (!sel && !nm) return A.toast(t('Kies de oliesoort'));
    if (sel === '__new' && !nm) { $f('#odNew').focus(); return A.toast(t('Vul de naam van de nieuwe soort in')); }
    if (!(L > 0)) { $f('#odL').focus(); return A.toast(t('Vul het aantal liters in')); }
    const o = sel && sel !== '__new' ? oilById(sel) : null;
    dispatch({ ...evBase('delivery'), oilId: o?.id || null, oilName: o ? short(o) : nm, loc: $f('#odLoc').value, pack: $f('#odP').value, n: $f('#odN').value === '' ? null : +$f('#odN').value, liters: L, date: $f('#odD').value || today() }, draft?.ctx);
  },
  oilInvMenu: () => A.openSheet(`<h2>📋 ${t('Inventaris tellen')}</h2><p class="muted">${t('Welke locatie tel je?')}</p><div class="stack">${LOCS().map((l) => `<button class="btn big" data-act="oilInv" data-loc="${l.id}">${l.icon} ${esc(l.name)}</button>`).join('')}</div>`),
  oilInv: (a) => invSheet(a.dataset.loc, {}),
  oilRunInv: (a) => { const ar = A.state.activeRun; const s = ar.route.steps[ar.idx]; invSheet(a.dataset.loc || 'mk', { run: true, fid: a.dataset.fid }, ar.values[s.id]?.[a.dataset.fid]); },
  oilInvTog: (a) => { const k = a.dataset.o; if (draft.items[k]) delete draft.items[k]; else draft.items[k] = { pack: oilById(k)?.bulk ? 'bulk' : '', n: '', liters: '' }; $f('#oilInvList').innerHTML = invRows(); },
  oilInvNew: () => { draft.newOils.push({ name: '', pack: '', n: '', liters: '' }); $f('#oilInvList').innerHTML = invRows(); $f(`[data-ni="${draft.newOils.length - 1}"][data-k=name]`)?.focus(); },
  oilInvSave: () => {
    const d = draft; const items = {};
    for (const [k, v] of Object.entries(d.items)) items[k] = { pack: v.pack || '', n: v.n === '' || v.n == null ? null : +v.n, liters: v.liters === '' || v.liters == null ? (PACKS()[v.pack]?.[1] && v.n ? +v.n * PACKS()[v.pack][1] : 0) : +v.liters };
    const newOils = d.newOils.filter((x) => x.name?.trim()).map((x) => ({ name: x.name.trim(), pack: x.pack || '', n: x.n === '' ? null : +x.n, liters: +x.liters || 0 }));
    dispatch({ ...evBase('inv'), loc: d.loc, full: true, items, newOils, date: today() }, d.ctx);
  },
  oilDetail: (a) => {
    const o = oilById(a.dataset.o); const ms = machines().filter((x) => x.oilId === o.id); const tt = total(o);
    A.openSheet(`<h2>🧴 ${esc(short(o))}</h2><p class="small">${o.alias.map(esc).join('<br>')}</p>
      <p>${t('Totaal')}: <b>${fmtL(tt.liters)} ${esc(o.unit || 'L')}</b>${tt.src === 'list' ? ` <span class="muted">(${t('lijst, verouderd')})</span>` : ''}</p>
      ${locEntries(o.id).map((x) => `<p class="small">${x.l.icon} ${esc(x.l.name)}: ${fmtL(x.e.liters)} L</p>`).join('')}
      ${ms.length ? `<h3>🔧 ${t('Machines')}</h3><ul class="locs">${ms.map((x) => `<li><span>${esc(x.name)}<small>${x.vol ? ' · ' + fmtL(x.vol) + ' L' : ''}${x.samples?.length ? ' · 🧪 ' + x.samples.join(', ') : ''}</small></span></li>`).join('')}</ul>` : ''}
      ${o.notes?.length ? `<p class="muted small">📝 ${o.notes.map(esc).join(' · ')}</p>` : ''}
      <label>${t('Minimum (leeg = uit de lijst)')}<input id="oMin" type="number" inputmode="decimal" placeholder="${o.target ?? ''}" value="${ST().min[o.id] ?? ''}"></label>
      <div class="row sticky"><button class="btn ghost" data-act="closeSheet">${t('Sluiten')}</button><button class="btn primary" data-act="oilMinSave" data-o="${o.id}">${t('Opslaan')}</button></div>`);
  },
  oilMinSave: (a) => { const v = $f('#oMin').value; if (v === '') delete ST().min[a.dataset.o]; else ST().min[a.dataset.o] = +v; A.persist(); A.closeSheet(); A.render(); },
  oilAssign: (a) => { const loc = a.dataset.loc; const st = ST().stock[loc] || {}; A.openSheet(`<h2>+ ${t('Toewijzen')}: ${esc(LOC(loc).name)}</h2><p class="muted small">${t('Tik aan welke soorten hier staan.')}</p><div class="list" id="oaList">${oils().map((o) => `<button class="invtog ${st[o.id] ? 'on' : ''}" data-act="oilAssignTog" data-loc="${loc}" data-o="${o.id}"><span class="box">${st[o.id] ? '✔' : ''}</span><span><b>${esc(short(o))}</b></span></button>`).join('')}</div><div class="row sticky"><button class="btn primary" data-act="closeSheet">${t('Klaar')}</button></div>`); },
  oilAssignTog: (a) => { const { loc, o } = a.dataset; const st = ST().stock[loc] || {}; applyEv({ ...evBase('set'), by: A.state.settings.userName || '', loc, oilId: o, remove: !!st[o], liters: 0, date: today() }); a.classList.toggle('on'); a.querySelector('.box').textContent = a.classList.contains('on') ? '✔' : ''; A.render(); },
  oilSet: (a) => { const { loc, o } = a.dataset; const e = ST().stock[loc]?.[o] || {}; draft = { kind: 'set', items: { [o]: { pack: e.pack || '', n: e.n ?? '', liters: e.liters ?? '' } } };
    A.openSheet(`<h2>${esc(short(oilById(o)))}</h2><p class="muted">${LOC(loc).icon} ${esc(LOC(loc).name)}</p><div class="invin big"><select data-oi="${o}" data-k="pack"><option value="">${t('verpakking')}</option>${packOpts(e.pack)}</select><input data-oi="${o}" data-k="n" type="number" inputmode="numeric" placeholder="${t('aantal')}" value="${e.n ?? ''}"><input data-oi="${o}" data-k="liters" type="number" inputmode="decimal" placeholder="L" value="${e.liters ?? ''}"></div>
    <div class="row sticky"><button class="btn danger" data-act="oilSetSave" data-loc="${loc}" data-o="${o}" data-rm="1">🗑 ${t('Hier weghalen')}</button><button class="btn primary" data-act="oilSetSave" data-loc="${loc}" data-o="${o}">${t('Opslaan')}</button></div>`); },
  oilSetSave: (a) => { const { loc, o, rm } = a.dataset; const v = draft.items[o]; applyEv({ ...evBase('set'), by: A.state.settings.userName || '', loc, oilId: o, remove: !!rm, pack: v.pack, n: v.n === '' ? null : +v.n, liters: +v.liters || 0, date: today() }); A.closeSheet(); A.render(); },
  oilHoursSave: (a) => { const hid = a.dataset.h, v = $f('#hv-' + hid).value, d = $f('#hd-' + hid).value || today(); if (v === '') return A.toast(t('Vul de urenstand in')); const last = lastHours(hid); if (last && +v < last.value && d >= last.date && !confirm(t('Lager dan de vorige stand ({v} h). Toch opslaan?', { v: last.value }))) return; applyEv({ ...evBase('hours'), by: A.state.settings.userName || '', hid, value: +v, date: d }); A.toast(t('Urenstand opgeslagen')); A.render(); },
  oilHoursExport: () => {
    const s = ST(); const rows = [['teller', 'datum', 'urenstand', 'door', 'bron']];
    for (const d of hoursDefs()) for (const x of s.hours[d.id] || []) if (!x.exported) rows.push([d.name, x.date.split('-').reverse().join('-'), x.value, x.by || '', x.src || '']);
    A.shareFile(`urenstanden-voor-marad-${today()}.csv`, '\ufeff' + rows.map((r) => r.map(A.csvCell).join(';')).join('\r\n'), 'text/csv', t('Urenstanden voor MARAD'));
  },
  oilHoursEntered: () => { for (const r of Object.values(ST().hours)) for (const x of r) x.exported = true; A.persist(); A.render(); A.toast(t('Gemarkeerd als ingevoerd in MARAD')); },
  oilOrderCopy: async () => { await A.copyText(orderText()); },
  oilInvRoute: () => {
    const st = A.state.settings; const now = Date.now();
    const r = { id: 'r-' + A.rid(), name: 'Olie-inventaris', description: 'Tel per locatie welke olie er staat.', assignee: '', createdAt: now, updatedAt: now, notifyTopic: st.ntfyTopic || '',
      tr: { en: { name: 'Oil inventory' }, id: { name: 'Inventaris oli' } },
      steps: LOCDEF.map((l) => ({ id: A.rid(), source: 'oil', locationId: l.locId, title: `Olie-inventaris: ${l.nl}`, instruction: 'Tik aan welke oliesoorten hier staan en vul liters of het aantal verpakkingen in. Staat er iets dat niet op de lijst staat? Tik op "+ Nieuwe soort".',
        tr: { en: { title: `Oil inventory: ${l.en}`, instruction: 'Tick which oils are stored here and enter litres or number of packages. Something not on the list? Tap "+ New type".' }, id: { title: `Inventaris oli: ${l.id_}`, instruction: 'Centang oli yang ada di sini dan isi liter atau jumlah kemasan. Ada yang tidak di daftar? Ketuk "+ Jenis baru".' } },
        fields: [{ id: 'oi', label: 'Olie-inventaris', type: 'oilinv', loc: l.id, tr: { en: { label: 'Oil inventory' }, id: { label: 'Inventaris oli' } } }, { id: 'or', label: 'Bijvullingen (optioneel)', type: 'oil', tr: { en: { label: 'Top-ups (optional)' }, id: { label: 'Penambahan (opsional)' } } }] })) };
    r.oilRef = buildRef(); A.state.routes.push(r); A.save(); A.sendRouteSheet(r);
  },
};
