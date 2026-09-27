// Logo lockups (symbol, horizontal, vertical, vertical + tagline) as self-contained SVG strings.
// Every transform is baked into the path data: output = <svg> + <path fill d> only.
import { requireDep } from './deps.mjs';
import { buildSymbol, FAVICON_PARAMS, transformPathData } from './geometry.mjs';
import { layoutRuns } from './wordmark.mjs';

const paper = requireDep('paper');

// Brand primitives (mirror of packages/design-tokens/tokens.json → color.primitive).
export const BRAND = {
  navy950: '#070B19',
  navy900: '#0B1E4A',
  navy800: '#12295F',
  navy700: '#173068',
  cobalt500: '#1E5BFF',
  cobalt400: '#4D7DFF',
  offwhite50: '#F7F8FB',
  slate500: '#64748B',
  slate300: '#CBD5E1',
  ink900: '#0F172A',
  white: '#FFFFFF',
  black: '#000000',
};

export const COLORWAYS = {
  light: { bag: BRAND.navy900, accent: BRAND.cobalt500, word1: BRAND.navy900, word2: BRAND.cobalt500, tagline: BRAND.slate500 },
  dark: { bag: BRAND.offwhite50, accent: BRAND.cobalt400, word1: BRAND.offwhite50, word2: BRAND.cobalt400, tagline: BRAND.slate300 },
  'mono-black': { bag: BRAND.black, accent: BRAND.black, word1: BRAND.black, word2: BRAND.black, tagline: BRAND.black },
  'mono-white': { bag: BRAND.white, accent: BRAND.white, word1: BRAND.white, word2: BRAND.white, tagline: BRAND.white },
  // App-icon colourway: white bag, bright cobalt swoosh on the navy tile.
  onNavy: { bag: BRAND.white, accent: BRAND.cobalt400, word1: BRAND.offwhite50, word2: BRAND.cobalt400, tagline: BRAND.slate300 },
};

// ---- Geometry (computed once) -------------------------------------------------------------
export const SYMBOL = buildSymbol();
export const SYMBOL_FAV = buildSymbol(FAVICON_PARAMS);

export const TYPE = {
  wordWeight: 600,
  wordTracking: -15, // 1/1000 em
  tagWeight: 500,
  tagTracking: 0,
};
export const WORD = layoutRuns(
  [
    { text: 'Jastip', key: 'jastip' },
    { text: 'Kita', key: 'kita' },
  ],
  { weight: TYPE.wordWeight, size: 100, tracking: TYPE.wordTracking },
);
export const TAGLINE_TEXT = 'Titip Mudah, Aman, Terpercaya.';
const TAG_RAW = layoutRuns([{ text: TAGLINE_TEXT, key: 'tag' }], { weight: TYPE.tagWeight, size: 100, tracking: TYPE.tagTracking });

/** Lockup proportions, expressed against the wordmark cap height (capH). */
export const PROPORTIONS = {
  horizontal: { symbolHeight: 2.25, gap: 0.62, baselineShift: 0.06 },
  vertical: { symbolWidth: 0.6, gap: 0.5 },
  tagline: { width: 0.94, gap: 0.62 },
  padding: 0.25, // around every lockup, × capH
};

// Mass centroid of a symbol (grid sampling), used for optical centring.
function centroid(sym) {
  const items = [sym.bag, sym.swoosh, sym.plane].filter(Boolean).map((d) => new paper.CompoundPath(d));
  const b = sym.bounds;
  const N = 140;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const p = new paper.Point(b.x + ((i + 0.5) / N) * b.width, b.y + ((j + 0.5) / N) * b.height);
      if (items.some((it) => it.contains(p))) {
        sx += p.x;
        sy += p.y;
        n++;
      }
    }
  }
  items.forEach((it) => it.remove());
  return { x: sx / n, y: sy / n };
}

/** Optical centre: halfway between the bounding-box centre and the mass centroid. */
export function opticalCenter(sym) {
  if (!sym._optical) {
    const c = centroid(sym);
    const b = sym.bounds;
    sym._optical = { x: (b.x + b.width / 2 + c.x) / 2, y: (b.y + b.height / 2 + c.y) / 2 };
  }
  return sym._optical;
}

/** Max distance from `center` to any outline point (for circular safe zones). */
export function maxRadius(sym, center) {
  const items = [sym.bag, sym.swoosh, sym.plane].filter(Boolean).map((d) => new paper.CompoundPath(d));
  let r = 0;
  const c = new paper.Point(center.x, center.y);
  for (const it of items) {
    for (const child of it.children) {
      const L = child.length;
      for (let k = 0; k <= 400; k++) r = Math.max(r, child.getPointAt((k / 400) * L).getDistance(c));
    }
    it.remove();
  }
  return r;
}

const m = (s, tx, ty) => [s, 0, 0, s, tx, ty];

/** Symbol paths placed with scale s so that design point (ox, oy) lands on (x, y). */
export function symbolPaths(sym, colors, s, x, y, ox, oy) {
  const t = m(s, x - ox * s, y - oy * s);
  const out = [];
  out.push(`<path fill="${colors.bag}" d="${transformPathData(sym.bag, t)}"/>`);
  out.push(`<path fill="${colors.accent}" d="${transformPathData(sym.swoosh, t)}"/>`);
  if (sym.plane) out.push(`<path fill="${colors.accent}" d="${transformPathData(sym.plane, t)}"/>`);
  return out.join('');
}

function wordPaths(colors, s, x, baseline) {
  // WORD is laid out at size 100 on baseline 0 starting at x = 0.
  const t = m(s, x, baseline);
  return (
    `<path fill="${colors.word1}" d="${transformPathData(WORD.runs[0].d, t)}"/>` +
    `<path fill="${colors.word2}" d="${transformPathData(WORD.runs[1].d, t)}"/>`
  );
}

function svgDoc(w, h, body, title = 'JastipKita') {
  const W = Math.round(w * 100) / 100;
  const H = Math.round(h * 100) / 100;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;
}

// ---- Lockups ------------------------------------------------------------------------------
// Unit system: wordmark at font-size 100 → capH ≈ 69.8 units.
const capH = WORD.capHeight;
const pad = PROPORTIONS.padding * capH;

export function horizontal(colors) {
  const P = PROPORTIONS.horizontal;
  const sym = SYMBOL;
  const symH = P.symbolHeight * capH;
  const s = symH / sym.bounds.height;
  const symW = sym.bounds.width * s;
  const top = pad;
  const left = pad;
  const symbol = symbolPaths(sym, colors, s, left, top, sym.bounds.x, sym.bounds.y);
  const midY = top + symH / 2 + P.baselineShift * capH;
  const baseline = midY + capH / 2;
  const wx = left + symW + P.gap * capH - WORD.ink.x;
  const words = wordPaths(colors, 1, wx, baseline);
  const right = wx + WORD.ink.x + WORD.ink.width;
  const bottom = Math.max(top + symH, baseline + WORD.ink.y + WORD.ink.height);
  const height = bottom + pad;
  return { svg: svgDoc(right + pad, height, symbol + words), width: right + pad, height };
}

export function vertical(colors, { tagline = false } = {}) {
  const P = PROPORTIONS.vertical;
  const sym = SYMBOL;
  const wordW = WORD.ink.width;
  const symW = P.symbolWidth * wordW;
  const s = symW / sym.bounds.width;
  const symH = sym.bounds.height * s;
  const oc = opticalCenter(sym);
  let W = wordW;
  let tag = null;
  if (tagline) {
    const ts = (PROPORTIONS.tagline.width * wordW) / TAG_RAW.ink.width;
    tag = { s: ts, w: TAG_RAW.ink.width * ts };
    W = Math.max(W, tag.w);
  }
  const width = W + 2 * pad;
  const cx = width / 2;
  const top = pad;
  // centre the symbol optically (x) — bounding box top stays at `top`
  const symbol = symbolPaths(sym, colors, s, cx, top, oc.x, sym.bounds.y);
  const wordTop = top + symH + P.gap * capH;
  const baseline = wordTop - WORD.ink.y; // ink.y is negative (above baseline)
  const wx = cx - wordW / 2 - WORD.ink.x;
  let body = symbol + wordPaths(colors, 1, wx, baseline);
  let bottom = baseline + WORD.ink.y + WORD.ink.height;
  if (tag) {
    // gap measured from the lowest wordmark ink (descender of "p") to the tagline's ink top
    const tBase = baseline + (WORD.ink.y + WORD.ink.height) + PROPORTIONS.tagline.gap * capH - TAG_RAW.ink.y * tag.s;
    const tx = cx - tag.w / 2 - TAG_RAW.ink.x * tag.s;
    body += `<path fill="${colors.tagline}" d="${transformPathData(TAG_RAW.runs[0].d, m(tag.s, tx, tBase))}"/>`;
    bottom = tBase + (TAG_RAW.ink.y + TAG_RAW.ink.height) * tag.s;
  }
  const height = bottom + pad;
  return { svg: svgDoc(width, height, body), width, height };
}

/** Square symbol artboard. `fill` = fraction of the side taken by the mark's larger dimension. */
export function symbolSquare(colors, { favicon = false, fill = 0.9, size = 512 } = {}) {
  const sym = favicon ? SYMBOL_FAV : SYMBOL;
  const s = (fill * size) / Math.max(sym.bounds.width, sym.bounds.height);
  const oc = opticalCenter(sym);
  const body = symbolPaths(sym, colors, s, size / 2, size / 2, oc.x, oc.y);
  return { svg: svgDoc(size, size, body, favicon ? 'JastipKita favicon' : 'JastipKita'), width: size, height: size };
}

/** Wordmark only (used for splash branding, footers). */
export function wordmarkOnly(colors) {
  const width = WORD.ink.width + 2 * pad;
  const baseline = pad - WORD.ink.y;
  const height = baseline + WORD.ink.y + WORD.ink.height + pad;
  return { svg: svgDoc(width, height, wordPaths(colors, 1, pad - WORD.ink.x, baseline)), width, height };
}

/** Tagline outline paths at a given size/position (for social graphics). */
export function taglinePaths(color, fontSize, x, baseline, text = TAGLINE_TEXT, weight = 500, tracking = 0) {
  const t = layoutRuns([{ text, key: 't' }], { weight, size: fontSize, x, y: baseline, tracking });
  return { d: `<path fill="${color}" d="${t.runs[0].d}"/>`, width: t.advance, ink: t.ink };
}
