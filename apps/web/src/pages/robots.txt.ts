import type { APIRoute } from 'astro';

// NOTE: crawlers only read robots.txt at the DOMAIN ROOT (https://antarkitaindonesia.com/robots.txt).
// This file is published at /jastipkita/robots.txt for reference and as the block to merge into the root
// robots.txt of the antarkita-landing repo (scripts/deploy-to-landing.sh --robots does it idempotently).
export const GET: APIRoute = () =>
  new Response(
    [
      '# BEGIN JastipKita (/jastipkita/) — managed by apps/web/scripts/deploy-to-landing.sh',
      'User-agent: *',
      'Allow: /jastipkita/',
      'Disallow: /jastipkita/akun/',
      'Disallow: /jastipkita/app/',
      '',
      'Sitemap: https://antarkitaindonesia.com/jastipkita/sitemap-index.xml',
      '# END JastipKita',
      '',
    ].join('\n'),
    { headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
