// Raster helpers on top of sharp (librsvg).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { requireDep } from './deps.mjs';
import * as L from './lockups.mjs';

export const sharp = requireDep('sharp');

export function ensureDir(file) {
  mkdirSync(path.dirname(file), { recursive: true });
}

export function writeText(file, content) {
  ensureDir(file);
  writeFileSync(file, content);
}

/** Force an SVG string to render at w × h pixels (keeps its viewBox). */
export function sized(svg, w, h) {
  return svg.replace(/width="[^"]+" height="[^"]+"/, `width="${w}" height="${h}"`);
}

/** Render SVG → PNG file. opts.opaque: flatten on `background` and drop the alpha channel. */
export async function png(svg, file, { opaque = false, background = '#FFFFFF' } = {}) {
  ensureDir(file);
  let img = sharp(Buffer.from(svg), { density: 72 });
  if (opaque) img = img.flatten({ background }).removeAlpha();
  await img.png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(file);
  return file;
}

export async function pngBuffer(svg, { opaque = false, background = '#FFFFFF' } = {}) {
  let img = sharp(Buffer.from(svg), { density: 72 });
  if (opaque) img = img.flatten({ background }).removeAlpha();
  return img.png({ compressionLevel: 9 }).toBuffer();
}

/** Minimal ICO writer with PNG-compressed entries (Windows Vista+, all modern browsers). */
export function icoFromPngs(entries) {
  // entries: [{ size, buf }]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, buf }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.buf)]);
}

// ---- Icon artboards ------------------------------------------------------------------------

const GRADIENT_DEFS = (id) => `
  <linearGradient id="${id}-bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${L.BRAND.navy700}"/>
    <stop offset="0.55" stop-color="${L.BRAND.navy900}"/>
    <stop offset="1" stop-color="#081738"/>
  </linearGradient>
  <radialGradient id="${id}-glow" cx="0.8" cy="0.18" r="0.62">
    <stop offset="0" stop-color="${L.BRAND.cobalt500}" stop-opacity="0.34"/>
    <stop offset="1" stop-color="${L.BRAND.cobalt500}" stop-opacity="0"/>
  </radialGradient>`;

/**
 * Square icon artboard.
 *  bg:     'gradient' | 'solid' | 'none'
 *  shape:  'square' (full bleed) | 'rounded' | 'circle'
 *  inset:  margin (fraction of size) between artboard edge and the background shape
 *  radius: corner radius for 'rounded' (fraction of shape side)
 *  mark:   { width: fraction of size }  or  { safeRadius: fraction of size (max outline distance) }
 *  favicon: use the simplified ≤32 px geometry
 */
export function iconSvg(size, { bg = 'gradient', shape = 'square', inset = 0, radius = 0.2237, mark = { width: 0.7 }, favicon = false, colors = L.COLORWAYS.onNavy, dy = 0 } = {}) {
  const sym = favicon ? L.SYMBOL_FAV : L.SYMBOL;
  const oc = L.opticalCenter(sym);
  let s;
  if (mark.safeRadius) s = (mark.safeRadius * size) / (sym._rmax ??= L.maxRadius(sym, oc));
  else s = (mark.width * size) / sym.bounds.width;
  const id = 'jk';
  const x0 = inset * size;
  const side = size - 2 * x0;
  let shapeEl = '';
  const fill = bg === 'gradient' ? `url(#${id}-bg)` : L.BRAND.navy900;
  if (bg !== 'none') {
    if (shape === 'square') shapeEl = `<rect width="${size}" height="${size}" fill="${fill}"/>`;
    else if (shape === 'rounded') shapeEl = `<rect x="${x0}" y="${x0}" width="${side}" height="${side}" rx="${radius * side}" fill="${fill}"/>`;
    else if (shape === 'circle') shapeEl = `<circle cx="${size / 2}" cy="${size / 2}" r="${side / 2}" fill="${fill}"/>`;
    if (bg === 'gradient') {
      const glow =
        shape === 'circle'
          ? `<circle cx="${size / 2}" cy="${size / 2}" r="${side / 2}" fill="url(#${id}-glow)"/>`
          : shape === 'rounded'
            ? `<rect x="${x0}" y="${x0}" width="${side}" height="${side}" rx="${radius * side}" fill="url(#${id}-glow)"/>`
            : `<rect width="${size}" height="${size}" fill="url(#${id}-glow)"/>`;
      shapeEl += glow;
    }
  }
  const defs = bg === 'gradient' ? `<defs>${GRADIENT_DEFS(id)}</defs>` : '';
  const body = L.symbolPaths(sym, colors, s, size / 2, size / 2 + dy * size, oc.x, oc.y);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${defs}${shapeEl}${body}</svg>`;
}

export { GRADIENT_DEFS };
