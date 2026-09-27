# ADR 0007 — Astro static web under antarkitaindonesia.com/jastipkita

- Status: Accepted (2026-09)
- Deciders: owner (GM)

## Context
The owner already runs `antarkitaindonesia.com` from the GitHub Pages repository `erzamadana-ui/antarkita-landing`.
The `jastipkita.com/.id/.co.id` domains are registered by others (research 04). The site must be fast, SEO-friendly
(customs calculator, restricted-items checker, country pages), cheap, and host legal pages and the account-deletion
URL required by Google Play.

## Decision
- `apps/web` is an **Astro** static site with `base: '/jastipkita'`, published into the `jastipkita/` folder of
  `antarkita-landing` by `deploy-staging.yml` when `LANDING_DEPLOY_TOKEN` exists (otherwise build artifact only).
- Only public, build-time values (`PUBLIC_*`); calculators reuse `packages/core` so numbers match the API.
- Private paths are excluded from the sitemap and marked noindex (`/akun/`, `/app/`, `/masuk/`, `/r/`).
- The Flutter web build is served under `/jastipkita/app/` (kept by the publish step).

## Consequences
- GitHub Pages has one environment: anything published is public "production". Until the API is production-ready,
  web content must not claim live service; forms must degrade to "segera hadir".
- Jekyll on GitHub Pages ignores `_`-prefixed folders; Astro emits `_assets/` → the landing repo needs `.nojekyll`
  (the workflow refuses to publish without it unless `LANDING_ADD_NOJEKYLL=true`).
- Brand/SEO depends on the AntarKita domain; if JastipKita gets its own domain later, add redirects.

## Alternatives considered
- Next.js on Vercel — server features not needed; vendor lock and cost later.
- Separate domain now — the obvious domains are taken; buying one is an owner decision.
