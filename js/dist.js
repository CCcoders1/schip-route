// Taken verdelen (Beheer): lijst openen → taken op urgentie (te laat eerst) → taken aantikken (selectie)
// → "Stuur selectie naar…" (persoon / rang + optioneel naam) → de app maakt zelf de tactische looproute
// (slimme volgorde over het schip, binnen een plek de te late taken eerst) en opent het bestaande deelscherm.
// Toewijzingen en selectie staan lokaal (state.dist), gekoppeld aan lijst + taak.
import { t } from './i18n.js';
import { RANK_IDS, RANK_ICON, normRank, normRanks, rankLabel } from './ranks.js';

let A; // helpers uit app.js
const $f = (s) => document.querySelector(s);
const esc = (s) => A.esc(s);
const D = () => { const d = (A.state.dist ||= {}); d.a ||= {}; d.sent ||= {}; d.dueOnly ||= {}; d.sel ||= {}; return d; };
let PK = null; // open kiezer: { list }

export function initDist(api) { A = api; return { view, actions }; }

// ---------- toewijzing / selectie ----------
const lists = () => A.MT.distLists();
const listBy = (k) => lists().find((l) => l.key === k);
const sorted = (l) => [...l.tasks].sort((a, b) => A.MT.byUrgency(a, b));
const shown = (l) => { const xs = sorted(l); return D().dueOnly[l.key] ? xs.filter((x) => x.soon) : xs; };
const assignOf = (l, x) => { const e = D().a[l.key]?.[x.key]; return e?.rank ? e : null; };
const selOf = (l) => new Set(D().sel[l.key] || []);
const setSel = (l, s) => { D().sel[l.key] = [...s]; };
const whoKey = (a) => a.rank + '|' + (a.name || '');
const whoLabel = (a) => `${RANK_ICON[a.rank] || '👤'} ${rankLabel(a.rank)}${a.name ? ' · ' + a.name : ''}`;
const whoShort = (a) => a.name || rankLabel(a.rank);
const ST = () => ({ overdue: ['red', t('Te laat')], week: ['orange', t('Binnen 7 dagen')], month: ['yellow', t('Binnen 30 dagen')], later: ['', t('Later')], hours: ['', t('Op draaiuren')], none: ['', t('Geen datum')] });
const ST_ORDER = ['overdue', 'week', 'month', 'later', 'hours', 'none'];
const stOf = (x) => (ST_ORDER.includes(x.st) ? x.st : 'none');

/** Locaties in looproute-volgorde, kort ("Voordek → Brug → …"). */
function routePreview(steps, max = 6) {
  const names = [];
  for (const s of steps) { const l = A.loc(s.locationId); const n = l ? A.tx(l, 'name') : t('Geen locatie'); if (names[names.length - 1] !== n) names.push(n); }
  const more = names.length - max;
  return names.slice(0, max).map(esc).join(' → ') + (more > 0 ? ' → ' + t('+{n} plekken', { n: more }) : '');
}
const itemsOf = (l, keys) => l.tasks.filter((x) => keys.has(x.key)).map((x) => ({ ...x, list: l.key, routeId: l.routeId }));

// ---------- schermen ----------
export function view() {
  const v = A.view();
  if (!A.state.maint?.tasks && !lists().length) return A.header(t('Taken verdelen'), true) + `<section class="card"><p class="muted">${t('Ontgrendel de MARAD-gegevens om de vaste rondes te verdelen.')}</p><button class="btn primary big" data-act="mUnlockSheet">${t('🔓 Ontgrendelen')}</button></section>`;
  if (v.dist === '__send') return sendView();
  if (v.dist) { const l = listBy(v.dist); if (l) return listView(l); }
  return overview();
}
function listCard(l) {
  const n = l.tasks.length, od = l.tasks.filter((x) => x.st === 'overdue').length, done = l.tasks.filter((x) => assignOf(l, x)).length;
  const pct = n ? Math.round((done / n) * 100) : 0;
  return `<button class="card tap dlist" data-act="distOpen" data-k="${esc(l.key)}"><span class="dl-ic">${l.icon}</span><span class="dl-body"><b>${esc(l.name)}</b>
    <small>${t('{n} taken', { n })}${od ? ` · <span class="tag red">${t('{n} te laat', { n: od })}</span>` : ''}${done ? ` · 📤 ${t('{n} verstuurd', { n: done })}` : ''}</small>
    <span class="dbar"><i style="width:${pct}%"></i></span></span><span class="dl-go">›</span></button>`;
}
function sentList() { return Object.entries(D().sent).filter(([k, s]) => s.list && s.rank).map(([k, s]) => ({ k, s, r: A.state.routes.find((x) => x.id === s.routeId) })).filter((x) => x.r); }
function overview() {
  const ls = lists(), sl = sentList();
  let h = A.header(t('Taken verdelen'), true) + `<p class="muted">${t('Open een lijst: de te late taken staan bovenaan. Tik de taken aan die je wilt meegeven en stuur de selectie naar iemand. De app bepaalt zelf de looproute over het schip.')}</p>`;
  if (sl.length) h += `<button class="card tap dsendbanner" data-act="distSendView">📤 <b>${t('Verstuurde lijstjes')}</b><small>${t('{a} lijstjes · {b} taken', { a: sl.length, b: sl.reduce((a, x) => a + x.r.steps.length, 0) })}</small></button>`;
  const fx = ls.filter((l) => l.kind === 'fixed'), own = ls.filter((l) => l.kind === 'route');
  if (fx.length) h += `<h3 class="sec">📌 ${t('Vaste rondes')}</h3><div class="list">${fx.map(listCard).join('')}</div>`;
  else if (!A.state.maint?.tasks) h += `<section class="card"><p class="muted small">${t('Ontgrendel de MARAD-gegevens om de vaste rondes te verdelen.')}</p><button class="btn primary" data-act="mUnlockSheet">${t('🔓 Ontgrendelen')}</button></section>`;
  if (own.length) h += `<h3 class="sec">🧭 ${t('Eigen rondes')}</h3><div class="list">${own.map(listCard).join('')}</div>`;
  return h;
}
function listView(l) {
  const xs = shown(l), dueOnly = !!D().dueOnly[l.key], sel = selOf(l); const nSoon = l.tasks.filter((x) => x.soon).length;
  const nOd = l.tasks.filter((x) => x.st === 'overdue').length;
  let h = A.header(t('Taken verdelen'), true) + `<h2 class="dlh">${l.icon} ${esc(l.name)}</h2>`;
  h += `<p class="shipsub">${t('{n} taken', { n: l.tasks.length })}${l.period ? ' · ' + esc(l.period) : ''}</p>`;
  if (l.kind === 'fixed') h += `<div class="seg"><button class="${dueOnly ? '' : 'on'}" data-act="distDue" data-v="0">${t('Alle taken ({n})', { n: l.tasks.length })}</button><button class="${dueOnly ? 'on' : ''}" data-act="distDue" data-v="1">${t('Aan de beurt ({n})', { n: nSoon })}</button></div>`;
  h += `<p class="muted small">${t('Tik een taak aan om hem te selecteren. Daarna: "Stuur selectie naar…".')}</p>`;
  h += `<div class="row dselbar"><span class="dselcount"><b>${t('{n} geselecteerd', { n: sel.size })}</b></span>${nOd ? `<button class="btn small" data-act="distSelOd">⏰ ${t('Selecteer te late ({n})', { n: nOd })}</button>` : ''}<button class="btn small ghost" data-act="distSelAll">${t('Alles')}</button><button class="btn small ghost" data-act="distSelNone" ${sel.size ? '' : 'disabled'}>${t('Niets')}</button></div>`;
  h += '<div class="dtasks">';
  if (!xs.length) h += `<p class="empty">${t('Geen taken.')}</p>`;
  for (const st of ST_ORDER) {
    const g = xs.filter((x) => stOf(x) === st); if (!g.length) continue;
    const [cls, lbl] = ST()[st];
    h += `<h3 class="dsec ${cls}" data-st="${st}">${lbl} (${g.length})</h3>`;
    for (const x of g) {
      const on = sel.has(x.key), a = assignOf(l, x); const hint = normRanks(x.ranks).find((r) => RANK_IDS.includes(r));
      h += `<div class="dtask ${on ? 'sel' : ''} st-${st}" role="checkbox" tabindex="0" aria-checked="${on}" data-act="distTog" data-t="${esc(x.key)}" data-st="${st}">
        <span class="dchk">${on ? '✔' : ''}</span><div class="dt-body"><b>${esc(x.title)}</b><small>${esc(x.sub)}${x.due ? ` · 📅 ${esc(x.due)}` : ''}</small>
        <span class="dtags">${cls ? `<span class="tag ${cls}">${lbl}</span>` : ''}${hint ? `<span class="tag ghost">${RANK_ICON[hint]} ${esc(rankLabel(hint))}</span>` : ''}${a ? `<span class="tag sent">📤 ${esc(whoShort(a))}</span>` : ''}</span></div></div>`;
    }
  }
  h += '</div>';
  let pv = '';
  if (sel.size) { try { pv = routePreview(A.MT.distRoute(itemsOf(l, sel), { name: '' }).steps); } catch (e) { console.warn(e); } }
  h += `<div class="dfoot">${pv ? `<p class="dprev small">🧭 ${t('Route:')} ${pv}</p>` : ''}<button class="btn primary huge" data-act="distSendSel" ${sel.size ? '' : 'disabled'}>📤 ${t('Stuur selectie ({n}) naar…', { n: sel.size })}</button></div>`;
  return h;
}
function sendView() {
  const sl = sentList().sort((a, b) => RANK_IDS.indexOf(a.s.rank) - RANK_IDS.indexOf(b.s.rank) || (a.s.name || '').localeCompare(b.s.name || '') || (a.s.listName || '').localeCompare(b.s.listName || ''));
  let h = A.header(t('Verstuurde lijstjes'), true) + `<p class="muted">${t('Per ronde en ontvanger één lijstje, in looproute-volgorde. Dezelfde ronde opnieuw naar dezelfde persoon sturen vervangt dat lijstje.')}</p>`;
  if (!sl.length) return h + `<p class="empty">${t('Nog niets verstuurd.')}</p>`;
  for (const { k, s, r } of sl) {
    const who = { rank: s.rank, name: s.name || '' };
    h += `<section class="card dgroup"><div class="ohead"><h3>${esc(A.tx(r, 'name'))}</h3><span class="oiltot">${t('{n} taken', { n: r.steps.length })}</span></div>
      <p class="small"><b>→ ${esc(whoLabel(who))}</b></p>
      <p class="small">🧭 ${routePreview(r.steps)}</p>
      <details><summary>${t('Taken bekijken (looproute)')}</summary><ol class="plain small">${r.steps.map((x) => `<li>${esc(A.tx(x, 'title'))}</li>`).join('')}</ol></details>
      <p class="okc small">✔ ${t('Klaargezet/gedeeld {d}', { d: A.fmtDT(s.at) })}</p>
      <button class="btn wa big" data-act="distReshare" data-id="${esc(r.id)}">📲 ${t('Opnieuw delen')}</button></section>`;
  }
  return h;
}

// ---------- kiezer ----------
function pickSheet(l) {
  PK = { list: l.key }; const n = selOf(l).size;
  const people = A.state.contacts.filter((c) => c.func && RANK_IDS.includes(normRank(c.func)));
  const usedRaw = [...Object.values(D().a).flatMap((m) => Object.values(m)), ...Object.values(D().sent)].filter((e) => e.rank && e.name && !people.some((c) => c.name === e.name)).map((e) => e.rank + '|' + e.name);
  const used = [...new Set(usedRaw)];
  const pbtn = (rank, name) => `<button class="btn pbtn" data-act="distSet" data-r="${esc(rank)}" data-n="${esc(name)}">${RANK_ICON[rank]} <b>${esc(name)}</b> <small>${esc(rankLabel(rank))}</small></button>`;
  A.openSheet(`<h2>${t('Stuur {n} taken naar…', { n })}</h2><p class="muted small">${t('De app zet de taken zelf in een slimme looproute en opent daarna het deelscherm. Er wordt niets automatisch verstuurd.')}</p>
    ${people.length || used.length ? `<div class="flbl">${t('Persoon')}</div><div class="pgrid">${people.map((c) => pbtn(normRank(c.func), c.name)).join('')}${used.map((k) => pbtn(...k.split('|'))).join('')}</div>` : ''}
    <div class="flbl">${t('Rang')}</div><label class="small">${t('Naam erbij (optioneel)')}<input id="dName" autocomplete="off" autocapitalize="words" placeholder="${t('bijv. voornaam')}" value=""></label>
    <div class="rankgrid compact">${RANK_IDS.map((r) => `<button class="rankcard" data-act="distSet" data-r="${esc(r)}"><span class="ri">${RANK_ICON[r]}</span><b>${esc(rankLabel(r))}</b></button>`).join('')}</div>
    <div class="row sticky"><button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button></div>`, { dist: true });
}

// ---------- versturen ----------
const slug = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
/** Eén kaart per ronde × ontvanger: naam = naam van de bronlijst, teller = aantal verstuurde taken. */
function sendSelection(rank, name) {
  const l = listBy(PK?.list); if (!l || !rank) return;
  const sel = selOf(l); if (!sel.size) return;
  const who = { rank, name: name || '' }, wk = whoKey(who), key = l.key + '#' + wk;
  // zelfde ronde opnieuw naar dezelfde ontvanger = die kaart vervangen (andere rondes blijven staan)
  const a = (D().a[l.key] ||= {});
  for (const [tk, e] of Object.entries(a)) if (e.rank && whoKey(e) === wk) delete a[tk];
  const at = new Date().toISOString();
  for (const k of sel) a[k] = { rank, name: who.name, at };
  const r = A.MT.distRoute(itemsOf(l, sel), { name: l.name, assignee: who.name });
  const id = 'r-dist-' + slug(l.key) + '-' + slug(rank) + (who.name ? '-' + slug(who.name) : '');
  Object.assign(r, { id, name: l.name, tr: undefined, source: 'dist', distList: l.key, intendedRank: rank, intendedName: who.name, description: '' });
  delete r.tr;
  const i = A.state.routes.findIndex((x) => x.id === id); if (i >= 0) A.state.routes[i] = r; else A.state.routes.push(r);
  D().sent[key] = { at, n: r.steps.length, routeId: id, rank, name: who.name, list: l.key, listName: l.name };
  D().sel[l.key] = [];
  A.save(); A.closeSheet(); A.render(); A.openShare(r);
}

export const actions = {
  goDist: () => { A.closeSheet(); A.go('verdelen', { dist: null }); },
  distOpen: (a) => A.go('verdelen', { dist: a.dataset.k }),
  distSendView: () => A.go('verdelen', { dist: '__send' }),
  distDue: (a) => { const k = A.view().dist; D().dueOnly[k] = a.dataset.v === '1'; A.save(); A.render(); },
  distTog: (a) => { const l = listBy(A.view().dist); if (!l) return; const s = selOf(l); const k = a.dataset.t; if (s.has(k)) s.delete(k); else s.add(k); setSel(l, s); A.save(); const y = scrollY; A.render(); scrollTo(0, y); },
  distSelOd: () => { const l = listBy(A.view().dist); if (!l) return; setSel(l, new Set(l.tasks.filter((x) => x.st === 'overdue').map((x) => x.key))); A.save(); A.render(); },
  distSelAll: () => { const l = listBy(A.view().dist); if (!l) return; setSel(l, new Set(shown(l).map((x) => x.key))); A.save(); A.render(); },
  distSelNone: () => { const l = listBy(A.view().dist); if (!l) return; setSel(l, new Set()); A.save(); A.render(); },
  distSendSel: () => { const l = listBy(A.view().dist); if (l && selOf(l).size) pickSheet(l); },
  distSet: (a) => { const r = a.dataset.r || null; const n = a.dataset.n ?? ($f('#dName')?.value.trim() || ''); sendSelection(r, n); },
  distReshare: (a) => { const r = A.state.routes.find((x) => x.id === a.dataset.id); if (r) A.openShare(r); },
};
