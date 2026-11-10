// Taken verdelen (Beheer): lijst openen → taken op urgentie (te laat eerst) → taken aantikken (selectie)
// → "Stuur selectie naar…" (persoon / rang + optioneel naam) → de app maakt zelf de tactische looproute
// (slimme volgorde over het schip, binnen een plek de te late taken eerst) en plaatst het lijstje direct in de app
// van een gekoppeld persoon (v1.13: geen WhatsApp meer).
// Toewijzingen en selectie staan lokaal (state.dist), gekoppeld aan lijst + taak.
import { t } from './i18n.js';
import { RANK_IDS, RANK_ICON, normRank, normRanks, rankLabel } from './ranks.js';

let A; // helpers uit app.js
const $f = (s) => document.querySelector(s);
const esc = (s) => A.esc(s);
const D = () => { const d = (A.state.dist ||= {}); d.a ||= {}; d.sent ||= {}; d.dueOnly ||= {}; d.sel ||= {}; return d; };
let PK = null; // open kiezer: { list }

export function initDist(api) {
  A = api;
  // aantekeningen in het verstuur-scherm: meteen bewaren (zonder opnieuw te tekenen, dan blijft de cursor staan)
  document.addEventListener('input', (e) => {
    const el = e.target, P = D().pre; if (!P) return;
    if (el.dataset.pnote != null) { (P.notes ||= {})[el.dataset.pnote] = el.value; saveSoon(); }
    else if (el.dataset.ptnote != null) { const [lk, tk] = el.dataset.ptnote.split('|'); ((P.tnotes ||= {})[lk] ||= {})[tk] = el.value; saveSoon(); }
  });
  return { view, actions, back };
}
let saveT = 0; const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(() => A.save(), 300); };
const clean = (x) => String(x || '').replace(/\r/g, '').trim().slice(0, 1000);

// ---------- toewijzing / selectie ----------
const lists = () => A.MT.distLists();
const listBy = (k) => lists().find((l) => l.key === k);
const sorted = (l) => [...l.tasks].sort((a, b) => A.MT.byUrgency(a, b));
const shown = (l) => { const xs = sorted(l); return D().dueOnly[l.key] ? xs.filter((x) => x.soon) : xs; };
const assignOf = (l, x) => { const e = D().a[l.key]?.[x.key]; return e?.rank ? e : null; };
/** Na het versturen afgetekend? (MARAD-afmelding op/na de dag van toewijzen) → { by, date } of null. */
const doneOf = (l, x) => { const e = assignOf(l, x); const tk = x.marad && A.state.maint?.tasks?.find((y) => y.id === x.marad); const ad = tk?.appDone; if (!e || !ad?.date || ad.date < String(e.at).slice(0, 10)) return null; const lg = (tk.doneLog || []).filter((d) => d.date === ad.date).pop(); return { by: lg?.by || '', date: ad.date }; };
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
  if (v.dist === '__pre') return D().pre ? preView() : overview();
  if (v.dist) { const l = listBy(v.dist); if (l) return listView(l); }
  return overview();
}
function listCard(l) {
  const n = l.tasks.length, od = l.tasks.filter((x) => x.st === 'overdue').length, done = l.tasks.filter((x) => assignOf(l, x)).length, signed = l.tasks.filter((x) => doneOf(l, x)).length;
  const pct = n ? Math.round((done / n) * 100) : 0;
  return `<button class="card tap dlist" data-act="distOpen" data-k="${esc(l.key)}"><span class="dl-ic">${l.icon}</span><span class="dl-body"><b>${esc(l.name)}</b>
    <small>${t('{n} taken', { n })}${od ? ` · <span class="tag red">${t('{n} te laat', { n: od })}</span>` : ''}${done ? ` · 📤 ${t('{n} verstuurd', { n: done })}` : ''}${signed ? ` · ✔ ${t('{n} afgetekend', { n: signed })}` : ''}</small>
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
      const on = sel.has(x.key), a = assignOf(l, x), dn = a && doneOf(l, x); const hint = normRanks(x.ranks).find((r) => RANK_IDS.includes(r));
      h += `<div class="dtask ${on ? 'sel' : ''} st-${st}" role="checkbox" tabindex="0" aria-checked="${on}" data-act="distTog" data-t="${esc(x.key)}" data-st="${st}">
        <span class="dchk">${on ? '✔' : ''}</span><div class="dt-body"><b>${esc(x.title)}</b><small>${esc(x.sub)}${x.due ? ` · 📅 ${esc(x.due)}` : ''}</small>
        <span class="dtags">${cls ? `<span class="tag ${cls}">${lbl}</span>` : ''}${hint ? `<span class="tag ghost">${RANK_ICON[hint]} ${esc(rankLabel(hint))}</span>` : ''}${a ? (dn ? `<span class="tag ok sdone">✔ ${t('Afgetekend door {name}', { name: esc(dn.by || whoShort(a)) })}</span>` : `<span class="tag sent">📤 ${esc(whoShort(a))}</span>`) : ''}</span></div></div>`;
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
      ${r.note ? `<p class="anote small"><span class="an-lbl">📝 ${t('Aantekening')}</span>${esc(r.note)}</p>` : ''}
      <details><summary>${t('Taken bekijken (looproute)')}</summary><ol class="plain small">${r.steps.map((x) => `<li>${esc(A.tx(x, 'title'))}${x.note ? `<span class="tnote">💬 ${esc(x.note)}</span>` : ''}</li>`).join('')}</ol></details>
      ${statusLine(s)}
      ${s.via === 'app' ? (A.LINK.doneAfter(s.aid, s.ver) ? '' : `<div class="row"><button class="btn" data-act="distRedeliver" data-k="${esc(k)}">🔁 ${t('Opnieuw plaatsen')}</button></div>`) : `<p class="muted small">${t('Nog niet in de app geplaatst. Koppel deze persoon (Voortgang → Iemand koppelen) en stuur het lijstje opnieuw.')}</p>`}</section>`;
  }
  return h;
}

function statusLine(s) {
  if (s.via !== 'app') return '';
  const fin = A.LINK.doneAfter(s.aid, s.ver);
  if (fin) return `<p class="okc small dstat done">✅ ${t('Afgerond door {name} · {d}', { name: esc(fin.by || s.toName || ''), d: A.fmtDT(fin.finishedAt) })}</p>`;
  return s.ackVer >= s.ver ? `<p class="okc small dstat ok">✔ ${t('Ontvangen in de app van {name} · {d}', { name: esc(s.toName || ''), d: A.fmtDT(s.ackAt) })}</p>` : `<p class="small dstat wait">📬 ${t('Geplaatst {d} – wacht tot {name} online is', { d: A.fmtDT(s.pubAt), name: esc(s.toName || '') })}</p>`;
}
// ---------- kiezer ----------
function pickSheet(l) {
  PK = { list: l.key }; const n = selOf(l).size;
  const people = A.state.contacts.filter((c) => c.func && RANK_IDS.includes(normRank(c.func)));
  const usedRaw = [...Object.values(D().a).flatMap((m) => Object.values(m)), ...Object.values(D().sent)].filter((e) => e.rank && e.name && !people.some((c) => c.name === e.name)).map((e) => e.rank + '|' + e.name);
  const used = [...new Set(usedRaw)];
  const pbtn = (rank, name) => { const pc = A.LINK.pairedFor({ rank, name }); return `<button class="btn pbtn ${pc ? 'paired' : ''}" data-act="distSet" data-r="${esc(rank)}" data-n="${esc(name)}">${RANK_ICON[rank]} <b>${esc(name)}</b> <small>${esc(rankLabel(rank))}${pc ? ' · 🔗 ' + t('direct in app') : ''}</small></button>`; };
  A.openSheet(`<h2>${t('Stuur {n} taken naar…', { n })}</h2><p class="muted small">${t('De app zet de taken zelf in een slimme looproute. Gekoppelde mensen (🔗) krijgen het lijstje direct in hun app. Wie nog niet gekoppeld is, koppel je eerst (Voortgang → Iemand koppelen).')}</p>
    ${people.length || used.length ? `<div class="flbl">${t('Persoon')}</div><div class="pgrid">${people.map((c) => pbtn(normRank(c.func), c.name)).join('')}${used.map((k) => pbtn(...k.split('|'))).join('')}</div>` : ''}
    <div class="flbl">${t('Rang')}</div><label class="small">${t('Naam erbij (optioneel)')}<input id="dName" autocomplete="off" autocapitalize="words" placeholder="${t('bijv. voornaam')}" value=""></label>
    <div class="rankgrid compact">${RANK_IDS.map((r) => `<button class="rankcard" data-act="distSet" data-r="${esc(r)}"><span class="ri">${RANK_ICON[r]}</span><b>${esc(rankLabel(r))}</b></button>`).join('')}</div>
    <div class="row sticky"><button class="btn ghost" data-act="pairSheet">🔗 ${t('Iemand koppelen')}</button><button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button></div>`, { dist: true });
}

// ---------- versturen ----------
const slug = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
/** Niet gekoppeld: niets versturen en niets toewijzen (geen WhatsApp) – eerst koppelen; selectie blijft staan. */
function needPair(who) {
  A.openSheet(`<h2>🔗 ${t('{name} is nog niet gekoppeld', { name: esc(whoShort(who)) })}</h2><p class="warnbox dpairhint">${t('Versturen kan alleen naar iemand die gekoppeld is. Laat {name} in zijn app openen: Meer → Koppelen met Beheer → Kopieer koppelcode, en plak die code bij Voortgang → Iemand koppelen. Daarna kun je dit lijstje opnieuw sturen.', { name: esc(whoShort(who)) })}</p>
    <div class="stack"><button class="btn primary big" data-act="pairSheet">🔗 ${t('Iemand koppelen')}</button><button class="btn ghost" data-act="closeSheet">${t('Sluiten')}</button></div>`, { needPair: true });
}
// ---------- vóór het versturen: onderwerpen + aantekeningen (v1.15) ----------
/** Onderwerp = bronlijst/ronde met een selectie. De lijst waar je vandaan komt eerst. */
function subjects(P) {
  const out = []; const ks = [P.from, ...Object.keys(D().sel).filter((k) => k !== P.from)];
  for (const k of ks) { const l = listBy(k); const sel = l ? selOf(l) : null; if (l && sel.size) out.push({ l, items: sorted(l).filter((x) => sel.has(x.key)) }); }
  return out;
}
const sentKey = (l, who) => l.key + '#' + whoKey(who);
/** Na het kiezen van een (gekoppeld) persoon: het verstuur-scherm openen, met eerdere aantekeningen van dezelfde kaart al ingevuld. */
function startPre(who) {
  const from = PK?.list; const P = { from, rank: who.rank, name: who.name || '', notes: {}, tnotes: {}, edit: [], open: null, at: new Date().toISOString() };
  for (const { l } of subjects(P)) { const prev = D().sent[sentKey(l, who)]; if (prev?.note) P.notes[l.key] = prev.note; if (prev?.tnotes) P.tnotes[l.key] = { ...prev.tnotes }; }
  D().pre = P; A.save(); A.closeSheet(); A.go('verdelen', { dist: '__pre' }); scrollTo(0, 0);
}
const preview = (x, n = 70) => { const s_ = clean(x).replace(/\s+/g, ' '); return s_.length > n ? s_.slice(0, n - 1) + '…' : s_; };
function preView() {
  const P = D().pre; const who = { rank: P.rank, name: P.name }; const c = A.LINK.pairedFor(who);
  const subs = subjects(P);
  if (P.open) { const sub = subs.find((x) => x.l.key === P.open); if (sub) return subjectView(P, sub, c); P.open = null; }
  const nT = subs.reduce((a, x) => a + x.items.length, 0);
  const nNotes = subs.filter((x) => clean(P.notes?.[x.l.key])).length + subs.reduce((a, x) => a + x.items.filter((i) => clean(P.tnotes?.[x.l.key]?.[i.key])).length, 0);
  let h = A.header(t('Taken verdelen'), true) + `<h2 class="dlh">📤 ${t('Versturen')}</h2>`;
  h += `<section class="prewho"><span class="pw-ic">${RANK_ICON[who.rank] || '👤'}</span><span class="pw-body"><small>${t('Naar')}</small><b>${esc(whoShort(who))}</b><small>${esc(rankLabel(who.rank))}${c ? ' · 🔗 ' + t('direct in app') : ''}</small></span><button class="btn small ghost" data-act="preWho">${t('Wijzigen')}</button></section>`;
  h += `<div class="wb-head"><h2>${t('Onderwerpen')}</h2><span class="wb-range">${subs.length === 1 ? t('1 onderwerp') : t('{n} onderwerpen', { n: subs.length })} · ${t('{n} taken', { n: nT })}</span></div>`;
  h += `<p class="wb-sub">${t('Elk onderwerp wordt een eigen lijstje in zijn app. Voeg desgewenst een aantekening toe – leeg laten mag.')}</p>`;
  if (!subs.length) h += `<p class="wb-empty">${t('Geen taken geselecteerd.')}</p>`;
  h += `<div class="wb-list">`;
  for (const { l, items } of subs) {
    const note = clean(P.notes?.[l.key]); const tn = items.filter((i) => clean(P.tnotes?.[l.key]?.[i.key])).length;
    h += `<article class="psubj ${note || tn ? 'has' : ''}" data-k="${esc(l.key)}">
      <button class="ps-main" data-act="preOpen" data-k="${esc(l.key)}"><span class="wc-ic" aria-hidden="true">${l.icon}</span>
        <span class="wc-body"><b class="wc-name">${esc(l.name)}</b><span class="wc-meta">${items.length === 1 ? t('1 taak') : t('{n} taken', { n: items.length })}${tn ? ' · 💬 ' + (tn === 1 ? t('1 opmerking bij een taak') : t('{n} opmerkingen bij taken', { n: tn })) : ''}</span>
        <span class="ps-note ${note ? '' : 'empty'}">${note ? '📝 “' + esc(preview(note)) + '”' : t('Niets toegevoegd')}</span></span><span class="dl-go" aria-hidden="true">›</span></button>
      ${subs.length > 1 ? `<button class="ps-drop" data-act="preDrop" data-k="${esc(l.key)}" aria-label="${t('Niet meesturen')}" title="${t('Niet meesturen')}">✕</button>` : ''}</article>`;
  }
  h += `</div>`;
  h += `<div class="dfoot prefoot"><p class="dprev small">${subs.length === 1 ? t('1 lijstje') : t('{n} lijstjes', { n: subs.length })} · ${t('{n} taken', { n: nT })}${nNotes ? ' · ' + (nNotes === 1 ? t('1 aantekening') : t('{n} aantekeningen', { n: nNotes })) : ''}</p>
    <button class="btn primary huge" data-act="preSend" ${subs.length ? '' : 'disabled'}>📤 ${t('Versturen naar {name}', { name: esc(whoShort(who)) })}</button></div>`;
  return h;
}
function subjectView(P, { l, items }, c) {
  const edit = new Set(P.edit || []);
  let h = A.header(t('Taken verdelen'), true) + `<p class="pcrumb small">📤 ${t('Versturen')} › ${t('Aantekeningen')}</p><h2 class="dlh">${l.icon} ${esc(l.name)}</h2><p class="shipsub">${items.length === 1 ? t('1 taak') : t('{n} taken', { n: items.length })} · → ${esc(whoShort({ rank: P.rank, name: P.name }))}</p>`;
  h += `<label class="pnote"><span class="flbl">📝 ${t('Aantekening bij dit onderwerp')}</span><textarea data-pnote="${esc(l.key)}" rows="3" maxlength="1000" placeholder="${t('Optioneel – bijv. waar op te letten bij deze ronde')}">${esc(P.notes?.[l.key] || '')}</textarea><small class="muted">${t('Komt bovenaan het lijstje in zijn app.')}</small></label>`;
  h += `<h3 class="sec">💬 ${t('Opmerking per taak')} <small>(${t('optioneel')})</small></h3><div class="ptasks">`;
  for (const x of items) {
    const v = P.tnotes?.[l.key]?.[x.key] || ''; const open = v || edit.has(l.key + '|' + x.key);
    h += `<div class="ptask st-${stOf(x)} ${v ? 'has' : ''}"><div class="pt-head"><b>${esc(x.title)}</b><small>${esc(x.sub)}${x.due ? ` · 📅 ${esc(x.due)}` : ''}</small></div>
      ${open ? `<textarea data-ptnote="${esc(l.key + '|' + x.key)}" rows="2" maxlength="600" placeholder="${t('Opmerking bij deze taak')}">${esc(v)}</textarea>` : `<button class="btn small ghost pt-add" data-act="preTNote" data-k="${esc(l.key + '|' + x.key)}">＋ ${t('Opmerking')}</button>`}</div>`;
  }
  h += `</div><div class="dfoot prefoot"><button class="btn primary huge" data-act="preBack">✔ ${t('Klaar')}</button></div>`;
  return h;
}
/** Terug-knop: onderwerp → overzicht → lijst waar je vandaan kwam. */
export function back() {
  if (A.view().tab !== 'verdelen' || A.view().dist !== '__pre') return false;
  const P = D().pre; A.save();
  if (P?.open) { P.open = null; A.render(); scrollTo(0, 0); return true; }
  const from = P?.from; D().pre = null; A.save(); A.go('verdelen', { dist: from && listBy(from) ? from : null }); return true;
}
/** Eén kaart per ronde × ontvanger: naam = naam van de bronlijst, teller = aantal verstuurde taken.
 *  De aantekening (onderwerp) en de opmerkingen per taak gaan mee in het lijstje én staan bij de toewijzing. */
function sendOne(l, who, c, note, tnotes, quiet) {
  const sel = selOf(l); if (!sel.size) return null;
  const wk = whoKey(who), key = sentKey(l, who);
  // zelfde ronde opnieuw naar dezelfde ontvanger = die kaart vervangen (andere rondes blijven staan)
  const a = (D().a[l.key] ||= {});
  for (const [tk, e] of Object.entries(a)) if (e.rank && whoKey(e) === wk) delete a[tk];
  const at = new Date().toISOString();
  for (const k of sel) a[k] = { rank: who.rank, name: who.name, at };
  const r = A.MT.distRoute(itemsOf(l, sel), { name: l.name, assignee: who.name });
  const id = 'r-dist-' + slug(l.key) + '-' + slug(who.rank) + (who.name ? '-' + slug(who.name) : '');
  Object.assign(r, { id, name: l.name, tr: undefined, source: 'dist', distList: l.key, intendedRank: who.rank, intendedName: who.name, description: '' });
  delete r.tr;
  const tn = {}; for (const [k, v] of Object.entries(tnotes || {})) { const x = clean(v); if (x && sel.has(k)) tn[k] = x; }
  const nt = clean(note); if (nt) r.note = nt; else delete r.note;
  for (const st of r.steps) { const k = st.marad?.id || st.fromStep; if (k && tn[k]) st.note = tn[k]; else delete st.note; }
  const i = A.state.routes.findIndex((x) => x.id === id); if (i >= 0) A.state.routes[i] = r; else A.state.routes.push(r);
  const prev = D().sent[key] || {};
  D().sent[key] = { ...prev, at, n: r.steps.length, routeId: id, rank: who.rank, name: who.name, list: l.key, listName: l.name, note: nt, tnotes: tn };
  D().sel[l.key] = [];
  if (!r.intendedName) r.intendedName = c.name;
  return { r, key };
}
async function sendPre() {
  const P = D().pre; if (!P) return;
  const who = { rank: P.rank, name: P.name }; const c = A.LINK.pairedFor(who);
  if (!c) return needPair(who);
  const subs = subjects(P); if (!subs.length) return;
  const done = [];
  for (const { l } of subs) { const x = sendOne(l, who, c, P.notes?.[l.key], P.tnotes?.[l.key], true); if (x) done.push(x); }
  const from = P.from; D().pre = null; A.save();
  A.go('verdelen', { dist: from && listBy(from) ? from : null });
  let parts = 0; for (const { r, key } of done) parts += await A.LINK.deliver(r, c, key, { quiet: true });
  const on = navigator.onLine;
  A.openSheet(`<h2>📬 ${t('Wordt geplaatst bij {name}', { name: esc(c.name) })}</h2>
    <ul class="present">${done.map(({ r }) => `<li><b>${esc(A.tx(r, 'name'))}</b><small>${t('{n} taken', { n: r.steps.length })}${r.note ? ' · 📝' : ''}${r.steps.some((s_) => s_.note) ? ' · 💬 ' + r.steps.filter((s_) => s_.note).length : ''}</small></li>`).join('')}</ul>
    <p class="${on ? 'okbox' : 'warnbox'}">${on ? t('Het lijstje komt automatisch in de app van {name}. {name} heeft internet nodig om het te ontvangen.', { name: esc(c.name) }) : t('📴 Geen internet: het lijstje staat in de outbox en gaat vanzelf weg zodra er verbinding is.')}</p>
    <p class="muted small">${t('Verstuurd in {n} bericht(en). Je ziet onder Voortgang wanneer het is ontvangen.', { n: parts })}</p>
    <div class="stack"><button class="btn primary big" data-act="closeSheet">${t('OK')}</button></div>`);
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
  distSet: (a) => {
    const rank = a.dataset.r || null; const name = a.dataset.n ?? ($f('#dName')?.value.trim() || ''); if (!rank) return;
    const who = { rank, name }; if (!A.LINK.pairedFor(who)) return needPair(who);
    if (A.view().dist === '__pre' && D().pre) { Object.assign(D().pre, { rank, name }); A.save(); A.closeSheet(); A.render(); return; }
    startPre(who);
  },
  preOpen: (a) => { const P = D().pre; if (!P) return; P.open = a.dataset.k; A.save(); A.render(); scrollTo(0, 0); },
  preBack: () => back(),
  preTNote: (a) => { const P = D().pre; if (!P) return; (P.edit ||= []).push(a.dataset.k); const y = scrollY; A.render(); scrollTo(0, y); const el = document.querySelector(`[data-ptnote="${CSS.escape(a.dataset.k)}"]`); el?.focus({ preventScroll: true }); },
  preDrop: (a) => { const l = listBy(a.dataset.k); if (!l) return; D().sel[l.key] = []; if (D().pre?.from === l.key) D().pre.from = subjects(D().pre).find((x) => x.l.key !== l.key)?.l.key || l.key; A.save(); A.render(); },
  preWho: () => { const P = D().pre; const l = listBy(P?.from) || subjects(P || {})[0]?.l; if (l) pickSheet(l); },
  preSend: () => sendPre(),
};
