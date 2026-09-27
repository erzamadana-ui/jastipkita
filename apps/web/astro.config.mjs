// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

/**
 * JastipKita public website.
 * Served from a sub-path of the AntarKita domain: https://antarkitaindonesia.com/jastipkita/
 * Every internal link and asset MUST go through `url()` / `asset()` in src/lib/paths.ts (base-aware).
 */
const NOINDEX_PREFIXES = ['/jastipkita/akun/', '/jastipkita/app/', '/jastipkita/masuk/', '/jastipkita/r/', '/jastipkita/404'];

export default defineConfig({
  site: 'https://antarkitaindonesia.com',
  base: '/jastipkita',
  trailingSlash: 'always',
  output: 'static',
  build: {
    format: 'directory',
    assets: '_assets',
    inlineStylesheets: 'auto',
  },
  compressHTML: true,
  integrations: [
    sitemap({
      filter: (page) => !NOINDEX_PREFIXES.some((p) => new URL(page).pathname.startsWith(p)),
      changefreq: 'weekly',
      lastmod: new Date('2026-09-27'),
    }),
  ],
  vite: {
    build: { assetsInlineLimit: 2048 },
  },
});
