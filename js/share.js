// Routes delen zonder server: gecomprimeerd in de URL-hash, of als .json-bestand.
const b64u = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (str) => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
export async function encodePayload(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if ('CompressionStream' in self) {
    try { return 'z' + b64u(await pipe(bytes, new CompressionStream('deflate-raw'))); } catch (e) { /* val terug */ }
  }
  return 'j' + b64u(bytes);
}
export async function decodePayload(str) {
  const kind = str[0], data = unb64u(str.slice(1));
  const bytes = kind === 'z' ? await pipe(data, new DecompressionStream('deflate-raw')) : data;
  return JSON.parse(new TextDecoder().decode(bytes));
}
// Bundel route + gebruikte locaties/dekken, zodat de ontvanger alles heeft.
export function routePackage(state, r, to = '') {
  const used = new Set(r.steps.map((s) => s.locationId));
  const locations = state.locations.filter((l) => used.has(l.id));
  const decks = state.decks.filter((d) => locations.some((l) => l.deck === d.id));
  return { app: 'schiproute', kind: 'route', v: 1, ship: state.shipName, to, from: state.settings.userName || '', replyTo: { name: state.settings.userName || '', phone: state.settings.userPhone || '' }, notify: state.settings.ntfyTopic ? { topic: state.settings.ntfyTopic, server: state.settings.ntfyServer || 'https://ntfy.sh' } : null, sentAt: new Date().toISOString(), route: r, locations, decks };
}
export async function buildShareLink(pkg) {
  const base = location.href.split('#')[0].split('?')[0];
  return `${base}#${pkg.kind === 'report' ? 'report' : 'route'}=${await encodePayload(pkg)}`;
}
// Leest #route=… of #report=… uit de URL (of uit een geplakte tekst/link).
export async function readHashPayload(text = location.hash) {
  const m = String(text).match(/(?:route|report)=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  return decodePayload(m[1]);
}
// Compact rapport van een afgeronde ronde (bemanning → beheer).
export function reportPackage(state, run, route) {
  return {
    app: 'schiproute', kind: 'report', v: 1, runId: run.id, routeId: run.routeId, routeName: run.routeName, ship: state.shipName,
    by: run.by || state.settings.userName || '', startedAt: run.startedAt, finishedAt: run.finishedAt, lang: state.settings.lang || 'nl',
    to: route?.from || '',
    results: run.results.map((x) => ({ stepId: x.stepId, marad: x.marad || null, title: x.title, titleNl: x.titleNl, locationId: x.locationId, locName: x.locName, locNl: x.locNl, deckName: x.deckName, status: x.status, at: x.at, values: x.values, fields: (x.fields || []).map((f) => ({ id: f.id, label: f.label, type: f.type, unit: f.unit, min: f.min, max: f.max, role: f.role, tr: f.tr })), outOfRange: x.outOfRange, note: x.note })),
    messages: run.messages || [],
  };
}
