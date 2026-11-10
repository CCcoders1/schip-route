/* Outbox (klassiek script): gedeeld door de app (window) en de service worker (Background Sync).
   Vragen/observaties + foto's worden in IndexedDB bewaard en verstuurd naar ntfy zodra er internet is. */
(function (g) {
  const DB_NAME = 'schiproute', DB_VERSION = 3;
  let dbp = null;
  function openDB() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('plans')) db.createObjectStore('plans');
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('maint')) db.createObjectStore('maint'); // lokale (ontsleutelde) MARAD-gegevens
      };
      r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); dbp = null; }; res(db); };
      r.onerror = () => { dbp = null; rej(r.error); };
    });
    return dbp;
  }
  function tx(store, mode, fn) {
    return openDB().then((db) => new Promise((res, rej) => {
      const t = db.transaction(store, mode); const s = t.objectStore(store);
      let out; const q = fn(s); if (q) q.onsuccess = () => (out = q.result);
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    }));
  }
  const all = () => tx('outbox', 'readonly', (s) => s.getAll()).then((xs) => (xs || []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  const put = (item) => tx('outbox', 'readwrite', (s) => s.put(item));
  const del = (id) => tx('outbox', 'readwrite', (s) => s.delete(id));
  const get = (id) => tx('outbox', 'readonly', (s) => s.get(id));

  function q(params) { return Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'); }
  async function sendOne(item) {
    const base = (item.server || 'https://ntfy.sh').replace(/\/+$/, '');
    if (!item.topic) throw new Error('Geen meldingskanaal ingesteld');
    if (!item.msgSent) {
      // JSON-publicatie: volledig UTF-8 (titels met – en emoji), werkt met CORS.
      const body = { topic: item.topic, title: item.title, message: item.message, tags: item.tags || [], priority: item.priority || 3 };
      if (item.click) body.click = item.click;
      const r = await fetch(base + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('ntfy ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120));
      item.msgSent = true; await put(item);
    }
    const photos = item.photos || [];
    item.photosSent = item.photosSent || [];
    for (let i = 0; i < photos.length; i++) {
      if (item.photosSent.includes(i)) continue;
      const p = photos[i];
      const url = `${base}/${encodeURIComponent(item.topic)}?` + q({ filename: p.name || `foto-${i + 1}.jpg`, title: p.title || `📷 ${i + 1}/${photos.length} · ${item.title}`, tags: p.tags || 'camera', priority: item.priority >= 4 ? item.priority : undefined });
      const r = await fetch(url, { method: 'PUT', body: p.blob || new Blob([p.buf], { type: p.type || 'application/octet-stream' }) });
      if (!r.ok) throw new Error('foto ' + (i + 1) + ': ntfy ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120));
      item.photosSent.push(i); await put(item);
    }
    item.status = 'sent'; item.sentAt = new Date().toISOString(); item.lastError = ''; await put(item);
  }
  let busy = false;
  async function flushInner() {
    // ook items meenemen die tíjdens het versturen in de outbox kwamen (anders wachten ze op de volgende ronde)
    const tried = new Set(); let sent = 0, failed = 0, net = false;
    for (let round = 0; round < 5 && !net; round++) {
      const items = (await all()).filter((x) => x.status !== 'sent' && !tried.has(x.id));
      if (!items.length) break;
      for (const it of items) {
        tried.add(it.id);
        try { it.attempts = (it.attempts || 0) + 1; await sendOne(it); sent++; }
        catch (e) { failed++; it.lastError = String(e.message || e); it.lastTry = new Date().toISOString(); await put(it).catch(() => {}); if (e instanceof TypeError) { net = true; break; } /* netwerk weg */ }
      }
    }
    return { sent, failed, pending: tried.size - sent };
  }
  async function flush() {
    if (g.navigator && g.navigator.onLine === false) return { sent: 0, failed: 0, offline: true };
    if (g.navigator && g.navigator.locks) return g.navigator.locks.request('schiproute-outbox', { ifAvailable: true }, (lock) => (lock ? flushInner() : { sent: 0, failed: 0, busy: true }));
    if (busy) return { sent: 0, failed: 0, busy: true };
    busy = true; try { return await flushInner(); } finally { busy = false; }
  }
  const kv = { get: (k) => tx('maint', 'readonly', (s) => s.get(k)), put: (k, v) => tx('maint', 'readwrite', (s) => s.put(v, k)), del: (k) => tx('maint', 'readwrite', (s) => s.delete(k)) };
  g.OutboxCore = { openDB, all, put, del, get, flush, sendOne, kv };
})(typeof self !== 'undefined' ? self : this);
