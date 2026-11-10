import { seedData, rid } from './seed.js';
export { rid };
const KEY = 'schiproute.v1';

export let legacyMaint = null;
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      // v1.3: MARAD-gegevens stonden in localStorage → nu alleen in IndexedDB (zie maint.js)
      if (s.maint) { legacyMaint = s.maint; delete s.maint; }
      const d = seedData();
      s.settings = { ...d.settings, ...(s.settings || {}) };
      for (const k of ['decks', 'locations', 'routes', 'library', 'contacts', 'runs', 'plans']) if (!Array.isArray(s[k])) s[k] = [];
      // Migratie: vertalingen toevoegen aan standaardlocaties/-gebieden (stabiele id's).
      for (const k of ['decks', 'locations']) for (const x of s[k]) { const def = d[k].find((y) => y.id === x.id); if (def && !x.tr && def.name === x.name) x.tr = def.tr; }
      for (const r of s.routes) { const def = d.routes.find((y) => y.id === r.id); if (def && !r.tr && def.name === r.name) { r.tr = def.tr; r.steps.forEach((st, i) => { const ds = def.steps[i]; if (ds && ds.title === st.title && !st.tr) { st.tr = ds.tr; st.fields?.forEach((f, j) => { if (ds.fields[j]?.label === f.label && !f.tr) f.tr = ds.fields[j].tr; }); } }); } }
      return s;
    }
  } catch (e) { console.warn('Kon opslag niet lezen', e); }
  return seedData();
}
export function randomTopic() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(10));
  return 'aquamarijn-' + [...b].map((x) => abc[x % abc.length]).join('');
}
export const state = load();
if (!state.settings.ntfyTopic) { state.settings.ntfyTopic = randomTopic(); state.settings.ntfyTopicAuto = true; }
if (!state.settings.ntfyServer) state.settings.ntfyServer = 'https://ntfy.sh';
// v1.12: eigen inbox per toestel (lijstjes ontvangen). Wordt NOOIT overschreven door het meldingskanaal van Beheer.
const _newId = !state.settings.inboxTopic || !state.settings.deviceId;
if (!state.settings.inboxTopic) state.settings.inboxTopic = randomTopic();
if (!state.settings.inboxServer) state.settings.inboxServer = 'https://ntfy.sh';
if (!state.settings.deviceId) state.settings.deviceId = 'd-' + randomTopic().split('-')[1];
if (_newId) queueMicrotask(() => save());
export function save() {
  // MARAD-gegevens (state.maint) nooit in localStorage; die bewaart maint.js in IndexedDB.
  try { localStorage.setItem(KEY, JSON.stringify(state, function (k, v) { return this === state && k === 'maint' ? undefined : v; })); }
  catch (e) { alert('Opslaan mislukt (opslag vol?): ' + e.message); }
}
export function replaceState(next) {
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, next);
  save();
}
export function resetAll() { const keep = { ntfyTopic: state.settings.ntfyTopic, ntfyTopicAuto: state.settings.ntfyTopicAuto, ntfyServer: state.settings.ntfyServer, userName: state.settings.userName }; const d = seedData(); Object.assign(d.settings, keep); replaceState(d); }

export const loc = (id) => state.locations.find((l) => l.id === id);
export const deck = (id) => state.decks.find((d) => d.id === id);
export const route = (id) => state.routes.find((r) => r.id === id);

// ---- Dekplattegronden (afbeeldingen) in IndexedDB ----
const idb = () => self.OutboxCore.openDB();
const planCache = new Map();
export async function getPlan(deckId) {
  if (planCache.has(deckId)) return planCache.get(deckId);
  const db = await idb();
  const v = await new Promise((res) => {
    const q = db.transaction('plans').objectStore('plans').get(deckId);
    q.onsuccess = () => res(q.result || null);
    q.onerror = () => res(null);
  });
  planCache.set(deckId, v);
  return v;
}
export async function setPlan(deckId, dataUrl) {
  const db = await idb();
  await new Promise((res, rej) => {
    const t = db.transaction('plans', 'readwrite');
    t.objectStore('plans').put(dataUrl, deckId);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
  planCache.set(deckId, dataUrl);
  if (!state.plans.includes(deckId)) state.plans.push(deckId);
  save();
}
export async function delPlan(deckId) {
  const db = await idb();
  await new Promise((res) => {
    const t = db.transaction('plans', 'readwrite');
    t.objectStore('plans').delete(deckId);
    t.oncomplete = res; t.onerror = res;
  });
  planCache.delete(deckId);
  state.plans = state.plans.filter((d) => d !== deckId);
  save();
}
