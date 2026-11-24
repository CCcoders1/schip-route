// v1.24 MARAD afvinken – overzicht van alles wat in de app is afgemeld (wie, wanneer, waardes, vervaldatum) met per taak
// "✔ in MARAD gezet". Zelfde afmeldingen (maint.signoffs, veld enteredInMarad) als overal in de app – geen aparte kopie.
// Laptop naast MARAD: eenmalig koppelen met een laptop-link van de telefoon. De telefoon stuurt een versleutelde lijst
// (AES-GCM, sleutel alleen in die link) via het eigen ntfy-kanaal; afvinken op de laptop gaat versleuteld terug en de
// telefoon zet het in de app. Geen account of inlog.
import { t, tx, getLang, LOCALES } from './i18n.js';
import { encodePayload, decodePayload, b64u, unb64u } from './share.js';
import { ivText } from './maint.js';

let A;
const esc = (s) => A.esc(s);
const F = { show: 'open', group: 'date', q: '', by: '' };
const M = () => A.state.maint;
const AF = () => A.state.afv || null;
/** Beheer-toestel (ook als MARAD op slot zit): eigen naam/kanaal, gekoppelde mensen, rondes of eerder ontgrendeld. Een verse laptop heeft niets van dit. */
const isBeheerDevice = () => { const s = A.state; return !A.isCrew() && (!!s.settings.userName || (!!s.settings.ntfyTopic && !s.settings.ntfyTopicAuto) || !!s.maint || (s.runs || []).length > 0 || (s.contacts || []).some((c) => c.deviceId) || !!localStorage.getItem('schiproute.maintSeen')); };
const isViewer = () => AF()?.role === 'viewer' && !M()?.tasks;
const fmtD = (iso) => (iso ? new Date(String(iso).slice(0, 10) + 'T12:00:00').toLocaleDateString(LOCALES[getLang()], { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const dayKey = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const PUB_MS = 6 * 3600e3;

export function initAfvink(api) { A = api; return { view, actions, isViewer, tick, pollPhone, pollViewer, publish, fromHash }; }

// ---------- gegevens ----------
function valsOf(r) {
  const out = [];
  for (const f of r?.fields || []) {
    const v = r.values?.[f.id]; if (v == null || v === '' || f.type === 'check' || ['mDone', 'mRem', 'mRh'].includes(f.role)) continue;
    out.push(`${tx(f, 'label')}: ${v === true ? '✔' : v === false ? '✕' : v}${f.unit ? ' ' + f.unit : ''}`);
  }
  return out;
}
/** Rijen uit de lokale afmeldingen (Beheer-toestel). */
function localRows() {
  const m = M(); if (!m?.signoffs) return [];
  const tasks = new Map((m.tasks || []).map((x) => [x.id, x])); const runs = new Map((A.state.runs || []).map((r) => [r.id, r]));
  return m.signoffs.map((s) => {
    const x = tasks.get(s.taskId); const c = x && m.components?.[x.componentId];
    const run = s.runId ? runs.get(s.runId) : null; const res = run?.results?.find((y) => (y.marad?.id || y.marad) === s.taskId);
    const vals = valsOf(res); if (s.runHours != null && s.runHours !== '') vals.unshift(t('Urenstand: {n}', { n: s.runHours }));
    return { id: s.id, task: s.task || x?.name || '', code: c?.code || '', comp: s.component || (c ? c.path.join(' » ') : ''), path: c?.path || [], done: s.doneDate, by: s.by || '', vals, rem: s.remarks || '', note: res?.note || '',
      due: s.prev?.dueDate || null, next: s.nextDue || null, iv: x?.interval ? ivText(x.interval) : '', round: run?.routeName || '', entered: s.enteredInMarad || null };
  });
}
const rows = () => (isViewer() ? AF().snap?.rows || [] : localRows()).map((r) => (isViewer() && AF().pend?.[r.id] !== undefined ? { ...r, entered: AF().pend[r.id] ? AF().pend[r.id] : null, pend: true } : r));

// ---------- afvinken ----------
/** In MARAD gezet (aan) of weer terug (uit). Op de laptop: versleuteld naar de telefoon. */
export async function tick(id, on) {
  if (isViewer()) {
    const af = AF(); (af.pend ||= {})[id] = on ? new Date().toISOString() : false; A.save();
    await sendTicks(); return;
  }
  const s = M()?.signoffs?.find((x) => x.id === id); if (!s) return;
  if (on) { s.enteredInMarad = s.enteredInMarad || new Date().toISOString(); s.enteredVia = 'app'; } else { s.enteredInMarad = false; delete s.enteredVia; }
  A.MT.persist(); A.save(); publishSoon();
}
// ---------- versleuteling ----------
async function keyOf(k) { return crypto.subtle.importKey('raw', unb64u(k), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function seal(k, obj) { const iv = crypto.getRandomValues(new Uint8Array(12)); const plain = new TextEncoder().encode(await encodePayload(obj)); return { iv: b64u(iv), ct: b64u(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyOf(k), plain))) }; }
async function open_(k, p) { const b = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(p.iv) }, await keyOf(k), unb64u(p.ct)); return decodePayload(new TextDecoder().decode(b)); }

// ---------- telefoon (Beheer): koppelen, lijst plaatsen, afvinkingen van de laptop ophalen ----------
function ensurePhone() {
  let af = AF(); if (af?.role === 'phone') return af;
  const st = A.state.settings; const rnd = b64u(crypto.getRandomValues(new Uint8Array(9)));
  af = A.state.afv = { role: 'phone', topic: (st.ntfyTopic ? st.ntfyTopic + '-afv-' : 'srafv-') + rnd, server: (st.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, ''), key: b64u(crypto.getRandomValues(new Uint8Array(32))), at: new Date().toISOString(), seenT: {} };
  A.save(); return af;
}
const linkOf = (af) => location.href.split('#')[0].split('?')[0] + '#afvinken=' + b64u(new TextEncoder().encode(JSON.stringify({ v: 1, t: af.topic, s: af.server, k: af.key })));
let pubT = 0;
function publishSoon() { clearTimeout(pubT); pubT = setTimeout(() => publish(true), 800); }
const hashOf = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
/** Lijst naar de laptop (alleen als er een laptop gekoppeld is, en alleen bij verandering of om de 6 uur). */
export async function publish(force = false) {
  const af = AF(); if (af?.role !== 'phone' || !af.linked || !M()?.signoffs || !navigator.onLine) return 0;
  const rs = localRows().filter((r) => !r.entered || Date.now() - new Date(r.entered).getTime() < 30 * 864e5); // ingevoerd: laatste 30 dagen
  const h = hashOf(JSON.stringify(rs));
  if (h === af.pubHash && Date.now() - (af.pubAt || 0) < (force ? 3000 : PUB_MS)) return 0;
  const ver = Date.now();
  const sealed = await seal(af.key, { v: 1, ver, gen: new Date().toISOString(), ship: A.state.shipName || '', by: A.state.settings.userName || '', rows: rs, applied: Object.keys(af.seenT || {}).slice(-200) });
  const items = await A.LINK.chunkItems({ app: 'schiproute', kind: 'afvink', v: 1, ...sealed }, { kind: 'afvink', aid: 'afv', ver, topic: af.topic, server: af.server, title: '✔ MARAD', by: '' });
  af.pubHash = h; af.pubAt = Date.now(); A.save(); await A.queueQuiet(items); return items.length;
}
async function fetchTopic(af) {
  const r = await fetch(`${af.server}/${encodeURIComponent(af.topic)}/json?poll=1&since=${encodeURIComponent(af.pollId || '12h')}`, { cache: 'no-store' });
  if (!r.ok) throw new Error('ntfy ' + r.status);
  const msgs = (await r.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((m) => m?.event === 'message');
  if (msgs.length) af.pollId = msgs.at(-1).id; return msgs;
}
let busy = false;
/** Telefoon: afvinkingen van de laptop verwerken. */
export async function pollPhone() {
  const af = AF(); if (busy || af?.role !== 'phone' || !navigator.onLine || !M()?.signoffs) return 0;
  busy = true; let n = 0, got = 0;
  try {
    for (const m of await fetchTopic(af)) {
      const txt = m.message || ''; if (!txt.startsWith('SRT1 ')) continue;
      let e; try { e = await open_(af.key, JSON.parse(txt.slice(5))); } catch { continue; }
      if (!e?.id || af.seenT?.[e.id]) continue; (af.seenT ||= {})[e.id] = 1; af.linked = true; got++;
      for (const [id, v] of Object.entries(e.set || {})) { const s = M().signoffs.find((x) => x.id === id); if (!s) continue; if (v) { if (!s.enteredInMarad) { s.enteredInMarad = v; s.enteredVia = 'laptop'; n++; } } else if (s.enteredInMarad) { s.enteredInMarad = false; delete s.enteredVia; n++; } }
    }
    A.save(); if (n) { A.MT.persist(); if (A.view().tab === 'afvinken') A.render(); }
    const ks = Object.keys(af.seenT || {}); if (ks.length > 300) for (const k of ks.slice(0, ks.length - 300)) delete af.seenT[k];
    await publish(got > 0);
  } catch (err) { console.warn('afvink', err); } finally { busy = false; }
  return n;
}
// ---------- laptop ----------
async function sendTicks() {
  const af = AF(); const set = Object.fromEntries(Object.entries(af.pend || {}));
  const e = { id: 'tk-' + A.rid(), set, at: new Date().toISOString() };
  /* i18n-skip-start */
  await A.queueQuiet([{ id: 'm-' + A.rid(), kind: 'afvink', createdAt: e.at, by: '', text: '', priority: 1, tags: ['white_check_mark'], title: '✔ MARAD', message: 'SRT1 ' + JSON.stringify(await seal(af.key, e)), topic: af.topic, server: af.server }]);
  /* i18n-skip-end */
  A.render();
}
/** Laptop: nieuwste lijst van de telefoon ophalen. */
export async function pollViewer(manual = false) {
  const af = AF(); if (busy || af?.role !== 'viewer' || !navigator.onLine) return 0;
  busy = true; let got = 0;
  try {
    for (const m of await fetchTopic(af)) {
      if (!(m.message || '').startsWith('SRX1 ')) continue;
      const c = await A.LINK.takeChunk(m); if (c?.pkg?.kind !== 'afvink') continue;
      let snap; try { snap = await open_(af.key, c.pkg); } catch { continue; }
      if (!snap?.rows || (af.snap && af.snap.ver >= snap.ver)) continue;
      af.snap = snap; got++;
      // wat de telefoon heeft verwerkt, hoeft niet meer als "onderweg"
      for (const [id, v] of Object.entries(af.pend || {})) { const r = snap.rows.find((x) => x.id === id); if (!r || (!!r.entered === !!v)) delete af.pend[id]; }
    }
    af.polledAt = new Date().toISOString(); A.save();
    if (got && A.view().tab === 'afvinken') A.render(); else if (manual) { A.toast(got ? t('Bijgewerkt') : t('Geen nieuwe gegevens')); A.render(); }
  } catch (err) { console.warn('afvink', err); if (manual) A.toast(t('Ophalen lukte niet: {msg}', { msg: err.message }), 4000); } finally { busy = false; }
  return got;
}
export function readLinkCode(text) {
  const m = String(text || '').match(/afvinken=([A-Za-z0-9_-]{20,})/) || String(text || '').match(/^([A-Za-z0-9_-]{40,})$/); if (!m) return null;
  try { const o = JSON.parse(new TextDecoder().decode(unb64u(m[1]))); if (o?.t && o.k && /^https?:\/\//.test(o.s)) return o; } catch { /* */ }
  return null;
}
function becomeViewer(o) {
  const cur = AF();
  if (M()?.tasks) { A.toast(t('Dit is het Beheer-toestel zelf – hier staat de lijst al.'), 4000); return false; }
  A.state.afv = { role: 'viewer', topic: o.t, server: String(o.s).replace(/\/+$/, ''), key: o.k, at: new Date().toISOString(), snap: cur?.topic === o.t ? cur.snap : null, pend: {} };
  A.save(); pollViewer(); return true;
}

// ---------- scherm ----------
function filtered(all) {
  const q = F.q.trim().toLowerCase();
  return all.filter((r) => (F.show === 'open' ? !r.entered : F.show === 'done' ? !!r.entered : true) && (!F.by || r.by === F.by)
    && (!q || [r.task, r.code, r.comp, r.by, r.rem, r.note, ...r.vals].join(' ').toLowerCase().includes(q)));
}
const byDate = (a, b) => String(b.done).localeCompare(String(a.done)) || a.comp.localeCompare(b.comp, undefined, { numeric: true }) || a.task.localeCompare(b.task);
const byComp = (a, b) => (a.code || '~').localeCompare(b.code || '~', undefined, { numeric: true }) || a.comp.localeCompare(b.comp, undefined, { numeric: true }) || a.task.localeCompare(b.task) || String(b.done).localeCompare(String(a.done));
function rowHTML(r) {
  const dl = r.due && r.done ? Math.round((new Date(r.done) - new Date(r.due)) / 864e5) : null;
  return `<li class="afr ${r.entered ? 'in' : ''} ${r.pend ? 'pend' : ''}" data-id="${esc(r.id)}"><label class="afchk"><input type="checkbox" data-afv="${esc(r.id)}" ${r.entered ? 'checked' : ''} aria-label="${t('In MARAD gezet')}"></label>
    <div class="afmain"><b class="aft" role="button" tabindex="0" data-act="afCopyName" data-id="${esc(r.id)}" title="${t('Tik om te kopiëren')}">${esc(r.task)} <span class="afcp" aria-hidden="true">📋</span></b><span class="afc">${r.code ? `<code role="button" data-act="afCopyCode" data-id="${esc(r.id)}" title="${t('Tik om te kopiëren')}">${esc(r.code)}</code> ` : ''}${esc(r.comp)}</span></div>
    <div class="afdate"><b>✔ ${esc(fmtD(r.done))}</b><small>👤 ${esc(r.by || '—')}${r.round ? ' · 🧭 ' + esc(r.round) : ''}</small></div>
    <div class="afdue"><small>${t('Vervaldatum')}: <b class="${dl > 0 ? 'cr' : ''}">${esc(fmtD(r.due))}</b>${dl > 0 ? ` (${t('{n} d te laat gedaan', { n: dl })})` : ''}</small><small>${t('Volgende')}: ${esc(fmtD(r.next))}${r.iv ? ' · ' + esc(r.iv) : ''}</small></div>
    ${r.vals.length || r.rem || r.note ? `<div class="afvals">${r.vals.length ? `<small>📏 ${r.vals.map(esc).join(' · ')}</small>` : ''}${r.rem ? `<small>📝 ${esc(r.rem)}</small>` : ''}${r.note ? `<small>💬 ${esc(r.note)}</small>` : ''}</div>` : ''}
    ${r.entered ? `<small class="afin">✔ ${r.pend ? t('onderweg naar de telefoon…') : t('in MARAD gezet {d}', { d: esc(fmtD(r.entered)) })}</small>` : ''}</li>`;
}
function listHTML(all) {
  const xs = filtered(all);
  if (!xs.length) return `<p class="empty">${F.show === 'open' && all.length ? '✅ ' + t('Alles staat in MARAD.') : t('Niets gevonden.')}</p>`;
  if (F.group === 'comp') {
    const by = new Map(); for (const r of xs.sort(byComp)) { const k = r.path[0] || r.comp.split(' » ')[0] || '—'; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
    return [...by].map(([k, rs]) => `<h3 class="afg">🔧 ${esc(k)} <small>(${rs.length})</small></h3><ul class="aflist">${rs.map(rowHTML).join('')}</ul>`).join('');
  }
  const by = new Map(); for (const r of xs.sort(byDate)) { const k = String(r.done).slice(0, 10); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  return [...by].map(([k, rs]) => `<h3 class="afg">📅 ${esc(fmtD(k))} <small>(${rs.length})</small></h3><ul class="aflist">${rs.map(rowHTML).join('')}</ul>`).join('');
}
function laptopHTML() {
  const af = AF(); const on = af?.role === 'phone' && af.linked;
  if (!on) return `<section class="card aflap aftop"><button class="btn primary big" data-act="afLink">💻 ${t('Laptop-link maken')}</button><p class="muted small">${t('Maak een laptop-link en open die op je laptop. De lijst gaat versleuteld via je eigen meldingskanaal; alleen wie de link heeft kan hem lezen. Geen account nodig.')}</p></section>`;
  let h = `<section class="card aflap aftop"><div class="row"><b>💻 ${t('Laptop gekoppeld')}</b><small class="muted">${af.pubAt ? t('lijst bijgewerkt {d}', { d: A.fmtDT(new Date(af.pubAt).toISOString()) }) : ''}</small></div>`;
  if (F.showLink) h += `<p class="small">${t('Mail deze link naar jezelf en open hem op je laptop. Hou hem voor jezelf: wie de link heeft, kan de lijst lezen.')}</p><textarea id="afLinkTxt" class="aflink" rows="4" readonly>${esc(linkOf(af))}</textarea>
    <button class="btn primary big" data-act="afCopy">📋 ${t('Kopiëren')}</button>`;
  else h += `<button class="btn" data-act="afShowLink">💻 ${t('Laptop-link tonen')}</button>`;
  h += `<p class="muted small">${t('Afvinken op de laptop komt hier binnen zodra deze telefoon internet heeft en de app open is.')} <button class="btn small ghost" data-act="afUnlink">✕ ${t('Laptop ontkoppelen')}</button></p></section>`;
  return h;
}
export function view() {
  const viewer = isViewer(); const af = AF();
  let h = A.header(t('MARAD afvinken'), !viewer);
  if (!viewer && !M()?.signoffs) {
    const paste = `<label>${t('Laptop-link')}<textarea id="afIn" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…#afvinken=…"></textarea></label><div class="stack"><button class="btn primary" data-act="afPair">🔗 ${t('Koppelen')}</button></div>`;
    if (!A.state.maint) A.MT.ensureMaint().then((m) => { if (m?.signoffs && A.view().tab === 'afvinken') A.render(); });
    if (isBeheerDevice()) return h + `<p class="muted">${t('Hier staat wat in de app is afgemeld, om in MARAD in te voeren. Ontgrendel eerst MARAD op dit toestel.')}</p>${A.MT.unlockHTML()}
      <details class="card afpaste"><summary>💻 ${t('Is dit je laptop? Plak hier de laptop-link van de telefoon')}</summary>${paste}</details>`;
    return h + `<section class="card"><p>${t('Hier staat wat in de app is afgemeld, om in MARAD in te voeren.')}</p><p class="muted">${t('Op de laptop: plak de laptop-link van de telefoon.')}</p>${paste}</section>
      <details class="card afpaste"><summary>🔓 ${t('Is dit het Beheer-toestel? Ontgrendel MARAD')}</summary>${A.MT.unlockHTML()}</details>`;
  }
  const all = rows(); const open = all.filter((r) => !r.entered).length; const today = dayKey();
  const todayIn = all.filter((r) => r.entered && dayKey(new Date(r.entered)) === today).length;
  if (viewer) h += `<p class="shipsub">💻 ${esc(af.snap?.ship || '')} · ${af.snap ? t('stand van de telefoon: {d}', { d: A.fmtDT(af.snap.gen) }) : t('wacht op de lijst van de telefoon…')} <button class="btn small ghost" data-act="afRefresh">🔄 ${t('Vernieuwen')}</button></p>`;
  if (!viewer) h += laptopHTML();
  h += `<div class="mstats afstats"><button data-act="afShow" data-v="open" class="${F.show === 'open' ? 'on' : ''}"><b class="cr">${open}</b><small>${t('Nog in MARAD')}</small></button><button data-act="afShow" data-v="done" class="${F.show === 'done' ? 'on' : ''}"><b class="okc">${todayIn}</b><small>${t('Vandaag in MARAD gezet')}</small></button><button data-act="afShow" data-v="all" class="${F.show === 'all' ? 'on' : ''}"><b>${all.length}</b><small>${t('Alle afmeldingen')}</small></button></div>`;
  const sb = (k, l) => `<button class="${F.show === k ? 'on' : ''}" data-act="afShow" data-v="${k}">${l}</button>`, gb = (k, l) => `<button class="${F.group === k ? 'on' : ''}" data-act="afGroup" data-v="${k}">${l}</button>`;
  const people = [...new Set(all.map((r) => r.by).filter(Boolean))].sort();
  h += `<div class="aftools"><div class="seg">${sb('open', t('Nog in MARAD'))}${sb('done', t('In MARAD gezet'))}${sb('all', t('Alles'))}</div><div class="seg">${gb('date', t('📅 Per datum'))}${gb('comp', t('🔧 Per component'))}</div>
    <input type="search" data-aff="q" value="${esc(F.q)}" placeholder="${t('🔍 Zoek taak, component of code')}"><select data-aff="by"><option value="">${t('Iedereen')}</option>${people.map((p) => `<option ${p === F.by ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div>`;
  h += `<p class="muted small">${t('Vink een taak aan zodra je hem in MARAD hebt ingevoerd. Uitvinken zet hem terug.')}${viewer ? '' : ` <button class="btn small ghost" data-act="mExport" ${open ? '' : 'disabled'}>⬇ CSV</button> <button class="btn small ghost" data-act="mEntered" ${open ? '' : 'disabled'}>${t('✔ Alles in MARAD gezet')}</button>`}</p>`;
  h += `<div id="afList">${listHTML(all)}</div>`;
  if (viewer) h += `<p class="muted small afnote">${t('Afvinken hier gaat naar de telefoon zodra die de app open heeft. Laptop ontkoppelen:')} <button class="btn small ghost" data-act="afForget">✕ ${t('Vergeten op deze laptop')}</button></p>`;
  return h;
}
function refresh() { const el = document.querySelector('#afList'); if (el) el.innerHTML = listHTML(rows()); }
document.addEventListener('input', (e) => { const el = e.target; if (el.dataset?.aff) { F[el.dataset.aff] = el.value; refresh(); } });
document.addEventListener('change', (e) => { const el = e.target; if (el.dataset?.afv) { tick(el.dataset.afv, el.checked).then(() => { if (!isViewer()) setTimeout(() => { if (A.view().tab === 'afvinken') A.render(); }, 600); }); } });
async function copyQuick(text, el) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { /* niet-beveiligd / iOS */ }
  if (!ok) { const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'; document.body.append(ta); ta.select(); ta.setSelectionRange(0, text.length); try { ok = document.execCommand('copy'); } catch { /* */ } ta.remove(); }
  A.toast(ok ? t('Gekopieerd ✔') : t('Kopiëren lukte niet'), 1500);
  if (ok && el) { el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 900); }
  return ok;
}
export const actions = {
  afShow: (a) => { F.show = a.dataset.v; A.render(); },
  afGroup: (a) => { F.group = a.dataset.v; A.render(); },
  afRefresh: () => pollViewer(true),
  afLink: async () => { const af = ensurePhone(); af.linked = true; A.save(); F.showLink = true; A.render(); scrollTo(0, 0); await publish(true); A.render(); },
  afCopyName: (a) => { const r = rows().find((x) => x.id === a.dataset.id); if (r) copyQuick(r.task, a); },
  afCopyCode: (a) => { const r = rows().find((x) => x.id === a.dataset.id); if (r?.code) copyQuick(r.code, a); },
  afShowLink: () => { F.showLink = true; A.render(); },
  afCopy: async () => { const af = AF(); if (!af) return; const el = document.querySelector('#afLinkTxt'); el?.select(); await A.copyText(linkOf(af)); A.toast(t('Laptop-link gekopieerd – open hem op je laptop'), 4000); },
  afUnlink: () => { if (!confirm(t('Laptop ontkoppelen? De laptop krijgt daarna geen nieuwe lijst meer.'))) return; delete A.state.afv; A.save(); A.render(); },
  afPair: () => { const o = readLinkCode(document.querySelector('#afIn')?.value); if (!o) return A.toast(t('Dat is geen geldige laptop-link.'), 3500); if (becomeViewer(o)) { A.go('afvinken'); A.toast(t('Gekoppeld – lijst wordt opgehaald'), 3000); } },
  afForget: () => { if (!confirm(t('De lijst en de koppeling van deze laptop wissen?'))) return; delete A.state.afv; A.save(); A.go('afvinken'); },
};
/** #afvinken=… in de adresbalk (laptop-link). */
export function fromHash() {
  const o = readLinkCode(location.hash); if (!o) return /#afvinken\b/.test(location.hash);
  history.replaceState(null, '', location.pathname + location.search + '#afvinken');
  becomeViewer(o); return true;
}
