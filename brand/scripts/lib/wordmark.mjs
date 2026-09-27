// Outlined wordmark + tagline built from Poppins with opentype.js (kerning on), so logo SVGs never
// depend on installed fonts.
import { readFileSync } from 'node:fs';
import { requireDep, resolveDep } from './deps.mjs';

const opentype = requireDep('opentype.js');

const FONT_FILES = {
  400: '@expo-google-fonts/poppins/400Regular/Poppins_400Regular.ttf',
  500: '@expo-google-fonts/poppins/500Medium/Poppins_500Medium.ttf',
  600: '@expo-google-fonts/poppins/600SemiBold/Poppins_600SemiBold.ttf',
  700: '@expo-google-fonts/poppins/700Bold/Poppins_700Bold.ttf',
};

const fmt = (n) => {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};
/** Own serializer (opentype.js 2.0 toPathData can emit NaN for long float offsets). */
function commandsToD(commands, dx, dy) {
  let d = '';
  for (const c of commands) {
    if (c.type === 'M' || c.type === 'L') d += `${c.type}${fmt(c.x + dx)} ${fmt(c.y + dy)}`;
    else if (c.type === 'Q') d += `Q${fmt(c.x1 + dx)} ${fmt(c.y1 + dy)} ${fmt(c.x + dx)} ${fmt(c.y + dy)}`;
    else if (c.type === 'C') d += `C${fmt(c.x1 + dx)} ${fmt(c.y1 + dy)} ${fmt(c.x2 + dx)} ${fmt(c.y2 + dy)} ${fmt(c.x + dx)} ${fmt(c.y + dy)}`;
    else if (c.type === 'Z') d += 'Z';
  }
  return d;
}

const cache = new Map();
export function loadPoppins(weight) {
  if (!cache.has(weight)) {
    const buf = readFileSync(resolveDep(FONT_FILES[weight]));
    cache.set(weight, opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
  }
  return cache.get(weight);
}

export function fontMetrics(weight) {
  const f = loadPoppins(weight);
  const os2 = f.tables.os2;
  return {
    unitsPerEm: f.unitsPerEm,
    capHeight: os2.sCapHeight,
    xHeight: os2.sxHeight,
    ascender: f.ascender,
    descender: f.descender,
  };
}

/**
 * Lay out `runs` ([{text, key}]) on one baseline. Returns per-run path data, total advance and
 * the ink bounds, in the coordinate space where baseline = y and the text starts at x.
 * tracking is in 1/1000 em (e.g. -10 = −1 %).
 */
export function layoutRuns(runs, { weight = 600, size = 100, x = 0, y = 0, tracking = 0 } = {}) {
  const font = loadPoppins(weight);
  const scale = size / font.unitsPerEm;
  const track = (tracking / 1000) * size;
  let cursor = x;
  let prevGlyph = null;
  const out = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const run of runs) {
    const glyphs = font.stringToGlyphs(run.text);
    const parts = [];
    for (const g of glyphs) {
      if (prevGlyph) cursor += font.getKerningValue(prevGlyph, g) * scale;
      const p = g.getPath(0, 0, size);
      const d = commandsToD(p.commands, cursor, y);
      p.commands.forEach((c) => {
        for (const k of ['x', 'x1', 'x2']) if (k in c) c[k] += cursor;
        for (const k of ['y', 'y1', 'y2']) if (k in c) c[k] += y;
      });
      if (d) parts.push(d);
      const bb = p.getBoundingBox();
      if (Number.isFinite(bb.x1) && d) {
        minX = Math.min(minX, bb.x1);
        minY = Math.min(minY, bb.y1);
        maxX = Math.max(maxX, bb.x2);
        maxY = Math.max(maxY, bb.y2);
      }
      cursor += g.advanceWidth * scale + track;
      prevGlyph = g;
    }
    out.push({ key: run.key, d: parts.join('') });
  }
  return {
    runs: out,
    advance: cursor - x - track,
    ink: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    capHeight: fontMetrics(weight).capHeight * scale,
    xHeight: fontMetrics(weight).xHeight * scale,
  };
}
