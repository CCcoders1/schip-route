// Taken verdelen (Beheer): lijst aantikken → alle taken → per taak een ontvanger (rang + optioneel naam)
// → samengestelde lijst per ontvanger → per ontvanger versturen via de bestaande deel-flow.
// Toewijzingen staan lokaal (state.dist), gekoppeld aan lijst + taak.
import { t } from './i18n.js';
import { RANK_IDS, RANK_ICON, normRank, normRanks, rankLabel } from './ranks.js';

let A; // helpers uit app.js
const $f = (s) => document.querySelector(s);
const esc = (s) => A.esc(s);
const D = () => { const d = (A.state.dist ||= {}); d.a ||= {}; d.sent ||= {}; d.dueOnly ||= {}; d.person ||= {}; d.on ||= {}; return d; };
let PK = null; // open keuze: { list, task | null (= alle onverdeelde) }

export function initDist(api) { A = api; return { view, actions }; }

// ---------- toewijzing ----------
const contactsOf = (rank) => A.state.contacts.filter((c) => c.func && normRank(c.func) === rank);
/** Standaardpersoon voor een rang: zelf gekozen, anders de enige persoon met die functie. */
function personFor(rank) { const p = D().person[rank]; if (p != null) return p; const cs = contactsOf(rank); return cs.length === 1 ? cs[0].name : ''; }
/** Voorstel: eerste herkende rang van de MARAD-taak (Junior Officer = 2nd Officer). */
function suggest(task) { const r = normRanks(task.ranks).find((x) => RANK_IDS.includes(x)); return r ? { rank: r, name: personFor(r), auto: true } : null; }
function assignOf(list, task) { const e = D().a[list.key]?.[task.key]; if (e) return e.rank ? { ...e, name: e.name ?? personFor(e.rank) } : null; return suggest(task); }
function setAssign(listKey, taskKey, rank, name) { const a = (D().a[listKey] ||= {}); a[taskKey] = rank ? { rank, name: name || '' } : { rank: null }; }
const lists = () => A.MT.distLists();
const listBy = (k) => lists().find((l) => l.key === k);
const shown = (l) => (D().dueOnly[l.key] ? l.tasks.filter((x) => x.soon) : l.tasks);
const whoKey = (a) => a.rank + '|' + (a.name || '');
const whoLabel = (a) => `${RANK_ICON[a.rank] || '👤'} ${rankLabel(a.rank)}${a.name ? ' · ' + a.name : ''}`;

/** Ontvangers met hun taken (over alle lijsten heen). */
function groups() {
  const g = new Map();
  for (const l of lists()) if (D().on[l.key]) for (const x of shown(l)) {
    const a = assignOf(l, x); if (!a) continue;
    const k = whoKey(a); const o = g.get(k) || { key: k, rank: a.rank, name: a.name || '', items: [], lists: new Map() };
    o.items.push({ ...x, list: l.key, routeId: l.routeId }); o.lists.set(l.name, (o.lists.get(l.name) || 0) + 1); g.set(k, o);
  }
  return [...g.values()].sort((a, b) => RANK_IDS.indexOf(a.rank) - RANK_IDS.indexOf(b.rank) || a.name.localeCompare(b.name));
}

// ---------- schermen ----------
export function view() {
  const v = A.view();
  if (!A.state.maint?.tasks && !lists().length) return A.header(t('Taken verdelen'), true) + `<section class="card"><p class="muted">${t('Ontgrendel de MARAD-gegevens om de vaste rondes te verdelen.')}</p><button class="btn primary big" data-act="mUnlockSheet">${t('🔓 Ontgrendelen')}</button></section>`;
  if (v.dist === '__send') return sendView();
  if (v.dist) { const l = listBy(v.dist); if (l) return listView(l); }
  return overview();
}
function progress(l) {
  const xs = shown(l); let n = 0; const per = new Map();
  for (const x of xs) { const a = assignOf(l, x); if (a) { n++; per.set(a.rank, (per.get(a.rank) || 0) + 1); } }
  return { total: xs.length, done: n, per };
}
function listCard(l) {
  const p = progress(l); const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  return `<button class="card tap dlist" data-act="distOpen" data-k="${esc(l.key)}"><span class="dl-ic">${l.icon}</span><span class="dl-body"><b>${esc(l.name)}</b>
    <small>${t('{n} taken', { n: p.total })} · ${p.done === p.total && p.total ? `<span class="okc">✔ ${t('alles verdeeld')}</span>` : t('{a} verdeeld · {b} onverdeeld', { a: p.done, b: p.total - p.done })}</small>
    ${D().on[l.key] ? `<span class="okc">📤 ${t('in de verzendlijst')}</span>` : ''}<span class="dbar"><i style="width:${pct}%"></i></span>
    ${p.per.size ? `<span class="dper">${[...p.per].sort((a, b) => RANK_IDS.indexOf(a[0]) - RANK_IDS.indexOf(b[0])).map(([r, n]) => `<span class="tag">${RANK_ICON[r]} ${n}</span>`).join(' ')}</span>` : ''}</span><span class="dl-go">›</span></button>`;
}
function overview() {
  const ls = lists(), gs = groups(); const nT = gs.reduce((a, g) => a + g.items.length, 0);
  let h = A.header(t('Taken verdelen'), true) + `<p class="muted">${t('Tik op een lijst, zie alle taken en tik per taak naar wie hij gaat. Alles wordt bewaard; versturen doe je daarna per ontvanger.')}</p>`;
  h += `<button class="card tap dsendbanner" data-act="distSendView" ${gs.length ? '' : 'disabled'}>📤 <b>${t('Klaar om te versturen')}</b><small>${gs.length ? t('{a} ontvangers · {b} taken', { a: gs.length, b: nT }) : t('Nog niets verdeeld')}</small></button>`;
  const fx = ls.filter((l) => l.kind === 'fixed'), own = ls.filter((l) => l.kind === 'route');
  if (fx.length) h += `<h3 class="sec">📌 ${t('Vaste rondes')}</h3><div class="list">${fx.map(listCard).join('')}</div>`;
  else if (!A.state.maint?.tasks) h += `<section class="card"><p class="muted small">${t('Ontgrendel de MARAD-gegevens om de vaste rondes te verdelen.')}</p><button class="btn primary" data-act="mUnlockSheet">${t('🔓 Ontgrendelen')}</button></section>`;
  if (own.length) h += `<h3 class="sec">🧭 ${t('Eigen rondes')}</h3><div class="list">${own.map(listCard).join('')}</div>`;
  return h;
}
const ST_TAG = () => ({ overdue: ['red', t('te laat')], week: ['orange', t('≤ 7 d')], month: ['', t('≤ 30 d')] });
function listView(l) {
  const xs = shown(l), p = progress(l), dueOnly = !!D().dueOnly[l.key]; const nSoon = l.tasks.filter((x) => x.soon).length;
  let h = A.header(t('Taken verdelen'), true) + `<h2 class="dlh">${l.icon} ${esc(l.name)}</h2>`;
  h += `<p class="shipsub">${t('{a} van {b} taken verdeeld', { a: p.done, b: p.total })}${l.period ? ' · ' + esc(l.period) : ''}</p>`;
  if (l.kind === 'fixed') h += `<div class="seg"><button class="${dueOnly ? '' : 'on'}" data-act="distDue" data-v="0">${t('Alle taken ({n})', { n: l.tasks.length })}</button><button class="${dueOnly ? 'on' : ''}" data-act="distDue" data-v="1">${t('Aan de beurt ({n})', { n: nSoon })}</button></div>`;
  h += `<p class="muted small">${t('Tik op de ontvanger naast een taak om te wijzigen. "Voorstel" = rang uit MARAD.')}</p>`;
  h += `<button class="btn donrow ${D().on[l.key] ? 'on' : ''}" data-act="distOn" data-k="${esc(l.key)}" aria-pressed="${D().on[l.key] ? 'true' : 'false'}">${D().on[l.key] ? '☑' : '☐'} ${t('Deze lijst meesturen')}</button>`;
  h += `<div class="row"><button class="btn small" data-act="distPick" data-k="${esc(l.key)}" data-all="1">${t('Alle onverdeelde → …')}</button><button class="btn small ghost" data-act="distReset" data-k="${esc(l.key)}">${t('↺ Terug naar voorstel')}</button></div>`;
  h += `<div class="dtasks">${xs.map((x) => { const a = assignOf(l, x); const tg = ST_TAG()[x.st];
    return `<article class="dtask ${a ? '' : 'open'}"><div class="dt-body"><b>${esc(x.title)}</b><small>${esc(x.sub)}${x.due ? ` · 📅 ${esc(x.due)}` : ''}${tg ? ` <span class="tag ${tg[0]}">${tg[1]}</span>` : ''}</small></div>
      <button class="dwho ${a ? (a.auto ? 'auto' : 'set') : 'none'}" data-act="distPick" data-k="${esc(l.key)}" data-t="${esc(x.key)}">${a ? `<span>${esc(whoLabel(a))}</span>${a.auto ? `<small>${t('voorstel')}</small>` : ''}` : `<span>➕ ${t('Kies')}</span>`}</button></article>`; }).join('') || `<p class="empty">${t('Geen taken.')}</p>`}</div>`;
  h += `<div class="dfoot"><button class="btn primary huge" data-act="distSendView">📤 ${t('Klaar → versturen')}</button></div>`;
  return h;
}
function sendView() {
  const gs = groups(); const sent = D().sent;
  let h = A.header(t('Klaar om te versturen'), true) + `<p class="muted">${t('Eén lijst per ontvanger. Tik op Versturen: de app maakt de route en opent het bekende deelscherm (WhatsApp, link of bestand). Bij de ontvanger staat hij onder "Voor jou".')}</p>`;
  if (!gs.length) return h + `<p class="empty">${t('Nog niets verdeeld.')}</p>`;
  for (const g of gs) {
    const s = sent[g.key];
    h += `<section class="card dgroup"><div class="ohead"><h3>${esc(whoLabel(g))}</h3><span class="oiltot">${t('{n} taken', { n: g.items.length })}</span></div>
      <p class="small muted">${[...g.lists].map(([n, c]) => `${esc(n)} (${c})`).join(' · ')}</p>
      ${!g.name && contactsOf(g.rank).length ? `<p class="small">${t('Naam (optioneel):')} ${contactsOf(g.rank).map((c) => `<button class="chip" data-act="distPerson" data-r="${esc(g.rank)}" data-n="${esc(c.name)}">👤 ${esc(c.name)}</button>`).join(' ')}</p>` : ''}
      <details><summary>${t('Taken bekijken')}</summary><ol class="plain small">${g.items.map((x) => `<li>${esc(x.title)}</li>`).join('')}</ol></details>
      ${s ? `<p class="okc small">✔ ${t('Klaargezet/gedeeld {d}', { d: A.fmtDT(s.at) })} · ${t('{n} taken', { n: s.n })}</p>` : ''}
      <button class="btn wa big" data-act="distSend" data-k="${esc(g.key)}">📲 ${s ? t('Opnieuw versturen') : t('Versturen naar {who}', { who: esc(g.name || rankLabel(g.rank)) })}</button></section>`;
  }
  return h;
}

// ---------- kiezer ----------
function pickSheet(list, task) {
  PK = { list: list.key, task: task?.key || null };
  const cur = task ? assignOf(list, task) : null;
  const people = A.state.contacts.filter((c) => c.func && RANK_IDS.includes(normRank(c.func)));
  const used = [...new Set(Object.values(D().a).flatMap((m) => Object.values(m)).filter((e) => e.rank && e.name && !people.some((c) => c.name === e.name)).map((e) => e.rank + '|' + e.name))];
  const pbtn = (rank, name) => `<button class="btn pbtn ${cur && cur.rank === rank && cur.name === name ? 'on' : ''}" data-act="distSet" data-r="${esc(rank)}" data-n="${esc(name)}">${RANK_ICON[rank]} <b>${esc(name)}</b> <small>${esc(rankLabel(rank))}</small></button>`;
  A.openSheet(`<h2>${task ? esc(task.title) : t('Alle onverdeelde taken')}</h2>${task?.sub ? `<p class="muted small">${esc(task.sub)}</p>` : ''}
    ${people.length || used.length ? `<div class="flbl">${t('Persoon')}</div><div class="pgrid">${people.map((c) => pbtn(normRank(c.func), c.name)).join('')}${used.map((k) => pbtn(...k.split('|'))).join('')}</div>` : ''}
    <div class="flbl">${t('Rang')}</div><label class="small">${t('Naam erbij (optioneel)')}<input id="dName" autocomplete="off" autocapitalize="words" placeholder="${t('bijv. voornaam')}" value=""></label>
    <div class="rankgrid compact">${RANK_IDS.map((r) => `<button class="rankcard ${cur && cur.rank === r && !cur.name ? 'on' : ''}" data-act="distSet" data-r="${esc(r)}"><span class="ri">${RANK_ICON[r]}</span><b>${esc(rankLabel(r))}</b></button>`).join('')}</div>
    <div class="row sticky"><button class="btn ghost" data-act="distSet" data-r="">${t('Onverdeeld')}</button><button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button></div>`, { dist: true });
}
function applyPick(rank, name) {
  const l = listBy(PK.list); if (!l) return;
  if (PK.task) setAssign(l.key, PK.task, rank, name);
  else for (const x of shown(l)) if (!assignOf(l, x)) setAssign(l.key, x.key, rank, name);
  A.save(); A.closeSheet(); A.render();
}

// ---------- versturen ----------
function send(key) {
  const g = groups().find((x) => x.key === key); if (!g) return;
  const who = g.name || rankLabel(g.rank);
  const name = t('Takenlijst {who} – {d}', { who: (g.name ? g.name + ' (' + rankLabel(g.rank) + ')' : rankLabel(g.rank)), d: new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) });
  const r = A.MT.distRoute(g.items, { name, assignee: g.name });
  const id = 'r-dist-' + g.rank.toLowerCase().replace(/[^a-z0-9]+/g, '') + (g.name ? '-' + g.name.toLowerCase().replace(/[^a-z0-9]+/g, '') : '');
  Object.assign(r, { id, source: 'dist', intendedRank: g.rank, intendedName: g.name || '', description: t('{n} taken voor {who}', { n: r.steps.length, who }) });
  const i = A.state.routes.findIndex((x) => x.id === id); if (i >= 0) A.state.routes[i] = r; else A.state.routes.push(r);
  D().sent[key] = { at: new Date().toISOString(), n: r.steps.length, routeId: id };
  A.save(); A.openShare(r);
}

export const actions = {
  goDist: () => { A.closeSheet(); A.go('verdelen', { dist: null }); },
  distOpen: (a) => { const k = a.dataset.k; if (!(k in D().on)) { D().on[k] = true; A.save(); } A.go('verdelen', { dist: k }); },
  distOn: (a) => { D().on[a.dataset.k] = !D().on[a.dataset.k]; A.save(); A.render(); },
  distSendView: () => A.go('verdelen', { dist: '__send' }),
  distDue: (a) => { const k = A.view().dist; D().dueOnly[k] = a.dataset.v === '1'; A.save(); A.render(); },
  distPick: (a) => { const l = listBy(a.dataset.k); if (!l) return; pickSheet(l, a.dataset.all ? null : l.tasks.find((x) => x.key === a.dataset.t)); },
  distSet: (a) => { const r = a.dataset.r || null; const n = a.dataset.n ?? ($f('#dName')?.value.trim() || (r ? personFor(r) : '')); applyPick(r, n); },
  distReset: (a) => { if (!confirm(t('Alle keuzes in deze lijst terugzetten naar het voorstel uit MARAD?'))) return; delete D().a[a.dataset.k]; A.save(); A.render(); },
  distPerson: (a) => { D().person[a.dataset.r] = a.dataset.n; for (const m of Object.values(D().a)) for (const e of Object.values(m)) if (e.rank === a.dataset.r && !e.name) e.name = a.dataset.n; A.save(); A.render(); },
  distSend: (a) => send(a.dataset.k),
};
