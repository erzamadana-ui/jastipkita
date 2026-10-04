# ADR 0007 — Astro static web under antarkitaindonesia.com/jastipkita

- Status: Accepted (2026-09) · amended 2026-10-04 (shared origin kept; web refresh token in an HttpOnly cookie — see below)
- Deciders: owner (GM); amendment: Commissioner (2026-10-04)

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

## Amendment 2026-10-04 — stay on the shared origin; refresh token in an HttpOnly cookie (SEC-14)

### Context
The security review (`docs/security/review-2026-09.md`, SEC-14) recommended moving the web to its own subdomain because
`antarkitaindonesia.com/jastipkita` shares its **origin** with every other AntarKita page: an XSS anywhere on the domain could read
the web's tokens from `sessionStorage` and call the API as the user.

### Decision (Commissioner, 2026-10-04)
- The public web **stays** at `https://antarkitaindonesia.com/jastipkita` (no subdomain; brand/SEO continuity with AntarKita).
- Engineering closes as much of SEC-14 as possible without a separate origin:
  1. strict CSP on every page (meta, inline theme script by hash; verified at build by `scripts/postbuild.mjs`);
  2. **cookie transport** for the refresh token: the web sends `X-JK-Token-Transport: cookie` on login/refresh/logout and the API
     (`apps/api/src/modules/auth/cookie-transport.ts`) keeps the refresh token in `jk_rt` — `HttpOnly; Secure; SameSite=Strict;
     Path=/v1/auth`, host-only on the API host, Max-Age = refresh TTL — omitting it from the JSON body. The production API host
     (`api.antarkitaindonesia.com` / `jastipkita-api.antarkitaindonesia.com`) is same-site with `antarkitaindonesia.com`, so the
     Strict cookie flows on credentialed fetches;
  3. CSRF: SameSite=Strict + the custom header (CORS preflight) + `Origin` ∈ web allow-list (`WEB_BASE_URL` + `CORS_ORIGINS`) whenever
     the cookie is used; credentialed CORS only for those origins;
  4. access token in memory only; no token in web storage (the old `jk:refresh` key is deleted on load); refreshes serialized across
     tabs with Web Locks (shared rotating cookie vs. reuse detection).
- Mobile and admin keep body tokens (default transport); rotation and reuse detection are unchanged.

### Consequences
- **Residual risk (accepted):** script injected into another page of the same origin can still act inside the victim's browser — drive
  an open JastipKita tab, or call `/v1/auth/refresh` with credentials to obtain 15-minute access tokens — but can no longer exfiltrate
  the refresh token for offline use. Required outside this repo: a CSP of equal strength across the **whole** `antarkitaindonesia.com`
  origin, a security review of the other AntarKita pages, and `frame-ancestors 'none'` as a real response header (meta is ignored).
- The web session now survives tab close (persistent cookie, 30 days) instead of being per-tab; logout revokes it server-side.
- Staging must put the API on a domain that is same-site with the web (e.g. a custom domain under `antarkitaindonesia.com`); on
  `*.workers.dev` the browser drops the cookie and web sessions end at the next page load.
- `docs/legal/cookie-policy.md` 0.3-template lists `jk_rt` as a strictly-necessary cookie.
- Revisit (own subdomain or domain) if the other AntarKita pages cannot meet the CSP/review requirement.
