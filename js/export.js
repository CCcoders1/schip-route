// v1.20 – "📦 Stand exporteren": de volledige app-stand (Beheer) als één JSON-bestand, om zelf te bewaren of privé te delen.
// Bevat ALLE metadata (taken, afmeldingen, verstuurde lijstjes, voortgang, olie, urentellers, instellingen), maar GEEN geheimen:
// geen ntfy-kanalen (topics), geen koppelcodes, geen PIN of wachtwoord. Wordt alleen geladen als je op de knop tikt
// (dynamische import), zodat oudere/gemengde bestandscaches de app nooit kunnen breken.
import { status, isHours, dueInDays } from './marad.js';
import { RANK_IDS, normRank } from './ranks.js';
import { t } from './i18n.js';

export const SCHEMA = 'schiproute-stand';
export const SCHEMA_VERSION = 1;
// sleutels die nooit mee mogen (op elk niveau)
const SECRET_KEYS = new Set(['ntfyTopic', 'inboxTopic', 'notifyTopic', 'topic', 'pinHash', 'pin', 'password', 'pw', 'secret', 'token', 'inboxPollId', 'ntfyPollId', 'ackSent', 'chunks', 'pairCode']);
const pad = (n) => String(n).padStart(2, '0');
const localStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
const localISO = (d) => { const o = -d.getTimezoneOffset(); const s = o >= 0 ? '+' : '-'; return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${s}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`; };
const dayOf = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? String(iso).slice(0, 10) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const ST_KEYS = ['overdue', 'week', 'month', 'later', 'hours', 'none'];
const zero = () => Object.fromEntries(ST_KEYS.map((k) => [k, 0]));

/** Alle geheime waarden (kanalen, PIN-hash) die we bovendien als tekst uit het hele bestand wegpoetsen. */
function secretValues(S) {
  const v = new Set();
  const add = (x) => { if (typeof x === 'string' && x.length >= 6) v.add(x); };
  add(S.settings?.ntfyTopic); add(S.settings?.inboxTopic); add(S.settings?.pinHash);
  for (const c of S.contacts || []) add(c.inbox);
  for (const r of S.routes || []) add(r.notifyTopic);
  for (const r of S.runs || []) add(r.notify?.topic);
  return [...v];
}
/** Diepe kopie: Set/Map → lijst/object, geheime sleutels weg, grote afbeeldingen (data:) weg, cyclische verwijzingen afgekapt. */
function clean(x, seen = new WeakSet(), depth = 0) {
  if (x == null || typeof x === 'number' || typeof x === 'boolean') return x;
  if (typeof x === 'string') return x.startsWith('data:') && x.length > 2000 ? '[afbeelding weggelaten]' : x;
  if (typeof x === 'function') return undefined;
  if (depth > 40) return '[te diep]';
  if (typeof x !== 'object') return String(x);
  if (seen.has(x)) return '[verwijzing]';
  seen.add(x);
  let out;
  if (x instanceof Set) out = [...x].map((y) => clean(y, seen, depth + 1));
  else if (x instanceof Map) out = Object.fromEntries([...x].map(([k, y]) => [String(k), clean(y, seen, depth + 1)]));
  else if (Array.isArray(x)) out = x.map((y) => clean(y, seen, depth + 1));
  else { out = {}; for (const [k, y] of Object.entries(x)) { if (SECRET_KEYS.has(k)) continue; const c = clean(y, seen, depth + 1); if (c !== undefined) out[k] = c; } }
  seen.delete(x);
  return out;
}
const scrubText = (json, secrets) => {
  let s = json; for (const v of secrets) s = s.split(v).join('[geheim]');
  return s.replace(/SRK1-[A-Za-z0-9_-]{10,}/g, 'SRK1-[geheim]');
};

/** Bouwt het export-object. A = helpers uit app.js. */
export function buildExport(A, now = new Date()) {
  const S = A.state; const m = S.maint || null; const tasks = m?.tasks || [];
  const today = dayOf(now.toISOString());
  const comp = (x) => m?.components?.[x.componentId] || null;
  const loc = (id) => (id ? S.locations.find((l) => l.id === id) : null);
  // ---------- taken ----------
  const T = tasks.map((x) => {
    const c = comp(x); const st = status(x, today); const l = loc(x.locId);
    return {
      id: x.id, name: x.name, source: x.source || 'marad',
      component: c ? { id: c.id, code: c.code || '', name: c.name || '', group: c.group || '', path: c.path || [] } : null,
      interval: x.interval || null, hoursBased: isHours(x),
      dueDate: x.dueDate || null, dueWeek: x.dueWeek ?? null, dueInDays: dueInDays(x, today), dueIn: x.dueIn ?? null,
      dueRunHours: x.dueRunHours ?? null, dueInHours: x.dueInHours ?? null, postponedUntil: x.postponedUntil || null,
      lastDone: x.lastDone || null, lastRunHours: x.lastRunHours ?? null, lastWeek: x.lastWeek ?? null, daysAgo: x.daysAgo ?? null,
      rank: x.rank || [], taskType: x.taskType || '', costCode: x.costCode || '', duration: x.duration ?? null,
      status: st,
      location: { id: x.locId || null, name: l?.name || null, manual: !!x.locManual, hint: x.locHint || null },
      appDone: x.appDone || null, doneLog: x.doneLog || [], notes: x.notes || [], workCard: x.workCard || '',
      importedAt: x.importedAt || null, updatedAt: x.updatedAt || null,
    };
  });
  // ---------- samenvatting ----------
  const ranks = [...new Set([...RANK_IDS, ...tasks.flatMap((x) => (x.rank || []).map(normRank))])].filter(Boolean);
  const byRank = {}; for (const r of ranks) byRank[r] = zero();
  const all = zero();
  for (const x of T) { all[x.status]++; for (const r of new Set(x.rank.map(normRank))) if (byRank[r]) byRank[r][x.status]++; }
  const sel = (Array.isArray(S.settings.rankSel) ? S.settings.rankSel : []).map(normRank);
  const cur = zero(); for (const x of T) if (!sel.length || x.rank.some((r) => sel.includes(normRank(r)))) cur[x.status]++;
  const perDay = {}; for (const s of m?.signoffs || []) perDay[s.doneDate] = (perDay[s.doneDate] || 0) + 1;
  const perDayBy = {}; for (const s of m?.signoffs || []) { const k = s.doneDate; (perDayBy[k] ||= {}); const b = s.by || '?'; perDayBy[k][b] = (perDayBy[k][b] || 0) + 1; }
  // ---------- verstuurde lijstjes + voortgang ----------
  const sent = S.dist?.sent || {};
  const sentStates = {}; const sentCount = {};
  for (const [k, s] of Object.entries(sent)) { let x = { st: 'unknown' }; try { x = A.LINK?.sentState ? A.LINK.sentState(s) : x; } catch { /* oud */ } sentStates[k] = { st: x.st, at: x.at || null, by: x.by || null, done: x.done ?? null, n: x.n ?? s.n ?? null }; if (s.list && s.rank) sentCount[x.st] = (sentCount[x.st] || 0) + 1; }
  let busy = []; try { busy = A.LINK?.busyList?.() || []; } catch { /* */ }
  const pg = A.LINK?.progressData?.() || null;
  let wb = null; try { const w = A.MT?.weekBoard?.(); if (w) wb = { ...w, rs: [...(w.rs || [])], week: w.week.map(({ sg, ...i }) => ({ ...i, taskIds: (sg?.tasks || []).map((y) => y.id) })), pkg: w.pkg.map(({ sg, ...i }) => ({ ...i, taskIds: (sg?.tasks || []).map((y) => y.id) })) }; } catch { /* */ }
  const selfLists = Object.entries(sent).filter(([, s]) => s.via === 'self').map(([k, s]) => ({ key: k, ...s, open: A.DIST?.selfBusy ? !!A.DIST.selfBusy(s) : null, route: S.routes.find((r) => r.id === s.routeId) || null }));
  const outbox = A.outboxItems || [];
  const obx = {}; for (const o of outbox) { const k = (o.kind || '?') + ':' + (o.status || 'queued'); obx[k] = (obx[k] || 0) + 1; }
  let restPile = null; try { const l = A.MT?.distLists?.().find((x) => x.kind === 'rest'); if (l) restPile = { key: l.key, total: l.tasks.length, overdue: l.tasks.filter((x) => x.st === 'overdue').length, taskIds: l.tasks.map((x) => x.key) }; } catch { /* */ }
  const st = S.settings || {};
  let oil = m?.oil || null; try { oil = A.OIL?.oilState?.() || oil; } catch { /* */ }
  const data = {
    schema: SCHEMA, schemaVersion: SCHEMA_VERSION,
    /* i18n-skip-start */
    warning: 'Bevat scheepsgegevens (MARAD) – alleen privé delen. Geen kanalen, koppelcodes, PIN of wachtwoord.',
    /* i18n-skip-end */
    meta: {
      app: 'schip-route', version: A.APP_VERSION, exportedAt: now.toISOString(), exportedAtLocal: localISO(now), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      today, device: { id: st.deviceId || '', role: A.isCrew() ? 'bemanning' : 'beheer', userName: st.userName || '', rank: normRank(st.myRank) || '', lang: st.lang || '' },
      ship: m?.ship || S.shipName || '',
      marad: m ? { loaded: true, ship: m.ship || '', importedAt: m.importedAt || null, lastImport: m.lastImport || null, bundleRev: m.bundleRev ?? null, tasks: tasks.length, components: Object.keys(m.components || {}).length, signoffs: (m.signoffs || []).length } : { loaded: false },
      userAgent: navigator.userAgent, standalone: !!A.isStandalone?.(),
    },
    summary: {
      today, statusKeys: ST_KEYS,
      counts: { all, currentFilter: { ranks: sel, counts: cur }, byRank },
      signoffsPerDay: perDay, signoffsPerDayBy: perDayBy,
      openForMarad: (m?.signoffs || []).filter((s) => !s.enteredInMarad).length,
      reopened: (m?.reopened || []).length,
      restPile, customTasks: { open: (S.dist?.custom?.tasks || []).filter((x) => !x.hidden).length, templates: (S.dist?.custom?.tpl || []).length }, sentLists: sentCount, busy: busy.length,
      outbox: obx,
      oil: oil ? { events: (oil.events || []).length, hourCounters: Object.keys(oil.hours || {}).length } : null,
    },
    tasks: T,
    components: m?.components || {},
    fixedRounds: m?.fixedRounds || [],
    signoffs: m?.signoffs || [],
    reopened: m?.reopened || [],
    dist: { sent, sentStates, assignments: S.dist?.a || {}, selection: S.dist?.sel || {}, dueOnly: S.dist?.dueOnly || {}, pending: S.dist?.pre || null },
    selfLists,
    customTasks: { tasks: S.dist?.custom?.tasks || [], templates: S.dist?.custom?.tpl || [] },
    weekBoard: wb,
    progress: { rows: pg?.runs || {}, busy },
    runs: S.runs || [], activeRun: S.activeRun || null, parkedRuns: S.parkedRuns || {},
    oil: { state: oil, reference: m?.oilRef || null },
    contacts: (S.contacts || []).map((c) => ({ id: c.id, name: c.name, func: c.func || '', rank: normRank(c.func) || '', deviceId: c.deviceId || '', paired: !!c.inbox, pairedAt: c.pairedAt || null, lastSeen: c.lastSeen || null })),
    routes: S.routes || [], locations: S.locations || [], decks: S.decks || [],
    messages: S.inbox || [],
    outboxItems: outbox.map((o) => ({ id: o.id, kind: o.kind, status: o.status || 'queued', createdAt: o.createdAt, title: o.title, tries: o.tries ?? null, error: o.error || null })),
    settings: st,
  };
  const secrets = secretValues(S);
  const json = scrubText(JSON.stringify(clean(data), null, 1), secrets);
  return { json, data, name: `schiproute-stand-${localStamp(now)}.json`, secrets: secrets.length };
}

/** Knop: bestand maken, downloaden (iOS: ook "bewaren via deelmenu" als het downloaden daar niet lukt). */
export async function runExport(A) {
  try { A.outboxItems = await self.OutboxCore?.all?.() || []; } catch { A.outboxItems = []; }
  const { json, name } = buildExport(A);
  let blob = new Blob([json], { type: 'application/json' }); let file = name;
  if (blob.size > 8e6 && 'CompressionStream' in self) { // groot → gzip (.json.gz)
    try { blob = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob(); file = name + '.gz'; } catch { /* dan maar ongecomprimeerd */ }
  }
  const dl = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); };
  dl();
  window.__lastExport = { name: file, size: blob.size, json: blob.type === 'application/json' ? json : null };
  const ios = A.isIOS(); const kb = Math.max(1, Math.round(blob.size / 1024));
  const S = A.state; const m = S.maint;
  A.openSheet(`<h2>📦 ${t('Stand exporteren')}</h2>
    <p class="okbox">✅ ${t('Bestand gemaakt: {name} ({kb} kB)', { name: A.esc(file), kb })}</p>
    <p class="small">${m ? t('{a} taken · {b} afmeldingen · {c} verstuurde lijstjes', { a: m.tasks.length, b: m.signoffs.length, c: Object.keys(S.dist?.sent || {}).length }) : t('MARAD is vergrendeld: taken en afmeldingen zitten er niet in. Ontgrendel eerst en exporteer opnieuw.')}</p>
    <p class="warnbox xwarn">⚠️ ${t('Dit bestand bevat scheepsgegevens. Deel het alleen privé.')}</p>
    <p class="muted small">${t('Zonder kanalen, koppelcodes, PIN of wachtwoord.')}${ios ? ' ' + t('Zie je het bestand niet bij Downloads? Bewaar het dan via het deelmenu → "Bewaar in Bestanden".') : ''}</p>
    <div class="stack">${ios ? `<button class="btn primary big" data-act="stateExportShare">📤 ${t('Bewaar via deelmenu')}</button>` : ''}<button class="btn" data-act="stateExportAgain">⬇ ${t('Opnieuw downloaden')}</button><button class="btn ghost" data-act="closeSheet">${t('Sluiten')}</button></div>`, { stateExport: true });
  A._lastBlob = { blob, file };
}
export async function shareLast(A) {
  const x = A._lastBlob; if (!x) return;
  const f = new File([x.blob], x.file, { type: x.blob.type || 'application/json' });
  if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f], title: x.file }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  A.toast(t('Delen lukt hier niet – gebruik "Opnieuw downloaden".'), 4000);
}
export function downloadLast(A) {
  const x = A._lastBlob; if (!x) return;
  const a = document.createElement('a'); a.href = URL.createObjectURL(x.blob); a.download = x.file; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
