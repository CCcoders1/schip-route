// Vereenvoudigde schets van het schip (binnenvaart-tanker/vrachtschip-vorm):
// opbouw + brug achter, lang ruim midscheeps, verhoogde bak (forecastle) en spitse boeg voor.
// Twee aanzichten: 'side' (zijaanzicht) en 'top' (bovenaanzicht). Hek links, boeg rechts.
// Locatie: x = lengte 0-100 (0 = hek), z = hoogte 0-100 (zijaanzicht), w = breedte -1 (BB) .. +1 (SB) (bovenaanzicht).
import { t, tx } from './i18n.js';
export const VIEWS = { side: t('Zijaanzicht'), top: t('Bovenaanzicht') };
const W = 1000;
const X0 = 40, X1 = 960;
const H = { side: 340, top: 300 };
const SIDE = { keel: 300, top: 60, deck: 210, water: 255 };
const TOP = { mid: 150, half: 80 };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PX = (x) => X0 + (x / 100) * (X1 - X0);
const unPX = (px) => ((px - X0) / (X1 - X0)) * 100;

export function locXY(l, view = 'side') {
  const x = PX(l.x ?? 50);
  if (view === 'top') return { x, y: TOP.mid + (l.w ?? 0) * TOP.half };
  return { x, y: SIDE.keel - ((l.z ?? 30) / 100) * (SIDE.keel - SIDE.top) };
}

function sideDrawing() {
  const { keel, deck, water } = SIDE;
  let s = '';
  s += `<rect x="0" y="${water}" width="${W}" height="${H.side - water}" class="water"/>`;
  // romp: afgerond hek, rechte zijde, opgaande bak en spitse steven
  s += `<path class="hull" d="M${X0 + 10} ${deck - 18} L${X0 + 10} ${deck} L880 ${deck} L880 185 L968 182 Q950 260 905 ${keel} L${X0 + 40} ${keel} Q${X0} ${keel - 10} ${X0 + 5} ${deck - 18} Z"/>`;
  // machinekamer & ruim (onder dek, gestippeld)
  s += `<rect class="zone mkz" x="${X0 + 18}" y="${deck + 6}" width="${PX(21) - X0 - 18}" height="${keel - deck - 12}" rx="6"/>`;
  s += `<text class="zlabel" x="${X0 + 24}" y="${deck + 26}">${t('MK')}</text>`;
  s += `<rect class="zone ruimz" x="${PX(24)}" y="${deck + 4}" width="${PX(86) - PX(24)}" height="${keel - deck - 10}" rx="4"/>`;
  s += `<text class="zlabel" x="${PX(55)}" y="${keel - 14}" text-anchor="middle">${t('Ruim')}</text>`;
  // luikhoofden boven het ruim
  s += `<rect class="hatch" x="${PX(24)}" y="${deck - 16}" width="${PX(86) - PX(24)}" height="16" rx="3"/>`;
  for (let x = PX(24) + 70; x < PX(86) - 20; x += 70) s += `<line class="hatchline" x1="${x}" y1="${deck - 16}" x2="${x}" y2="${deck}"/>`;
  // opbouw achter + brug
  s += `<rect class="sup" x="${X0 + 22}" y="128" width="${PX(19) - X0 - 22}" height="${deck - 128}" rx="5"/>`;
  for (let x = X0 + 40; x < PX(19) - 20; x += 34) s += `<rect class="win" x="${x}" y="150" width="20" height="12" rx="2"/><rect class="win" x="${x}" y="178" width="20" height="12" rx="2"/>`;
  s += `<rect class="wheel" x="${PX(4)}" y="72" width="${PX(18) - PX(4)}" height="40" rx="5"/>`;
  s += `<rect class="post" x="${PX(10) - 8}" y="112" width="16" height="16"/>`;
  for (let x = PX(4) + 10; x < PX(18) - 16; x += 26) s += `<rect class="win dark" x="${x}" y="80" width="18" height="14" rx="2"/>`;
  s += `<line class="mast" x1="${PX(94)}" y1="182" x2="${PX(94)}" y2="140"/>`;
  s += `<text class="end" x="${X0}" y="${H.side - 10}">${t('◀ Achter (hek)')}</text><text class="end" text-anchor="end" x="${X1}" y="${H.side - 10}">${t('Voor (boeg) ▶')}</text>`;
  return s;
}

function topDrawing() {
  const { mid, half } = TOP;
  const tp = mid - half - 10, b = mid + half + 10;
  let s = `<rect x="0" y="0" width="${W}" height="${H.top}" class="water"/>`;
  s += `<path class="hull" d="M120 ${tp} L850 ${tp} Q930 ${tp + 20} 978 ${mid} Q930 ${b - 20} 850 ${b} L120 ${b} Q${X0 - 5} ${b} ${X0 - 5} ${mid} Q${X0 - 5} ${tp} 120 ${tp} Z"/>`;
  // zijtanks / gangboorden langs het ruim
  s += `<rect class="sidetank" x="${PX(24)}" y="${tp + 8}" width="${PX(86) - PX(24)}" height="18" rx="3"/>`;
  s += `<rect class="sidetank" x="${PX(24)}" y="${b - 26}" width="${PX(86) - PX(24)}" height="18" rx="3"/>`;
  for (let x = PX(24) + 90; x < PX(86) - 30; x += 90) { s += `<line class="hatchline" x1="${x}" y1="${tp + 8}" x2="${x}" y2="${tp + 26}"/><line class="hatchline" x1="${x}" y1="${b - 26}" x2="${x}" y2="${b - 8}"/>`; }
  s += `<rect class="zone ruimz" x="${PX(24)}" y="${tp + 32}" width="${PX(86) - PX(24)}" height="${b - tp - 64}" rx="4"/>`;
  s += `<text class="zlabel" x="${PX(55)}" y="${mid + 34}" text-anchor="middle">${t('Ruim')}</text>`;
  // opbouw + machinekamer achter
  s += `<rect class="sup" x="${X0 + 20}" y="${tp + 18}" width="${PX(19) - X0 - 20}" height="${b - tp - 36}" rx="10"/>`;
  s += `<text class="zlabel" x="${X0 + 30}" y="${tp + 36}">${t('Opbouw / MK')}</text>`;
  // bak voor
  s += `<path class="zone voorz" d="M${PX(87)} ${tp + 12} L850 ${tp + 12} Q915 ${tp + 30} 955 ${mid} Q915 ${b - 30} 850 ${b - 12} L${PX(87)} ${b - 12} Z"/>`;
  s += `<text class="zlabel" x="${PX(88)}" y="${tp + 30}">${t('Bak')}</text>`;
  s += `<text class="end" x="${X1 - 10}" y="${tp - 4}" text-anchor="end">${t('BB (bakboord)')}</text><text class="end" x="${X1 - 10}" y="${b + 18}" text-anchor="end">${t('SB (stuurboord)')}</text>`;
  s += `<text class="end" x="${X0}" y="${b + 18}">${t('◀ Hek')}</text>`;
  return s;
}

/** opts: { view, locations, highlight, numbers: Map(locId -> [nr]), dim, labels, ship } */
export function shipSVG(opts) {
  const { view = 'side', locations, highlight, numbers, dim, labels = false, ship = '' } = opts;
  let s = `<svg class="ship ${view}" data-view="${view}" viewBox="0 0 ${W} ${H[view]}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(VIEWS[view])} ${esc(ship)}">`;
  s += view === 'top' ? topDrawing() : sideDrawing();
  const r = view === 'top' ? 12 : 14;
  const lbls = [];
  let li = 0;
  for (const l of locations) {
    const { x, y } = locXY(l, view);
    const nr = numbers?.get(l.id);
    const hl = highlight === l.id;
    if (numbers && !nr && !hl) continue;
    const cls = `mk${hl ? ' hl' : ''}${dim && !hl ? ' dim' : ''}${nr ? ' used' : ''}`;
    s += `<g class="${cls}" data-act="mapLoc" data-id="${esc(l.id)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">`;
    if (hl) s += `<circle class="pulse" r="28"/>`;
    s += `<circle class="dot" r="${hl ? 20 : r}"/>`;
    if (nr) s += `<text class="nr" y="5">${esc(nr.length > 2 ? nr[0] + '+' : nr.join(','))}</text>`;
    s += `<title>${esc(tx(l, 'name'))}</title></g>`;
    if (hl || labels) {
      const anchor = x < 260 ? 'start' : x > 740 ? 'end' : 'middle';
      const lx = anchor === 'start' ? Math.max(x - 22, 8) : anchor === 'end' ? Math.min(x + 22, W - 8) : x;
      const below = !hl && li++ % 2 === 1;
      lbls.push(`<text class="lbl${hl ? ' hl' : ''}" x="${lx.toFixed(1)}" y="${(below ? y + 30 : y - (hl ? 32 : 19)).toFixed(1)}" text-anchor="${anchor}">${esc(tx(l, 'name'))}</text>`);
    }
  }
  s += lbls.join('') + `</svg>`;
  return s;
}

// Zet een tik op de SVG om naar positievelden voor het actieve aanzicht.
export function svgPointToLoc(svg, evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  const x = Math.round(Math.min(100, Math.max(0, unPX(p.x))) * 10) / 10;
  if (svg.dataset.view === 'top') {
    const w = Math.max(-1, Math.min(1, (p.y - TOP.mid) / TOP.half));
    return { x, w: Math.round(w * 100) / 100 };
  }
  const z = Math.max(0, Math.min(100, ((SIDE.keel - p.y) / (SIDE.keel - SIDE.top)) * 100));
  return { x, z: Math.round(z) };
}
