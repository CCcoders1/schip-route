import { state, save, rid, loc, deck, route, getPlan, setPlan, delPlan, replaceState, resetAll, randomTopic, legacyMaint } from './store.js';
import { STRATEGIES, orderSteps } from './planner.js';
import { routePackage, buildShareLink, readHashPayload, reportPackage } from './share.js';
import { initOil } from './oil.js';
import { initMaint } from './maint.js';
import { shipSVG, svgPointToLoc, VIEWS } from './shipmap.js';
import { t, tx, setTx, getLang, setLang, LANGS, LOCALES } from './i18n.js';

const APP_VERSION = '1.8.0';
const OB = self.OutboxCore;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const main = $('#main');
const clone = (o) => JSON.parse(JSON.stringify(o));
const fmtDT = (iso) => iso ? new Date(iso).toLocaleString(LOCALES[getLang()], { dateStyle: 'short', timeStyle: 'short' }) : '';
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
// Modus: 'beheer' (manager: alles) of 'bemanning' (crew: ontvangen routes, ronde, vragen, observaties, outbox).
const isCrew = () => state.settings.mode === 'bemanning';
const CREW_TABS = ['routes', 'meer'];
const BEHEER_TABS = ['vandaag', 'onderhoud', 'olie', 'routes', 'meldingen'];

let view = { tab: '', mel: 'msgs', routeId: null, runId: null, mapMode: 'side', mapRoute: '', placing: null, hist: 'runs' };
// iPhone/iPad (ook iPadOS die zich als Mac voordoet) en of de app vanaf het beginscherm draait
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone === true;
const iosOtherBrowser = () => /CriOS|FxiOS|EdgiOS|OPiOS/i.test(navigator.userAgent);
let draft = null;        // taak die in de editor open staat
let sheetCtx = null;     // context van het open paneel
let deferredInstall = null;
let wakeLock = null;
let compose = null;      // vraag/observatie in opbouw
let outboxPending = 0, outboxErr = false;

// ---------- algemene helpers ----------
function toast(msg, ms = 2500) {
  const tb = $('#toast'); tb.textContent = msg; tb.hidden = false;
  clearTimeout(toast.tm); toast.tm = setTimeout(() => (tb.hidden = true), ms);
}
function openSheet(html, ctx = {}) {
  const el = $('#sheet');
  el.innerHTML = `<div class="sheet-bg" data-act="closeSheet"></div><div class="sheet-card" role="dialog"><button class="iconbtn sheet-x" data-act="closeSheet" aria-label="${t('Sluiten')}">✕</button>${html}</div>`;
  el.hidden = false; sheetCtx = ctx;
  return el;
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet').innerHTML = ''; sheetCtx = null; draft = null; if (compose) { compose.photos.forEach((p) => URL.revokeObjectURL(p.url)); compose = null; } }
function go(tab, extra = {}) { view = { ...view, tab, routeId: null, runId: null, placing: null, ...extra }; render(); scrollTo(0, 0); }
function download(filename, content, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function shareFile(filename, content, mime, title, text) {
  const file = new File([content], filename, { type: mime });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title, text }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancel'; }
  }
  download(filename, content, mime); toast(t('Bestand gedownload: ') + filename); return 'download';
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast(t('Gekopieerd ✔')); return true; }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); toast(ok ? t('Gekopieerd ✔') : t('Kopiëren lukte niet')); return ok; }
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'route';
function applyTheme() {
  const th = state.settings.theme;
  const dark = th === 'dark' || (th === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.classList.toggle('bigtext', !!state.settings.bigText);
}
const deckName = (id) => tx(deck(id), 'name') || '—';
function locSelect(selected, attrs, noNew = false) {
  let h = `<select ${attrs}><option value="">${t('— Kies locatie —')}</option>`;
  for (const d of state.decks) {
    const ls = state.locations.filter((l) => l.deck === d.id);
    if (!ls.length) continue;
    h += `<optgroup label="${esc(tx(d, 'name'))}">` + ls.map((l) => `<option value="${esc(l.id)}" ${l.id === selected ? 'selected' : ''}>${esc(tx(l, 'name'))}</option>`).join('') + `</optgroup>`;
  }
  const orphan = state.locations.filter((l) => !deck(l.deck));
  if (orphan.length) h += `<optgroup label="${t('Overig')}">` + orphan.map((l) => `<option value="${esc(l.id)}" ${l.id === selected ? 'selected' : ''}>${esc(tx(l, 'name'))}</option>`).join('') + `</optgroup>`;
  return h + (noNew ? '' : `<option value="__new">${t('+ Nieuwe locatie…')}</option>`) + '</select>';
}
const deckSelect = (selected, attrs) => `<select ${attrs}>` + state.decks.map((d) => `<option value="${esc(d.id)}" ${d.id === selected ? 'selected' : ''}>${esc(tx(d, 'name'))}</option>`).join('') + `</select>`;
function numbersFor(r) {
  const m = new Map();
  r.steps.forEach((s, i) => { if (!m.has(s.locationId)) m.set(s.locationId, []); m.get(s.locationId).push(i + 1); });
  return m;
}
const viewToggle = (act, cur) => `<div class="seg">${Object.entries(VIEWS).map(([k, v]) => `<button class="${cur === k ? 'on' : ''}" data-act="${act}" data-v="${k}">${v}</button>`).join('')}</div>`;

// ---------- render ----------
function render() {
  applyTheme();
  if (!view.tab) view.tab = isCrew() ? 'routes' : 'vandaag';
  if (isCrew() && !CREW_TABS.includes(view.tab)) view = { ...view, tab: 'routes', routeId: null, runId: null };
  if (isCrew()) view.routeId = null;
  document.body.classList.toggle('crew', isCrew());
  $$('#nav button').forEach((b) => { b.classList.toggle('on', b.dataset.tab === view.tab); b.hidden = isCrew() || !BEHEER_TABS.includes(b.dataset.tab); });
  const NAVL = { olie: t('Olie'), vandaag: t('Vandaag'), meldingen: t('Meldingen'), routes: isCrew() ? t('Mijn routes') : t('Rondes'), onderhoud: t('Onderhoud'), kaart: t('Kaart'), locaties: t('Locaties'), historie: t('Historie'), meer: t('Meer') };
  $$('#nav button').forEach((b) => { b.lastChild.textContent = NAVL[b.dataset.tab]; });
  const nb = $('#nav button[data-tab=meldingen]'); const un = isCrew() ? 0 : unseenCount() + unseenMsgs();
  let bd = nb.querySelector('.nbadge'); if (!bd) { bd = document.createElement('b'); bd.className = 'nbadge'; nb.prepend(bd); }
  bd.textContent = un > 99 ? '99+' : un; bd.hidden = !un; nb.setAttribute('aria-label', NAVL.meldingen + (un ? ' – ' + t('{n} ongelezen', { n: un }) : ''));
  const fn = {
    vandaag: viewToday, meldingen: viewMeldingen, olie: () => OIL.view(),
    routes: isCrew() ? viewCrewRoutes : view.routeId ? viewRoute : viewRoutes,
    onderhoud: MT.view,
    kaart: viewMap, locaties: viewLocations,
    historie: view.runId ? viewRunDetail : viewHistory, meer: isCrew() ? viewCrewMore : viewMore,
  }[view.tab];
  main.innerHTML = fn();
  afterRender();
}
function header(title, back = false, extra = '') {
  return `<header class="top">${back ? `<button class="iconbtn" data-act="back" aria-label="${t('Terug')}">◀</button>` : ''}<h1>${esc(title)}</h1>${extra}${isCrew() ? `<span class="modechip" title="${t('Bemanning-modus')}">👷</span>` : ''}${obxBadge()}<button class="langbtn" data-act="langMenu" aria-label="${t('Taal / Language / Bahasa')}">${LANGS[getLang()].flag} ${getLang().toUpperCase()}</button>${isCrew() ? `<button class="iconbtn gear" data-act="goTab" data-v="${view.tab === 'meer' ? 'routes' : 'meer'}" aria-label="${t('Instellingen')}">${view.tab === 'meer' ? '✕' : '⚙'}</button>` : `<span class="net ${navigator.onLine ? 'on' : 'off'}">${navigator.onLine ? 'online' : 'offline'}</span><button class="iconbtn menubtn" data-act="appMenu" aria-label="${t('Menu')}">☰</button>`}</header>`;
}
function obxBadge() { return `<button class="obx ${outboxErr ? 'err' : ''}" data-act="openOutbox" ${outboxPending ? '' : 'hidden'} aria-label="${t('Outbox')}">📤 ${outboxPending}</button>`; }
function installBanner() {
  if (isStandalone() || state.settings.hideInstall) return '';
  if (isIOS()) return `<div class="banner ios"><b>${t('📲 Zet de app op je beginscherm (iPhone)')}</b><p>${iosOtherBrowser() ? t('Open deze pagina in <b>Safari</b>, tik op <b>Deel</b> ⬆️ en kies <b>Zet op beginscherm</b>.') : t('Tik in Safari op <b>Deel</b> ⬆️ en dan <b>Zet op beginscherm</b>.')}</p><div class="row"><button class="btn primary" data-act="iosInstall">${t('Stap voor stap')}</button><button class="btn ghost" data-act="hideInstall">${t('Verbergen')}</button></div></div>`;
  return `<div class="banner"><b>${t('Zet de app op je beginscherm')}</b><p>${deferredInstall ? t('Dan start hij schermvullend en werkt hij offline.') : t('Open het browsermenu ⋮ en kies <b>App installeren</b> / <b>Toevoegen aan startscherm</b>.')}</p><div class="row">${deferredInstall ? `<button class="btn primary" data-act="install">${t('Installeren')}</button>` : ''}<button class="btn ghost" data-act="hideInstall">${t('Verbergen')}</button></div></div>`;
}
function iosInstallSheet() {
  openSheet(`<h2>${t('📲 Installeren op iPhone')}</h2>
    ${iosOtherBrowser() ? `<p class="warnbox">${t('Je gebruikt een andere browser dan Safari. Dat kan ook (iOS 16.4+), maar Safari werkt het best: kopieer het adres en open het in Safari.')}</p>` : ''}
    <ol class="iossteps">
      <li><span class="ico">⬆️</span><div><b>${t('Tik op Deel')}</b><small>${t('Het vierkantje met pijl omhoog, onderaan in Safari (op iPad bovenaan).')}</small></div></li>
      <li><span class="ico">➕</span><div><b>${t('Kies "Zet op beginscherm"')}</b><small>${t('Scroll in het menu omlaag als je hem niet direct ziet.')}</small></div></li>
      <li><span class="ico">✅</span><div><b>${t('Tik op "Voeg toe"')}</b><small>${t('Rechtsboven. Het icoon "Schip Route" staat nu op je beginscherm.')}</small></div></li>
      <li><span class="ico">🚢</span><div><b>${t('Open de app vanaf het beginscherm')}</b><small>${t('Dan start hij schermvullend en werkt hij offline. Gebruik vanaf nu altijd dit icoon.')}</small></div></li>
    </ol>
    <p class="infobox">${t('ℹ️ Belangrijk op iPhone: de app op het beginscherm heeft een eigen opslag, los van Safari. Een route-link uit WhatsApp opent in Safari: kopieer hem daar met "📋 Kopieer route" en plak hem in de app met "📋 Route plakken".')}</p>
    <button class="btn primary big" data-act="closeSheet">${t('Begrepen')}</button>`, { iosInstall: true });
}

// ---------- Vandaag (startscherm Beheer) ----------
function resumeCard() {
  const ar = state.activeRun; if (!ar) return '';
  return `<div class="card resume"><b>${t('Ronde bezig: {name}', { name: esc(tx(ar.route, 'name')) })}</b><p>${t('Stap {a} van {b} · gestart {c}', { a: Math.min(ar.idx + 1, ar.route.steps.length), b: ar.route.steps.length, c: fmtDT(ar.startedAt) })}</p><div class="row"><button class="btn ok big" data-act="resumeRun">${t('▶ Doorgaan')}</button>${isCrew() ? '' : `<button class="btn ghost" data-act="abortRun">${t('Afbreken')}</button>`}</div></div>`;
}
function viewToday() {
  const d = new Date().toLocaleDateString(LOCALES[getLang()], { weekday: 'long', day: 'numeric', month: 'long' });
  let h = header(t('Vandaag')) + `<p class="shipsub">📅 ${esc(d)} · 🚢 ${esc(state.shipName)}</p>`;
  h += resumeCard() + installBanner();
  const un = unseenMsgs() + unseenCount();
  if (un) h += `<button class="card tap melbanner" data-act="goTab" data-v="meldingen">🔔 <b>${t('{n} ongelezen meldingen', { n: un })}</b><small>${t('vragen, observaties, Niet OK en aftekeningen')}</small></button>`;
  if (!state.maint?.tasks) h += `<section class="card"><h3>🔐 ${t('Onderhoud ontgrendelen')}</h3><p class="muted small">${t('Ontgrendel de MARAD-gegevens om de vaste rondes en te-late taken te zien.')}</p><button class="btn primary big" data-act="mUnlockSheet">${t('🔓 Ontgrendelen')}</button></section>`;
  else h += MT.todayHTML() + `<div class="row"><button class="btn" data-act="mWeekGo">${t('📅 Weekoverzicht')}</button><button class="btn" data-act="goSug">${t('💡 Alle vaste rondes')}</button></div>`;
  const rs = state.routes.filter((r) => !r.templateId).slice(0, 5);
  if (rs.length) h += `<h3 class="sec">🧭 ${t('Eigen rondes')}</h3><div class="list compact">${rs.map((r) => `<article class="card route mini"><div class="tap" data-act="openRoute" data-id="${r.id}"><b>${esc(tx(r, 'name'))}</b><small>${plural(r.steps.length, t('taak'), t('taken'))}</small></div><button class="btn ok" data-act="startRun" data-id="${r.id}" ${r.steps.length ? '' : 'disabled'}>▶</button></article>`).join('')}</div><button class="btn small ghost" data-act="goTab" data-v="routes">${t('Alle rondes →')}</button>`;
  return h;
}
function appMenu() {
  const it = (act, v, ico, label, extra = '') => `<button class="btn menuitem" data-act="${act}" ${v ? `data-v="${v}"` : ''} ${extra}>${ico} ${label}</button>`;
  openSheet(`<h2>☰ ${t('Menu')}</h2><div class="menugrid">
    ${it('mWeekGo', '', '📅', t('Weekoverzicht'))}${it('goMaradDone', '', '⬇', t('Afgemeld voor MARAD (CSV)'))}
    ${it('goTab', 'kaart', '🚢', t('Kaart'))}${it('goTab', 'locaties', '📍', t('Locaties'))}
    ${it('goTab', 'historie', '📋', t('Historie (eigen rondes)'))}${it('newObs', '', '👁', t('Eigen observatie'))}
    ${it('openOutbox', '', '📤', t('Outbox'))}${it('langMenu', '', '🌐', t('Taal · Language · Bahasa'))}
    ${it('goTab', 'meer', '⚙️', t('Instellingen, personen, PIN, modus'))}${state.maint ? it('mLock', '', '🔒', t('Vergrendelen')) : it('mUnlockSheet', '', '🔓', t('Ontgrendelen'))}
  </div><p class="muted small">${t('Versie')} ${APP_VERSION}</p>`, { menu: true });
}

// ---------- Meldingen (Beheer) ----------
const inbox = () => (state.inbox ||= []);
function unseenMsgs() { return inbox().filter((m) => !m.seenAt).length; }
const MK = () => ({ olie: ['🛢', t('Olie')], vraag: ['❓', t('Vraag')], observatie: ['👁', t('Observatie')], nietok: ['✖', t('Niet OK')], urgent: ['🚨', t('Urgent')] });
function melFilter() { return view.melF || 'all'; }
function viewMeldingen() {
  const un = unseenMsgs(), uo = unseenCount();
  let h = header(t('Meldingen')) + `<div class="seg hseg"><button class="${view.mel !== 'others' ? 'on' : ''}" data-act="melMode" data-v="msgs">💬 ${t('Berichten')}${un ? ` <b class="sbadge">${un}</b>` : ''}</button><button class="${view.mel === 'others' ? 'on' : ''}" data-act="melMode" data-v="others">👥 ${t('Afgetekend door anderen')}${uo ? ` <b class="sbadge">${uo}</b>` : ''}</button></div>`;
  if (view.mel === 'others') return h + viewOthers();
  const f = melFilter();
  const items = [];
  for (const m of inbox()) items.push({ ...m, src: 'ntfy' });
  for (const r of received()) for (const m of r.messages || []) if (!inbox().some((x) => x.text && m.text && x.message?.includes(m.text))) items.push({ id: r.id + ':' + (m.id || m.text), kind: m.kind, text: m.text, by: r.by, locName: m.locName, time: m.at || r.finishedAt, photosN: m.photos, src: 'report', run: r.id, seenAt: r.received.seenAt || 'x' });
  for (const o of state.observations || []) items.push({ id: o.id, kind: o.kind, text: o.text, by: t('ik'), locName: o.locName, time: o.at, photosN: o.photos, src: 'own', seenAt: 'own', urgent: o.urgent });
  const xs = items.filter((x) => f === 'all' || x.kind === f).sort((a, b) => String(b.time).localeCompare(String(a.time)));
  const fb = (k, l) => `<button class="${f === k ? 'on' : ''}" data-act="melFilter" data-v="${k}">${l}</button>`;
  h += `<div class="seg">${fb('all', t('Alles'))}${fb('vraag', '❓ ' + t('Vragen'))}${fb('observatie', '👁 ' + t('Observaties'))}${fb('nietok', '✖ ' + t('Niet OK'))}</div>`;
  h += `<div class="row">${un ? `<button class="btn small ok" data-act="melSeenAll">${t('✔ Alles gezien')}</button>` : ''}<button class="btn small" data-act="ntfyPoll">${t('🔄 Ophalen uit meldingskanaal')}</button></div><p class="muted small" id="pollInfo">${state.settings.ntfyPolledAt ? t('Laatst opgehaald: {d}', { d: fmtDT(state.settings.ntfyPolledAt) }) : ''} · ${t('ntfy bewaart berichten ±12 uur en foto’s ±3 uur: open de app minstens dagelijks.')}</p>`;
  if (!xs.length) return h + `<p class="empty">${t('Nog geen meldingen. Vragen, observaties en "Niet OK" van de bemanning komen hier binnen via het meldingskanaal.')}</p>`;
  for (const x of xs) {
    const [ico, lbl] = MK()[x.urgent ? 'urgent' : x.kind] || ['🔔', x.kind];
    const isNew = !x.seenAt;
    h += `<article class="card msg k-${x.kind} ${isNew ? 'new' : ''}"><div class="ohead"><b>${(x.title || '').startsWith(ico) ? '' : ico + ' '}${esc(x.title || lbl)}</b>${isNew ? ` <span class="tag warn">${t('NIEUW')}</span>` : ''}</div>
      <p class="muted small">${x.time ? fmtDT(x.time) : ''}${x.by ? ' · 👤 ' + esc(x.by) : ''}${x.locName ? ' · 📍 ' + esc(x.locName) : ''} · ${x.src === 'ntfy' ? t('via meldingskanaal') : x.src === 'report' ? t('uit rapport') : t('eigen')}</p>
      ${x.message || x.text ? `<p class="msgtext">${esc(msgBody(x.message || x.text))}</p>` : ''}
      ${x.photos?.length ? `<div class="thumbs">${x.photos.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener" class="thumb"><img src="${esc(p.url)}" alt="📷 ${t('foto (verloopt na ±3 uur)')}" loading="lazy"></a>`).join('')}</div>` : x.photosN ? `<p class="muted small">📷 ${x.photosN}</p>` : ''}
      <div class="row">${isNew ? `<button class="btn small ok" data-act="melSeen" data-id="${esc(x.id)}">${t('✔ Gezien')}</button>` : ''}${x.run ? `<button class="btn small ghost" data-act="openRunH" data-id="${x.run}">${t('Rapport')}</button>` : ''}</div></article>`;
  }
  return h;
}
/* i18n-skip-start */
// ntfy-bericht → soort (tags worden door de app zelf gezet)
// Meta-regels (📍 👤 🕒 🚢 …) staan al in de kop van de kaart: niet dubbel tonen. Vragen houden 🧭/🔧 (route + taak).
function msgBody(txt) { return String(txt).split('\n').filter((l) => !/^\s*(📍|👤|🕒|🚢|📷)/u.test(l)).join('\n').trim(); }
function ntfyKind(m) {
  const tg = m.tags || [];
  if (tg.includes('clipboard') || tg.includes('paperclip') || /^rapport-.*\.json$/i.test(m.attachment?.name || '') || /#report=/.test(m.click || '') || /^📨/.test(m.title || '')) return 'rapport';
  if (tg.includes('bell')) return 'test';
  if (tg.includes('camera') || (m.attachment && !m.message?.trim())) return 'foto';
  if (tg.includes('question')) return 'vraag';
  if (tg.includes('x')) return 'nietok';
  if (tg.includes('eyes') || tg.includes('rotating_light')) return 'observatie';
  const ti = m.title || '';
  if (/^(Vraag|Question|Pertanyaan)\b/i.test(ti)) return 'vraag';
  if (/^✖/.test(ti)) return 'nietok';
  if (/^(URGENT: )?(Observatie|Observation|Observasi)\b/i.test(ti)) return 'observatie';
  return 'anders';
}
/* i18n-skip-end */

function viewRoutes() {
  const ar = state.activeRun;
  let h = header(t('Rondes')) + `<p class="shipsub">🚢 ${esc(state.shipName)}</p>`;
  if (ar) h += `<div class="card resume"><b>${t('Ronde bezig: {name}', { name: esc(tx(ar.route, 'name')) })}</b><p>${t('Stap {a} van {b} · gestart {c}', { a: Math.min(ar.idx + 1, ar.route.steps.length), b: ar.route.steps.length, c: fmtDT(ar.startedAt) })}</p><div class="row"><button class="btn ok big" data-act="resumeRun">${t('▶ Doorgaan')}</button><button class="btn ghost" data-act="abortRun">${t('Afbreken')}</button></div></div>`;
  h += installBanner();
  const ns = state.maint ? MT.sugCount() : 0;
  if (ns) h += `<button class="card tap sugbanner" data-act="goSug">💡 <b>${t('{n} voorgestelde routes', { n: ns })}</b><small>${t('op basis van functie en interval (Onderhoud → Voorstel)')}</small></button>`;
  h += `<div class="list">`;
  if (!state.routes.length) h += `<p class="empty">${t('Nog geen routes. Maak er een met de knop hieronder.')}</p>`;
  for (const r of state.routes) {
    const nLoc = new Set(r.steps.map((s) => s.locationId)).size;
    h += `<article class="card route"><div class="tap" data-act="openRoute" data-id="${r.id}"><h2>${esc(tx(r, 'name'))}</h2><p>${plural(r.steps.length, t('taak'), t('taken'))} · ${plural(nLoc, t('locatie'), t('locaties'))}${r.assignee ? ` · ${t('voor {name}', { name: `<b>${esc(r.assignee)}</b>` })}` : ''}${r.templateId ? ' · <span class="tag">🔁</span>' : ''}</p>${r.description ? `<p class="muted">${esc(tx(r, 'description'))}</p>` : ''}</div>
      <div class="row"><button class="btn ok" data-act="startRun" data-id="${r.id}" ${r.steps.length ? '' : 'disabled'}>${t('▶ Start ronde')}</button><button class="btn" data-act="shareRoute" data-id="${r.id}">${t('📤 Versturen')}</button><button class="btn" data-act="openRoute" data-id="${r.id}">✎</button></div></article>`;
  }
  h += `</div><div class="stack"><button class="btn primary big" data-act="newRoute">${t('+ Nieuwe route')}</button><div class="row"><button class="btn" data-act="newObs">${t('👁 Extra observatie')}</button><button class="btn" data-act="openOutbox">${t('📤 Outbox')}</button></div><div class="row"><button class="btn ghost" data-act="importFile">${t('📥 Route-bestand importeren')}</button><button class="btn ghost" data-act="pasteRoute">${t('📋 Route plakken')}</button></div></div>`;
  return h;
}

function viewRoute() {
  const r = route(view.routeId);
  if (!r) { view.routeId = null; return viewRoutes(); }
  const nums = numbersFor(r);
  let h = header(t('Route bewerken'), true);
  h += `<div class="form"><label>${t('Naam')}<input data-rf="name" value="${esc(tx(r, 'name'))}" placeholder="${t('Bijv. Dagelijkse ronde')}"></label>
    <label>${t('Omschrijving')}<textarea data-rf="description" rows="2">${esc(r.description || '')}</textarea></label>
    <label>${t('Bestemd voor')}<select data-rf="assignee"><option value="">${t('— niemand / mezelf —')}</option>${state.contacts.map((c) => `<option ${c.name === r.assignee ? 'selected' : ''}>${esc(tx(c, 'name'))}</option>`).join('')}</select></label></div>`;
  h += MT.templateInfo(r);
  h += waSection(r);
  h += `<div class="mapcard">${viewToggle('routeMapView', view.mapMode)}<div class="mapwrap">${shipSVG({ view: view.mapMode, locations: state.locations, numbers: nums, ship: state.shipName })}</div><p class="hint">${t('Nummers = volgorde van de taken.')}</p></div>`;
  h += `<h3 class="sec">${t('Taken (')}${r.steps.length}) <small>${t('sleep ☰ of gebruik ▲▼')}</small></h3><ol class="steps" id="steps">`;
  r.steps.forEach((s, i) => {
    const l = loc(s.locationId);
    h += `<li data-id="${s.id}"><span class="handle" aria-label="${t('Verslepen')}">☰</span><div class="sbody" data-act="editStep" data-id="${s.id}"><b>${i + 1}. ${esc(tx(s, 'title') || t('(zonder titel)'))}</b><small>📍 ${esc(tx(l, 'name') || t('onbekende locatie'))}${s.fields?.length ? ` · ${plural(s.fields.length, t('invoerveld'), t('invoervelden'))}` : ''}</small></div>
      <div class="sbtns"><button data-act="stepMove" data-d="-1" data-id="${s.id}" ${i === 0 ? 'disabled' : ''} aria-label="${t('Omhoog')}">▲</button><button data-act="stepMove" data-d="1" data-id="${s.id}" ${i === r.steps.length - 1 ? 'disabled' : ''} aria-label="${t('Omlaag')}">▼</button><button data-act="stepMenu" data-id="${s.id}" aria-label="${t('Meer')}">⋯</button></div></li>`;
  });
  h += `</ol><div class="stack"><button class="btn primary big" data-act="addStep">${t('+ Taak toevoegen')}</button>${state.library.length ? `<button class="btn" data-act="addFromLib">${t('+ Uit takenbibliotheek (')}${state.library.length})</button>` : ''}</div>`;
  if (r.steps.length > 1) h += `<button class="btn big smartbtn" data-act="smartOrder">🧭 ${t('Slimme volgorde')}</button>`;
  h += `<details class="auto"><summary>${t('⚙️ Automatisch ordenen (experimenteel)')}</summary><p class="muted">${t('Jij bepaalt de volgorde. Deze knop doet een voorstel; je kunt daarna nog alles verschuiven.')}</p><div class="row"><select id="strategy">${Object.entries(STRATEGIES).map(([k, v]) => `<option value="${k}">${esc(tx(v, 'label'))}</option>`).join('')}</select><button class="btn" data-act="autoOrder">${t('Toepassen')}</button></div></details>`;
  h += `<div class="stack"><button class="btn ok big" data-act="startRun" data-id="${r.id}" ${r.steps.length ? '' : 'disabled'}>${t('▶ Start ronde')}</button><button class="btn" data-act="shareRoute" data-id="${r.id}">${t('📤 Route versturen')}</button>
    <div class="row"><button class="btn ghost" data-act="dupRoute" data-id="${r.id}">${t('Dupliceren')}</button><button class="btn danger" data-act="delRoute" data-id="${r.id}">${t('Verwijderen')}</button></div></div>`;
  if (r.sentLog?.length) h += `<p class="muted small">${t('Verstuurd:')} ${r.sentLog.slice(-5).map((x) => `${esc(x.to)} (${fmtDT(x.at)})`).join(', ')}</p>`;
  return h;
}

function viewMap() {
  const mode = view.mapMode;
  const r = view.mapRoute ? route(view.mapRoute) : null;
  let h = header(t('Scheepskaart'));
  const tabs = { side: t('Zijaanzicht'), top: t('Bovenaanzicht'), ...Object.fromEntries(state.plans.map((d) => [`plan:${d}`, `${t('Plan:')} ${deckName(d)}`])) };
  h += `<div class="chips">${Object.entries(tabs).map(([k, v]) => `<button class="chip ${mode === k ? 'on' : ''}" data-act="mapMode" data-v="${esc(k)}">${esc(v)}</button>`).join('')}<button class="chip" data-act="uploadPlan">${t('+ Eigen plattegrond')}</button></div>`;
  h += `<label class="inline">${t('Toon route')} <select id="mapRoute"><option value="">${t('Alle locaties')}</option>${state.routes.map((x) => `<option value="${x.id}" ${x.id === view.mapRoute ? 'selected' : ''}>${esc(tx(x, 'name'))}</option>`).join('')}</select></label>`;
  const placing = view.placing ? loc(view.placing) : null;
  if (placing) h += `<div class="placebar">${t('Tik op de kaart om {name} te plaatsen', { name: `<b>${esc(tx(placing, 'name'))}</b>` })} <button class="btn small" data-act="stopPlacing">${t('Klaar')}</button></div>`;
  if (mode.startsWith('plan:')) {
    const d = mode.slice(5);
    const ls = state.locations.filter((l) => l.deck === d || l.pp?.deck === d);
    h += `<div class="plan ${placing ? 'placing' : ''}" id="plan" data-deck="${esc(d)}"><img id="planImg" alt="${t('Plattegrond')} ${esc(deckName(d))}">${ls.filter((l) => l.pp && l.pp.deck === d).map((l) => `<button class="pmk ${r && !numbersFor(r).has(l.id) ? 'dim' : ''}" style="left:${l.pp.x}%;top:${l.pp.y}%" data-act="mapLoc" data-id="${l.id}">${r && numbersFor(r).get(l.id) ? numbersFor(r).get(l.id)[0] : ''}<span>${esc(tx(l, 'name'))}</span></button>`).join('')}</div>`;
    h += `<p class="hint">${t('Locaties van "{deck}" plaatsen: kies hieronder een locatie en tik op de plattegrond.', { deck: esc(deckName(d)) })}</p>`;
    h += `<div class="row"><button class="btn danger small" data-act="delPlan" data-deck="${esc(d)}">${t('Plattegrond verwijderen')}</button></div>`;
  } else {
    const nums = r ? numbersFor(r) : allNumbers();
    h += `<p class="hint">${t('↔ Veeg opzij om het hele schip te zien. Tik op een nummer.')}</p><div class="mapwrap wide ${placing ? 'placing' : ''}" id="shipmap">${shipSVG({ view: mode, locations: state.locations, numbers: nums, highlight: view.placing || view.selLoc, ship: state.shipName })}</div>`;
    h += legendHTML(r);
  }
  h += `<h3 class="sec">${t('Locatie plaatsen op deze kaart')}</h3><div class="row">${locSelect(view.placing || '', 'id="placeSel"', true)}</div>`;
  h += `<p class="hint">${t('Tik op een stip voor details. Schets is vereenvoudigd (geen echte maatvoering). Upload je eigen dekplan voor meer detail.')}</p>`;
  return h;
}

function orderedLocs() { return [...state.decks.flatMap((d) => state.locations.filter((l) => l.deck === d.id)), ...state.locations.filter((l) => !deck(l.deck))]; }
function allNumbers() { return new Map(orderedLocs().map((l, i) => [l.id, [i + 1]])); }
function legendHTML(r) {
  if (r) return `<ol class="legend">${r.steps.map((s) => `<li data-act="mapLoc" data-id="${esc(s.locationId)}" class="${view.selLoc === s.locationId ? 'on' : ''}"><b>${esc(tx(s, 'title'))}</b> · ${esc(tx(loc(s.locationId), 'name') || '?')}</li>`).join('')}</ol>`;
  let h = '<div class="legend2">', n = 0;
  for (const d of state.decks) {
    const ls = state.locations.filter((l) => l.deck === d.id); if (!ls.length) continue;
    h += `<div><h4>${esc(tx(d, 'name'))}</h4>${ls.map((l) => `<button class="lg ${view.selLoc === l.id ? 'on' : ''}" data-act="mapLoc" data-id="${l.id}"><span>${++n}</span>${esc(tx(l, 'name'))}</button>`).join('')}</div>`;
  }
  return h + '</div>';
}
function viewLocations() {
  let h = header(t('Locaties'));
  h += `<p class="hint">${t('Gegroepeerd per gebied/dek. Deze lijst verschijnt als keuzelijst bij elke taak.')}</p>`;
  state.decks.forEach((d, i) => {
    const ls = state.locations.filter((l) => l.deck === d.id);
    h += `<section class="deckgrp"><div class="deckhead"><h3>${esc(tx(d, 'name'))} <small>(${ls.length})</small></h3><div class="sbtns"><button data-act="deckMove" data-d="-1" data-id="${d.id}" ${i === 0 ? 'disabled' : ''}>▲</button><button data-act="deckMove" data-d="1" data-id="${d.id}" ${i === state.decks.length - 1 ? 'disabled' : ''}>▼</button><button data-act="editDeck" data-id="${d.id}">✎</button></div></div><ul class="locs">`;
    for (const l of ls) {
      const uses = state.routes.reduce((n, r) => n + r.steps.filter((s) => s.locationId === l.id).length, 0);
      h += `<li data-act="editLoc" data-id="${l.id}"><span>📍 ${esc(tx(l, 'name'))}</span><small>${uses ? plural(uses, t('taak'), t('taken')) : ''}</small></li>`;
    }
    h += `</ul><button class="btn small ghost" data-act="addLoc" data-deck="${d.id}">${t('+ Locatie in {deck}', { deck: esc(tx(d, 'name')) })}</button></section>`;
  });
  h += `<div class="stack"><button class="btn" data-act="addDeck">${t('+ Gebied / dek toevoegen')}</button></div>`;
  return h;
}

function runStats(run) {
  const c = { done: 0, skipped: 0, problem: 0, oor: 0 };
  for (const x of run.results) { c[x.status]++; if (x.outOfRange?.length) c.oor++; }
  return c;
}
function histSeg() {
  const un = unseenCount();
  return `<div class="seg hseg"><button class="${view.hist !== 'others' ? 'on' : ''}" data-act="histMode" data-v="runs">${t('📋 Rondes')}</button><button class="${view.hist === 'others' ? 'on' : ''}" data-act="histMode" data-v="others">${t('👥 Door anderen')}${un ? ` <b class="sbadge">${un}</b>` : ''}</button></div>`;
}
function viewHistory() {
  let h = header(t('Historie')) + histSeg();
  if (view.hist === 'others') return h + viewOthers();
  h += `<div class="stack"><button class="btn primary" data-act="reportImport">${t('📨 Rapport importeren (link of bestand)')}</button></div>`;
  if (!state.runs.length) return h + `<p class="empty">${t('Nog geen afgeronde rondes. Start een route via het tabblad Routes.')}</p>`;
  h += `<div class="row"><button class="btn" data-act="exportAll" data-f="csv">${t('⬇ Alles CSV')}</button><button class="btn" data-act="exportAll" data-f="json">${t('⬇ Alles JSON')}</button></div><div class="list">`;
  for (const run of [...state.runs].reverse()) {
    const c = runStats(run);
    h += `<article class="card tap" data-act="openRun" data-id="${run.id}"><h2>${esc(run.routeName)}</h2>${run.received ? `<p class="tag ok">📨 ${t('rapport van {name}', { name: esc(run.by || '?') })}</p>` : ''}${run.maradDone ? ` <span class="tag">🔧 ${t('{n} MARAD afgemeld', { n: run.maradDone })}</span>` : ''}<p>${fmtDT(run.startedAt)} → ${fmtDT(run.finishedAt)}</p><p><span class="tag ok">✔ ${c.done}</span> <span class="tag">↷ ${c.skipped}</span> <span class="tag warn">⚠ ${c.problem}</span>${c.oor ? ` <span class="tag warn">${t('buiten bereik:')} ${c.oor}</span>` : ''}</p></article>`;
  }
  return h + `</div>`;
}

// ---------- afgetekend door anderen (ontvangen rapporten) ----------
const OF = { person: '', func: '', period: '30' };
const received = () => state.runs.filter((r) => r.received);
function unseenCount() { return received().filter((r) => !r.received.seenAt).reduce((n, r) => n + r.results.length, 0); }
const personFunc = (name) => state.contacts.find((c) => c.name.trim().toLowerCase() === String(name || '').trim().toLowerCase())?.func || '';
function runFuncs(run) {
  const f = new Set(); const pf = personFunc(run.by); if (pf) f.add(pf);
  if (state.maint?.tasks) for (const x of run.results) { const tk = x.marad?.id && state.maint.tasks.find((y) => y.id === x.marad.id); if (tk) tk.rank.forEach((r) => f.add(r)); }
  return f;
}
const VIA = () => ({ link: t('via link'), ntfy: t('via meldingskanaal'), file: t('via bestand'), paste: t('geplakt') });
function resultFlags(x) {
  const fl = [];
  if (x.status === 'problem') fl.push(`<span class="tag warn">⚠ ${t('probleem')}</span>`);
  if (x.status === 'skipped') fl.push(`<span class="tag">↷ ${t('overgeslagen')}</span>`);
  if (x.outOfRange?.length) fl.push(`<span class="tag warn">❗ ${t('buiten bereik')}</span>`);
  if ((x.fields || []).some((f) => f.role === 'mDone' && x.values?.[f.id] === false)) fl.push(`<span class="tag warn">✖ ${t('niet uitgevoerd')}</span>`);
  return fl.join(' ');
}
function othersResult(run, x) {
  const vals = (x.fields || []).filter((f) => !(f.role === 'mDone' && x.values?.[f.id] === true) && !(f.role === 'mRem' && !x.values?.[f.id])).map((f) => `<li class="${x.outOfRange?.includes(f.id) ? 'oor' : ''}">${esc(tx(f, 'label'))}: <b>${esc(fmtVal(f, x.values?.[f.id]))}</b></li>`).join('');
  const so = x.marad?.id && state.maint?.signoffs?.find((s) => s.taskId === x.marad.id && s.runId === run.id);
  const md = x.marad ? `<small class="mtag">🔧 MARAD${so ? ' · ✔ ' + t('afgemeld') : state.maint ? '' : ' · 🔒 ' + t('wordt afgemeld na ontgrendelen')}</small>` : '';
  return `<li class="st-${x.status}"><b>${x.status === 'done' ? '✔' : x.status === 'problem' ? '⚠' : '↷'} ${esc(tx(x, 'title'))}</b> <small>📍 ${esc(x.locName)} · ${new Date(x.at).toLocaleTimeString(LOCALES[getLang()], { timeStyle: 'short' })}</small> ${resultFlags(x)}${md}${vals ? `<ul>${vals}</ul>` : ''}${x.note ? `<p class="note">📝 ${esc(x.note)}</p>` : ''}</li>`;
}
function viewOthers() {
  let h = `<section class="card pastecard"><h3>${t('📨 Rapport binnenhalen')}</h3><p class="muted small">${t('Open de rapport-link uit WhatsApp of de melding: dan wordt hij vanzelf geïmporteerd. Of plak hem hier:')}</p>
    <textarea id="repPaste" rows="2" placeholder="${t('Plak hier de rapport-link of -tekst')}"></textarea>
    <div class="row"><button class="btn small" data-act="repClip">${t('📋 Plakken')}</button><button class="btn small" data-act="ntfyPoll">${t('🔄 Ophalen uit meldingskanaal')}</button><button class="btn small" data-act="importFile">${t('📄 Bestand')}</button></div>
    <p class="muted small" id="pollInfo">${state.settings.ntfyPolledAt ? t('Laatst opgehaald: {d}', { d: fmtDT(state.settings.ntfyPolledAt) }) : ''}</p></section>`;
  const all = received();
  if (!all.length) return h + `<p class="empty">${t('Nog geen rapporten van anderen. Rapporten van de bemanning (via link, meldingskanaal of bestand) verschijnen hier.')}</p>`;
  const persons = [...new Set(all.map((r) => r.by || '?'))].sort();
  const funcs = [...new Set(all.flatMap((r) => [...runFuncs(r)]))].sort();
  const since = OF.period === 'all' ? '' : new Date(Date.now() - +OF.period * 864e5).toISOString();
  const xs = all.filter((r) => (!OF.person || (r.by || '?') === OF.person) && (!OF.func || runFuncs(r).has(OF.func)) && (!since || (r.finishedAt || '') >= since));
  const pb = (k, l) => `<button class="${OF.period === k ? 'on' : ''}" data-act="ofPeriod" data-v="${k}">${l}</button>`;
  h += `<div class="mfilters"><select id="ofPerson"><option value="">${t('Alle personen')}</option>${persons.map((p) => `<option ${p === OF.person ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select><select id="ofFunc"><option value="">${t('Alle functies')}</option>${funcs.map((f) => `<option ${f === OF.func ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></div>`;
  h += `<div class="seg">${pb('7', t('7 dagen'))}${pb('30', t('30 dagen'))}${pb('all', t('Alles'))}</div>`;
  const nRes = xs.reduce((n, r) => n + r.results.length, 0), nNew = xs.filter((r) => !r.received.seenAt).reduce((n, r) => n + r.results.length, 0);
  const nProb = xs.reduce((n, r) => n + r.results.filter((x) => resultFlags(x).includes('warn')).length, 0);
  h += `<p class="ofsum">${t('{n} aftekeningen', { n: nRes })}${nNew ? ` · <b class="newc">${t('{n} nieuw', { n: nNew })}</b>` : ''}${nProb ? ` · <span class="cr">⚠ ${t('{n} met probleem', { n: nProb })}</span>` : ''}</p>`;
  h += `<div class="row">${nNew ? `<button class="btn small" data-act="seenAll">${t('✔ Alles gezien')}</button>` : ''}<button class="btn small" data-act="goMaradDone">${t('⬇ Afgemeld voor MARAD')}</button></div>`;
  const byP = new Map();
  for (const r of [...xs].sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || ''))) { const p = r.by || '?'; if (!byP.has(p)) byP.set(p, []); byP.get(p).push(r); }
  for (const [p, runs] of byP) {
    const pf = personFunc(p);
    h += `<h3 class="sec person">👤 ${esc(p)}${pf ? ` <small>· ${esc(pf)}</small>` : ''} <small>(${runs.reduce((n, r) => n + r.results.length, 0)})</small></h3>`;
    let lastD = '';
    for (const r of runs) {
      const d = new Date(r.finishedAt || r.received.at).toLocaleDateString(LOCALES[getLang()], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      if (d !== lastD) { h += `<h4 class="odate">📅 ${esc(d)}</h4>`; lastD = d; }
      const c = runStats(r); const photos = (r.messages || []).reduce((n, m) => n + (m.photos || 0), 0);
      h += `<article class="card others ${r.received.seenAt ? '' : 'new'}"><div class="ohead"><b>${esc(r.routeName)}</b>${r.received.seenAt ? '' : ` <span class="tag warn">${t('NIEUW')}</span>`}</div>
        <p class="muted small">${fmtDT(r.startedAt)} → ${fmtDT(r.finishedAt)} · ${VIA()[r.received.via] || t('via link')}</p>
        <p><span class="tag ok">✔ ${c.done}</span> <span class="tag">↷ ${c.skipped}</span> <span class="tag warn">⚠ ${c.problem}</span>${c.oor ? ` <span class="tag warn">❗ ${c.oor}</span>` : ''}${photos ? ` <span class="tag">📷 ${photos}</span>` : ''}${r.maradDone ? ` <span class="tag">🔧 ${r.maradDone}</span>` : ''}</p>
        <ul class="oresults">${r.results.map((x) => othersResult(r, x)).join('')}</ul>
        ${(r.messages || []).length ? `<ul class="omsgs">${r.messages.map((m) => `<li>${m.kind === 'vraag' ? '❓' : m.urgent ? '🚨' : '👁'} ${esc(m.text || '')}${m.locName ? ` <small>(${esc(m.locName)})</small>` : ''}${m.photos ? ` <small>📷 ${m.photos} ${t('(foto via meldingskanaal)')}</small>` : ''}</li>`).join('')}</ul>` : ''}
        <div class="row">${r.received.seenAt ? `<small class="muted">✔ ${t('gezien {d}', { d: fmtDT(r.received.seenAt) })}</small>` : `<button class="btn small ok" data-act="seenRun" data-id="${r.id}">${t('✔ Markeer als gezien')}</button>`}<button class="btn small ghost" data-act="openRunH" data-id="${r.id}">${t('Details')}</button></div></article>`;
    }
  }
  if (!xs.length) h += `<p class="empty">${t('Niets in deze periode / met dit filter.')}</p>`;
  return h;
}
function optLabel(f, o, k) { const L = getLang(); return (L !== 'nl' && f.tr?.[L]?.options?.[k]) || o; }
function fmtVal(f, v) {
  if (v === undefined || v === null || v === '') return '—';
  if (f.type === 'check') return v ? t('Ja') : t('Nee');
  if (f.type === 'oil' || f.type === 'oilinv') return OIL.fmtValue(f, v);
  if (f.type === 'choice') { const k = (f.options || []).indexOf(v); return k >= 0 ? optLabel(f, v, k) : v; }
  return `${v}${f.unit ? ' ' + f.unit : ''}`;
}
function viewRunDetail() {
  const run = state.runs.find((x) => x.id === view.runId);
  if (!run) { view.runId = null; return viewHistory(); }
  const c = runStats(run);
  let h = header(run.routeName, true);
  h += `<p>${fmtDT(run.startedAt)} → ${fmtDT(run.finishedAt)}${run.by ? ` · ${t('door {name}', { name: esc(run.by) })}` : ''}</p><p><span class="tag ok">✔ ${c.done}</span> <span class="tag">↷ ${c.skipped}</span> <span class="tag warn">⚠ ${c.problem}</span></p>`;
  h += `<div class="row"><button class="btn" data-act="exportRun" data-id="${run.id}" data-f="csv">${t('⬇ CSV')}</button><button class="btn" data-act="exportRun" data-id="${run.id}" data-f="json">${t('⬇ JSON')}</button><button class="btn" data-act="shareSummary" data-id="${run.id}">${t('📤 Samenvatting')}</button></div><ol class="results">`;
  for (const x of run.results) {
    h += `<li class="st-${x.status}"><b>${esc(tx(x, 'title'))}</b> <small>📍 ${esc(x.locName)} · ${new Date(x.at).toLocaleTimeString(LOCALES[getLang()], { timeStyle: 'short' })} · ${{ done: t('✔ klaar'), skipped: t('↷ overgeslagen'), problem: t('⚠ probleem') }[x.status]}</small>`;
    if (x.fields?.length) h += `<ul>${x.fields.map((f) => `<li class="${x.outOfRange?.includes(f.id) ? 'oor' : ''}">${esc(tx(f, 'label'))}: <b>${esc(fmtVal(f, x.values?.[f.id]))}</b></li>`).join('')}</ul>`;
    if (x.note) h += `<p class="note">📝 ${esc(x.note)}</p>`;
    h += `</li>`;
  }
  return h + `</ol><button class="btn danger small" data-act="delRun" data-id="${run.id}">${t('Ronde verwijderen')}</button>`;
}

function viewMore() {
  const st = state.settings;
  let h = header(t('Meer'));
  h += `<section class="card"><h2>${t('🌐 Taal · Language · Bahasa')}</h2><div class="seg langseg">${Object.entries(LANGS).map(([k, v]) => `<button class="${k === getLang() ? 'on' : ''}" data-act="setLang" data-v="${k}">${v.flag} ${k.toUpperCase()}</button>`).join('')}</div><p class="muted small">${t('Per toestel. De meldingen naar de ontvanger blijven Nederlands; getypte tekst wordt niet vertaald.')}</p></section>`;
  h += modeCard();
  h += `<section class="card"><h2>${t('🔧 MARAD-onderhoud')}</h2><p class="muted">${t('Worklist-export uit MARAD inlezen (.xlsx/.csv). Bijwerken zonder dubbelingen.')}</p><div class="row"><button class="btn" data-act="mImport">${t('📥 MARAD-import')}</button><button class="btn" data-act="reportImport">${t('📨 Rapport importeren')}</button></div>${state.maint ? `<button class="btn ghost small" data-act="mLock">${t('🔒 Vergrendel opnieuw (lokale MARAD-kopie wissen)')}</button>` : ''}</section>`;
  h += `<section class="card"><h2>${t('Personen')}</h2><p class="muted">${t('Naar wie je routes kunt sturen.')}</p><ul class="locs">${state.contacts.map((c) => `<li data-act="editContact" data-id="${c.id}"><span>👤 ${esc(tx(c, 'name'))}${c.func ? ` <small class="func">· ${esc(c.func)}</small>` : ''}</span><small>${esc(c.phone || c.email || '')}</small></li>`).join('')}</ul><button class="btn small" data-act="editContact">${t('+ Persoon toevoegen')}</button></section>`;
  const tog = (k, label) => `<label class="switch"><input type="checkbox" data-set="${k}" ${st[k] ? 'checked' : ''}><span>${label}</span></label>`;
  h += `<section class="card"><h2>${t('Instellingen')}</h2>
    <label>${t('Schip')}<input data-ship value="${esc(state.shipName)}"></label>
    <label>${t('Mijn naam (in rapporten en meldingen)')}<input data-set-text="userName" value="${esc(st.userName || '')}" placeholder="${t('Bijv. Hessel')}"></label>
    <label>${t('Mijn functie (filter in Onderhoud)')}<select data-set-sel="myRank">${[...new Set([st.myRank || 'Engineer', ...MT.rankNames()])].map((r) => `<option ${r === (st.myRank || 'Engineer') ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
    <label>${t('Mijn telefoon (WhatsApp) – bemanning stuurt rapporten hierheen')}<input type="tel" data-set-text="userPhone" value="${esc(st.userPhone || '')}" placeholder="+31 6…"></label>
    <label>${t('Thema')}<select data-set-sel="theme"><option value="auto" ${st.theme === 'auto' ? 'selected' : ''}>${t('Automatisch')}</option><option value="light" ${st.theme === 'light' ? 'selected' : ''}>${t('Licht (hoog contrast)')}</option><option value="dark" ${st.theme === 'dark' ? 'selected' : ''}>${t('Donker')}</option></select></label>
    ${tog('bigText', t('Extra grote tekst'))}${tog('vibrate', t('Trillen bij volgende stap'))}${tog('speak', t('Instructie uitspreken (spraak)'))}${tog('wakeLock', t('Scherm aan houden tijdens ronde'))}${fsToggle(tog)}${tog('resumeOnStart', t('Lopende ronde direct openen bij starten app'))}</section>`;
  h += `<section class="card" id="ntfyCard"><h2>${t('🔔 Meldingen (vragen & observaties)')}</h2>
    <p class="muted">${t('Vragen en observaties van de bemanning gaan via')} <b>${t('ntfy')}</b> ${t('naar je telefoon, met piepje. Installeer de gratis app')} <b>${t('ntfy')}</b> ${t('(Android/iPhone), tik op')} <b>+</b> ${t('en abonneer op dit kanaal. Zonder internet wachten berichten in de outbox en gaan ze vanzelf weg zodra er verbinding is.')}</p>
    <label>${t('Melding naar (ntfy-kanaal)')}<input data-ntfy="ntfyTopic" value="${esc(st.ntfyTopic || '')}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <div class="row"><button class="btn small" data-act="copyTopic">${t('Kopieer kanaal')}</button><a class="btn small" href="${esc((st.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, ''))}/${esc(st.ntfyTopic || '')}" target="_blank" rel="noopener">${t('Open in ntfy')}</a></div>
    <button class="btn primary" data-act="testNtfy">${t('🔔 Testmelding sturen')}</button>
    <p class="muted small">${t('Houd het kanaal geheim: wie de naam kent kan meelezen. Het kanaal gaat automatisch mee met routes die je verstuurt, zodat vragen van bijv. Hessel bij jou binnenkomen.')}</p>
    <details class="auto"><summary>${t('Geavanceerd')}</summary><label>${t('ntfy-server')}<input data-ntfy="ntfyServer" value="${esc(st.ntfyServer || 'https://ntfy.sh')}"></label><button class="btn small ghost" data-act="newTopic">${t('Nieuw willekeurig kanaal')}</button></details></section>`;
  h += `<section class="card"><h2>${t('Back-up')}</h2><p class="muted">${t('Alles (routes, locaties, historie, plattegronden) in één bestand.')}</p><div class="row"><button class="btn" data-act="backup">${t('⬇ Back-up maken')}</button><button class="btn" data-act="importFile">${t('⬆ Terugzetten / importeren')}</button></div></section>`;
  h += `<section class="card"><h2>${t('App')}</h2><p class="muted">${t('Versie')} ${APP_VERSION} ${t('· werkt offline na eerste keer openen · gegevens blijven op dit toestel.')}</p><div class="row"><button class="btn ghost" data-act="showInstall">${t('Installatie-uitleg')}</button><button class="btn danger" data-act="reset">${t('Demo-gegevens herstellen')}</button></div></section>`;
  return h;
}

const fsToggle = (tog) => (isIOS() ? `<p class="muted small">${t('📱 iPhone: schermvullend werkt door de app vanaf het beginscherm te starten (geen aparte schakelaar nodig).')}</p>` : tog('fullscreen', t('Ronde schermvullend starten')));
function afterRender() {
  const list = $('#steps');
  if (list) bindDrag(list, (ids) => {
    const r = route(view.routeId);
    r.steps = ids.map((id) => r.steps.find((s) => s.id === id));
    touch(r); render();
  });
  fillWaLinks();
  const oc = $('.rchips .chip.on'); if (oc && oc.dataset.v) oc.parentElement.scrollLeft = oc.offsetLeft - 60;
  const img = $('#planImg');
  if (img) getPlan($('#plan').dataset.deck).then((src) => { if (src) img.src = src; });
}
function touch(r) { r.updatedAt = Date.now(); save(); }

function bindDrag(list, onDone) {
  list.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.handle'); if (!h) return;
    e.preventDefault();
    const li = h.closest('li'); li.classList.add('dragging');

    const move = (ev) => {
      const y = ev.clientY;
      let before = null;
      for (const it of [...list.children]) {
        if (it === li) continue;
        const r = it.getBoundingClientRect();
        if (y < r.top + r.height / 2) { before = it; break; }
      }
      if (before !== li.nextSibling) list.insertBefore(li, before);
      if (y < 70) scrollBy(0, -12); else if (y > innerHeight - 110) scrollBy(0, 12);
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      li.classList.remove('dragging');
      onDone([...list.children].map((x) => x.dataset.id));
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  });
}

// ---------- taak-editor ----------
const FIELD_TYPES = { number: t('Getal / meting'), text: t('Tekst'), check: t('Ja / nee'), choice: t('Keuze'), oil: t('🛢 Olie bijvullen') };
let editLang = getLang();
const txIn = (o, k, L) => (L === 'nl' ? o?.[k] : o?.tr?.[L]?.[k]) || '';
function taskEditorHTML() {
  const d = draft;
  const l = loc(d.locationId);
  let h = `<h2>${sheetCtx.isNew ? t('Nieuwe taak') : t('Taak bewerken')}</h2>
    <label>${t('Waar? (locatie)')}${locSelect(d.locationId, 'data-tf="locationId"')}</label>
    <div id="newLocBox" ${d.locationId === '__new' ? '' : 'hidden'} class="subform"><label>${t('Naam nieuwe locatie')}<input data-nl="name" value="${esc(d._newLoc?.name || '')}"></label><label>${t('Gebied')}${deckSelect(d._newLoc?.deck || state.decks[0]?.id, 'data-nl="deck"')}</label></div>
    <div class="mapwrap small" id="edMap">${l ? shipSVG({ view: view.mapMode === 'top' ? 'top' : 'side', locations: state.locations, highlight: l.id, dim: true }) : ''}</div>
    <div class="flbl">${t('Taal van de tekst')}</div><div class="seg langtabs">${Object.keys(LANGS).map((L) => `<button data-act="edLang" data-v="${L}" class="${L === editLang ? 'on' : ''}">${LANGS[L].flag} ${L.toUpperCase()}${txIn(d, 'title', L) ? ' ✓' : ''}</button>`).join('')}</div>
    <p class="hint">${t('Vul de taak in één of meer talen in. Lege talen tonen automatisch een andere ingevulde taal.')}</p>
    <label>${t('Taak (kort)')}<input data-tf="title" value="${esc(txIn(d, 'title', editLang))}" placeholder="${esc(tx(d, 'title') || t('Bijv. Oliepeil hoofdmotor controleren'))}"></label>
    <label>${t('Instructie')}<textarea data-tf="instruction" rows="3" placeholder="${esc(tx(d, 'instruction') || t('Wat moet er precies gebeuren?'))}">${esc(txIn(d, 'instruction', editLang))}</textarea></label>
    <h3 class="sec">${t('Gegevens invoeren bij deze taak')}</h3><div id="fieldsBox">${fieldsEditorHTML()}</div>
    <div class="row wrap">${Object.entries(FIELD_TYPES).map(([k, v]) => `<button class="btn small" data-act="addField" data-type="${k}">+ ${v}</button>`).join('')}</div>
    <div class="row sticky"><button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button><button class="btn primary" data-act="saveStep">${t('Opslaan')}</button></div>`;
  return h;
}
function fieldsEditorHTML() {
  if (!draft.fields.length) return `<p class="muted">${t('Geen invoer nodig. Voeg een veld toe als je iets wilt vastleggen (meting, ja/nee, opmerking).')}</p>`;
  return draft.fields.map((f, i) => `<div class="fieldrow"><div class="row"><input data-fi="${i}" data-k="label" value="${esc(txIn(f, 'label', editLang))}" placeholder="${esc(tx(f, 'label') || t('Naam veld'))}"><select data-fi="${i}" data-k="type">${Object.entries(FIELD_TYPES).map(([k, v]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select><button class="iconbtn" data-act="delField" data-i="${i}" aria-label="${t('Verwijderen')}">🗑</button></div>
    ${f.type === 'number' ? `<div class="row"><input data-fi="${i}" data-k="unit" value="${esc(f.unit || '')}" placeholder="${t('Eenheid (°C, bar…)')}"><input type="number" step="any" data-fi="${i}" data-k="min" value="${f.min ?? ''}" placeholder="${t('Min')}"><input type="number" step="any" data-fi="${i}" data-k="max" value="${f.max ?? ''}" placeholder="${t('Max')}"></div>` : ''}
    ${f.type === 'choice' ? `<input data-fi="${i}" data-k="options" value="${esc((f.options || []).join(', '))}" placeholder="${t('Opties, gescheiden door komma\'s')}">` : ''}
    <label class="switch"><input type="checkbox" data-fi="${i}" data-k="required" ${f.required ? 'checked' : ''}><span>${t('Verplicht')}</span></label></div>`).join('');
}
function openTaskEditor(step, ctx) {
  draft = clone(step);
  draft.fields ??= [];
  editLang = getLang();
  openSheet('', ctx);
  $('.sheet-card').insertAdjacentHTML('beforeend', `<div id="edBody">${taskEditorHTML()}</div>`);
}
function saveDraft() {
  const d = draft;
  if (d.locationId === '__new') {
    const name = d._newLoc?.name?.trim();
    if (!name) return toast(t('Geef de nieuwe locatie een naam'));
    const nl = { id: 'l-' + rid(), name, deck: d._newLoc?.deck || state.decks[0]?.id, x: 50, z: 40, w: 0 };
    state.locations.push(nl); d.locationId = nl.id;
    toast(t('Locatie toegevoegd – plaats hem later op de kaart'));
  }
  if (!d.locationId) return toast(t('Kies een locatie'));
  if (!(tx(d, 'title') || '').trim()) return toast(t('Geef de taak een korte naam'));
  delete d._newLoc;
  d.fields = d.fields.filter((f) => (tx(f, 'label') || '').trim()).map((f) => {
    const o = { id: f.id || rid(), label: (f.label || '').trim(), type: f.type };
    if (f.tr) o.tr = f.tr;
    if (f.required) o.required = true;
    if (f.type === 'number') { if (f.unit) o.unit = f.unit; if (f.min !== '' && f.min != null && !isNaN(f.min)) o.min = +f.min; if (f.max !== '' && f.max != null && !isNaN(f.max)) o.max = +f.max; }
    if (f.type === 'choice') o.options = (Array.isArray(f.options) ? f.options : String(f.options || '').split(',')).map((x) => x.trim()).filter(Boolean);
    return o;
  });
  const { target } = sheetCtx;
  if (target === 'library') {
    const i = state.library.findIndex((x) => x.id === d.id);
    if (i >= 0) state.library[i] = d; else state.library.push(d);
    save();
  } else {
    const r = route(view.routeId);
    const i = r.steps.findIndex((s) => s.id === d.id);
    if (i >= 0) r.steps[i] = d; else r.steps.push(d);
    touch(r);
  }
  closeSheet(); render();
}

// ---------- route delen / importeren ----------
async function openShare(r) {
  const pkg = () => routePackage(state, r, sheetCtx?.to || '');
  const contactOpts = state.contacts.map((c) => `<option value="${c.id}" ${c.name === r.assignee ? 'selected' : ''}>${esc(tx(c, 'name'))}</option>`).join('');
  openSheet(`<h2>${t('Route versturen')}</h2><p><b>${esc(tx(r, 'name'))}</b> · ${plural(r.steps.length, t('taak'), t('taken'))}</p>
    <label>${t('Naar')}<select id="shTo">${contactOpts}<option value="">${t('Iemand anders…')}</option></select></label>
    <div id="shOther" class="subform" hidden><label>${t('Naam')}<input id="shName" placeholder="${t('Naam')}"></label><label>${t('Telefoon (WhatsApp, optioneel)')}<input id="shPhone" type="tel" placeholder="+31 6…"></label><label>${t('E-mail (optioneel)')}<input id="shEmail" type="email"></label><label class="switch"><input type="checkbox" id="shSave" checked><span>${t('Bewaren in personen')}</span></label></div>
    <label>${t('Bericht')}<textarea id="shText" rows="3"></textarea></label>
    <div class="stack"><button class="btn primary big" data-act="shLink">${t('📤 Deel link (WhatsApp, mail, …)')}</button><button class="btn" data-act="shFile">${t('📄 Deel als bestand (.json)')}</button><div class="row" id="shDirect"></div><button class="btn ghost" data-act="shCopy">${t('🔗 Kopieer link')}</button></div>
    <p class="muted small" id="shInfo">${t('Link maken…')}</p><p class="muted small">${t('De ontvanger opent de link (of het bestand) in deze app; de route wordt dan geïmporteerd en werkt daarna offline.')}</p>`, { route: r, to: '' });
  const upd = async () => {
    const sel = $('#shTo').value;
    const c = state.contacts.find((x) => x.id === sel);
    $('#shOther').hidden = !!c;
    const name = c ? c.name : $('#shName').value.trim();
    const phone = c ? c.phone : $('#shPhone').value.trim();
    const email = c ? c.email : $('#shEmail').value.trim();
    sheetCtx.to = name; sheetCtx.phone = phone; sheetCtx.email = email;
    sheetCtx.link = await buildShareLink(pkg());
    $('#shText').value = (name ? t('Route "{route}" voor {name} – {n} ({ship}). Open de link om de route in de app te zetten:', { route: tx(r, 'name'), name, n: plural(r.steps.length, t('taak'), t('taken')), ship: state.shipName }) : t('Route "{route}" – {n} ({ship}). Open de link om de route in de app te zetten:', { route: tx(r, 'name'), n: plural(r.steps.length, t('taak'), t('taken')), ship: state.shipName }));
    $('#shInfo').textContent = t('Link: {n} tekens', { n: sheetCtx.link.length }) + (sheetCtx.link.length > 6000 ? t(' – lang; deel liever als bestand') : '');
    const msg = encodeURIComponent($('#shText').value + '\n' + sheetCtx.link);
    const ph = (phone || '').replace(/[^\d]/g, '').replace(/^0(?=6)/, '31');
    $('#shDirect').innerHTML = (ph ? `<a class="btn" href="https://wa.me/${ph}?text=${msg}" target="_blank" rel="noopener" data-act="shLog" data-via="whatsapp">${t('WhatsApp')} ${esc(name)}</a>` : '') + (email ? `<a class="btn" href="mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(t('Route ') + r.name)}&body=${msg}" data-act="shLog" data-via="mail">${t('Mail')} ${esc(name)}</a>` : '');
  };
  sheetCtx.update = upd;
  await upd();
}
function logSend(via) {
  const { route: r, to } = sheetCtx;
  if (sheetCtx.saveNew !== false && to && !state.contacts.some((c) => c.name === to) && $('#shSave')?.checked) {
    state.contacts.push({ id: 'c-' + rid(), name: to, phone: sheetCtx.phone || '', email: sheetCtx.email || '' });
  }
  if (to) r.assignee = to;
  (r.sentLog ??= []).push({ to: to || '?', at: new Date().toISOString(), via });
  save();
}
function importSheet(pkg) {
  const r = pkg.route;
  const exists = !!route(r.id);
  openSheet(`<h2>${t('Route ontvangen')}</h2><p><b>${esc(tx(r, 'name'))}</b>${pkg.to ? ` ${t('voor {name}', { name: `<b>${esc(pkg.to)}</b>` })}` : ''}</p><p>${plural(r.steps.length, t('taak'), t('taken'))} · ${plural(pkg.locations?.length || 0, t('locatie'), t('locaties'))}${pkg.ship ? ` · ${esc(pkg.ship)}` : ''}</p>${exists ? `<p class="warnbox">${t('Deze route staat al in de app. Bijwerken vervangt jouw versie.')}</p>` : ''}
    ${pkg.notify?.topic && pkg.notify.topic !== state.settings.ntfyTopic ? `<label class="switch"><input type="checkbox" id="adoptTopic" ${state.settings.ntfyTopicAuto !== false ? 'checked' : ''}><span>${t('Mijn vragen & observaties naar het meldingskanaal van {name} sturen (aanbevolen)', { name: esc(pkg.from || t('de afzender')) })}</span></label>` : ''}
    <div class="stack"><button class="btn primary big" data-act="doImport">${exists ? t('Bijwerken') : t('Importeren')}</button>${exists ? `<button class="btn" data-act="doImport" data-copy="1">${t('Als kopie importeren')}</button>` : ''}<button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button></div>`, { pkg });
}
function importPackage(pkg, asCopy) {
  const deckMap = new Map(), locMap = new Map();
  for (const d of pkg.decks || []) {
    const hit = deck(d.id) || state.decks.find((x) => x.name.toLowerCase() === d.name.toLowerCase());
    if (hit) deckMap.set(d.id, hit.id); else { state.decks.push(clone(d)); deckMap.set(d.id, d.id); }
  }
  for (const l of pkg.locations || []) {
    const dk = deckMap.get(l.deck) || l.deck;
    const hit = loc(l.id) || state.locations.find((x) => x.name.toLowerCase() === l.name.toLowerCase());
    if (hit) locMap.set(l.id, hit.id); else { state.locations.push({ ...clone(l), deck: dk }); locMap.set(l.id, l.id); }
  }
  const r = clone(pkg.route);
  r.steps.forEach((s) => (s.locationId = locMap.get(s.locationId) || s.locationId));
  r.importedAt = new Date().toISOString();
  if (pkg.replyTo) r.replyTo = pkg.replyTo;
  if (pkg.notify?.topic) { r.notifyTopic = pkg.notify.topic; r.notifyServer = pkg.notify.server || 'https://ntfy.sh'; r.from = pkg.from || ''; }
  if (asCopy) { r.id = 'r-' + rid(); r.name += ' (kopie)'; r.steps.forEach((s) => (s.id = rid())); }
  const i = state.routes.findIndex((x) => x.id === r.id);
  if (i >= 0) state.routes[i] = r; else state.routes.push(r);
  save();
  return r;
}
async function handleImportText(text, via = 'file') {
  let obj;
  try { obj = JSON.parse(text); } catch { return toast(t('Geen geldig bestand')); }
  if (obj.kind === 'route' && obj.route) return importSheet(obj);
  if (obj.kind === 'report' && obj.results) return autoImportReport(obj, via);
  if (obj.kind === 'backup' && obj.data) {
    if (!confirm(t('Back-up terugzetten? Dit vervangt ALLE gegevens op dit toestel.'))) return;
    const imgs = obj.data.planImages || {}; delete obj.data.planImages;
    replaceState(obj.data); MT.persist();
    for (const [d, src] of Object.entries(imgs)) await setPlan(d, src);
    toast(t('Back-up teruggezet')); go('routes'); return;
  }
  toast(t('Onbekend bestandstype'));
}

// ---------- export ----------
const csvCell = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function runsToCSV(runs) {
  const rows = [['ronde_id', 'route', 'schip', 'door', 'start', 'einde', 'stap', 'locatie', 'gebied', 'taak', 'status', 'tijd', 'veld', 'waarde', 'eenheid', 'min', 'max', 'buiten_bereik', 'opmerking'].map((h) => t('csv:' + h))];
  const stt = { done: t('klaar'), skipped: t('overgeslagen'), problem: t('probleem') };
  for (const run of runs) run.results.forEach((x, i) => {
    const base = [run.id, run.routeName, run.ship, run.by || '', run.startedAt, run.finishedAt, i + 1, x.locName, x.deckName, x.title, stt[x.status] || x.status, x.at];
    const fs = x.fields?.length ? x.fields : [null];
    fs.forEach((f) => rows.push([...base, (f ? tx(f, 'label') : ''), f ? (f.type === 'check' ? (x.values?.[f.id] === undefined ? '' : x.values[f.id] ? t('ja') : t('nee')) : x.values?.[f.id] ?? '') : '', f?.unit || '', f?.min ?? '', f?.max ?? '', f && x.outOfRange?.includes(f.id) ? t('JA') : '', x.note || '']));
  });
  return '\ufeff' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
}
function runSummary(run) {
  const c = runStats(run);
  let txt = `${state.shipName} – ${run.routeName}\n${fmtDT(run.startedAt)} – ${fmtDT(run.finishedAt)}${run.by ? ` (${run.by})` : ''}\n✔ ${c.done} ${t('klaar')} · ↷ ${c.skipped} ${t('overgeslagen')} · ⚠ ${plural(c.problem, t('probleem'), t('problemen'))}\n`;
  for (const x of run.results) {
    if (x.status === 'done' && !x.outOfRange?.length) continue;
    txt += `\n${x.status === 'problem' ? '⚠' : x.status === 'skipped' ? '↷' : '❗'} ${x.title} (${x.locName})`;
    if (x.note) txt += `: ${x.note}`;
    for (const f of x.fields || []) if (x.outOfRange?.includes(f.id)) txt += `\n   ${tx(f, 'label')}: ${fmtVal(f, x.values[f.id])} (${t('bereik')} ${f.min ?? '…'}–${f.max ?? '…'})`;
  }
  for (const m of run.messages || []) txt += `\n${m.kind === 'vraag' ? t('❓ Vraag') : t('👁 Observatie')}${m.urgent ? ' (URGENT)' : ''}${m.locName ? ` (${m.locName})` : ''}: ${m.text}${m.photos ? ` [${m.photos} ${t('foto')}]` : ''}`;
  return txt;
}
async function exportRuns(runs, f, name) {
  const stamp = new Date().toISOString().slice(0, 10);
  if (f === 'csv') await shareFile(`${name}-${stamp}.csv`, runsToCSV(runs), 'text/csv', name, t('Rondes ') + state.shipName);
  else await shareFile(`${name}-${stamp}.json`, JSON.stringify({ app: 'schiproute', kind: 'runs', ship: state.shipName, runs }, null, 2), 'application/json', name, t('Rondes ') + state.shipName);
}

// ---------- ronde (run mode) ----------
async function startRun(id) {
  const r = route(id);
  if (!r?.steps.length) return;
  if (state.activeRun && !confirm(t('Er loopt nog een ronde ({name}). Die afbreken en deze starten?', { name: tx(state.activeRun.route, 'name') }))) return;
  const locs = {};
  for (const s of r.steps) { const l = loc(s.locationId); if (l) locs[l.id] = { ...clone(l), deckName: deckName(l.deck) }; }
  state.activeRun = { id: 'run-' + rid(), routeId: r.id, route: clone(r), locs, idx: 0, results: [], values: {}, startedAt: new Date().toISOString(), by: state.settings.userName || '' };
  save(); openRun();
}
async function enterRunChrome() {
  document.body.classList.add('running');
  if (state.settings.fullscreen !== false && !document.fullscreenElement && document.documentElement.requestFullscreen) {
    try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { /* niet toegestaan */ }
  }
  if (state.settings.wakeLock) {
    let ok = false;
    if ('wakeLock' in navigator) { try { wakeLock = await navigator.wakeLock.request('screen'); ok = true; } catch { /* niet beschikbaar */ } }
    if (!ok && !sessionStorage.getItem('wlWarn')) {
      sessionStorage.setItem('wlWarn', '1');
      toast(isIOS() ? t('Scherm aan houden lukt hier niet. iPhone: Instellingen → Beeldscherm en helderheid → Automatisch slot → tijdelijk langer zetten.') : t('Scherm aan houden wordt op dit toestel niet ondersteund.'), 6000);
    }
  }
}
function exitRunChrome() {
  document.body.classList.remove('running');
  wakeLock?.release?.().catch(() => {}); wakeLock = null;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
function openRun() { $('#run').hidden = false; enterRunChrome(); renderRun(true); }
function closeRun() { $('#run').hidden = true; $('#run').innerHTML = ''; exitRunChrome(); render(); }
function speak(text) {
  if (!state.settings.speak || !('speechSynthesis' in self)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text); u.lang = LOCALES[getLang()]; speechSynthesis.speak(u);
}
const curLoc = (ar, s) => loc(s.locationId) || ar.locs[s.locationId] || { name: t('Onbekende locatie') };
function runMap(ar, l) {
  if (l.pp && state.plans.includes(l.pp.deck)) return `<div class="plan mini" data-deck="${esc(l.pp.deck)}"><img class="runPlanImg" alt=""><span class="pmk hl" style="left:${l.pp.x}%;top:${l.pp.y}%"></span></div>`;
  const locs = Object.values(ar.locs).map((x) => loc(x.id) || x);
  return shipSVG({ view: ar.mapView || 'side', locations: locs, highlight: l.id, dim: true });
}
function fieldInput(f, v, oor) {
  if (f.type === 'oil' || f.type === 'oilinv') return OIL.fieldHTML(f, v);
  const req = f.required ? ' <i>*</i>' : '';
  if (f.type === 'number') {
    const rng = f.min != null || f.max != null ? `<small>${f.min ?? '…'} – ${f.max ?? '…'} ${esc(f.unit || '')}</small>` : '';
    return `<div class="fld ${oor ? 'oor' : ''}" data-fid="${f.id}"><span class="flbl">${esc(tx(f, 'label'))}${req} ${rng}</span><div class="numrow"><input type="number" inputmode="decimal" step="any" data-rv="${f.id}" value="${v ?? ''}"><span class="unit">${esc(f.unit || '')}</span></div><p class="oormsg">${t('⚠ Buiten bereik – controleer of meld een probleem')}</p></div>`;
  }
  if (f.type === 'text') return `<div class="fld" data-fid="${f.id}"><span class="flbl">${esc(tx(f, 'label'))}${req}</span><textarea rows="2" data-rv="${f.id}">${esc(v ?? '')}</textarea></div>`;
  if (f.type === 'check') return `<div class="fld" data-fid="${f.id}"><span class="flbl">${esc(tx(f, 'label'))}${req}</span><div class="choice2"><button class="cbtn yes ${v === true ? 'on' : ''}" data-act="runPick" data-fid="${f.id}" data-val="true">${t('Ja')}</button><button class="cbtn no ${v === false ? 'on' : ''}" data-act="runPick" data-fid="${f.id}" data-val="false">${t('Nee')}</button></div></div>`;
  if (f.type === 'choice') return `<div class="fld" data-fid="${f.id}"><span class="flbl">${esc(tx(f, 'label'))}${req}</span><div class="choiceN">${(f.options || []).map((o, k) => `<button class="cbtn ${v === o ? 'on' : ''}" data-act="runPick" data-fid="${f.id}" data-val="${esc(JSON.stringify(o))}">${esc(optLabel(f, o, k))}</button>`).join('')}</div></div>`;
  return '';
}
const isOOR = (f, v) => f.type === 'number' && v !== '' && v != null && !isNaN(v) && ((f.min != null && +v < f.min) || (f.max != null && +v > f.max));
function renderRun(first = false) {
  const ar = state.activeRun;
  const el = $('#run');
  if (!ar) return closeRun();
  const steps = ar.route.steps, i = ar.idx, total = steps.length;
  if (i >= total) return renderRunDone();
  const s = steps[i], l = curLoc(ar, s);
  const last = ar.results[ar.results.length - 1];
  const lead = i === 0 ? t('Daar gaan we!') : last?.status === 'done' ? t('Goed zo!') : last?.status === 'problem' ? t('Probleem genoteerd.') : t('Oké, overgeslagen.');
  const vals = ar.values[s.id] || {};
  const next = steps[i + 1];
  const same = i > 0 && steps[i - 1].locationId === s.locationId;
  const shown = (s.fields || []).filter((f) => f.role !== 'mDone' && f.role !== 'mRem'); // OK/Niet OK vervangen "Uitgevoerd" en "Opmerking"
  const acts = `<div class="run-actions onetap"><div class="row2"><button class="btn ok huge" data-act="runDone">✔ ${t('OK')}</button><button class="btn bad huge" data-act="runProblem">✖ ${t('Niet OK')}</button></div>
      <div class="row2"><button class="btn" data-act="newHelp">❓ ${t('Vraag')}</button><button class="btn" data-act="newObs">📷 ${t('Foto / observatie')}</button></div></div>`;
  if (isCrew()) {
    // Bemanning: alleen de route, de huidige taak groot met locatie, en OK / Niet OK / Vraag / Foto.
    el.innerHTML = `<div class="run-top"><button class="iconbtn" data-act="runPause" aria-label="${t('Pauze')}">✕</button><div class="prog"><div style="width:${(i / total) * 100}%"></div></div>${obxBadge()}<span class="cnt">${i + 1}/${total}</span></div>
    <div class="run-body crewrun"><p class="rname">${esc(tx(ar.route, 'name'))}</p>
      <p class="bigloc">📍 ${esc(tx(l, 'name'))}</p>
      <h2 class="bigtask">${esc(tx(s, 'title'))}</h2>
      ${s.instruction || s.workCard ? `<details class="instr"><summary>${t('Uitleg')}</summary>${s.instruction ? `<p>${esc(tx(s, 'instruction'))}</p>` : ''}${s.workCard ? `<pre>${esc(s.workCard)}</pre>` : ''}</details>` : ''}
      ${shown.length ? `<div class="fields">${shown.map((f) => fieldInput(f, vals[f.id], isOOR(f, vals[f.id]))).join('')}</div>` : ''}
      <div class="row mininav"><button class="btn small ghost" data-act="runPrev" ${i === 0 ? 'disabled' : ''}>◀ ${t('Vorige')}</button><button class="btn small ghost" data-act="runSkip">↷ ${t('Overslaan')}</button></div>
    </div>${acts}`;
    el.scrollTop = 0;
    if (!first && state.settings.vibrate && navigator.vibrate) navigator.vibrate(80);
    speak(t('{lead} {go} {loc}, en voer de taak uit: {task}. {instr}', { lead: '', go: same ? t('Blijf bij') : t('Loop nu naar'), loc: tx(l, 'name'), task: tx(s, 'title'), instr: tx(s, 'instruction') }));
    return;
  }
  el.innerHTML = `<div class="run-top"><button class="iconbtn" data-act="runPause" aria-label="${t('Pauze')}">✕</button><div class="prog"><div style="width:${(i / total) * 100}%"></div></div>${obxBadge()}<span class="cnt">${i + 1}/${total}</span></div>
    <div class="run-body">
      <p class="lead">${lead}</p>
      <h2 class="goto">${same ? t('Blijf bij') : t('Loop nu naar')} <span class="locname">${esc(tx(l, 'name'))}</span></h2>
      <p class="deckname">${esc(tx(deck(l.deck), 'name') || l.deckName || '')}</p>
      <div class="run-map" data-act="runMapToggle">${runMap(ar, l)}</div>
      <div class="task"><p class="tasklbl">${t('en voer de taak uit:')}</p><h3>${esc(tx(s, 'title'))}</h3>${s.instruction ? `<p>${esc(tx(s, 'instruction'))}</p>` : ''}${MT.runExtra(s)}</div>
      ${shown.length ? `<div class="fields">${shown.map((f) => fieldInput(f, vals[f.id], isOOR(f, vals[f.id]))).join('')}</div>` : ''}
      ${next ? `<p class="next">${t('Daarna:')} <b>${esc(tx(next, 'title'))}</b> · ${esc(tx(curLoc(ar, next), 'name'))}</p>` : `<p class="next">${t('Dit is de laatste taak.')}</p>`}
    </div>
    <div class="row mininav"><button class="btn small ghost" data-act="runPrev" ${i === 0 ? 'disabled' : ''}>${t('◀ Vorige')}</button><button class="btn small ghost" data-act="runSkip">${t('↷ Overslaan')}</button></div>
    ${acts}`;
  el.scrollTop = 0; $('.run-body', el).scrollTop = 0;
  const pi = $('.runPlanImg', el);
  if (pi) getPlan(l.pp.deck).then((src) => { if (src) pi.src = src; });
  if (!first && state.settings.vibrate && navigator.vibrate) navigator.vibrate(80);
  speak(t('{lead} {go} {loc}, en voer de taak uit: {task}. {instr}', { lead, go: same ? t('Blijf bij') : t('Loop nu naar'), loc: tx(l, 'name'), task: tx(s, 'title'), instr: tx(s, 'instruction') }));
}
function recordStep(status, note = '') {
  const ar = state.activeRun;
  const s = ar.route.steps[ar.idx];
  const l = curLoc(ar, s);
  const values = clone(ar.values[s.id] || {});
  ar.results = ar.results.filter((x) => x.stepId !== s.id);
  ar.results.push({ stepId: s.id, marad: s.marad || null, title: tx(s, 'title'), titleNl: s.title, locNl: l.name, locationId: s.locationId, locName: tx(l, 'name'), deckName: tx(deck(l.deck), 'name') || l.deckName || '', status, at: new Date().toISOString(), values, fields: clone(s.fields || []), outOfRange: (s.fields || []).filter((f) => isOOR(f, values[f.id])).map((f) => f.id), note });
  ar.idx++; save(); renderRun();
}
function renderRunDone() {
  const ar = state.activeRun;
  const run = { id: ar.id, routeId: ar.routeId, routeName: tx(ar.route, 'name'), ship: state.shipName, by: ar.by, startedAt: ar.startedAt, finishedAt: new Date().toISOString(), results: ar.results, messages: ar.messages || [] };
  if (ar.route.notifyTopic) run.notify = { topic: ar.route.notifyTopic, server: ar.route.notifyServer }; if (ar.route.replyTo) run.replyTo = ar.route.replyTo; run.from = ar.route.from || '';
  state.runs.push(run); state.activeRun = null; save();
  if (!isCrew() && state.maint) { const m = MT.applyRun(run); run.maradDone = m.done; save(); }
  const c = runStats(run);
  if (state.settings.vibrate && navigator.vibrate) navigator.vibrate([80, 60, 160]);
  speak(t('Ronde voltooid. Goed gedaan!'));
  $('#run').innerHTML = `<div class="run-body done"><p class="big-ok">🎉</p><h2>${t('Ronde voltooid!')}</h2><p class="lead">${esc(run.routeName)}</p>
    <p class="donestats"><span class="tag ok">✔ ${c.done} ${t('klaar')}</span> <span class="tag">↷ ${c.skipped} ${t('overgeslagen')}</span> <span class="tag warn">⚠ ${plural(c.problem, t('probleem'), t('problemen'))}</span></p>
    ${c.problem || c.oor || c.skipped ? `<pre class="summary">${esc(runSummary(run))}</pre>` : `<p>${t('Alles in orde.')}</p>`}
    ${run.maradDone ? `<p class="okbox">🔧 ${t('{n} MARAD-taken afgemeld (Onderhoud → Afgemeld). Nog zelf invoeren in MARAD.', { n: run.maradDone })}</p>` : ''}
    <div class="stack">${isCrew() || run.notify ? `<button class="btn ok big" data-act="sendReport" data-id="${run.id}">${t('📨 Stuur rapport')}</button>` : ''}<button class="btn ${isCrew() ? '' : 'primary big'}" data-act="shareSummary" data-id="${run.id}">${t('📤 Rapport delen')}</button><div class="row"><button class="btn" data-act="exportRun" data-id="${run.id}" data-f="csv">${t('⬇ CSV')}</button><button class="btn" data-act="exportRun" data-id="${run.id}" data-f="json">${t('⬇ JSON')}</button></div><button class="btn ghost big" data-act="runClose">${t('Sluiten')}</button></div></div>`;
}

// ---------- acties ----------
const actions = {
  edLang: (a) => { editLang = a.dataset.v; $('#edBody').innerHTML = taskEditorHTML(); },
  langMenu: () => openSheet(`<h2>${t('🌐 Taal · Language · Bahasa')}</h2><div class="stack">${Object.entries(LANGS).map(([k, v]) => `<button class="btn big ${k === getLang() ? 'primary' : ''}" data-act="setLang" data-v="${k}">${v.flag} ${v.name}</button>`).join('')}</div>`),
  setLang: (a) => { const L = a.dataset.v; if (L === getLang()) return closeSheet(); state.settings.lang = L; save(); setLang(L); location.reload(); },
  closeSheet, back: () => go(view.tab),
  install: async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; render(); },
  hideInstall: () => { state.settings.hideInstall = true; save(); render(); },
  showInstall: () => { state.settings.hideInstall = false; save(); go('routes'); },
  newRoute: () => {
    const r = { id: 'r-' + rid(), name: t('Nieuwe route'), description: '', assignee: '', createdAt: Date.now(), updatedAt: Date.now(), steps: [] };
    state.routes.push(r); save(); go('routes', { routeId: r.id });
  },
  openRoute: (a) => (isCrew() ? crewRouteSheet(route(a.dataset.id)) : go('routes', { routeId: a.dataset.id })),
  dupRoute: (a) => {
    const r = clone(route(a.dataset.id)); r.id = 'r-' + rid(); r.name += ' (kopie)'; r.steps.forEach((s) => (s.id = rid())); r.sentLog = [];
    state.routes.push(r); save(); go('routes', { routeId: r.id }); toast(t('Route gedupliceerd'));
  },
  delRoute: (a) => { if (!confirm(t('Route verwijderen?'))) return; state.routes = state.routes.filter((r) => r.id !== a.dataset.id); save(); go('routes'); },
  addStep: () => {
    const r = route(view.routeId); const prev = r.steps[r.steps.length - 1];
    openTaskEditor({ id: rid(), locationId: prev?.locationId || '', title: '', instruction: '', fields: [] }, { isNew: true });
  },
  editStep: (a) => openTaskEditor(route(view.routeId).steps.find((s) => s.id === a.dataset.id), {}),
  stepMove: (a) => {
    const r = route(view.routeId); const i = r.steps.findIndex((s) => s.id === a.dataset.id); const j = i + +a.dataset.d;
    if (j < 0 || j >= r.steps.length) return;
    [r.steps[i], r.steps[j]] = [r.steps[j], r.steps[i]]; touch(r); render();
  },
  stepMenu: (a) => openSheet(`<h2>${t('Taak')}</h2><div class="stack"><button class="btn" data-act="editStep" data-id="${a.dataset.id}">${t('✎ Bewerken')}</button><button class="btn" data-act="dupStep" data-id="${a.dataset.id}">${t('⧉ Dupliceren')}</button><button class="btn" data-act="libStep" data-id="${a.dataset.id}">${t('⭐ Opslaan in takenbibliotheek')}</button><button class="btn danger" data-act="delStep" data-id="${a.dataset.id}">${t('🗑 Verwijderen')}</button><button class="btn ghost" data-act="closeSheet">${t('Sluiten')}</button></div>`),
  dupStep: (a) => { const r = route(view.routeId); const i = r.steps.findIndex((s) => s.id === a.dataset.id); const c = clone(r.steps[i]); c.id = rid(); r.steps.splice(i + 1, 0, c); touch(r); closeSheet(); render(); toast(t('Taak gedupliceerd')); },
  delStep: (a) => { const r = route(view.routeId); r.steps = r.steps.filter((s) => s.id !== a.dataset.id); touch(r); closeSheet(); render(); },
  libStep: (a) => { const s = clone(route(view.routeId).steps.find((x) => x.id === a.dataset.id)); s.id = rid(); state.library.push(s); save(); closeSheet(); toast(t('Opgeslagen in bibliotheek')); },
  addFromLib: () => openSheet(`<h2>${t('Takenbibliotheek')}</h2><ul class="locs">${state.library.map((tk) => `<li data-act="pickLib" data-id="${tk.id}"><span>${esc(tx(tk, 'title'))}</span><small>📍 ${esc(tx(loc(tk.locationId), 'name') || '?')}</small></li>`).join('')}</ul><button class="btn ghost" data-act="closeSheet">${t('Sluiten')}</button>`),
  pickLib: (a) => { const tk = clone(state.library.find((x) => x.id === a.dataset.id)); tk.id = rid(); tk.fields.forEach((f) => (f.id = rid())); const r = route(view.routeId); r.steps.push(tk); touch(r); closeSheet(); render(); toast(t('Taak toegevoegd')); },
  addField: (a) => { draft.fields.push({ id: rid(), label: a.dataset.type === 'text' ? t('Opmerking') : '', type: a.dataset.type, ...(a.dataset.type === 'choice' ? { options: [t('Goed'), t('Matig'), t('Slecht')] } : {}) }); $('#fieldsBox').innerHTML = fieldsEditorHTML(); $$('#fieldsBox [data-k="label"]').pop()?.focus(); },
  delField: (a) => { draft.fields.splice(+a.dataset.i, 1); $('#fieldsBox').innerHTML = fieldsEditorHTML(); },
  saveStep: saveDraft,
  autoOrder: () => { const r = route(view.routeId); r.steps = orderSteps(r.steps, state, $('#strategy').value); touch(r); render(); toast(t('Nieuwe volgorde voorgesteld')); },
  routeMapView: (a) => { view.mapMode = a.dataset.v; render(); },
  shareRoute: (a) => openShare(route(a.dataset.id)),
  shLink: async () => {
    const text = $('#shText').value, url = sheetCtx.link;
    if (navigator.share) { try { await navigator.share({ title: t('Route ') + sheetCtx.route.name, text, url }); logSend('link'); toast(t('Gedeeld')); return; } catch (e) { if (e.name === 'AbortError') return; } }
    await copyText(text + '\n' + url); logSend('link');
  },
  shFile: async () => {
    const r = sheetCtx.route;
    const res = await shareFile(`route-${slug(r.name)}.json`, JSON.stringify(routePackage(state, r, sheetCtx.to), null, 2), 'application/json', t('Route ') + r.name, $('#shText').value);
    if (res !== 'cancel') logSend('bestand');
  },
  shCopy: async () => { await copyText($('#shText').value + '\n' + sheetCtx.link); logSend('kopie'); },
  shLog: (a) => { logSend(a.dataset.via); return 'default'; },
  doImport: (a) => {
    const pkg = sheetCtx.pkg;
    if (pkg.notify?.topic && $('#adoptTopic')?.checked) { state.settings.ntfyTopic = pkg.notify.topic; state.settings.ntfyServer = pkg.notify.server || 'https://ntfy.sh'; state.settings.ntfyTopicAuto = false; save(); }
    const r = importPackage(pkg, !!a.dataset.copy); closeSheet(); toast(t('Route geïmporteerd ✔')); go('routes', isCrew() ? {} : { routeId: r.id }); },
  importFile: () => $('#fileImport').click(),
  startRun: (a) => startRun(a.dataset.id),
  resumeRun: () => openRun(),
  abortRun: () => { if (!confirm(t('Lopende ronde afbreken? Ingevoerde gegevens gaan verloren.'))) return; state.activeRun = null; save(); render(); },
  runPause: () => { closeRun(); toast(t('Ronde gepauzeerd – ga verder via Routes')); },
  runClose: () => { closeRun(); },
  runMapToggle: () => { const ar = state.activeRun; if (!ar) return; ar.mapView = ar.mapView === 'top' ? 'side' : 'top'; save(); const s = ar.route.steps[ar.idx]; $('.run-map').innerHTML = runMap(ar, curLoc(ar, s)); },
  runPick: (a) => {
    const ar = state.activeRun; const s = ar.route.steps[ar.idx];
    const v = JSON.parse(a.dataset.val);
    const vals = (ar.values[s.id] ??= {});
    vals[a.dataset.fid] = vals[a.dataset.fid] === v ? undefined : v; save();
    $$(`[data-fid="${a.dataset.fid}"] .cbtn`, $('#run')).forEach((b) => b.classList.toggle('on', JSON.parse(b.dataset.val) === vals[a.dataset.fid]));
  },
  runDone: () => {
    const ar = state.activeRun; const s = ar.route.steps[ar.idx]; const vals = (ar.values[s.id] ??= {});
    for (const f of s.fields || []) if (f.role === 'mDone') vals[f.id] = true; // één tik: OK = uitgevoerd
    const missing = (s.fields || []).filter((f) => f.role !== 'mDone' && f.required && (vals[f.id] === undefined || vals[f.id] === ''));
    $$('.fld', $('#run')).forEach((el) => el.classList.toggle('missing', missing.some((f) => f.id === el.dataset.fid)));
    if (missing.length) { toast(t('Vul eerst in: ') + missing.map((f) => tx(f, 'label')).join(', ')); if (navigator.vibrate) navigator.vibrate([40, 40, 40]); return; }
    if ((s.fields || []).some((f) => isOOR(f, vals[f.id]))) toast(t('Let op: waarde buiten bereik vastgelegd'), 3500);
    recordStep('done');
  },
  runSkip: () => recordStep('skipped'),
  runPrev: () => { const ar = state.activeRun; if (ar.idx === 0) return; ar.idx--; const s = ar.route.steps[ar.idx]; ar.results = ar.results.filter((x) => x.stepId !== s.id); save(); renderRun(); },
  runProblem: () => openCompose('nietok'),
  runProblemOld: () => openSheet(`<h2>${t('Probleem melden')}</h2><p class="muted">${t('Wat is er aan de hand? Dit komt in het rapport.')}</p><textarea id="probNote" rows="4" placeholder="${t('Bijv. lekkage bij pakkingbus, oliepeil te laag')}"></textarea><div class="row sticky"><button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button><button class="btn warn" data-act="saveProblem">${t('Opslaan & verder')}</button></div>`),
  saveProblem: () => { const n = $('#probNote').value.trim(); if (!n) return toast(t('Beschrijf kort het probleem')); closeSheet(); recordStep('problem', n); },
  openRun: (a) => go('historie', { runId: a.dataset.id }),
  delRun: (a) => { if (!confirm(t('Ronde uit historie verwijderen?'))) return; state.runs = state.runs.filter((x) => x.id !== a.dataset.id); save(); go('historie'); },
  exportRun: (a) => { const run = state.runs.find((x) => x.id === a.dataset.id); exportRuns([run], a.dataset.f, 'ronde-' + slug(run.routeName)); },
  exportAll: (a) => exportRuns(state.runs, a.dataset.f, 'rondes-' + slug(state.shipName)),
  shareSummary: async (a) => {
    const text = runSummary(state.runs.find((x) => x.id === a.dataset.id));
    if (navigator.share) { try { await navigator.share({ title: t('Rapport ronde'), text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    copyText(text);
  },
  // kaart
  mapMode: (a) => { view.mapMode = a.dataset.v; render(); },
  mapLoc: (a) => {
    const l = loc(a.dataset.id); if (!l || view.placing) return;
    if (view.tab === 'kaart') { view.selLoc = l.id; render(); }
    const used = state.routes.flatMap((r) => r.steps.filter((s) => s.locationId === l.id).map((s) => `${esc(tx(r, 'name'))}: ${esc(tx(s, 'title'))}`));
    openSheet(`<h2>📍 ${esc(tx(l, 'name'))}</h2><p class="muted">${esc(deckName(l.deck))}</p>${l.note ? `<p>${esc(l.note)}</p>` : ''}<h3 class="sec">${t('Taken hier (')}${used.length})</h3><ul class="plain">${used.map((u) => `<li>${u}</li>`).join('') || `<li class="muted">${t('Geen')}</li>`}</ul><div class="stack"><button class="btn" data-act="placeLoc" data-id="${l.id}">${t('Verplaatsen op kaart')}</button><button class="btn" data-act="editLoc" data-id="${l.id}">${t('✎ Bewerken')}</button><button class="btn ghost" data-act="closeSheet">${t('Sluiten')}</button></div>`);
  },
  placeLoc: (a) => { closeSheet(); go('kaart', { placing: a.dataset.id, mapMode: view.mapMode }); },
  stopPlacing: () => { view.placing = null; render(); },
  uploadPlan: () => openSheet(`<h2>${t('Eigen plattegrond')}</h2><p class="muted">${t('Upload een foto of tekening van een dek (bijv. een dekplan of tankplan). Daarna kun je locaties erop plaatsen door te tikken.')}</p><label>${t('Voor gebied/dek')}${deckSelect(state.decks[0]?.id, 'id="planDeck"')}</label><div class="stack"><button class="btn primary big" data-act="pickPlanImage">${t('Afbeelding kiezen')}</button><button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button></div>`),
  pickPlanImage: () => { sheetCtx = { planDeck: $('#planDeck').value }; $('#fileImage').click(); },
  delPlan: async (a) => { if (!confirm(t('Plattegrond verwijderen?'))) return; await delPlan(a.dataset.deck); view.mapMode = 'side'; render(); },
  // locaties & dekken
  addLoc: (a) => editLocSheet({ id: '', name: '', deck: a.dataset.deck, x: 50, z: 40, w: 0, note: '' }),
  editLoc: (a) => editLocSheet(loc(a.dataset.id)),
  saveLoc: () => {
    const name = $('#lName').value.trim(); if (!name) return toast(t('Naam is verplicht'));
    let l = loc(sheetCtx.id);
    if (!l) { l = { id: 'l-' + rid(), x: 50, z: 40, w: 0 }; state.locations.push(l); }
    if (l.name) setTx(l, 'name', name); else l.name = name; l.deck = $('#lDeck').value; l.note = $('#lNote').value.trim();
    save(); closeSheet(); render();
  },
  delLoc: () => {
    const id = sheetCtx.id;
    const n = state.routes.reduce((k, r) => k + r.steps.filter((s) => s.locationId === id).length, 0);
    if (!confirm(n ? t('Deze locatie wordt in {n} taken gebruikt. Toch verwijderen?', { n }) : t('Locatie verwijderen?'))) return;
    state.locations = state.locations.filter((l) => l.id !== id); save(); closeSheet(); render();
  },
  addDeck: () => { const name = prompt(t('Naam van het gebied/dek (bijv. Tankdek)')); if (!name?.trim()) return; state.decks.push({ id: 'd-' + rid(), name: name.trim() }); save(); render(); },
  editDeck: (a) => {
    const d = deck(a.dataset.id);
    const name = prompt(t('Nieuwe naam (leeg laten en OK = verwijderen als het leeg is)'), tx(d, 'name'));
    if (name === null) return;
    if (!name.trim()) {
      if (state.locations.some((l) => l.deck === d.id)) return toast(t('Verplaats of verwijder eerst de locaties'));
      state.decks = state.decks.filter((x) => x.id !== d.id);
    } else setTx(d, 'name', name.trim());
    save(); render();
  },
  deckMove: (a) => { const i = state.decks.findIndex((d) => d.id === a.dataset.id); const j = i + +a.dataset.d; [state.decks[i], state.decks[j]] = [state.decks[j], state.decks[i]]; save(); render(); },
  // personen
  editContact: (a) => {
    const c = state.contacts.find((x) => x.id === a.dataset.id) || { id: '', name: '', phone: '', email: '' };
    openSheet(`<h2>${c.id ? t('Persoon bewerken') : t('Nieuwe persoon')}</h2><label>${t('Naam')}<input id="cName" value="${esc(tx(c, 'name'))}"></label><label>${t('Telefoon (WhatsApp)')}<input id="cPhone" type="tel" value="${esc(c.phone)}" placeholder="+31 6…"></label><label>${t('E-mail')}<input id="cEmail" type="email" value="${esc(c.email)}"></label><label>${t('Functie (optioneel)')}<input id="cFunc" list="rankList" value="${esc(c.func || '')}" placeholder="${t('Bijv. 2nd Officer')}" autocapitalize="words"><datalist id="rankList">${MT.rankNames().map((r) => `<option value="${esc(r)}">`).join('')}</datalist></label><p class="muted small">${t('Met een functie stelt de app deze persoon voor bij routes voor die functie.')}</p><div class="row sticky">${c.id ? `<button class="btn danger" data-act="delContact">${t('Verwijderen')}</button>` : ''}<button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button><button class="btn primary" data-act="saveContact">${t('Opslaan')}</button></div>`, { id: c.id });
  },
  saveContact: () => {
    const name = $('#cName').value.trim(); if (!name) return toast(t('Naam is verplicht'));
    let c = state.contacts.find((x) => x.id === sheetCtx.id);
    if (!c) { c = { id: 'c-' + rid() }; state.contacts.push(c); }
    Object.assign(c, { name, phone: $('#cPhone').value.trim(), email: $('#cEmail').value.trim(), func: $('#cFunc').value.trim() }); save(); closeSheet(); render();
  },
  delContact: () => { state.contacts = state.contacts.filter((c) => c.id !== sheetCtx.id); save(); closeSheet(); render(); },
  backup: async () => {
    const planImages = {}; for (const d of state.plans) planImages[d] = await getPlan(d);
    await shareFile(`schiproute-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'schiproute', kind: 'backup', v: 1, at: new Date().toISOString(), data: { ...state, planImages } }), 'application/json', 'Back-up Schip Route', '');
  },
  reset: () => { if (!confirm(t('Alle gegevens wissen en demo-gegevens terugzetten?'))) return; const keepM = state.maint; resetAll(); if (keepM) state.maint = keepM; go('routes'); toast(t('Demo-gegevens hersteld')); },
};
function editLocSheet(l) {
  openSheet(`<h2>${l.id ? t('Locatie bewerken') : t('Nieuwe locatie')}</h2><label>${t('Naam')}<input id="lName" value="${esc(tx(l, 'name'))}"></label><label>${t('Gebied / dek')}${deckSelect(l.deck, 'id="lDeck"')}</label><label>${t('Notitie (optioneel)')}<textarea id="lNote" rows="2">${esc(l.note || '')}</textarea></label>
    <div class="row sticky">${l.id ? `<button class="btn danger" data-act="delLoc">${t('Verwijderen')}</button>` : ''}<button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button><button class="btn primary" data-act="saveLoc">${t('Opslaan')}</button></div>${l.id ? `<button class="btn ghost small" data-act="placeLoc" data-id="${l.id}">${t('Plaats op kaart')}</button>` : ''}`, { id: l.id });
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  // plaatsen op kaart
  if (view.placing && !$('#run').contains(e.target)) {
    const svg = e.target.closest('#shipmap svg');
    const img = e.target.closest('#plan');
    const l = loc(view.placing);
    if (svg && l) { Object.assign(l, svgPointToLoc(svg, e)); save(); render(); toast(t('{name} geplaatst', { name: tx(l, 'name') })); return; }
    if (img && l) {
      const r = $('#planImg').getBoundingClientRect();
      l.pp = { deck: img.dataset.deck, x: Math.round(((e.clientX - r.left) / r.width) * 1000) / 10, y: Math.round(((e.clientY - r.top) / r.height) * 1000) / 10 };
      save(); render(); toast(t('{name} geplaatst op plattegrond', { name: tx(l, 'name') })); return;
    }
  }
  const a = e.target.closest('[data-act]');
  if (a && actions[a.dataset.act]) {
    if (a.tagName === 'A' && a.getAttribute('href') && a.getAttribute('href') !== '#') { actions[a.dataset.act](a, e); return; }
    e.preventDefault(); actions[a.dataset.act](a, e); return;
  }
  const nb = e.target.closest('#nav button');
  if (nb) go(nb.dataset.tab);
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.rf) { const r = route(view.routeId); if (el.dataset.rf === 'assignee') r.assignee = el.value; else setTx(r, el.dataset.rf, el.value); touch(r); return; }
  if (el.dataset.rv) {
    const ar = state.activeRun; const s = ar.route.steps[ar.idx];
    (ar.values[s.id] ??= {})[el.dataset.rv] = el.type === 'number' ? (el.value === '' ? '' : +el.value) : el.value; save();
    const f = s.fields.find((x) => x.id === el.dataset.rv);
    el.closest('.fld').classList.toggle('oor', isOOR(f, ar.values[s.id][f.id]));
    el.closest('.fld').classList.remove('missing');
    return;
  }
  if (draft && el.dataset.tf) {
    if (el.dataset.tf === 'title' || el.dataset.tf === 'instruction') setTx(draft, el.dataset.tf, el.value, editLang);
    else draft[el.dataset.tf] = el.value;
    if (el.dataset.tf === 'locationId') {
      $('#newLocBox').hidden = el.value !== '__new';
      const l = loc(el.value);
      $('#edMap').innerHTML = l ? shipSVG({ view: view.mapMode === 'top' ? 'top' : 'side', locations: state.locations, highlight: l.id, dim: true }) : '';
    }
    return;
  }
  if (draft && el.dataset.nl) { (draft._newLoc ??= { deck: state.decks[0]?.id })[el.dataset.nl] = el.value; return; }
  if (draft && el.dataset.fi) {
    const f = draft.fields[+el.dataset.fi], k = el.dataset.k;
    if (k === 'label') setTx(f, 'label', el.value, editLang);
    else f[k] = el.type === 'checkbox' ? el.checked : k === 'options' ? el.value.split(',').map((x) => x.trim()) : el.value;
    if (k === 'type') $('#fieldsBox').innerHTML = fieldsEditorHTML();
    return;
  }
  if (el.id === 'shTo' || el.id === 'shName' || el.id === 'shPhone' || el.id === 'shEmail') { sheetCtx?.update?.(); return; }
  if (el.dataset.set) { state.settings[el.dataset.set] = el.checked; save(); applyTheme(); return; }
  if (el.dataset.setSel) { state.settings[el.dataset.setSel] = el.value; if (el.dataset.setSel === 'myRank') state.settings.rankSel = [el.value]; save(); applyTheme(); return; }
  if (el.dataset.ntfy) {
    const k = el.dataset.ntfy;
    state.settings[k] = k === 'ntfyTopic' ? el.value.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : el.value.trim();
    if (k === 'ntfyTopic') state.settings.ntfyTopicAuto = false;
    save(); return;
  }
  if (el.id === 'cText' && compose) { compose.text = el.value; return; }
  if (el.id === 'cLoc' && compose) { compose.locId = el.value; return; }
  if (el.dataset.setText) { state.settings[el.dataset.setText] = el.value; save(); return; }
  if (el.hasAttribute('data-ship')) { state.shipName = el.value; save(); return; }
  if (el.id === 'mapRoute') { view.mapRoute = el.value; render(); return; }
  if (el.id === 'ofPerson' || el.id === 'ofFunc') { OF[el.id === 'ofPerson' ? 'person' : 'func'] = el.value; render(); return; }
  if ((el.id === 'repPaste' || el.id === 'pasteBox') && /(route|report)=[A-Za-z0-9_-]{20,}|^\s*\{[\s\S]*\}\s*$/.test(el.value)) { const v = el.value; handlePasted(v).then((ok) => { if (ok && $('#' + el.id)) $('#' + el.id).value = ''; }); return; }
  if (el.id === 'placeSel') { view.placing = el.value || null; render(); return; }
});
$('#fileImport').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) handleImportText(await f.text()); });
$('#fileImage').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const d = sheetCtx?.planDeck || state.decks[0].id;
  const bmp = await createImageBitmap(f);
  const sc = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  await setPlan(d, c.toDataURL('image/jpeg', 0.85));
  closeSheet(); go('kaart', { mapMode: `plan:${d}` }); toast(t('Plattegrond opgeslagen – kies een locatie en tik om te plaatsen'));
});
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; if (view.tab === 'routes' && !view.routeId) render(); });
addEventListener('online', () => $$('.net').forEach((n) => { n.className = 'net on'; n.textContent = 'online'; }));
addEventListener('offline', () => $$('.net').forEach((n) => { n.className = 'net off'; n.textContent = 'offline'; }));
addEventListener('hashchange', checkHash);
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.activeRun && !$('#run').hidden && state.settings.wakeLock && 'wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* */ }
  }
});
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

async function checkHash() {
  try {
    const raw = location.href;
    const pkg = await readHashPayload();
    if (!pkg) return;
    history.replaceState(null, '', location.pathname + location.search);
    // iPhone: een link uit WhatsApp opent in Safari, niet in de app op het beginscherm (eigen opslag!)
    if (isIOS() && !isStandalone() && !state.settings.iosUseSafari) return iosLinkSheet(pkg, raw);
    if (pkg.kind === 'route') importSheet(pkg); else if (pkg.kind === 'report') autoImportReport(pkg, 'link');
  } catch (e) { console.warn(e); toast(t('Kon de gedeelde route niet lezen') + (typeof DecompressionStream === 'undefined' ? ' – ' + t('deze browser is te oud (iOS 16.4+ nodig)') : '')); }
}
function iosLinkSheet(pkg, link) {
  const isR = pkg.kind === 'route';
  openSheet(`<h2>${isR ? t('📲 Route ontvangen') : t('📨 Rapport ontvangen')}</h2><p><b>${esc(isR ? tx(pkg.route, 'name') : pkg.routeName)}</b>${isR ? ' · ' + plural(pkg.route.steps.length, t('taak'), t('taken')) : ' · ' + t('door {name}', { name: esc(pkg.by || '?') })}</p>
    <p class="infobox">${t('Op de iPhone opent een link altijd in Safari. De app op je beginscherm heeft een eigen opslag, dus zet hem daar zo over:')}</p>
    <ol class="iossteps"><li><span class="ico">1</span><div><b>${isR ? t('Tik op "📋 Kopieer route"') : t('Tik op "📋 Kopieer rapport"')}</b></div></li><li><span class="ico">2</span><div><b>${t('Open Schip Route vanaf je beginscherm')}</b><small>${t('Nog niet geïnstalleerd? Zie "Op beginscherm zetten" hieronder.')}</small></div></li><li><span class="ico">3</span><div><b>${isR ? t('Tik op "📋 Route plakken"') : t('Historie → Door anderen → "📋 Plakken"')}</b><small>${t('iOS vraagt of plakken mag: tik op "Sta plakken toe" / "Plak".')}</small></div></li></ol>
    <div class="stack"><button class="btn primary big" data-act="iosCopyLink">${isR ? t('📋 Kopieer route') : t('📋 Kopieer rapport')}</button><button class="btn" data-act="iosInstall">${t('📲 Op beginscherm zetten (uitleg)')}</button><button class="btn ghost" data-act="iosUseHere">${t('Toch hier in Safari gebruiken')}</button></div>
    <p class="muted small">${t('Tip: deel de route liever als bestand (.json). Dat bewaar je in Bestanden en open je in de app met "📥 Route-bestand importeren".')}</p>`, { iosLink: { pkg, link } });
}
/** Route of rapport uit geplakte tekst (link of JSON). Geeft true als het iets herkende. */
async function handlePasted(text, via = 'paste') {
  const s0 = String(text || '').trim(); if (!s0) return false;
  try {
    if (s0.startsWith('{')) { await handleImportText(s0, via); return true; }
    if (/(route|report)=/.test(s0)) {
      const pkg = await readHashPayload(s0);
      if (pkg?.kind === 'route') { importSheet(pkg); return true; }
      if (pkg?.kind === 'report') { autoImportReport(pkg, via); return true; }
    }
  } catch (e) { console.warn(e); toast(t('Geen geldige route of rapport gevonden')); return true; }
  return false;
}
function pasteSheet() {
  openSheet(`<h2>${t('📋 Route of rapport plakken')}</h2><p class="muted">${t('Houd je vinger in het vak hieronder en kies "Plak". De route (of het rapport) wordt dan meteen gelezen.')}</p><textarea id="pasteBox" rows="4" placeholder="https://…#route=…"></textarea><div class="stack"><button class="btn primary" data-act="pasteRead">${t('Lezen')}</button><button class="btn ghost" data-act="importFile">${t('📄 Bestand kiezen')}</button></div>`, { paste: true });
  setTimeout(() => $('#pasteBox')?.focus(), 50);
}

// ---------- vragen, observaties & outbox ----------
const inRun = () => state.activeRun && !$('#run').hidden;
async function toJpeg(file, max = 1280, q = 0.8) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); });
  }
  const w = src.width, h = src.height, sc = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', q));
}
function composeHTML() {
  const c = compose, ar = state.activeRun;
  const step = c.inRun ? ar.route.steps[ar.idx] : null;
  const topic = c.inRun && ar.route.notifyTopic ? ar.route.notifyTopic : state.settings.ntfyTopic;
  let h = c.kind === 'nietok'
    ? `<h2>✖ ${t('Niet OK')}</h2><p class="muted">${t('Bij taak:')} <b>${esc(tx(step, 'title'))}</b> · ${esc(step ? tx(curLoc(ar, step), 'name') : '')}</p><label>${t('Wat is er niet in orde?')}<textarea id="cText" rows="3" placeholder="${t('Bijv. lekkage bij pakkingbus, oliepeil te laag')}">${esc(c.text)}</textarea></label>`
    : c.kind === 'vraag'
    ? `<h2>${t('❓ Hulp / vraag')}</h2><p class="muted">${t('Bij taak:')} <b>${esc(tx(step, 'title'))}</b> · ${esc(step ? tx(curLoc(ar, step), 'name') : '')}</p><label>${t('Je vraag')}<textarea id="cText" rows="4" placeholder="${t('Waar loop je tegenaan?')}">${esc(c.text)}</textarea></label>`
    : `<h2>${t('👁 Extra observatie')}</h2><label>${t('Wat zag je?')}<textarea id="cText" rows="4" placeholder="${t('Bijv. druppelende leiding bij …')}">${esc(c.text)}</textarea></label>
       <label>${t('Waar? (optioneel)')}${locSelect(c.locId, 'id="cLoc"', true)}</label>
       <div class="flbl">${t('Prioriteit')}</div><div class="seg prio"><button class="${c.urgent ? '' : 'on'}" data-act="cPrio" data-v="0">${t('Normaal')}</button><button class="${c.urgent ? 'on urgent' : ''}" data-act="cPrio" data-v="1">${t('⚠ Urgent')}</button></div>`;
  h += `<div class="flbl">${t('Foto\'s')}</div><div class="thumbs" id="thumbs">${thumbsHTML()}</div>
    <div class="row"><button class="btn" data-act="cCam">${t('📷 Foto maken')}</button><button class="btn" data-act="cGal">${t('🖼 Uit galerij')}</button></div>
    ${c.kind === 'nietok' ? `<label class="switch"><input type="checkbox" id="cNotify" ${c.notify ? 'checked' : ''} ${topic ? '' : 'disabled'}><span>${t('Als melding (met foto) naar de beheerder sturen')}</span></label>` : ''}
    ${topic ? '' : `<p class="warnbox">${t('Er is nog geen meldingskanaal ingesteld (Meer → Meldingen). Het bericht wordt wel bewaard.')}</p>`}
    <p class="muted small">${navigator.onLine ? t('Wordt direct verstuurd.') : t('📴 Geen internet: wordt bewaard en automatisch verstuurd zodra er verbinding is.')}</p>
    <div class="row sticky"><button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button><button class="btn ${c.kind === 'nietok' ? 'bad' : 'primary'}" data-act="cSend">${c.kind === 'nietok' ? t('Opslaan & verder') : navigator.onLine ? t('Versturen') : t('Opslaan & later versturen')}</button></div>`;
  return h;
}
const thumbsHTML = () => compose.photos.map((p, i) => `<div class="thumb"><img src="${p.url}" alt="Foto ${i + 1}"><button data-act="cDelPhoto" data-i="${i}" aria-label="${t('Foto verwijderen')}">✕</button></div>`).join('') || `<p class="muted small">${t('Nog geen foto\'s.')}</p>`;
function openCompose(kind) {
  const ar = state.activeRun, run = inRun();
  const step = run ? ar.route.steps[ar.idx] : null;
  const prevCompose = null;
  openSheet('', {});
  compose = prevCompose || { kind, text: '', photos: [], urgent: kind === 'nietok', inRun: run, locId: step?.locationId || '', notify: kind === 'nietok' && (isCrew() || !!ar?.route.notifyTopic) };
  $('.sheet-card').insertAdjacentHTML('beforeend', composeHTML());
  setTimeout(() => $('#cText')?.focus(), 50);
}
async function addPhotos(files) {
  if (!compose) return;
  for (const f of files) {
    try { const blob = await toJpeg(f); if (blob) compose.photos.push({ blob, url: URL.createObjectURL(blob), name: `foto-${compose.photos.length + 1}.jpg` }); }
    catch (e) { toast(t('Foto kon niet worden gelezen')); }
  }
  const tb = $('#thumbs'); if (tb) tb.innerHTML = thumbsHTML();
}
/* i18n-skip-start */
function buildItem(c) {
  const st = state.settings, ar = state.activeRun, name = st.userName || 'bemanning';
  const step = c.inRun ? ar.route.steps[ar.idx] : null;
  const locName = c.kind === 'vraag' || c.kind === 'nietok' ? (step ? curLoc(ar, step).name : '') : (loc(c.locId)?.name || '');
  const now = new Date();
  const title = c.kind === 'nietok' ? `✖ Niet OK: ${step?.title || ''} – ${name}${locName ? ' (' + locName + ')' : ''}` : c.kind === 'vraag' ? `Vraag van ${name}${locName ? ' – ' + locName : ''}` : c.kind === 'test' ? `Testmelding – ${state.shipName}` : `${c.urgent ? 'URGENT: ' : ''}Observatie van ${name}${locName ? ' – ' + locName : ''}`;
  const lines = c.kind === 'test' ? [`Het werkt! Meldingen van Schip Route komen op dit kanaal binnen.`, '', `👤 ${name}`, `🕒 ${fmtDT(now.toISOString())}`] : [
    c.text, '',
    locName ? `📍 Locatie: ${locName}` : '',
    step ? `🧭 Route: ${ar.route.name} (stap ${ar.idx + 1}/${ar.route.steps.length})` : '',
    step ? `🔧 Taak: ${step.title || tx(step, 'title')}` : '',
    `🕒 ${fmtDT(now.toISOString())}`, `👤 ${name}`, `🚢 ${state.shipName}`, getLang() !== 'nl' ? `🌐 Taal bemanning: ${LANGS[getLang()].name}` : '',
    c.photos.length ? `📷 ${c.photos.length} foto${c.photos.length > 1 ? "'s" : ''} volgen` : '',
  ];
  const topic = (c.inRun && ar.route.notifyTopic) || st.ntfyTopic;
  const server = (c.inRun && ar.route.notifyTopic && ar.route.notifyServer) || st.ntfyServer || 'https://ntfy.sh';
  return {
    id: 'm-' + rid(), kind: c.kind, createdAt: now.toISOString(), by: name, text: c.text, locName,
    routeName: step ? ar.route.name : '', taskTitle: step?.title || '', urgent: !!c.urgent,
    title, message: lines.filter((x, i) => x !== '' || i === 1).join('\n').trim(),
    priority: c.kind === 'vraag' || c.kind === 'nietok' ? 4 : c.urgent ? 5 : 3,
    tags: c.kind === 'nietok' ? ['x', 'warning'] : c.kind === 'vraag' ? ['question', 'ship'] : c.kind === 'test' ? ['bell', 'white_check_mark'] : c.urgent ? ['rotating_light', 'eyes'] : ['eyes'],
    topic, server, status: 'pending', photos: c.photos.map((p, i) => ({ name: `foto-${i + 1}.jpg`, blob: p.blob })),
  };
}
/* i18n-skip-end */
async function queueItem(item) {
  // Foto's/bijlagen als ArrayBuffer bewaren: Safari (iOS) kan Blobs in IndexedDB niet altijd opslaan (o.a. privé-modus).
  for (const ph of item.photos || []) if (ph.blob) { ph.type = ph.blob.type; ph.buf = await ph.blob.arrayBuffer(); delete ph.blob; }
  try { await OB.put(item); } catch (e) { console.warn('outbox', e); toast(t('Opslaan in de outbox lukte niet: {msg}', { msg: e?.name || e?.message || '?' }), 5000); return; }
  await refreshOutbox();
  try { const reg = await navigator.serviceWorker?.ready; await reg?.sync?.register('outbox'); } catch { /* geen Background Sync */ }
  if (navigator.onLine) return flushNow(false, item.id);
  toast(t('📴 Bewaard in outbox – wordt verstuurd zodra er internet is'), 3500);
}
async function flushNow(manual = false, justId = null) {
  if (!navigator.onLine) { if (manual) toast(t('Geen internet – berichten blijven in de outbox')); return; }
  const r = await OB.flush();
  await refreshOutbox();
  if (r.sent) toast('✔ ' + t('{n} verzonden', { n: plural(r.sent, t('bericht'), t('berichten')) }));
  else if (r.failed && (manual || justId)) toast(t('Versturen lukte niet – wordt later opnieuw geprobeerd'), 3500);
}
async function refreshOutbox() {
  let xs = [];
  try { xs = await OB.all(); } catch { /* */ }
  const pend = xs.filter((x) => x.status !== 'sent');
  outboxPending = pend.length; outboxErr = pend.some((x) => x.lastError);
  $$('.obx').forEach((b) => { b.hidden = !outboxPending; b.textContent = `📤 ${outboxPending}`; b.classList.toggle('err', outboxErr); });
  if (sheetCtx?.outbox) renderOutboxList(xs);
  return xs;
}
function renderOutboxList(xs) {
  const el = $('#obxList'); if (!el) return;
  el.innerHTML = [...xs].reverse().map((x) => `<li class="${x.status}"><div><b>${x.kind === 'vraag' ? '❓' : x.kind === 'test' ? '🔔' : x.urgent ? '🚨' : '👁'} ${esc(tx(x, 'title'))}</b><small>${fmtDT(x.createdAt)}${x.photos?.length ? ` · 📷 ${x.photos.length}` : ''}</small>
    <small class="st">${x.status === 'sent' ? `✔ ${t('verzonden')} ${fmtDT(x.sentAt)}` : x.lastError ? `⚠ ${t('nog niet gelukt')} (${esc(x.lastError.slice(0, 80))}) – ${t('wordt opnieuw geprobeerd')}` : t('⏳ wacht op internet')}</small>${x.text ? `<p>${esc(x.text.slice(0, 160))}</p>` : ''}</div><button class="iconbtn" data-act="obxDel" data-id="${x.id}" aria-label="${t('Verwijderen')}">🗑</button></li>`).join('') || `<li class="muted">${t('Outbox is leeg.')}</li>`;
  const pend = xs.filter((x) => x.status !== 'sent').length;
  $('#obxInfo').textContent = pend ? t('{n} wacht op verzending.', { n: pend }) : t('Alles is verzonden.');
}
Object.assign(actions, {
  newHelp: () => openCompose('vraag'),
  newObs: () => openCompose('observatie'),
  cPrio: (a) => { compose.urgent = a.dataset.v === '1'; $$('.seg.prio button').forEach((b) => { const on = (b.dataset.v === '1') === compose.urgent; b.classList.toggle('on', on); b.classList.toggle('urgent', on && compose.urgent); }); },
  cCam: () => $('#fileCam').click(),
  cGal: () => $('#fileGal').click(),
  cDelPhoto: (a) => { const [p] = compose.photos.splice(+a.dataset.i, 1); URL.revokeObjectURL(p.url); $('#thumbs').innerHTML = thumbsHTML(); },
  cSend: async () => {
    const c = compose; c.text = $('#cText').value.trim();
    if (c.kind === 'nietok') {
      if (!c.text) { $('#cText').focus(); return toast(t('Beschrijf kort wat er niet in orde is')); }
      const ar = state.activeRun; const s = ar.route.steps[ar.idx]; const vals = (ar.values[s.id] ??= {});
      for (const f of s.fields || []) { if (f.role === 'mDone') vals[f.id] = false; if (f.role === 'mRem') vals[f.id] = c.text; }
      const notify = $('#cNotify')?.checked;
      if (notify && !state.settings.userName && isCrew()) { const n = prompt(t('Wat is je naam? (komt in de melding)')); if (n?.trim()) { state.settings.userName = n.trim(); save(); } }
      const item = notify ? buildItem(c) : null;
      (ar.messages ??= []).push({ id: item?.id || 'n-' + rid(), kind: 'nietok', text: c.text, locName: tx(curLoc(ar, s), 'name'), taskTitle: s.title, urgent: false, at: new Date().toISOString(), photos: c.photos.length, sent: !!item });
      save(); closeSheet(); recordStep('problem', c.text);
      if (item) await queueItem(item);
      return;
    }
    if (!c.text && !c.photos.length) return toast(c.kind === 'vraag' ? t('Typ eerst je vraag') : t('Beschrijf wat je zag'));
    if ($('#cLoc')) c.locId = $('#cLoc').value;
    if (!state.settings.userName) { const n = prompt(t('Wat is je naam? (komt in de melding)')); if (n?.trim()) { state.settings.userName = n.trim(); save(); } }
    const item = buildItem(c);
    if (c.inRun) (state.activeRun.messages ??= []).push({ id: item.id, kind: c.kind, text: c.text, locName: item.locName, urgent: c.urgent, at: item.createdAt, photos: c.photos.length });
    else (state.observations ??= []).push({ id: item.id, kind: c.kind, text: c.text, locName: item.locName, urgent: c.urgent, at: item.createdAt, photos: c.photos.length });
    save(); closeSheet();
    await queueItem(item);
  },
  openOutbox: async () => {
    openSheet(`<h2>${t('📤 Outbox')}</h2><p class="muted" id="obxInfo"></p><p class="muted small">${navigator.onLine ? t('Online') : t('📴 Offline')} · ${t('kanaal:')} <b>${esc(state.settings.ntfyTopic || '—')}</b></p>
      <div class="row"><button class="btn primary" data-act="obxFlush">${t('Nu versturen')}</button><button class="btn ghost" data-act="obxClear">${t('Verzonden wissen')}</button></div><ul class="obxlist" id="obxList"></ul>`, { outbox: true });
    await refreshOutbox();
  },
  obxFlush: () => flushNow(true),
  obxDel: async (a) => { if (!confirm(t('Bericht uit outbox verwijderen?'))) return; await OB.del(a.dataset.id); refreshOutbox(); },
  obxClear: async () => { for (const x of await OB.all()) if (x.status === 'sent') await OB.del(x.id); refreshOutbox(); },
  copyTopic: () => copyText(state.settings.ntfyTopic || ''),
  newTopic: () => { if (!confirm(t('Nieuw kanaal maken? Je moet je dan opnieuw abonneren in de ntfy-app.'))) return; state.settings.ntfyTopic = randomTopic(); state.settings.ntfyTopicAuto = false; save(); render(); },
  testNtfy: () => queueItem(buildItem({ kind: 'test', text: '', photos: [], inRun: false })),
});
$('#fileCam').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; addPhotos(fs); });
$('#fileGal').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; addPhotos(fs); });
addEventListener('online', () => setTimeout(() => flushNow(), 800));
setInterval(() => { if (outboxPending && navigator.onLine) flushNow(); }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (outboxPending) flushNow(); maybePoll(); } });
// iPhone/Safari heeft geen Background Sync: versturen bij openen, terugkeren naar de app en focus.
addEventListener('focus', () => { if (outboxPending) flushNow(); maybePoll(); });
addEventListener('online', () => setTimeout(maybePoll, 1500));
addEventListener('pageshow', () => { if (outboxPending) flushNow(); });
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'outbox') refreshOutbox(); });


// ---------- modus: beheer / bemanning ----------
async function pinHash(pin) {
  const data = new TextEncoder().encode('schiproute:' + pin);
  if (crypto.subtle) return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('');
  let h = 0; for (const b of data) h = (h * 31 + b) >>> 0; return 'x' + h.toString(16);
}
function modeCard() {
  const st = state.settings;
  return `<section class="card"><h2>${t('👤 Modus')}</h2><div class="seg"><button class="${isCrew() ? '' : 'on'}" data-act="modeSwitch" data-v="beheer">${t('🛠 Beheer')}</button><button class="${isCrew() ? 'on' : ''}" data-act="modeSwitch" data-v="bemanning">${t('👷 Bemanning')}</button></div>
    <p class="muted small">${t('Beheer: onderhoud, routes maken en versturen, historie, rapporten. Bemanning: alleen ontvangen routes uitvoeren, vragen en observaties.')}</p>
    ${!isCrew() ? `<div class="row"><button class="btn small ghost" data-act="pinSet">${st.pinHash ? t('Pincode wijzigen') : t('Pincode instellen')}</button>${st.pinHash ? `<button class="btn small ghost" data-act="pinClear">${t('Pincode verwijderen')}</button>` : ''}</div>` : ''}</section>`;
}
function setMode(m) { state.settings.mode = m; save(); closeSheet(); if (m === 'beheer') MT.ensureMaint(); go(m === 'beheer' ? 'vandaag' : 'routes'); toast(m === 'beheer' ? t('Beheer-modus') : t('Bemanning-modus')); }
function pinSheet(kind, target) {
  const txt = { set: t('Kies een pincode (4–8 cijfers). Die is nodig om van Bemanning terug naar Beheer te gaan.'), ask: t('Voer de pincode in om naar Beheer te gaan.'), first: t('Wil je Beheer beveiligen met een pincode? Dat is optioneel; zonder pincode kan iedereen wisselen.') }[kind];
  openSheet(`<h2>🔒 ${kind === 'ask' ? t('Pincode') : t('Pincode (optioneel)')}</h2><p class="muted">${txt}</p><input id="pinIn" type="password" inputmode="numeric" autocomplete="off" maxlength="8" pattern="[0-9]*">
    <div class="row sticky">${kind === 'first' ? `<button class="btn ghost" data-act="pinSkip" data-v="${target || ''}">${t('Zonder pincode')}</button>` : `<button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button>`}<button class="btn primary" data-act="pinOk" data-kind="${kind}" data-v="${target || ''}">${kind === 'ask' ? t('Openen') : t('Opslaan')}</button></div>`, { pin: kind });
  setTimeout(() => $('#pinIn')?.focus(), 50);
}
Object.assign(actions, {
  modeSwitch: (a) => {
    const m = a.dataset.v; if ((m === 'bemanning') === isCrew()) return;
    if (m === 'beheer' && state.settings.pinHash) return pinSheet('ask', m);
    if (!state.settings.pinHash && !state.settings.pinAsked) return pinSheet('first', m);
    setMode(m);
  },
  pinSkip: (a) => { state.settings.pinAsked = true; save(); setMode(a.dataset.v); },
  pinOk: async (a) => {
    const pin = $('#pinIn').value.trim(); const kind = a.dataset.kind, m = a.dataset.v;
    if (kind === 'ask') { if (await pinHash(pin) !== state.settings.pinHash) { $('#pinIn').value = ''; if (navigator.vibrate) navigator.vibrate([60, 40, 60]); return toast(t('Onjuiste pincode')); } return setMode(m); }
    if (!/^\d{4,8}$/.test(pin)) return toast(t('Gebruik 4 tot 8 cijfers'));
    state.settings.pinHash = await pinHash(pin); state.settings.pinAsked = true; save();
    if (m) setMode(m); else { closeSheet(); render(); toast(t('Pincode ingesteld')); }
  },
  pinSet: () => pinSheet('set'),
  pinClear: () => { if (!confirm(t('Pincode verwijderen?'))) return; delete state.settings.pinHash; save(); render(); },
});

// ---------- bemanning-weergaven ----------
function viewCrewRoutes() {
  const ar = state.activeRun;
  let h = header(t('Mijn routes')) + `<p class="shipsub">🚢 ${esc(state.shipName)}${state.settings.userName ? ` · 👤 ${esc(state.settings.userName)}` : ''}</p>`;
  h += resumeCard() + installBanner() + `<div class="list">`;
  const recv = state.routes.filter((r) => r.importedAt); // alleen ontvangen routes (geen demo's)
  if (!recv.length) h += `<p class="empty">${t('Nog geen routes ontvangen. Open de link die je (bijv. via WhatsApp) kreeg, of importeer het routebestand.')}</p>`;
  for (const r of [...recv].reverse()) {
    const nLoc = new Set(r.steps.map((s) => s.locationId)).size;
    h += `<article class="card route"><div class="tap" data-act="openRoute" data-id="${r.id}"><h2>${esc(tx(r, 'name'))}</h2><p>${plural(r.steps.length, t('taak'), t('taken'))} · ${plural(nLoc, t('locatie'), t('locaties'))}${r.from ? ` · ${t('van {name}', { name: `<b>${esc(r.from)}</b>` })}` : ''}</p>${r.description ? `<p class="muted">${esc(tx(r, 'description'))}</p>` : ''}</div>
      <div class="stack"><button class="btn ok big" data-act="startRun" data-id="${r.id}" ${r.steps.length ? '' : 'disabled'}>${t('▶ Start ronde')}</button></div></article>`;
  }
  h += `</div>` + OIL.crewCard() + `<div class="row crewimp"><button class="btn small ghost" data-act="pasteRoute">${t('📋 Route plakken')}</button><button class="btn small ghost" data-act="importFile">${t('📥 Route-bestand')}</button></div>`;
  return h;
}
function crewRunsHTML() {
  const runs = [...state.runs].reverse().slice(0, 5);
  return runs.length ? `<section class="card"><h2>${t('Laatste rondes')}</h2><ul class="locs">${runs.map((run) => { const c = runStats(run); return `<li><span>${esc(run.routeName)}<small> · ${fmtDT(run.finishedAt)} · ✔ ${c.done} ↷ ${c.skipped} ⚠ ${c.problem}${run.reportSentAt ? ' · 📨 ' + t('verstuurd') : ''}</small></span><button class="btn small" data-act="sendReport" data-id="${run.id}">${run.reportSentAt ? t('Opnieuw sturen') : t('📨 Stuur rapport')}</button></li>`; }).join('')}</ul></section>` : '';
}
function crewRouteSheet(r) {
  if (!r) return;
  openSheet(`<h2>${esc(tx(r, 'name'))}</h2>${r.description ? `<p class="muted">${esc(tx(r, 'description'))}</p>` : ''}<ol class="plain">${r.steps.map((s) => `<li><b>${esc(tx(s, 'title'))}</b><br><small>📍 ${esc(tx(loc(s.locationId), 'name') || '?')}</small></li>`).join('')}</ol><div class="stack"><button class="btn ok big" data-act="startRun" data-id="${r.id}">${t('▶ Start ronde')}</button><button class="btn danger small" data-act="crewDelRoute" data-id="${r.id}">${t('Route verwijderen van dit toestel')}</button></div>`);
}
function viewCrewMore() {
  const st = state.settings;
  const tog = (k, label) => `<label class="switch"><input type="checkbox" data-set="${k}" ${st[k] ? 'checked' : ''}><span>${label}</span></label>`;
  let h = header(t('Meer'));
  h += `<section class="card"><h2>${t('🌐 Taal · Language · Bahasa')}</h2><div class="seg langseg">${Object.entries(LANGS).map(([k, v]) => `<button class="${k === getLang() ? 'on' : ''}" data-act="setLang" data-v="${k}">${v.flag} ${k.toUpperCase()}</button>`).join('')}</div></section>`;
  h += `<section class="card"><h2>${t('Instellingen')}</h2><label>${t('Mijn naam (in rapporten en meldingen)')}<input data-set-text="userName" value="${esc(st.userName || '')}"></label>
    ${tog('bigText', t('Extra grote tekst'))}${tog('vibrate', t('Trillen bij volgende stap'))}${tog('speak', t('Instructie uitspreken (spraak)'))}${tog('wakeLock', t('Scherm aan houden tijdens ronde'))}${fsToggle(tog)}</section>`;
  h += crewRunsHTML();
  h += `<section class="card"><h2>${t('📤 Outbox')}</h2><p class="muted small">${t('Vragen, observaties en rapporten gaan naar kanaal:')} <b>${esc(st.ntfyTopic || '—')}</b></p><div class="row"><button class="btn" data-act="openOutbox">${t('📤 Outbox openen')}</button><button class="btn" data-act="newObs">${t('👁 Extra observatie')}</button></div></section>`;
  h += modeCard();
  h += `<section class="card"><h2>${t('App')}</h2><p class="muted">${t('Versie')} ${APP_VERSION} ${t('· werkt offline na eerste keer openen · gegevens blijven op dit toestel.')}</p><button class="btn ghost" data-act="showInstall">${t('Installatie-uitleg')}</button></section>`;
  return h;
}

// ---------- WhatsApp per persoon (beheer, route-scherm) ----------
const waNum = (phone) => (phone || '').replace(/[^\d]/g, '').replace(/^00/, '').replace(/^0(?=6)/, '31');
function waSection(r) {
  if (!r.steps.length) return '';
  const cs = state.contacts;
  return `<section class="card wasec"><h3>${t('📲 Direct versturen via WhatsApp')}</h3><div class="wabtns">${cs.map((c) => waNum(c.phone)
    ? `<a class="btn wa" href="#" target="_blank" rel="noopener" data-wa="${c.id}" data-act="waSent" data-id="${c.id}">🟢 ${esc(tx(c, 'name'))}</a>`
    : `<button class="btn ghost small" data-act="editContact" data-id="${c.id}">${t('{name}: telefoon toevoegen', { name: esc(tx(c, 'name')) })}</button>`).join('')}<button class="btn ghost small" data-act="editContact">${t('+ Persoon')}</button></div>${r.assignee ? `<p class="muted small">${t('Bestemd voor {name}', { name: esc(r.assignee) })}${r.sentLog?.length ? ' · ' + t('laatst verstuurd {d}', { d: fmtDT(r.sentLog[r.sentLog.length - 1].at) }) : ''}</p>` : ''}</section>`;
}
async function fillWaLinks() {
  const els = $$('a[data-wa]'); if (!els.length) return;
  const r = route(view.routeId); if (!r) return;
  for (const a of els) {
    const c = state.contacts.find((x) => x.id === a.dataset.wa); if (!c) continue;
    const link = await buildShareLink(routePackage(state, r, c.name));
    const txt = t('Route "{route}" voor {name} – {n} ({ship}). Open de link om de route in de app te zetten:', { route: tx(r, 'name'), name: c.name, n: plural(r.steps.length, t('taak'), t('taken')), ship: state.shipName });
    a.href = `https://wa.me/${waNum(c.phone)}?text=${encodeURIComponent(txt + '\n' + link)}`;
  }
}
Object.assign(actions, {
  waSent: (a) => { const r = route(view.routeId); const c = state.contacts.find((x) => x.id === a.dataset.id); if (!r || !c) return; r.assignee = c.name; (r.sentLog ??= []).push({ to: c.name, at: new Date().toISOString(), via: 'whatsapp' }); save(); setTimeout(render, 300); },
  crewDelRoute: (a) => { if (!confirm(t('Route verwijderen?'))) return; state.routes = state.routes.filter((r) => r.id !== a.dataset.id); save(); closeSheet(); render(); },
});

// ---------- rapport: bemanning → beheer ----------
/* i18n-skip-start */
function reportNtfyText(run, link) {
  const c = runStats(run);
  const lines = [`✔ ${c.done} klaar · ↷ ${c.skipped} overgeslagen · ⚠ ${c.problem} ${c.problem === 1 ? 'probleem' : 'problemen'}`, `🕒 ${fmtDT(run.startedAt)} – ${fmtDT(run.finishedAt)}`, `👤 ${run.by || 'bemanning'} · 🚢 ${state.shipName}`];
  if (getLang() !== 'nl') lines.push(`🌐 Taal bemanning: ${LANGS[getLang()].name}`);
  const md = run.results.filter((x) => x.marad);
  if (md.length) lines.push('', `🔧 MARAD-taken: ${md.filter((x) => x.status === 'done').length}/${md.length} uitgevoerd`);
  for (const x of run.results) {
    const bad = x.status !== 'done' || x.outOfRange?.length || x.note;
    const nee = (x.fields || []).some((f) => f.role === 'mDone' && x.values?.[f.id] === false);
    if (!bad && !nee) continue;
    lines.push(`${x.status === 'problem' ? '⚠' : x.status === 'skipped' ? '↷' : nee ? '✖' : '❗'} ${x.titleNl || x.title} (${x.locNl || x.locName})${x.note ? ': ' + x.note : ''}`);
  }
  lines.push('', link.length < 3500 ? 'Tik op de melding of open de link om het rapport in Schip Route (beheer) te importeren.' : 'Rapport staat als bijlage (.json) bij deze melding: downloaden en importeren in Schip Route → Historie → Rapport importeren.');
  return { title: `📨 Rapport: ${run.routeName} – ${run.by || 'bemanning'}`, message: lines.join('\n').slice(0, 3800) };
}
/* i18n-skip-end */
async function sendReport(run) {
  const r = route(run.routeId);
  if (!run.by && state.settings.userName) run.by = state.settings.userName;
  if (!run.by) { const n = prompt(t('Wat is je naam? (komt in de melding)')); if (n?.trim()) { state.settings.userName = n.trim(); run.by = n.trim(); save(); } }
  const pkg = reportPackage(state, run, r);
  const link = await buildShareLink(pkg);
  const json = JSON.stringify(pkg);
  const fname = `rapport-${slug(run.routeName)}-${run.finishedAt.slice(0, 10)}.json`;
  // 1) samenvatting naar het meldingskanaal van de beheerder (via outbox, ook offline)
  const topic = run.notify?.topic || r?.notifyTopic || state.settings.ntfyTopic;
  const server = run.notify?.server || r?.notifyServer || state.settings.ntfyServer || 'https://ntfy.sh';
  if (!run.reportQueuedAt && topic) {
    const m = reportNtfyText(run, link);
    await queueItem({ id: 'm-' + rid(), kind: 'rapport', createdAt: new Date().toISOString(), by: run.by || '', text: '', title: m.title, message: m.message, priority: 3, tags: ['clipboard', 'white_check_mark'], click: link.length < 3500 ? link : undefined, topic, server, status: 'pending', photos: [{ name: fname, blob: new Blob([json], { type: 'application/json' }), title: '📎 ' + m.title, tags: 'paperclip' }] });
    run.reportQueuedAt = new Date().toISOString(); save();
  }
  // 2) zelf delen via WhatsApp / deelmenu
  const rt = run.replyTo || r?.replyTo || {};
  const to = rt.name || r?.from || '';
  const txt = t('Rapport ronde "{route}" – {name}. Open de link om het rapport te importeren:', { route: run.routeName, name: run.by || '' });
  const ph = waNum(rt.phone);
  openSheet(`<h2>${t('📨 Rapport versturen')}</h2><p><b>${esc(run.routeName)}</b> · ${fmtDT(run.finishedAt)}</p>
    <p class="${run.reportQueuedAt ? 'okbox' : 'warnbox'}">${run.reportQueuedAt ? (navigator.onLine ? t('🔔 Samenvatting gaat naar het meldingskanaal van {name}.', { name: esc(to || t('de beheerder')) }) : t('📴 Samenvatting staat in de outbox en gaat vanzelf weg zodra er internet is.')) : t('Geen meldingskanaal bekend – deel het rapport hieronder.')}</p>
    <div class="stack">${ph ? `<a class="btn ok big" href="https://wa.me/${ph}?text=${encodeURIComponent(txt + '\n' + link)}" target="_blank" rel="noopener" data-act="repSent" data-id="${run.id}">🟢 ${t('WhatsApp naar {name}', { name: esc(to || '') })}</a>` : ''}
    <button class="btn ${ph ? '' : 'primary big'}" data-act="repShare">${t('📤 Delen (WhatsApp, mail, …)')}</button><button class="btn" data-act="repFile">${t('📄 Als bestand (.json)')}</button><button class="btn ghost" data-act="repCopy">${t('🔗 Kopieer link')}</button></div>
    <p class="muted small">${t('Link: {n} tekens', { n: link.length })}</p>`, { report: { run, link, txt, json, fname } });
}
function reportSheet(pkg) {
  if (isCrew()) return toast(t('Rapporten importeren kan alleen in Beheer-modus (Meer → Modus).'), 4500);
  const exists = state.runs.some((x) => x.id === pkg.runId);
  const c = { done: 0, skipped: 0, problem: 0 }; for (const x of pkg.results) c[x.status] = (c[x.status] || 0) + 1;
  const md = pkg.results.filter((x) => x.marad).length;
  openSheet(`<h2>${t('📨 Rapport ontvangen')}</h2><p><b>${esc(pkg.routeName)}</b> · ${t('door {name}', { name: esc(pkg.by || '?') })}</p><p>${fmtDT(pkg.startedAt)} → ${fmtDT(pkg.finishedAt)}</p><p><span class="tag ok">✔ ${c.done}</span> <span class="tag">↷ ${c.skipped}</span> <span class="tag warn">⚠ ${c.problem}</span>${md ? ` <span class="tag">🔧 ${t('{n} MARAD-taken', { n: md })}</span>` : ''}</p>
    ${exists ? `<p class="warnbox">${t('Dit rapport is al geïmporteerd.')}</p>` : ''}
    <div class="stack"><button class="btn primary big" data-act="repImport" ${exists ? 'disabled' : ''}>${t('Importeren in historie')}</button><button class="btn ghost" data-act="closeSheet">${t('Annuleren')}</button></div>`, { repPkg: pkg });
}
function importReport(pkg, via = 'link') {
  const run = { id: pkg.runId, routeId: pkg.routeId, routeName: pkg.routeName, ship: pkg.ship, by: pkg.by, startedAt: pkg.startedAt, finishedAt: pkg.finishedAt, results: pkg.results, messages: pkg.messages || [], received: { at: new Date().toISOString(), lang: pkg.lang, via } };
  state.runs.push(run);
  const m = state.maint ? MT.applyRun(run) : { done: 0, missing: 0 };
  run.maradDone = m.done; run.maradApplied = !!state.maint; save();
  return m;
}
/** Rapport direct importeren (link geopend, geplakt, bestand of meldingskanaal) en de pagina "Door anderen" tonen. */
async function autoImportReport(pkg, via = 'link', quiet = false) {
  if (pkg?.oilOnly && !isCrew()) return importOilPkg(pkg, via, quiet);
  if (isCrew()) { toast(t('Rapporten importeren kan alleen in Beheer-modus (Meer → Modus).'), 4500); return false; }
  if (!pkg?.runId || !Array.isArray(pkg.results)) { if (!quiet) toast(t('Geen geldig rapport gevonden')); return false; }
  if (state.runs.some((x) => x.id === pkg.runId)) { if (!quiet) { toast(t('Dit rapport is al geïmporteerd.')); closeSheet(); go('historie', { hist: 'others' }); } return false; }
  await MT.ensureMaint();
  const m = importReport(pkg, via);
  if (!quiet) { closeSheet(); toast(m.done ? t('Rapport van {name} geïmporteerd · {n} MARAD-taken afgemeld', { name: pkg.by || '?', n: m.done }) : t('Rapport van {name} geïmporteerd', { name: pkg.by || '?' }), 4000); go('historie', { hist: 'others' }); }
  return true;
}
/** Olie-registratie van de bemanning (via ntfy, link of plakken): direct verwerken in voorraad en verbruik. Idempotent via de unieke id's. */
async function importOilPkg(pkg, via, quiet) {
  state.oilSeen ||= [];
  if (state.oilSeen.includes(pkg.runId)) { if (!quiet) toast(t('Deze olie-registratie is al verwerkt.')); return false; }
  await MT.ensureMaint();
  let n = 0;
  if (state.maint?.oilRef) n = OIL.ingest(pkg.oilEvents || []); else (state.oilPending ||= []).push(pkg);
  state.oilSeen.push(pkg.runId); if (state.oilSeen.length > 500) state.oilSeen = state.oilSeen.slice(-500);
  if (!inbox().some((x) => x.id === 'oil:' + pkg.runId)) inbox().push({ id: 'oil:' + pkg.runId, kind: 'olie', title: pkg.title || pkg.routeName, message: pkg.summary || '', time: pkg.finishedAt || new Date().toISOString(), by: pkg.by || '', via, applied: n, photos: [] });
  save();
  if (!quiet) { closeSheet(); toast(state.maint?.oilRef ? t('Olie-registratie van {name} verwerkt', { name: pkg.by || '?' }) : t('Olie-registratie ontvangen – wordt verwerkt na ontgrendelen'), 4000); go('olie'); }
  return 'oil';
}
/** Bemanning: olie-registratie via de outbox naar het meldingskanaal (offline: wachtrij). Zonder kanaal: delen via WhatsApp. */
async function sendOil(ev, sum) {
  const st = state.settings; const name = ev.by || st.userName || 'bemanning';
  (state.oilLog ||= []).push(ev); if (state.oilLog.length > 200) state.oilLog = state.oilLog.slice(-200); save();
  const pkg = { app: 'schiproute', kind: 'report', v: 1, oilOnly: true, runId: 'oil-' + ev.id, routeName: 'Olie', title: sum.title, summary: sum.text, ship: state.shipName, by: name, startedAt: ev.at, finishedAt: ev.at, lang: st.lang || 'nl', results: [], messages: [], oilEvents: [ev] };
  const link = await buildShareLink(pkg);
  const ar = state.activeRun; const topic = ar?.route.notifyTopic || st.ntfyTopic;
  if (!topic) {
    const txt = `${sum.title}\n${sum.text}\n${link}`;
    openSheet(`<h2>🛢 ${t('Opgeslagen')}</h2><p class="warnbox">${t('Er is geen meldingskanaal ingesteld. Stuur deze registratie via WhatsApp naar de beheerder:')}</p><div class="stack"><a class="btn wa big" href="https://wa.me/?text=${encodeURIComponent(txt)}" target="_blank" rel="noopener">🟢 WhatsApp</a></div>`);
    return;
  }
  /* i18n-skip-start */
  const item = { id: 'm-' + rid(), kind: 'olie', createdAt: ev.at, by: name, text: sum.text, title: sum.title, message: `${sum.text}\n\n🕒 ${fmtDT(ev.at)}\n👤 ${name}\n🚢 ${state.shipName}`, priority: 3, tags: ['droplet', 'ship'], click: link, topic, server: (ar?.route.notifyTopic && ar.route.notifyServer) || st.ntfyServer || 'https://ntfy.sh', status: 'pending', photos: [] };
  /* i18n-skip-end */
  await queueItem(item);
  if (navigator.onLine) toast(t('Verstuurd naar Beheer: {s}', { s: sum.short }), 3500);
}
/* Rapporten ophalen uit het eigen ntfy-kanaal (bericht met link of .json-bijlage). ntfy.sh bewaart berichten ±12 uur, bijlagen ±3 uur. */
let polling = false;
async function pollNtfy(manual = false) {
  const st = state.settings; if (polling || isCrew() || !st.ntfyTopic || !navigator.onLine) { if (manual && !navigator.onLine) toast(t('Geen internet')); return 0; }
  polling = true; let n = 0, seen = 0;
  try {
    const base = (st.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '');
    const r = await fetch(`${base}/${encodeURIComponent(st.ntfyTopic)}/json?poll=1&since=${encodeURIComponent(st.ntfyPollId || '24h')}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('ntfy ' + r.status);
    const msgs = (await r.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((m) => m?.event === 'message');
    const own = new Set((await OB.all().catch(() => [])).map((x) => x.title));
    let nMsg = 0;
    for (const m of msgs) {
      const kind = ntfyKind(m);
      if (kind !== 'rapport') {
        if (kind === 'test' || own.has(m.title) || inbox().some((x) => x.id === m.id)) continue;
        if (kind === 'foto') {
          const base_ = (m.title || '').replace(/^📷\s*\d+\/\d+\s*·\s*/, '');
          if (own.has(base_)) continue;
          let par = [...inbox()].reverse().find((x) => x.title === base_);
          if (!par) { par = { id: m.id, kind: 'observatie', title: base_ || t('Foto'), message: '', time: new Date(m.time * 1000).toISOString(), photos: [] }; inbox().push(par); nMsg++; }
          if (m.attachment?.url) (par.photos ||= []).push({ url: m.attachment.url, name: m.attachment.name || '', expires: m.attachment.expires || null });
          continue;
        }
        const by = (/👤\s*(.+)/.exec(m.message || '') || [])[1] || '';
        const locName = (/📍\s*[^:]*:\s*(.+)/.exec(m.message || '') || [])[1] || '';
        inbox().push({ id: m.id, kind: kind === 'anders' ? 'observatie' : kind, title: m.title || '', message: m.message || '', time: new Date(m.time * 1000).toISOString(), by: by.trim(), locName: locName.trim(), urgent: (m.tags || []).includes('rotating_light'), photos: [] });
        nMsg++;
        continue;
      }
      let pkg = null;
      try {
        if (m.click && /report=/.test(m.click)) pkg = await readHashPayload(m.click);
        else if (m.attachment?.url && /^rapport-.*\.json$/i.test(m.attachment.name || '')) { const a = await fetch(m.attachment.url); if (a.ok) pkg = await a.json(); }
      } catch (e) { console.warn('ntfy-rapport', e); }
      if (pkg?.kind === 'report') { seen++; const ok = await autoImportReport(pkg, 'ntfy', true); if (ok === 'oil') nMsg++; else if (ok) n++; }
    }
    if (msgs.length) st.ntfyPollId = msgs[msgs.length - 1].id;
    st.ntfyPolledAt = new Date().toISOString(); save();
    if (inbox().length > 300) state.inbox = inbox().slice(-300);
    if (nMsg) save();
    if (manual || n || nMsg) toast([n ? t('{n} nieuw(e) rapport(en) opgehaald', { n }) : '', nMsg ? t('{n} nieuwe melding(en)', { n: nMsg }) : ''].filter(Boolean).join(' · ') || (seen ? t('Geen nieuwe rapporten (al geïmporteerd)') : t('Niets nieuws in het meldingskanaal (ntfy bewaart berichten ±12 uur)')), 3500);
    if (n || nMsg || ['historie', 'meldingen', 'vandaag', 'olie'].includes(view.tab)) render();
  } catch (e) { console.warn(e); if (manual) toast(t('Ophalen lukte niet: {msg}', { msg: e.message }), 4000); }
  finally { polling = false; }
  return n;
}
Object.assign(actions, {
  sendReport: (a) => sendReport(state.runs.find((x) => x.id === a.dataset.id)),
  repSent: () => { const run = sheetCtx.report.run; run.reportSentAt = new Date().toISOString(); save(); },
  repShare: async () => {
    const { run, link, txt } = sheetCtx.report;
    if (navigator.share) { try { await navigator.share({ title: t('Rapport ronde'), text: txt, url: link }); run.reportSentAt = new Date().toISOString(); save(); toast(t('Gedeeld')); return; } catch (e) { if (e.name === 'AbortError') return; } }
    await copyText(txt + '\n' + link); run.reportSentAt = new Date().toISOString(); save();
  },
  repFile: async () => { const { run, json, fname, txt } = sheetCtx.report; const res = await shareFile(fname, json, 'application/json', t('Rapport ronde'), txt); if (res !== 'cancel') { run.reportSentAt = new Date().toISOString(); save(); } },
  repCopy: async () => { const { run, link, txt } = sheetCtx.report; await copyText(txt + '\n' + link); run.reportSentAt = new Date().toISOString(); save(); },
  repImport: async () => {
    const pkg = sheetCtx.repPkg; await MT.ensureMaint();
    const m = importReport(pkg, 'link'); closeSheet();
    toast(m.done ? t('Rapport geïmporteerd · {n} MARAD-taken afgemeld', { n: m.done }) : t('Rapport geïmporteerd'), 4000);
    go('historie', { runId: pkg.runId });
  },
  reportImport: () => openSheet(`<h2>${t('📨 Rapport importeren')}</h2><p class="muted">${t('Plak de link uit WhatsApp of de melding, of kies het rapportbestand (.json).')}</p><textarea id="repText" rows="3" placeholder="https://…#report=…"></textarea><div class="stack"><button class="btn primary" data-act="repFromText">${t('Link lezen')}</button><button class="btn" data-act="importFile">${t('📄 Bestand kiezen')}</button></div>`),
  repFromText: async () => {
    const txt = $('#repText').value.trim();
    try { const pkg = txt.startsWith('{') ? JSON.parse(txt) : await readHashPayload(txt); if (pkg?.kind === 'report') return autoImportReport(pkg, 'paste'); if (pkg?.kind === 'route') return importSheet(pkg); } catch (e) { console.warn(e); }
    toast(t('Geen geldig rapport gevonden'));
  },
});

Object.assign(actions, {
  histMode: (a) => { view.hist = a.dataset.v; render(); if (view.hist === 'others') maybePoll(); },
  ofPeriod: (a) => { OF.period = a.dataset.v; render(); },
  seenRun: (a) => { const r = state.runs.find((x) => x.id === a.dataset.id); if (r?.received) { r.received.seenAt = new Date().toISOString(); save(); render(); } },
  seenAll: () => { const now = new Date().toISOString(); for (const r of received()) r.received.seenAt ||= now; save(); render(); toast(t('Alles gemarkeerd als gezien')); },
  openRunH: (a) => go('historie', { runId: a.dataset.id }),
  goMaradDone: () => { closeSheet(); MT.actions.mView({ dataset: { v: 'done' } }); go('onderhoud'); },
  goSug: () => { MT.actions.mView({ dataset: { v: 'sug' } }); go('onderhoud'); },
  ntfyPoll: () => pollNtfy(true),
  repClip: async () => { let txt = ''; try { txt = await navigator.clipboard.readText(); } catch { /* geen toegang */ } if (!(await handlePasted(txt))) { toast(t('Niets bruikbaars op het klembord – plak in het vak (lang indrukken → Plak).'), 4000); $('#repPaste')?.focus(); } },
  pasteRoute: async () => { let txt = ''; try { if (navigator.clipboard?.readText) txt = await navigator.clipboard.readText(); } catch { /* geen toegang */ } if (!(await handlePasted(txt))) pasteSheet(); },
  pasteRead: async () => { if (!(await handlePasted($('#pasteBox').value))) toast(t('Geen geldige route of rapport gevonden')); },
  iosInstall: () => iosInstallSheet(),
  iosCopyLink: async () => { const { link } = sheetCtx.iosLink; const ok = await copyText(link); if (ok) toast(t('Gekopieerd ✔ – open nu Schip Route vanaf je beginscherm en tik op "📋 Route plakken"'), 6000); },
  iosUseHere: () => { const { pkg } = sheetCtx.iosLink; closeSheet(); if (pkg.kind === 'route') importSheet(pkg); else autoImportReport(pkg, 'link'); },
});
let lastPoll = 0;
function maybePoll() { if (!isCrew() && navigator.onLine && Date.now() - lastPoll > 20000) { lastPoll = Date.now(); pollNtfy(false); } }
Object.assign(actions, {
  goTab: (a) => { closeSheet(); go(a.dataset.v); if (a.dataset.v === 'meldingen') maybePoll(); },
  appMenu: () => appMenu(),
  melMode: (a) => { view.mel = a.dataset.v; render(); maybePoll(); },
  melFilter: (a) => { view.melF = a.dataset.v; render(); },
  melSeen: (a) => { const m = inbox().find((x) => x.id === a.dataset.id); if (m) { m.seenAt = new Date().toISOString(); save(); render(); } },
  melSeenAll: () => { const now = new Date().toISOString(); for (const m of inbox()) m.seenAt ||= now; save(); render(); toast(t('Alles gemarkeerd als gezien')); },
  tdStart: (a) => { const id = MT.startFixed(a.dataset.k); if (id) startRun(id); else toast(t('Geen taken')); },
  smartOrder: () => openSheet(`<h2>🧭 ${t('Slimme volgorde')}</h2><p class="muted">${t('Sorteert de taken op locatie, zodat je elke ruimte maar één keer bezoekt. De machinekamer-onderdelen blijven bij elkaar.')}</p><div class="stack"><button class="btn primary big" data-act="smartApply" data-v="va">⬅️ ${t('Van voor naar achter')}</button><button class="btn big" data-act="smartApply" data-v="av">➡️ ${t('Van achter naar voor')}</button></div><p class="muted small">${t('De keuze wordt onthouden voor vaste rondes.')}</p>`),
  smartApply: (a) => { const r = route(view.routeId); if (!r) return; state.settings.orderDir = a.dataset.v; r.steps = orderSteps(r.steps, state, a.dataset.v === 'av' ? 'slimAV' : 'slimVA'); touch(r); closeSheet(); render(); toast(t('Slimme volgorde toegepast: {n} locaties', { n: new Set(r.steps.map((x) => x.locationId)).size })); },
});

// ---------- onderhoud (MARAD) ----------
const MT = initMaint({ oilApply: (run) => OIL.applyRun(run), legacyMaint, state, save, rid, esc, header, openSheet, closeSheet, toast, render: () => render(), go: (...x) => go(...x), shareFile, csvCell, fmtDT, plural, locSelect, loc, tx, STRATEGIES, orderSteps, waNum: (p) => waNum(p), buildShareLink, routePackage, openShare: (r) => openShare(r) });
Object.assign(actions, MT.actions);
const OIL = initOil({ state, save, rid, esc, header, openSheet, closeSheet, toast, render: () => render(), renderRun: () => renderRun(), shareFile, csvCell, fmtDT, tx, isCrew, copyText, persist: () => MT.persist(), openShare: (r) => openShare(r), sendOil: (ev, sum) => sendOil(ev, sum) });
Object.assign(actions, OIL.actions);

// ---------- start ----------
if (!state.settings.lang) { state.settings.lang = getLang(); save(); }
// Eerste start via een gedeelde route-link → bemanning; anders (eigen toestel / bestaande gegevens) → beheer.
if (!state.settings.mode) { state.settings.mode = /route=/.test(location.hash) && !state.runs.length ? 'bemanning' : 'beheer'; save(); }
if (!isCrew()) MT.ensureMaint().then((m) => { if (m?.tasks && ['routes', 'onderhoud', 'vandaag'].includes(view.tab || 'vandaag') && !view.routeId && $('#sheet').hidden) render(); });
render();
checkHash();
// iPhone in Safari (niet vanaf beginscherm): installatie-uitleg automatisch tonen (eenmaal per sessie, niet bij een gedeelde link)
if (isIOS() && !isStandalone() && !state.settings.hideInstall && !/(route|report)=/.test(location.hash) && !sessionStorage.getItem('iosHint')) { sessionStorage.setItem('iosHint', '1'); setTimeout(() => { if ($('#sheet').hidden) iosInstallSheet(); }, 600); }
if (!isCrew()) setTimeout(maybePoll, 1500);
if (state.activeRun && state.settings.resumeOnStart && !location.hash.includes('route=')) { $('#run').hidden = false; document.body.classList.add('running'); renderRun(true); }
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').then(() => (window.__swRegistered = true)).catch((e) => console.warn('SW', e));
}
refreshOutbox().then(() => flushNow());
window.__app = { state, view: () => view, flushNow, refreshOutbox, MT, pollNtfy, isIOS, isStandalone };
