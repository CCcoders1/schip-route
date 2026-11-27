// Taken verdelen (Beheer): lijst openen → taken op urgentie (te laat eerst) → taken aantikken (selectie)
// → "Stuur selectie naar…" (persoon / rang + optioneel naam) → de app maakt zelf de tactische looproute
// (slimme volgorde over het schip, binnen een plek de te late taken eerst) en plaatst het lijstje direct in de app
// van een gekoppeld persoon (v1.13: geen WhatsApp meer).
// Toewijzingen en selectie staan lokaal (state.dist), gekoppeld aan lijst + taak.
import { t, getLang, LOCALES } from './i18n.js';
import { RANK_IDS, RANK_ICON, normRank, normRanks, rankLabel } from './ranks.js';

let A; // helpers uit app.js
const $f = (s) => document.querySelector(s);
const esc = (s) => A.esc(s);
const D = () => { const d = (A.state.dist ||= {}); d.a ||= {}; d.sent ||= {}; d.dueOnly ||= {}; d.sel ||= {}; return d; };
let PK = null; // open kiezer: { list }
let RO = null; // v1.19: open 'opnieuw sturen'-keuze: { k, sel:Set, note }

export function initDist(api) {
  A = api;
  // aantekeningen in het verstuur-scherm: meteen bewaren (zonder opnieuw te tekenen, dan blijft de cursor staan)
  document.addEventListener('input', (e) => {
    const el = e.target, P = D().pre; if (el.id === 'roNote' && RO) { RO.note = el.value; return; } if (!P) return;
    if (el.dataset.pnote != null) { (P.notes ||= {})[el.dataset.pnote] = el.value; saveSoon(); }
    else if (el.dataset.ptnote != null) { const [lk, tk] = el.dataset.ptnote.split('|'); ((P.tnotes ||= {})[lk] ||= {})[tk] = el.value; saveSoon(); }
  });
  return { view, actions, back, selfHTML, selfBusy, ideas };
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
const doneOf = (l, x) => { const e = assignOf(l, x); if (x.custom) return e ? customDone(x.key, e.at) : null; const tk = x.marad && A.state.maint?.tasks?.find((y) => y.id === x.marad); const ad = tk?.appDone; if (!e || !ad?.date || ad.date < String(e.at).slice(0, 10)) return null; const lg = (tk.doneLog || []).filter((d) => d.date === ad.date).pop(); return { by: lg?.by || '', date: ad.date }; };
const selOf = (l) => new Set(D().sel[l.key] || []);
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
/** Vandaag al afgemeld (door wie dan ook: zelf, rapport of ronde)? → { by } of null. Leest de bestaande MARAD-afmelding. */
const doneToday = (x) => { const tk = x.marad && A.state.maint?.tasks?.find((y) => y.id === x.marad); if (tk?.appDone?.date !== today()) return null; const lg = (tk.doneLog || []).filter((z) => z.date === tk.appDone.date).at(-1); return { by: lg?.by || '' }; };
const canSelf = (x) => !!x.marad && !doneToday(x);
const setSel = (l, s) => { D().sel[l.key] = [...s]; };
const whoKey = (a) => a.rank + '|' + (a.name || '');
// v1.17: "Ikzelf" – een lijstje voor Beheer zelf (blijft op dit toestel; geen koppeling, geen ntfy)
const SELF = 'self';
const isSelf = (a) => a?.rank === SELF;
const myName = () => A.state.settings.userName || '';
const icoOf = (a) => (isSelf(a) ? '🙋' : RANK_ICON[a.rank] || '👤');
const whoLabel = (a) => (isSelf(a) ? `🙋 ${t('Ikzelf')}` : `${RANK_ICON[a.rank] || '👤'} ${rankLabel(a.rank)}${a.name ? ' · ' + a.name : ''}`);
const whoShort = (a) => (isSelf(a) ? t('Ikzelf') : a.name || rankLabel(a.rank));
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
  if (v.dist === '__idea') return ideaView();
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
  let h = A.header(t('Taken verdelen'), true) + topTabs('lists') + `<p class="muted">${t('Open een lijst: de te late taken staan bovenaan. Tik de taken aan die je wilt meegeven en stuur de selectie naar iemand. De app bepaalt zelf de looproute over het schip.')}</p>`;
  h += ctBar();
  if (sl.length) h += `<button class="card tap dsendbanner" data-act="distSendView">📤 <b>${t('Verstuurde lijstjes')}</b><small>${t('{a} lijstjes · {b} taken', { a: sl.length, b: sl.reduce((a, x) => a + x.r.steps.length, 0) })}</small></button>`;
  const fx = ls.filter((l) => l.kind === 'fixed'), own = ls.filter((l) => l.kind === 'route');
  if (fx.length) h += `<h3 class="sec">📌 ${t('Vaste rondes')}</h3><div class="list">${fx.map(listCard).join('')}</div>`;
  else if (!A.state.maint?.tasks) h += `<section class="card"><p class="muted small">${t('Ontgrendel de MARAD-gegevens om de vaste rondes te verdelen.')}</p><button class="btn primary" data-act="mUnlockSheet">${t('🔓 Ontgrendelen')}</button></section>`;
  // v1.20: eigen taken
  const cus = ls.find((l) => l.kind === 'custom');
  if (cus?.tasks.length) h += `<h3 class="sec">✏️ ${t('Eigen taken')}</h3><div class="list cuslist">${listCard(cus)}</div>`;
  // v1.20: losse taken (niet in een vaste ronde) als eigen stapel
  const rest = ls.find((l) => l.kind === 'rest');
  if (rest && (rest.tasks.length || Object.values(D().sent).some((x) => x.list === rest.key))) h += `<h3 class="sec">🗂 ${t('Overige taken')}</h3><p class="muted small">${t('Losse taken die in geen enkele vaste ronde zitten – oudste te late bovenaan.')}</p><div class="list restlist">${listCard(rest)}</div>`;
  if (own.length) h += `<h3 class="sec">🧭 ${t('Eigen rondes')}</h3><div class="list">${own.map(listCard).join('')}</div>`;
  return h;
}
function listView(l) {
  const xs = shown(l), dueOnly = !!D().dueOnly[l.key], sel = selOf(l); const nSoon = l.tasks.filter((x) => x.soon).length;
  const nOd = l.tasks.filter((x) => x.st === 'overdue').length;
  let h = A.header(t('Taken verdelen'), true) + `<h2 class="dlh">${l.icon} ${esc(l.name)}</h2>`;
  h += `<p class="shipsub">${t('{n} taken', { n: l.tasks.length })}${l.period ? ' · ' + esc(l.period) : ''}</p>`;
  if (l.kind === 'fixed') h += `<div class="seg"><button class="${dueOnly ? '' : 'on'}" data-act="distDue" data-v="0">${t('Alle taken ({n})', { n: l.tasks.length })}</button><button class="${dueOnly ? 'on' : ''}" data-act="distDue" data-v="1">${t('Aan de beurt ({n})', { n: nSoon })}</button></div>`;
  const byLoc = l.kind === 'rest' && D().restBy === 'loc';
  if (l.kind === 'custom') h += ctBar(true);
  if (l.kind === 'rest') h += `<div class="restfilter">${A.MT.rankChips?.() || ''}</div><div class="seg restby"><button class="${byLoc ? '' : 'on'}" data-act="distRestBy" data-v="due">⏰ ${t('Oudste eerst')}</button><button class="${byLoc ? 'on' : ''}" data-act="distRestBy" data-v="loc">📍 ${t('Per locatie')}</button></div>`;
  h += `<p class="muted small">${t('Tik een taak aan om hem te selecteren. Daarna: "Stuur selectie naar…".')}</p>`;
  h += `<div class="row dselbar"><span class="dselcount"><b>${t('{n} geselecteerd', { n: sel.size })}</b></span>${nOd ? `<button class="btn small" data-act="distSelOd">⏰ ${t('Selecteer te late ({n})', { n: nOd })}</button>` : ''}<button class="btn small ghost" data-act="distSelAll">${t('Alles')}</button><button class="btn small ghost" data-act="distSelNone" ${sel.size ? '' : 'disabled'}>${t('Niets')}</button></div>`;
  h += '<div class="dtasks">';
  if (!xs.length) h += `<p class="empty">${t('Geen taken.')}</p>`;
  for (const st of ST_ORDER) {
    const g = xs.filter((x) => stOf(x) === st); if (!g.length) continue;
    const [cls, lbl0] = ST()[st]; const lbl = l.kind === 'custom' ? t('Eigen taken') : lbl0;
    h += `<h3 class="dsec ${cls}" data-st="${st}">${lbl} (${g.length})</h3>`;
    if (byLoc) { const LI = new Map(A.state.locations.map((y, i) => [y.id, i])); const li = (x) => LI.get(x.loc) ?? 1e6; g.sort((a, b) => li(a) - li(b) || (a.dd || '9999').localeCompare(b.dd || '9999')); }
    let lastLoc = null;
    for (const x of g) {
      if (byLoc && x.loc !== lastLoc) { lastLoc = x.loc; const lo = A.loc(x.loc); h += `<h4 class="dlocsec">📍 ${esc(lo ? A.tx(lo, 'name') : t('Geen locatie'))}</h4>`; }
      const on = sel.has(x.key), a = assignOf(l, x), dn = a && doneOf(l, x); const hint = normRanks(x.ranks).find((r) => RANK_IDS.includes(r));
      const td = !dn && doneToday(x);
      h += `<div class="dtask ${on ? 'sel' : ''} st-${st} ${td ? 'selfdone' : ''}" role="checkbox" tabindex="0" aria-checked="${on}" data-act="distTog" data-t="${esc(x.key)}" data-st="${st}">
        <span class="dchk">${on ? '✔' : ''}</span><div class="dt-body"><b>${esc(x.title)}</b><small>${esc(x.sub)}${x.due ? ` · 📅 ${esc(x.due)}` : ''}</small>
        <span class="dtags">${x.custom ? `<span class="tag ctag">✏️ ${t('Eigen taak')}</span>${!a || dn ? `<button class="btn small ghost cthide" data-act="ctHide" data-id="${esc(x.key)}">✕ ${t('Weghalen')}</button>` : ''}` : ''}${cls && !x.custom ? `<span class="tag ${cls}">${lbl}</span>` : ''}${hint ? `<span class="tag ghost">${RANK_ICON[hint]} ${esc(rankLabel(hint))}</span>` : ''}${a ? (dn ? `<span class="tag ok sdone">✔ ${t('Afgetekend door {name}', { name: esc(dn.by || whoShort(a)) })}</span>` : `<span class="tag sent">${isSelf(a) ? '🙋' : '📤'} ${esc(whoShort(a))}</span>`) : ''}${td ? `<span class="tag ok sdone">✔ ${t('Afgetekend door {name}', { name: esc(td.by || t('ik')) })}</span>` : ''}</span></div>${canSelf(x) ? `<button class="dself" data-act="distSelfOne" data-t="${esc(x.key)}" aria-label="${t('Zelf afvinken')}" title="${t('Zelf afvinken')}">✓</button>` : ''}</div>`;
    }
  }
  h += '</div>';
  let pv = '';
  if (sel.size) { try { pv = routePreview(A.MT.distRoute(itemsOf(l, sel), { name: '' }).steps); } catch (e) { console.warn(e); } }
  const nSelf = l.tasks.filter((x) => sel.has(x.key) && canSelf(x)).length;
  h += `<div class="dfoot">${pv ? `<p class="dprev small">🧭 ${t('Route:')} ${pv}</p>` : ''}<div class="dfoot-row"><button class="btn ok big dselfbtn" data-act="distSelf" ${nSelf ? '' : 'disabled'}>✔ ${t('Zelf afvinken ({n})', { n: nSelf })}</button><button class="btn primary big dsendbtn" data-act="distSendSel" ${sel.size ? '' : 'disabled'}>📤 ${t('Stuur selectie ({n}) naar…', { n: sel.size })}</button></div></div>`;
  return h;
}
function sendView() {
  const sl = sentList().sort((a, b) => RANK_IDS.indexOf(a.s.rank) - RANK_IDS.indexOf(b.s.rank) || (a.s.name || '').localeCompare(b.s.name || '') || (a.s.listName || '').localeCompare(b.s.listName || ''));
  let h = A.header(t('Verstuurde lijstjes'), true) + `<p class="muted">${t('Per ronde en ontvanger één lijstje, in looproute-volgorde. Dezelfde ronde opnieuw naar dezelfde persoon sturen vervangt dat lijstje.')}</p>`;
  if (!sl.length) return h + `<p class="empty">${t('Nog niets verstuurd.')}</p>`;
  // v1.18: dezelfde telling als Voortgang
  const cnt = {}; for (const { s } of sl) { if (s.via === 'self') continue; const st = A.LINK.sentState(s).st; cnt[st] = (cnt[st] || 0) + 1; }
  const SL = [['pending', '📬', t('Onderweg')], ['recv', '📥', t('Ontvangen')], ['busy', '⏳', t('Bezig')], ['done', '✅', t('Afgerond')], ['legacy', '⚪', t('Niet in de app')]];
  h += `<div class="ps-chips sentchips">${SL.filter(([k]) => cnt[k] || k !== 'legacy').map(([k, ic, l]) => `<span class="ps-chip st-${k}" data-st="${k}">${ic} ${l} <b>${cnt[k] || 0}</b></span>`).join('')}</div>`;
  for (const { k, s, r } of sl) {
    const who = { rank: s.rank, name: s.name || '' };
    h += `<section class="card dgroup"><div class="ohead"><h3>${esc(A.tx(r, 'name'))}</h3><span class="oiltot">${t('{n} taken', { n: r.steps.length })}</span></div>
      <p class="small"><b>→ ${esc(whoLabel(who))}</b></p>
      <p class="small">🧭 ${routePreview(r.steps)}</p>
      ${r.note ? `<p class="anote small"><span class="an-lbl">📝 ${t('Aantekening')}</span>${esc(r.note)}</p>` : ''}
      <details><summary>${t('Taken bekijken (looproute)')}</summary><ol class="plain small">${r.steps.map((x) => `<li>${esc(A.tx(x, 'title'))}${x.note ? `<span class="tnote">💬 ${esc(x.note)}</span>` : ''}</li>`).join('')}</ol></details>
      ${statusLine(s)}
      ${reopenNote(s)}
      ${s.via === 'self' ? `<p class="small dstat ${selfState(s).done ? 'done okc' : 'ok'}">${selfState(s).done ? '✅ ' + t('Afgerond') : '🙋 ' + t('Staat bovenaan je Rondes')}</p>${selfState(s).done ? reopenBtn(k) : ''}` : s.via === 'app' ? (A.LINK.sentState(s).st === 'done' ? reopenBtn(k) : `<div class="row"><button class="btn" data-act="distRedeliver" data-k="${esc(k)}">🔁 ${t('Opnieuw plaatsen')}</button></div>`) : `<p class="muted small">${t('Nog niet in de app geplaatst. Koppel deze persoon (Voortgang → Iemand koppelen) en stuur het lijstje opnieuw.')}</p>`}</section>`;
  }
  return h;
}

function statusLine(s) {
  if (s.via !== 'app') return '';
  const x = A.LINK.sentState(s); // v1.18: zelfde stand als Voortgang
  if (x.st === 'done') return `<p class="okc small dstat done">✅ ${x.at ? t('Afgerond door {name} · {d}', { name: esc(x.by || s.toName || ''), d: A.fmtDT(x.at) }) : t('Alle taken afgetekend')}</p>`;
  if (x.st === 'busy') return `<p class="small dstat busy">⏳ ${t('{name} is bezig · {a}/{b}', { name: esc(s.toName || ''), a: x.done, b: x.n })}</p>`;
  if (x.st === 'recv') return `<p class="okc small dstat ok">✔ ${t('Ontvangen in de app van {name} · {d}', { name: esc(s.toName || ''), d: A.fmtDT(x.at) })}</p>`;
  return `<p class="small dstat wait">📬 ${t('Geplaatst {d} – wacht tot {name} online is', { d: A.fmtDT(s.pubAt), name: esc(s.toName || '') })}</p>`;
}
// ---------- kiezer ----------
function pickSheet(l) {
  PK = { list: l.key }; const n = selOf(l).size;
  const people = A.state.contacts.filter((c) => c.func && RANK_IDS.includes(normRank(c.func)));
  const usedRaw = [...Object.values(D().a).flatMap((m) => Object.values(m)), ...Object.values(D().sent)].filter((e) => e.rank && e.name && !people.some((c) => c.name === e.name)).map((e) => e.rank + '|' + e.name);
  const used = [...new Set(usedRaw)];
  const pbtn = (rank, name) => { const pc = A.LINK.pairedFor({ rank, name }); return `<button class="btn pbtn ${pc ? 'paired' : ''}" data-act="distSet" data-r="${esc(rank)}" data-n="${esc(name)}">${RANK_ICON[rank]} <b>${esc(name)}</b> <small>${esc(rankLabel(rank))}${pc ? ' · 🔗 ' + t('direct in app') : ''}</small></button>`; };
  const me = myName();
  A.openSheet(`<h2>${t('Stuur {n} taken naar…', { n })}</h2><p class="muted small">${t('De app zet de taken zelf in een slimme looproute. Gekoppelde mensen (🔗) krijgen het lijstje direct in hun app. Wie nog niet gekoppeld is, koppel je eerst (Voortgang → Iemand koppelen).')}</p>
    ${l.kind === 'custom' ? tplToggle(l) : ''}
    <button class="btn pbtn pself" data-act="distSet" data-self="1">🙋 <b>${t('Ikzelf')}${me ? ` (${esc(me)})` : ''}</b> <small>${t('Komt bovenaan je Rondes · geen koppeling nodig')}</small></button>
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
  const out = []; const ks = P.only?.length ? P.only : [P.from, ...Object.keys(D().sel).filter((k) => k !== P.from)]; // v1.19: opnieuw sturen = alleen dat lijstje
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
  const P = D().pre; const who = { rank: P.rank, name: P.name }; const me = isSelf(who); const c = me ? null : A.LINK.pairedFor(who);
  const subs = subjects(P);
  if (P.open) { const sub = subs.find((x) => x.l.key === P.open); if (sub) return subjectView(P, sub, c); P.open = null; }
  const nT = subs.reduce((a, x) => a + x.items.length, 0);
  const nNotes = subs.filter((x) => clean(P.notes?.[x.l.key])).length + subs.reduce((a, x) => a + x.items.filter((i) => clean(P.tnotes?.[x.l.key]?.[i.key])).length, 0);
  let h = A.header(t('Taken verdelen'), true) + `<h2 class="dlh">📤 ${t('Versturen')}</h2>`;
  h += `<section class="prewho ${me ? 'self' : ''}"><span class="pw-ic">${icoOf(who)}</span><span class="pw-body"><small>${t('Naar')}</small><b>${esc(whoShort(who))}</b><small>${me ? t('Bovenaan je Rondes, op dit toestel') : esc(rankLabel(who.rank)) + (c ? ' · 🔗 ' + t('direct in app') : '')}</small></span><button class="btn small ghost" data-act="preWho">${t('Wijzigen')}</button></section>`;
  if (P.reopen) h += `<p class="infobox reopenbox">↩ ${P.reopen.n === 1 ? t('1 taak weer open gezet – stuur het lijstje opnieuw.') : t('{n} taken weer open gezet – stuur het lijstje opnieuw.', { n: P.reopen.n })}</p>`;
  h += `<div class="wb-head"><h2>${t('Onderwerpen')}</h2><span class="wb-range">${subs.length === 1 ? t('1 onderwerp') : t('{n} onderwerpen', { n: subs.length })} · ${t('{n} taken', { n: nT })}</span></div>`;
  h += `<p class="wb-sub">${me ? t('Elk onderwerp wordt een eigen lijstje bovenaan je Rondes. Voeg desgewenst een aantekening toe – leeg laten mag.') : t('Elk onderwerp wordt een eigen lijstje in zijn app. Voeg desgewenst een aantekening toe – leeg laten mag.')}</p>`;
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
    <button class="btn primary huge" data-act="preSend" ${subs.length ? '' : 'disabled'}>${me ? '🙋 ' + t('In mijn Rondes zetten') : '📤 ' + t('Versturen naar {name}', { name: esc(whoShort(who)) })}</button></div>`;
  return h;
}
function subjectView(P, { l, items }, c) {
  const edit = new Set(P.edit || []);
  let h = A.header(t('Taken verdelen'), true) + `<p class="pcrumb small">📤 ${t('Versturen')} › ${t('Aantekeningen')}</p><h2 class="dlh">${l.icon} ${esc(l.name)}</h2><p class="shipsub">${items.length === 1 ? t('1 taak') : t('{n} taken', { n: items.length })} · → ${esc(whoShort({ rank: P.rank, name: P.name }))}</p>`;
  h += `<label class="pnote"><span class="flbl">📝 ${t('Aantekening bij dit onderwerp')}</span><textarea data-pnote="${esc(l.key)}" rows="3" maxlength="1000" placeholder="${t('Optioneel – bijv. waar op te letten bij deze ronde')}">${esc(P.notes?.[l.key] || '')}</textarea><small class="muted">${isSelf(P) ? t('Komt bovenaan het lijstje in je Rondes.') : t('Komt bovenaan het lijstje in zijn app.')}</small></label>`;
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
function sendOne(l, who, c, note, tnotes, quiet, opt = {}) {
  const sel = selOf(l); if (!sel.size) return null;
  const cu = l.kind === 'custom' || !!opt.single; const stamp = cu ? Date.now().toString(36) + (opt.single ? Math.random().toString(36).slice(2, 5) : '') : '';
  const wk = whoKey(who), key = sentKey(l, who) + (cu ? '#' + stamp : '');
  // zelfde ronde opnieuw naar dezelfde ontvanger = die kaart vervangen (andere rondes blijven staan)
  const a = (D().a[l.key] ||= {});
  if (!cu) for (const [tk, e] of Object.entries(a)) if (e.rank && whoKey(e) === wk) delete a[tk];
  const at = new Date().toISOString();
  for (const k of sel) a[k] = { rank: who.rank, name: who.name, at };
  const r = A.MT.distRoute(itemsOf(l, sel), { name: l.name, assignee: who.name });
  const id = 'r-dist-' + slug(l.key) + '-' + slug(who.rank) + (who.name ? '-' + slug(who.name) : '') + (cu ? '-' + stamp : '');
  const cuT = l.kind === 'custom' ? (D().custom?.tasks || []).filter((x) => sel.has(x.id)) : [];
  const lname = cuT.length === 1 ? '✏️ ' + cuT[0].title : opt.single ? '💡 ' + (opt.title || l.name) : l.name;
  Object.assign(r, { id, name: lname, tr: undefined, source: 'dist', distList: l.key, intendedRank: who.rank, intendedName: who.name, description: '' });
  if (isSelf(who)) Object.assign(r, { self: true, intendedName: myName(), assignee: myName(), stepsDone: [] });
  delete r.tr;
  const tn = {}; for (const [k, v] of Object.entries(tnotes || {})) { const x = clean(v); if (x && sel.has(k)) tn[k] = x; }
  const nt = clean(note); if (nt) r.note = nt; else delete r.note;
  for (const st of r.steps) { const k = st.marad?.id || st.fromStep; if (k && tn[k]) st.note = tn[k]; else delete st.note; }
  const i = A.state.routes.findIndex((x) => x.id === id); if (i >= 0) A.state.routes[i] = r; else A.state.routes.push(r);
  const prev = D().sent[key] || {};
  D().sent[key] = { ...prev, at, n: r.steps.length, routeId: id, rank: who.rank, name: who.name, list: l.key, listName: lname, ...(l.kind === 'custom' ? { custom: cuT.map((x) => x.id) } : {}), ...(opt.single ? { idea: 1 } : {}), note: nt, tnotes: tn };
  D().sel[l.key] = [];
  if (!r.intendedName) r.intendedName = c?.name || '';
  return { r, key };
}
async function sendPre() {
  const P = D().pre; if (!P) return;
  const who = { rank: P.rank, name: P.name };
  if (isSelf(who)) return sendSelf(P, who);
  const c = A.LINK.pairedFor(who);
  if (!c) return needPair(who);
  const subs = subjects(P); if (!subs.length) return;
  const done = [];
  for (const { l } of subs) { const x = sendOne(l, who, c, P.notes?.[l.key], P.tnotes?.[l.key], true); if (x) { applyReopen(P, l, x); done.push(x); } }
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

// ---------- v1.25: idee-lijstjes (per gekoppeld persoon, bootsman vandaag, voor mij) ----------
const topTabs = (on) => `<div class="seg ideatabs"><button class="${on === 'lists' ? 'on' : ''}" data-act="distTop" data-v="lists">📋 ${t('Lijsten')}</button><button class="${on === 'idea' ? 'on' : ''}" data-act="distTop" data-v="idea">💡 ${t('Idee-lijstjes')}</button></div>`;
const ST_SET = ['Chief Officer', 'Marof', 'Engineer', 'Junior engineer']; // stagiair: dek, veiligheid en machinekamer (geen kapitein/2e stuurman-taken)
const OUT = ['dek', 'ruim', 'voor'];
const IDEA_MAX = 12;
const dayKey = () => today();
/** Wie krijgt een idee-lijstje: gekoppelde mensen (niet de kapitein), altijd de bootsman, en ikzelf. */
function ideaPeople() {
  const cs = A.LINK.paired().filter((c) => RANK_IDS.includes(normRank(c.func)) && normRank(c.func) !== 'Master');
  const ord = ['Stagiair', 'Engineer', 'Junior engineer', 'Marof', 'Chief Officer', 'Bosun', '2nd Officer'];
  const ps = cs.map((c) => ({ key: 'c:' + c.id, rank: normRank(c.func), name: c.name, c, kind: normRank(c.func) === 'Bosun' ? 'bosun' : normRank(c.func) === 'Stagiair' ? 'stagiair' : 'rank' }))
    .sort((a, b) => ord.indexOf(a.rank) - ord.indexOf(b.rank) || a.name.localeCompare(b.name));
  if (!ps.some((p) => p.kind === 'bosun')) { const i = ps.findIndex((p) => p.rank === '2nd Officer'); ps.splice(i < 0 ? ps.length : i, 0, { key: 'bosun', rank: 'Bosun', name: '', c: null, kind: 'bosun' }); }
  ps.push({ key: 'self', rank: SELF, name: '', c: null, kind: 'self' });
  return ps;
}
const myRankI = () => normRank(A.state.settings.myRank) || 'Engineer';
/** Past deze taak bij deze persoon? 0 = nee; hoger = beter. */
function fit(p, x) {
  const rk = normRanks(x.ranks);
  if (p.kind === 'bosun') return x.custom ? 3 : (OUT.includes(x.deck) && rk.some((r) => ['Marof', 'Chief Officer', 'Bosun'].includes(r)) ? 3 : 0);
  if (x.custom) return 0;
  if (p.kind === 'stagiair') return rk.some((r) => ST_SET.includes(r)) ? (x.deck === 'mk' ? 1 : 2) : 0;
  if (p.kind === 'self') return rk.includes(myRankI()) ? (x.deck === 'mk' ? 3 : 2) : 0;
  return rk.includes(p.rank) ? (rk.length === 1 ? 3 : 2) : 0;
}
/** Bronlijst van een taak (vaste ronde, Overige taken of Eigen taken) – voor toewijzen en versturen. */
function srcList(x) {
  const l = listBy(x.list); if (l && l.tasks.some((y) => y.key === x.key)) return l;
  if (l && l.kind !== 'rest') return { ...l, tasks: [...l.tasks, x] };
  const r = l || { key: x.list, kind: 'rest', icon: '🗂', name: t('Overige taken'), tasks: [] };
  return { ...r, tasks: [...r.tasks.filter((y) => y.key !== x.key), x] };
}
const busyIdea = (x) => { const l = srcList(x); const a = assignOf(l, x); return (a && !doneOf(l, x)) || !!doneToday(x); };
/** Slim verdelen: te laat (oudste eerst), dan binnen 7 dagen; elke taak bij de best passende persoon, max. ~12 per lijstje; nooit dubbel. */
function ideas() {
  const ps = ideaPeople(); const out = Object.fromEntries(ps.map((p) => [p.key, []]));
  const sk = D().ideaSkip?.day === dayKey() ? new Set(D().ideaSkip.ids || []) : new Set();
  const cus = listBy('eigen'); const custom = (cus?.tasks || []).filter((x) => !assignOf(cus, x)).map((x) => ({ ...x, list: 'eigen', deck: A.loc(x.loc)?.deck || '' }));
  const pool = [...(A.MT.ideaPool?.() || []).sort((a, b) => (a.st === 'overdue' ? 0 : 1) - (b.st === 'overdue' ? 0 : 1) || String(a.dd || '9999').localeCompare(String(b.dd || '9999'))), ...custom]
    .filter((x) => !busyIdea(x));
  const pass = (useSkip, only = null) => { for (const x of pool) {
    if (useSkip && sk.has(x.key)) continue; if (ps.some((p) => out[p.key].some((y) => y.key === x.key))) continue;
    let best = null, bs = 0; for (const p of ps) { if (only && !only.has(p.key)) continue; const f = fit(p, x); const n = out[p.key].length; if (!f || n >= IDEA_MAX) continue; if (f > bs || (f === bs && n < out[best.key].length)) { best = p; bs = f; } }
    if (best) out[best.key].push(x);
  } };
  pass(true); if (sk.size) { const empty = new Set(ps.filter((p) => !out[p.key].length).map((p) => p.key)); if (empty.size) pass(false, empty); }
  // looproute: per gebied/plek in de volgorde van het schip
  const LI = new Map(A.state.locations.map((y, i) => [y.id, i]));
  for (const k of Object.keys(out)) out[k].sort((a, b) => (LI.get(a.loc) ?? 1e6) - (LI.get(b.loc) ?? 1e6) || String(a.dd || '9999').localeCompare(String(b.dd || '9999')));
  return { ps, out };
}
const ideaWho = (p) => (p.kind === 'self' ? { rank: SELF, name: '' } : { rank: p.rank, name: p.name });
const ideaLabel = (p) => (p.kind === 'self' ? '🙋 ' + t('Voor mij vandaag') : p.kind === 'bosun' ? '⚒️ ' + t('Bootsman vandaag') + (p.name ? ' · ' + p.name : '') : `${RANK_ICON[p.rank] || '👤'} ${p.name}`);
function reasonOf(x) {
  if (x.custom) return ['', t('Eigen taak')];
  const d = x.dd ? Math.round((new Date(x.dd + 'T12:00:00') - new Date(today() + 'T12:00:00')) / 864e5) : null;
  if (x.st === 'overdue') return ['red', d != null ? t('{n} d te laat', { n: -d }) : t('Te laat')];
  return ['orange', d == null ? t('Binnen 7 dagen') : d === 0 ? t('vandaag') : t('over {n} d', { n: d })];
}
function ideaView() {
  const v = A.view(); const { ps, out } = ideas();
  const p = ps.find((x) => x.key === v.idea) || ps[0]; const xs = out[p.key] || [];
  const sel = new Set((D().ideaSel?.[p.key] || []).filter((k) => xs.some((x) => x.key === k)));
  const sentToday = Object.values(D().sent).filter((x) => x.idea && dayOf(x.at) === today() && x.rank === p.rank && (p.kind === 'bosun' && !p.name ? true : x.name === p.name)).length;
  let h = A.header(t('Taken verdelen'), true) + topTabs('idea');
  h += `<div class="chips ideappl">${ps.map((q) => `<button class="chip ${q.key === p.key ? 'on' : ''}" data-act="ideaWho" data-v="${esc(q.key)}">${esc(ideaLabel(q))} <b>${(out[q.key] || []).length}</b></button>`).join('')}</div>`;
  const desc = p.kind === 'self' ? t('Taken die bij jouw functie passen; machinekamer-taken gaan voor. Aangevinkte taken komen in je Vandaag (bovenaan Rondes).') : p.kind === 'bosun' ? t('Klusjes op dek, in het ruim en op het voorschip, plus je eigen taken. Aangevinkte taken gaan één voor één naar de bootsman.') : t('Voorstel uit MARAD: te laat eerst, dan binnen 7 dagen, passend bij zijn functie en nog bij niemand. Aangevinkte taken gaan één voor één naar zijn app.');
  h += `<p class="muted small">💡 ${desc}${sentToday ? ` <span class="tag green">📤 ${t('vandaag {n} los verstuurd', { n: sentToday })}</span>` : ''}</p>`;
  if (!p.c && p.kind === 'bosun') h += `<p class="warnbox small">${t('Nog geen bootsman gekoppeld – koppel hem eerst om de taken direct in zijn app te zetten.')} <button class="btn small" data-act="pairSheet">🔗 ${t('Iemand koppelen')}</button></p>`;
  h += `<div class="row dselbar"><span class="dselcount"><b>${t('{n} geselecteerd', { n: sel.size })}</b></span><button class="btn small ghost" data-act="ideaAll">${t('Alles')}</button><button class="btn small ghost" data-act="ideaNone">${t('Niets')}</button><button class="btn small" data-act="ideaNew">🔄 ${t('Vernieuw ideeën')}</button></div>`;
  h += '<div class="dtasks idealist">';
  if (!xs.length) h += `<p class="empty">${A.state.maint?.tasks ? t('Geen ideeën – alles is al verdeeld of niet aan de beurt.') : t('Ontgrendel de MARAD-gegevens om ideeën te krijgen.')}</p>`;
  let lastLoc = null;
  for (const x of xs) {
    if (x.loc !== lastLoc) { lastLoc = x.loc; const lo = A.loc(x.loc); h += `<h4 class="dlocsec">📍 ${esc(lo ? A.tx(lo, 'name') : t('Geen locatie'))}</h4>`; }
    const on = sel.has(x.key); const [cls, why] = reasonOf(x);
    h += `<div class="dtask ${on ? 'sel' : ''} st-${stOf(x)}" role="checkbox" tabindex="0" aria-checked="${on}" data-act="ideaTog" data-t="${esc(x.key)}"><span class="dchk">${on ? '✔' : ''}</span><div class="dt-body"><b>${esc(x.title)}</b><small>${esc(x.sub)}${x.due ? ` · 📅 ${esc(x.due)}` : ''}</small><span class="dtags"><span class="tag ${cls}">${esc(why)}</span></span></div></div>`;
  }
  h += '</div>';
  const n = sel.size; const who = p.kind === 'self' ? '' : p.name || t('bootsman');
  h += `<div class="dfoot"><div class="dfoot-row">${p.kind === 'self'
    ? `<button class="btn primary big" data-act="ideaSend" ${n ? '' : 'disabled'}>🙋 ${t('In mijn Vandaag zetten ({n})', { n })}</button>`
    : `<button class="btn primary big" data-act="ideaSend" ${n && p.c ? '' : 'disabled'}>📤 ${t('{n} taken los naar {name}', { n, name: esc(who) })}</button>`}</div></div>`;
  return h;
}
async function ideaSend() {
  const v = A.view(); const { ps, out } = ideas(); const p = ps.find((x) => x.key === v.idea) || ps[0];
  const keys = new Set(D().ideaSel?.[p.key] || []); const xs = (out[p.key] || []).filter((x) => keys.has(x.key)); if (!xs.length) return;
  const keep = JSON.parse(JSON.stringify(D().sel));
  if (p.kind === 'self') {
    const by = new Map(); for (const x of xs) { const l = srcList(x); if (!by.has(l.key)) by.set(l.key, l); }
    for (const k of by.keys()) D().sel[k] = xs.filter((x) => srcList(x).key === k).map((x) => x.key);
    const done = []; for (const l of by.values()) { const x = sendOne(l, { rank: SELF, name: '' }, null, '', {}, true, { single: true, title: l.name }); if (x) { Object.assign(D().sent[x.key], { via: 'self', ver: Date.now(), name: '' }); done.push(x); } }
    for (const [k, v_] of Object.entries(keep)) if (!by.has(k)) D().sel[k] = v_; else D().sel[k] = (v_ || []).filter((y) => !keys.has(y));
    (D().ideaSel ||= {})[p.key] = []; A.save(); A.render();
    A.openSheet(`<h2>🙋 ${t('In je Rondes gezet')}</h2><ul class="present">${done.map(({ r }) => `<li><b>${esc(A.tx(r, 'name'))}</b><small>${t('{n} taken', { n: r.steps.length })}</small></li>`).join('')}</ul>
      <p class="okbox">${t('Staat bovenaan je Rondes onder Vandaag. Start het als ronde of vink taken direct af.')}</p><div class="stack"><button class="btn primary big" data-act="selfGo">🧭 ${t('Naar Rondes')}</button><button class="btn ghost" data-act="closeSheet">${t('OK')}</button></div>`, { selfSent: true });
    return;
  }
  const c = p.c; if (!c) return needPair(ideaWho(p));
  const who = ideaWho(p); const done = [];
  for (const x of xs) { const l = srcList(x); D().sel[l.key] = [x.key]; const r = sendOne(l, who, c, '', {}, true, { single: true, title: x.title }); if (r) done.push(r); }
  for (const [k, v_] of Object.entries(keep)) D().sel[k] = (v_ || []).filter((y) => !keys.has(y));
  for (const k of Object.keys(D().sel)) if (!(k in keep)) D().sel[k] = [];
  (D().ideaSel ||= {})[p.key] = []; A.save(); A.render();
  let parts = 0; for (const { r, key } of done) parts += await A.LINK.deliver(r, c, key, { quiet: true });
  const on = navigator.onLine;
  A.openSheet(`<h2>📬 ${t('{n} losse taken naar {name}', { n: done.length, name: esc(c.name) })}</h2>
    <ul class="present">${done.map(({ r }) => `<li><b>${esc(A.tx(r, 'name'))}</b><small>${esc(r.steps[0] ? A.tx(r.steps[0], 'title') : '')}</small></li>`).join('')}</ul>
    <p class="${on ? 'okbox' : 'warnbox'}">${on ? t('Elke taak komt als eigen opdracht in de app van {name}.', { name: esc(c.name) }) : t('📴 Geen internet: het lijstje staat in de outbox en gaat vanzelf weg zodra er verbinding is.')}</p>
    <p class="muted small">${t('Verstuurd in {n} bericht(en). Je ziet onder Voortgang wanneer het is ontvangen.', { n: parts })}</p><div class="stack"><button class="btn primary big" data-act="closeSheet">${t('OK')}</button></div>`);
}

// ---------- lijstje voor mezelf (v1.17) ----------
/** Zelfde weg als naar een ander (onderwerpen, aantekeningen, één kaart per ronde × ontvanger), maar alleen lokaal: geen outbox, geen ntfy. */
function sendSelf(P, who) {
  const subs = subjects(P); if (!subs.length) return;
  const done = [];
  for (const { l } of subs) { const x = sendOne(l, who, null, P.notes?.[l.key], P.tnotes?.[l.key], true); if (x) { Object.assign(D().sent[x.key], { via: 'self', ver: Date.now(), name: '' }); applyReopen(P, l, x); done.push(x); } }
  const from = P.from; D().pre = null; A.save();
  A.go('verdelen', { dist: from && listBy(from) ? from : null });
  A.openSheet(`<h2>🙋 ${t('In je Rondes gezet')}</h2>
    <ul class="present">${done.map(({ r }) => `<li><b>${esc(A.tx(r, 'name'))}</b><small>${t('{n} taken', { n: r.steps.length })}${r.note ? ' · 📝' : ''}${r.steps.some((s_) => s_.note) ? ' · 💬 ' + r.steps.filter((s_) => s_.note).length : ''}</small></li>`).join('')}</ul>
    <p class="okbox">${t('Staat bovenaan je Rondes onder Vandaag. Start het als ronde of vink taken direct af.')}</p>
    <div class="stack"><button class="btn primary big" data-act="selfGo">🧭 ${t('Naar Rondes')}</button><button class="btn ghost" data-act="closeSheet">${t('OK')}</button></div>`, { selfSent: true });
}
const dayOf = (iso) => { const d = new Date(iso); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
/** Stand van een eigen lijstje – uit de bestaande MARAD-afmeldingen (op/na de dag van versturen) en afgeronde rondes. */
function selfState(s) {
  const r = A.state.routes.find((x) => x.id === s.routeId); if (!r) return { r: null, n: 0, signed: new Map(), done: false };
  const day = dayOf(s.at); const tasks = A.state.maint?.tasks || []; const signed = new Map(); let last = '';
  for (const st of r.steps) {
    const tk = st.marad?.id && tasks.find((y) => y.id === st.marad.id); const ad = tk?.appDone;
    if (ad?.date && ad.date >= day) { const lg = (tk.doneLog || []).filter((z) => z.date === ad.date).at(-1); signed.set(st.id, { by: lg?.by || '', date: ad.date }); if (ad.date > last) last = ad.date; }
  }
  const run = A.state.runs.filter((x) => x.routeId === r.id && x.finishedAt && x.finishedAt >= s.at).at(-1);
  if (run) { const d = dayOf(run.finishedAt); if (d > last) last = d; }
  const done = !!run || (r.steps.length > 0 && signed.size >= r.steps.length);
  return { r, n: r.steps.length, signed, done, last, day };
}
/** Eigen lijstjes voor het Vandaag-blok: open (ook van eerdere dagen) + vandaag afgerond. */
function selfLists() {
  const td = today();
  return Object.entries(D().sent).filter(([, s]) => s.via === 'self' && s.rank === SELF).map(([k, s]) => ({ k, s, ...selfState(s) }))
    .filter((x) => x.r && (!x.done || x.last === td)).sort((a, b) => a.done - b.done || String(a.s.at).localeCompare(String(b.s.at)));
}
/** Nog open eigen lijstje voor deze lijst? (weekbord: "bij Ikzelf"). */
function selfBusy(s) { return s.via === 'self' && !selfState(s).done; }
const shortDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString(LOCALES[getLang()], { weekday: 'short', day: 'numeric', month: 'short' });
export function selfHTML() {
  const xs = selfLists(); const td = today();
  let h = `<section class="selfblock"><div class="wb-head self"><h2>${t('Vandaag')}</h2><span class="wb-range">🙋 ${t('Mijn lijstjes')}</span></div>`;
  if (!xs.length) return h + `<p class="wb-empty">${t('Nog geen eigen lijstjes. Via Taken verdelen → Stuur selectie naar… → Ikzelf zet je er een klaar.')}</p></section>`;
  h += `<div class="wb-list">`;
  for (const x of xs) {
    const l = listBy(x.s.list); const nS = x.signed.size; const pct = x.n ? Math.round((nS / x.n) * 100) : 0;
    const old = !x.done && x.day < td;
    h += `<button class="wcard selfc ${x.done ? 'done' : ''}" data-act="selfOpen" data-k="${esc(x.k)}"><span class="wc-ic" aria-hidden="true">${x.done ? '✓' : l?.icon || '🧭'}</span>
      <span class="wc-body"><b class="wc-name">${esc(A.tx(x.r, 'name'))}</b>
        <span class="wc-meta">${x.n === 1 ? t('1 taak') : t('{n} taken', { n: x.n })}${nS && !x.done ? ' · ' + t('{a}/{b} afgevinkt', { a: nS, b: x.n }) : ''}${old ? ` · <span class="wc-late">${t('sinds {d}', { d: esc(shortDay(x.day)) })}</span>` : ''}</span>
        ${x.r.note && !x.done ? `<span class="ps-note">📝 “${esc(preview(x.r.note, 60))}”</span>` : ''}${x.done ? `<span class="wc-ok">✔ ${t('Afgerond')}</span>` : ''}</span>
      ${x.done ? '' : `<span class="wc-side"><span class="wc-count"><b class="okn">${x.n - nS}</b><small>${t('te doen')}</small></span></span>`}
      ${!x.done && nS ? `<span class="wc-prog"><i style="width:${pct}%"></i></span>` : ''}</button>`;
  }
  return h + `</div></section>`;
}
let SO = null; // open eigen lijstje (sheet)
function selfSheet(k) {
  const s = D().sent[k]; if (!s) return; const x = selfState(s); if (!x.r) return; SO = k;
  const loc = (id) => { const l = A.loc(id); return l ? A.tx(l, 'name') : t('Geen locatie'); };
  const left = x.n - x.signed.size;
  let h = `<h2>🙋 ${esc(A.tx(x.r, 'name'))}</h2><p class="muted small">${x.n === 1 ? t('1 taak') : t('{n} taken', { n: x.n })} · ${t('in looproute-volgorde')}${x.day < today() ? ' · ' + t('sinds {d}', { d: esc(shortDay(x.day)) }) : ''}</p>`;
  if (x.r.note) h += `<p class="anote"><span class="an-lbl">📝 ${t('Aantekening')}</span><span class="an-t">${esc(x.r.note)}</span></p>`;
  if (x.done) h += `<p class="okbox">✅ ${t('Afgerond')}</p>${reopenBtn(k)}`;
  else h += `<div class="stack"><button class="btn ok big" data-act="selfStart" data-k="${esc(k)}">${left < x.n ? t('▶ Start ronde ({n} over)', { n: left }) : t('▶ Start ronde')}</button></div>`;
  h += `<ol class="selfsteps">`;
  let lastLoc = null;
  for (const st of x.r.steps) {
    const sg = x.signed.get(st.id); const ln = loc(st.locationId);
    if (ln !== lastLoc) { h += `<li class="ss-loc">📍 ${esc(ln)}</li>`; lastLoc = ln; }
    h += `<li class="ss-step ${sg ? 'done' : ''}"><span class="ss-body"><b>${esc(A.tx(st, 'title'))}</b>${st.note ? `<span class="tnote">💬 ${esc(st.note)}</span>` : ''}${sg ? `<span class="tag ok sdone">✔ ${t('Afgetekend door {name}', { name: esc(sg.by || t('ik')) })}</span>` : ''}</span>
      ${!sg && st.marad?.id && !x.done ? `<button class="dself" data-act="selfOne" data-k="${esc(k)}" data-s="${esc(st.id)}" aria-label="${t('Zelf afvinken')}" title="${t('Zelf afvinken')}">✓</button>` : ''}</li>`;
  }
  h += `</ol><div class="row sticky"><button class="btn ghost" data-act="closeSheet">${t('Sluiten')}</button></div>`;
  A.openSheet(h, { self: k });
}
const reSelf = () => { const y = scrollY; A.render(); scrollTo(0, y); if (SO && document.querySelector('#sheet:not([hidden]) .selfsteps')) selfSheet(SO); };

// ---------- v1.19: afgerond lijstje opnieuw sturen (heropenen) ----------
const reopenBtn = (k) => `<div class="row"><button class="btn reopenbtn" data-act="distReopen" data-k="${esc(k)}">↩ ${t('Opnieuw sturen')}</button></div>`;
/** Laatste heropening van dit lijstje (audit) – zichtbaar onder Verstuurde lijstjes. */
function reopenNote(s) {
  const ro = s.reopened; if (!ro) return '';
  return `<p class="small muted reopened">↩ ${t('Heropend {d}', { d: A.fmtDT(ro.at) })} · ${t('{n} taken', { n: ro.n })}${ro.reason ? ' · “' + esc(preview(ro.reason, 60)) + '”' : ''}${ro.sent ? '' : ' · ' + t('nog niet opnieuw verstuurd')}</p>`;
}
const keyOf = (st) => st.marad?.id || st.fromStep;
/** Wat er bij dit lijstje hoort: taken (looproute), afmelding sinds versturen, en het resultaat uit het rapport. */
function reopenInfo(k) {
  const s = D().sent[k]; if (!s || !s.list) return null;
  const r = A.state.routes.find((x) => x.id === (s.routeId || s.aid)); if (!r) return null;
  const l = listBy(s.list); const since = dayOf(s.at || new Date(s.ver || Date.now()).toISOString());
  const run = A.state.runs.filter((x) => x.routeId === r.id && x.finishedAt).at(-1) || null;
  const steps = r.steps.map((st) => {
    const key = l?.kind === 'route' ? st.fromStep || keyOf(st) : keyOf(st); const so = st.marad?.id ? A.MT.signoffOf(st.marad.id, since) : null;
    const res = run?.results?.find((z) => z.stepId === st.id || (st.marad?.id && z.marad?.id === st.marad.id)) || null;
    return { st, key, so, res, ok: !!l && l.tasks.some((x) => x.key === key) };
  });
  return { s, r, l, since, steps, run, self: s.via === 'self' };
}
function reopenSheet(k, keep = false) {
  const I = reopenInfo(k); if (!I) return A.toast(t('Dit lijstje is niet meer te vinden.'));
  if (!keep || RO?.k !== k) RO = { k, sel: new Set(I.steps.filter((x) => x.ok).map((x) => x.key)), note: '' };
  const who = I.self ? t('Ikzelf') : I.s.toName || I.s.name || rankLabel(I.s.rank);
  const nSel = I.steps.filter((x) => x.ok && RO.sel.has(x.key)).length;
  let h = `<h2>↩ ${t('Opnieuw sturen')}</h2><p class="small"><b>${esc(A.tx(I.r, 'name'))}</b> → ${I.self ? '🙋 ' : ''}<b>${esc(who)}</b></p>
    <p class="muted small">${t('Alle taken staan aangevinkt. Vink uit wat echt klaar is. Alleen de aangevinkte taken gaan weer open (afmelding teruggedraaid, met aantekening in de geschiedenis) en komen opnieuw in het lijstje.')}</p>
    <div class="row dselbar"><span class="dselcount"><b>${t('{n} geselecteerd', { n: nSel })}</b></span><button class="btn small ghost" data-act="roAll">${t('Alles')}</button><button class="btn small ghost" data-act="roNone" ${nSel ? '' : 'disabled'}>${t('Niets')}</button></div><div class="dtasks rotasks">`;
  for (const x of I.steps) {
    const on = x.ok && RO.sel.has(x.key); const rs = x.res?.status;
    const tag = x.so ? `<span class="tag ok sdone">✔ ${t('Afgetekend door {name}', { name: esc(x.so.by || '?') })} · ${esc(x.so.doneDate)}</span>` : `<span class="tag ghost">${t('Niet afgetekend')}</span>`;
    const rtag = rs === 'problem' ? `<span class="tag warn">⚠ ${t('probleem')}</span>` : rs === 'skipped' ? `<span class="tag">↷ ${t('overgeslagen')}</span>` : '';
    h += `<div class="dtask rotask ${on ? 'sel' : ''} ${x.ok ? '' : 'off'}" role="checkbox" tabindex="0" aria-checked="${on}" ${x.ok ? `data-act="roTog" data-t="${esc(x.key)}"` : ''}>
      <span class="dchk">${on ? '✔' : ''}</span><div class="dt-body"><b>${esc(A.tx(x.st, 'title'))}</b><span class="dtags">${tag}${rtag}${x.so?.enteredInMarad ? `<span class="tag red">${t('Al ingevoerd in MARAD – daar ook corrigeren')}</span>` : ''}${x.ok ? '' : `<span class="tag">${t('Staat niet meer in de lijst')}</span>`}</span></div></div>`;
  }
  h += `</div><label class="pnote"><span class="flbl">📝 ${t('Extra aantekening (optioneel)')}</span><textarea id="roNote" rows="2" maxlength="600" placeholder="${t('Nog niet af, graag afmaken')}">${esc(RO.note)}</textarea></label>
    <div class="row"><button class="btn small ghost" data-act="roNoteFill">＋ ${t('Nog niet af, graag afmaken')}</button></div>
    <p class="muted small">${I.s.note ? t('De vorige aantekening en opmerkingen blijven staan; je ziet ze in het volgende scherm.') : t('Je ziet alles nog in het volgende scherm voordat het verstuurd wordt.')}</p>
    <div class="row sticky"><button class="btn primary big" data-act="roGo" ${nSel ? '' : 'disabled'}>↩ ${t('Heropenen en verder ({n})', { n: nSel })}</button><button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button></div>`;
  A.openSheet(h, { reopen: k });
}
/** Heropenen: afmeldingen terug (audit), selectie klaarzetten, en via het gewone Versturen-scherm naar dezelfde persoon. */
function reopenGo() {
  const I = RO && reopenInfo(RO.k); if (!I || !I.l) return A.toast(t('Dit lijstje is niet meer te vinden.'));
  const xs = I.steps.filter((x) => x.ok && RO.sel.has(x.key)); if (!xs.length) return;
  const extra = clean(RO.note);
  const who = I.self ? { rank: SELF, name: '' } : { rank: I.s.rank, name: I.s.name || '' };
  if (!I.self && !A.LINK.pairedFor(who)) return needPair(who);
  const rec = A.MT.reopenSignoffs(xs.map((x) => x.st.marad?.id).filter(Boolean), I.since, { reason: extra || t('Opnieuw gestuurd'), sentKey: RO.k, to: I.self ? 'self' : I.s.toName || I.s.name || '', route: I.r.id });
  const at = new Date().toISOString();
  // waarden uit het rapport meegeven (de bemanning hoeft ze niet opnieuw in te typen)
  const vals = {}; for (const x of xs) if (x.res?.values && Object.keys(x.res.values).length) vals[x.st.marad?.id || x.st.title] = x.res.values;
  I.s.reopened = { at, n: xs.length, rec: rec?.id || '', reason: extra, sent: false };
  (I.s.reopens ||= []).push({ at, n: xs.length, rec: rec?.id || '', reason: extra });
  for (const k of Object.keys(D().sel)) if (k === I.l.key) D().sel[k] = [];
  setSel(I.l, new Set(xs.map((x) => x.key)));
  PK = { list: I.l.key }; const k = RO.k; RO = null;
  startPre(who);
  const P = D().pre; P.only = [I.l.key];
  P.reopen = { k, at, n: xs.length, rec: rec?.id || '', runs: A.LINK.runIdsFor(I.r.id), vals };
  if (extra) P.notes[I.l.key] = [extra, P.notes[I.l.key]].filter(Boolean).join('\n\n');
  A.save(); A.render(); scrollTo(0, 0);
  const n = rec?.n || 0;
  A.toastAct(n ? (n === 1 ? t('1 taak heropend') : t('{n} taken heropend', { n })) : t('Lijstje klaargezet om opnieuw te sturen'), t('Ongedaan maken'), 'roUndo', 8000, { rec: rec?.id || '', k });
}
/** Na het versturen: oude rondes tellen niet meer mee, het lijstje is weer "onderweg"; route krijgt een markering voor de bemanning. */
function applyReopen(P, l, x) {
  const R = P.reopen; if (!R || !P.only?.includes(l.key)) return;
  const s = D().sent[x.key];
  s.reRuns = [...new Set([...(s.reRuns || []), ...R.runs])]; s.doneSent = 0; delete s.doneAfter;
  s.reopened = { ...(D().sent[R.k]?.reopened || {}), at: R.at, n: R.n, rec: R.rec, sent: true };
  x.r.reopen = { at: R.at, n: R.n, vals: Object.keys(R.vals || {}).length ? R.vals : undefined };
  if (R.k !== x.key && D().sent[R.k]?.reopened) D().sent[R.k].reopened.sent = true;
}
function reopenUndo(a) {
  const rec = a.dataset.rec, k = a.dataset.k; document.querySelector('#toast').hidden = true;
  const n = rec ? A.MT.undoReopen(rec) : 0;
  const s = D().sent[k];
  const e = s?.reopens?.filter((x) => x.rec === rec).at(-1); if (e) e.undoneAt = new Date().toISOString(); // audit blijft, gemarkeerd
  if (D().pre?.reopen?.k === k) { // nog niet verstuurd → terug naar Verstuurde lijstjes, niets veranderd
    const l = listBy(D().pre.only?.[0]); if (l) D().sel[l.key] = [];
    D().pre = null; if (s?.reopened && !s.reopened.sent) delete s.reopened;
    A.save(); A.go('verdelen', { dist: '__send' });
  } else { A.save(); A.render(); }
  A.toast(n ? (n === 1 ? t('Heropenen ongedaan gemaakt (1 taak)') : t('Heropenen ongedaan gemaakt ({n} taken)', { n })) : t('Heropenen ongedaan gemaakt'));
}

// ---------- zelf afvinken (v1.16) ----------
let syncT = 0;
/** Afmelden via de bestaande MARAD-afmelding; daarna (na de ongedaan-maken-tijd) de bemanning bijwerken. */
function selfDo(l, keys) {
  const ids = l.tasks.filter((x) => keys.includes(x.key) && canSelf(x)).map((x) => x.marad);
  const es = A.MT.selfSignoff(ids); if (!es.length) return;
  const sel = selOf(l); for (const k of keys) sel.delete(k); setSel(l, sel); A.save();
  const y = scrollY; A.render(); scrollTo(0, y);
  A.toastAct(es.length === 1 ? t('1 taak afgevinkt') : t('{n} taken afgevinkt', { n: es.length }), t('Ongedaan maken'), 'distUndo', 8000, { ids: es.map((e) => e.id).join(',') });
  clearTimeout(syncT); syncT = setTimeout(() => A.LINK.syncDone(), 9000); // pas na de ongedaan-maken-tijd naar de bemanning
}

// ---------- v1.20: eigen taken (＋ Nieuwe taak) en bewaarde taken (sjablonen) ----------
const CK = 'eigen';
const CU = () => { const c = (D().custom ||= {}); c.tasks ||= []; c.tpl ||= []; return c; };
let CF = null; // open formulier: { tplId, edit }
/** Klaar? Een afgeronde ronde (bemanning of Ikzelf) waarin deze eigen taak als "gedaan" staat, na het toewijzen. */
function customDone(id, at) {
  for (const r of A.state.routes) {
    const st = r.steps?.find((x) => x.custom === id); if (!st) continue;
    const run = A.state.runs.filter((z) => z.routeId === r.id && z.finishedAt && z.finishedAt >= at).find((z) => z.results?.some((q) => q.stepId === st.id && q.status === 'done'));
    if (run) return { by: run.by || '', date: String(run.finishedAt).slice(0, 10) };
  }
  return null;
}
function ctBar(inList = false) {
  const tp = CU().tpl;
  return `<div class="ctbar ${inList ? 'inlist' : ''}"><button class="btn primary ctnew" data-act="ctNew">＋ ${t('Nieuwe taak')}</button>${tp.length ? `<details class="ctdrop"><summary>📂 ${t('Bewaarde taken ({n})', { n: tp.length })}</summary><div class="ctlist">${tp.map(tplRow).join('')}</div></details>` : ''}</div>`;
}
function tplRow(x) {
  const l = x.locId && A.loc(x.locId);
  return `<div class="ctrow"><button class="btn small ctuse" data-act="ctUse" data-id="${esc(x.id)}">✏️ <b>${esc(x.title)}</b>${l ? ` <small>· ${esc(A.tx(l, 'name'))}</small>` : ''}${x.measure?.label ? ` <small>· 📏 ${esc(x.measure.label)}${x.measure.unit ? ' (' + esc(x.measure.unit) + ')' : ''}</small>` : ''}</button><button class="iconbtn ctedit" data-act="ctEdit" data-id="${esc(x.id)}" aria-label="${t('Bewerken')}">✎</button><button class="iconbtn ctdel" data-act="ctDel" data-id="${esc(x.id)}" aria-label="${t('Verwijderen')}">✕</button></div>`;
}
function ctForm(v = {}, ctx = {}) {
  CF = ctx;
  const locs = A.state.locations.filter((l) => l.id !== 'l-algemeen');
  const tp = CU().tpl;
  A.openSheet(`<h2>${ctx.edit ? '✎ ' + t('Bewaarde taak bewerken') : '＋ ' + t('Nieuwe taak')}</h2>
    ${!ctx.edit && tp.length ? `<details class="ctdrop inform"><summary>📂 ${t('Bewaarde taken ({n})', { n: tp.length })}</summary><div class="ctlist">${tp.map(tplRow).join('')}</div></details>` : ''}
    <p class="muted small">✏️ ${t('Eigen taak: alleen in de app, telt niet mee voor MARAD.')}</p>
    <label class="pnote"><span class="flbl">${t('Titel')} *</span><input id="ctTitle" maxlength="140" autocomplete="off" value="${esc(v.title || '')}" placeholder="${t('bijv. Lier voor smeren')}"></label>
    <label class="pnote"><span class="flbl">📍 ${t('Locatie (optioneel)')}</span><select id="ctLoc"><option value="">${t('— Geen vaste plek —')}</option>${locs.map((l) => `<option value="${esc(l.id)}" ${l.id === v.locId ? 'selected' : ''}>${esc(A.tx(l, 'name'))}</option>`).join('')}</select></label>
    <label class="pnote"><span class="flbl">📝 ${t('Omschrijving (optioneel)')}</span><textarea id="ctNote" rows="2" maxlength="600">${esc(v.note || '')}</textarea></label>
    <div class="ctmeas"><span class="flbl">📏 ${t('Meting (optioneel)')}</span><div class="row"><input id="ctMLabel" maxlength="60" autocomplete="off" placeholder="${t('bijv. Druk')}" value="${esc(v.measure?.label || '')}"><input id="ctMUnit" maxlength="12" autocomplete="off" placeholder="${t('eenheid')}" value="${esc(v.measure?.unit || '')}"><select id="ctMType"><option value="number" ${v.measure?.type !== 'text' ? 'selected' : ''}>${t('getal')}</option><option value="text" ${v.measure?.type === 'text' ? 'selected' : ''}>${t('tekst')}</option></select></div></div>
    <div class="row sticky">${ctx.edit ? `<button class="btn primary big" data-act="ctTplSave">💾 ${t('Opslaan')}</button>` : `<button class="btn primary big" data-act="ctGo">${t('Verder')} ›</button>`}<button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button></div>`, { ctForm: true });
}
function readForm() {
  const title = clean($f('#ctTitle')?.value).slice(0, 140); if (!title) { A.toast(t('Geef de taak een titel.')); $f('#ctTitle')?.focus(); return null; }
  const ml = clean($f('#ctMLabel')?.value).slice(0, 60);
  return { title, locId: $f('#ctLoc')?.value || '', note: clean($f('#ctNote')?.value).slice(0, 600), measure: ml ? { label: ml, unit: clean($f('#ctMUnit')?.value).slice(0, 12), type: $f('#ctMType')?.value === 'text' ? 'text' : 'number' } : null };
}
function tplToggle(l) {
  const xs = CU().tasks.filter((x) => selOf(l).has(x.id) && (!x.tplId || x.tplNew)); if (!xs.length) return '';
  const on = xs.every((x) => x.tplNew);
  return `<button class="btn tplsave ${on ? 'on' : ''}" data-act="ctSaveTog" role="switch" aria-checked="${on}"><span class="tsw">${on ? '✔' : ''}</span> 💾 ${t('Bewaar taak voor volgende keer')}</button>`;
}
export const actions = {

  ctNew: () => { A.closeSheet(); ctForm(); },
  ctUse: (a) => { const x = CU().tpl.find((y) => y.id === a.dataset.id); if (!x) return; A.closeSheet(); ctForm(x, { tplId: x.id }); },
  ctEdit: (a) => { const x = CU().tpl.find((y) => y.id === a.dataset.id); if (!x) return; A.closeSheet(); ctForm(x, { tplId: x.id, edit: true }); },
  ctDel: (a) => { const x = CU().tpl.find((y) => y.id === a.dataset.id); if (!x || !confirm(t('Bewaarde taak "{name}" verwijderen?', { name: x.title }))) return; CU().tpl = CU().tpl.filter((y) => y.id !== x.id); for (const c of CU().tasks) if (c.tplId === x.id) { delete c.tplId; delete c.tplNew; } A.save(); A.closeSheet(); A.render(); A.toast(t('Bewaarde taak verwijderd')); },
  ctTplSave: () => { const v = readForm(); if (!v) return; const x = CU().tpl.find((y) => y.id === CF?.tplId); if (!x) return; Object.assign(x, v, { updatedAt: new Date().toISOString() }); A.save(); A.closeSheet(); A.render(); A.toast(t('Bewaarde taak bijgewerkt')); },
  ctGo: () => {
    const v = readForm(); if (!v) return;
    const c = { id: 'ct-' + A.rid(), ...v, createdAt: new Date().toISOString(), by: myName(), ...(CF?.tplId ? { tplId: CF.tplId } : {}) };
    CU().tasks.push(c); if (CU().tasks.length > 400) CU().tasks = CU().tasks.slice(-400);
    D().sel[CK] = [c.id]; A.save(); A.closeSheet(); A.go('verdelen', { dist: CK });
    const l = listBy(CK); if (l) pickSheet(l);
  },
  ctSaveTog: () => {
    const l = listBy(PK?.list || CK); if (!l) return;
    const xs = CU().tasks.filter((x) => selOf(l).has(x.id) && (!x.tplId || x.tplNew)); if (!xs.length) return;
    const on = xs.every((x) => x.tplNew);
    for (const x of xs) {
      if (on) { CU().tpl = CU().tpl.filter((y) => y.id !== x.tplId); delete x.tplId; delete x.tplNew; }
      else { const tp = { id: 'tpl-' + A.rid(), title: x.title, locId: x.locId, note: x.note, measure: x.measure ? { ...x.measure } : null, createdAt: new Date().toISOString() }; CU().tpl.push(tp); x.tplId = tp.id; x.tplNew = true; }
    }
    A.save(); pickSheet(l); A.toast(on ? t('Niet meer bewaard') : t('Bewaard voor volgende keer'));
  },
  ctHide: (a) => { const c = CU().tasks.find((y) => y.id === a.dataset.id); if (!c) return; c.hidden = true; D().sel[CK] = (D().sel[CK] || []).filter((k) => k !== c.id); A.save(); A.render(); },
  distReopen: (a) => { A.closeSheet(); reopenSheet(a.dataset.k); },
  roTog: (a) => { if (!RO) return; const k = a.dataset.t; if (RO.sel.has(k)) RO.sel.delete(k); else RO.sel.add(k); reopenSheet(RO.k, true); },
  roAll: () => { if (!RO) return; const I = reopenInfo(RO.k); RO.sel = new Set(I.steps.filter((x) => x.ok).map((x) => x.key)); reopenSheet(RO.k, true); },
  roNone: () => { if (!RO) return; RO.sel = new Set(); reopenSheet(RO.k, true); },
  roNoteFill: () => { if (!RO) return; const v = t('Nog niet af, graag afmaken'); RO.note = clean(RO.note) ? (RO.note.includes(v) ? RO.note : RO.note + ' ' + v) : v; reopenSheet(RO.k, true); },
  roGo: () => reopenGo(),
  roUndo: (a) => reopenUndo(a),
  selfGo: () => { A.closeSheet(); A.go('routes'); scrollTo(0, 0); },
  selfOpen: (a) => selfSheet(a.dataset.k),
  selfOne: (a) => {
    const s = D().sent[a.dataset.k]; const r = s && A.state.routes.find((x) => x.id === s.routeId); const st = r?.steps.find((x) => x.id === a.dataset.s);
    if (!st?.marad?.id) return; const es = A.MT.selfSignoff([st.marad.id]); if (!es.length) return;
    reSelf();
    A.toastAct(t('1 taak afgevinkt'), t('Ongedaan maken'), 'selfUndo', 8000, { ids: es.map((e) => e.id).join(',') });
  },
  selfUndo: (a) => { actions.distUndo(a); reSelf(); },
  selfStart: (a) => {
    const s = D().sent[a.dataset.k]; const x = s && selfState(s); if (!x?.r) return;
    x.r.stepsDone = [...x.signed.keys()]; A.save(); A.closeSheet(); A.startRun(x.r.id); // al afgevinkt → overslaan (bestaande regel)
  },
  distSelf: () => { const l = listBy(A.view().dist); if (l) selfDo(l, [...selOf(l)]); },
  distSelfOne: (a) => { const l = listBy(A.view().dist); if (l) selfDo(l, [a.dataset.t]); },
  distUndo: (a) => {
    const n = A.MT.undoSignoffs(String(a.dataset.ids || '').split(',').filter(Boolean));
    document.querySelector('#toast').hidden = true; const y = scrollY; A.render(); scrollTo(0, y);
    if (n) A.toast(n === 1 ? t('1 afvinking ongedaan gemaakt') : t('{n} afvinkingen ongedaan gemaakt', { n }));
  },
  distTop: (a) => A.go('verdelen', { dist: a.dataset.v === 'idea' ? '__idea' : null }),
  ideaWho: (a) => { A.go('verdelen', { dist: '__idea', idea: a.dataset.v }); },
  ideaTog: (a) => { const k = A.view().idea || ideas().ps[0].key; const s_ = new Set((D().ideaSel ||= {})[k] || []); const id = a.dataset.t; if (s_.has(id)) s_.delete(id); else s_.add(id); D().ideaSel[k] = [...s_]; A.save(); const y = scrollY; A.render(); scrollTo(0, y); },
  ideaAll: () => { const I = ideas(); const p = I.ps.find((x) => x.key === A.view().idea) || I.ps[0]; (D().ideaSel ||= {})[p.key] = (I.out[p.key] || []).map((x) => x.key); A.save(); A.render(); },
  ideaNone: () => { const I = ideas(); const p = I.ps.find((x) => x.key === A.view().idea) || I.ps[0]; (D().ideaSel ||= {})[p.key] = []; A.save(); A.render(); },
  ideaNew: () => { const I = ideas(); const p = I.ps.find((x) => x.key === A.view().idea) || I.ps[0]; const keep = new Set(D().ideaSel?.[p.key] || []);
    const sk = D().ideaSkip?.day === dayKey() ? D().ideaSkip : (D().ideaSkip = { day: dayKey(), ids: [] }); for (const x of I.out[p.key] || []) if (!keep.has(x.key) && !sk.ids.includes(x.key)) sk.ids.push(x.key); A.save(); A.render(); A.toast(t('Nieuwe ideeën')); },
  ideaSend: () => ideaSend(),
  goDist: () => { A.closeSheet(); A.go('verdelen', { dist: null }); },
  distOpen: (a) => A.go('verdelen', { dist: a.dataset.k }),
  distSendView: () => A.go('verdelen', { dist: '__send' }),
  distDue: (a) => { const k = A.view().dist; D().dueOnly[k] = a.dataset.v === '1'; A.save(); A.render(); },
  distTog: (a) => { const l = listBy(A.view().dist); if (!l) return; const s = selOf(l); const k = a.dataset.t; if (s.has(k)) s.delete(k); else s.add(k); setSel(l, s); A.save(); const y = scrollY; A.render(); scrollTo(0, y); },
  distRestBy: (a) => { D().restBy = a.dataset.v === 'loc' ? 'loc' : 'due'; A.save(); A.render(); },
  distSelOd: () => { const l = listBy(A.view().dist); if (!l) return; setSel(l, new Set(l.tasks.filter((x) => x.st === 'overdue').map((x) => x.key))); A.save(); A.render(); },
  distSelAll: () => { const l = listBy(A.view().dist); if (!l) return; setSel(l, new Set(shown(l).map((x) => x.key))); A.save(); A.render(); },
  distSelNone: () => { const l = listBy(A.view().dist); if (!l) return; setSel(l, new Set()); A.save(); A.render(); },
  distSendSel: () => { const l = listBy(A.view().dist); if (l && selOf(l).size) pickSheet(l); },
  distSet: (a) => {
    if (a.dataset.self) { const who = { rank: SELF, name: '' }; if (A.view().dist === '__pre' && D().pre) { Object.assign(D().pre, who); A.save(); A.closeSheet(); A.render(); return; } return startPre(who); }
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
