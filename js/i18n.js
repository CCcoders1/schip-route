// Meertaligheid (nl / en / id). Sleutels zijn de Nederlandse teksten (gettext-stijl);
// ontbrekende vertalingen vallen terug op Nederlands.
import { DICT } from './i18n-dict.js';

export const LANGS = {
  nl: { name: 'Nederlands', flag: '🇳🇱' },
  en: { name: 'English', flag: '🇬🇧' },
  id: { name: 'Bahasa Indonesia', flag: '🇮🇩' },
};
export const LOCALES = { nl: 'nl-NL', en: 'en-GB', id: 'id-ID' };

function detect() {
  try {
    const s = JSON.parse(localStorage.getItem('schiproute.v1') || 'null');
    if (s?.settings?.lang && LANGS[s.settings.lang]) return s.settings.lang;
  } catch { /* */ }
  for (const l of navigator.languages || [navigator.language || 'nl']) {
    const c = String(l).toLowerCase();
    if (c.startsWith('nl')) return 'nl';
    if (c.startsWith('id') || c.startsWith('in') || c.startsWith('ms')) return 'id';
    if (c.startsWith('en')) return 'en';
  }
  return 'nl';
}
let lang = detect();
document.documentElement.lang = lang;

export const getLang = () => lang;
export function setLang(l) { if (LANGS[l]) { lang = l; document.documentElement.lang = l; } }

export function t(key, vars) {
  let s = lang === 'nl' ? key : (DICT[lang]?.[key] ?? key);
  if (lang === 'nl' && key.startsWith('csv:')) s = key.slice(4);
  else if (s.startsWith('csv:')) s = s.slice(4);
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return s;
}

// Vertaalbare gebruikersdata: basisveld = Nederlands (of de taal waarin het is ingevoerd),
// vertalingen in obj.tr[lang][key]. Volgorde: huidige taal → basis → en → id.
export function tx(obj, key) {
  if (!obj) return '';
  return (lang !== 'nl' && obj.tr?.[lang]?.[key]) || obj[key] || obj.tr?.nl?.[key] || obj.tr?.en?.[key] || obj.tr?.id?.[key] || '';
}
// Schrijven: met forceLang (taak-editor tabs) altijd in die taal; anders in de huidige taal
// als het object al vertalingen heeft, en anders in het basisveld.
export function setTx(obj, key, val, forceLang) {
  const L = forceLang || lang;
  if (L === 'nl' || (!forceLang && !obj.tr?.[L])) { obj[key] = val; return; }
  obj.tr ??= {}; (obj.tr[L] ??= {})[key] = val;
}
