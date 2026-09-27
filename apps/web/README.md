# @jastipkita/web — public website

Static Astro site for **JastipKita** ("Titip Mudah, Aman, Terpercaya."), served from a sub-path of the AntarKita domain:

> **https://antarkitaindonesia.com/jastipkita/**

Zero-framework, near-zero JS (small vanilla TypeScript islands for the calculator, item checker, trip search, help search, login/account). Design tokens come from `@jastipkita/design-tokens`; every number shown in marketing copy (fees, limits, SLAs, customs examples) is computed **at build time** from `@jastipkita/core` + `DEFAULT_BUSINESS_CONFIG` + the seed rules, so the site cannot drift from the engines.

## Pages

| Path (under `/jastipkita`) | What | Index |
|---|---|---|
| `/` · `/en/` | Landing (hero, how it works, SafePay, 11-line breakdown example, trust, countries, traveler earnings, FAQ, early access — **no testimonials**) | ✓ |
| `/jastip-jepang/` `/jastip-korea/` `/jastip-singapore/` `/jastip-usa/` `/jastip-malaysia/` `/jastip-australia/` | SEO country pages from `src/data/countries.ts` (categories with live restricted status, merchants, customs example via core engine, restricted highlights from the seed, tips, FAQ + JSON-LD) | ✓ |
| `/trip/` | Trip discovery → `GET /v1/trips` (shows `trustBadge`, `trustScore` + `trustTier`, `kycLevel`, rating); honest "layanan segera hadir" when the API is unreachable | ✓ |
| `/kalkulator-bea-cukai/` · `/en/customs-calculator/` | Customs & tax estimator → `POST /v1/customs/estimate`, offline fallback = same PMK 34/2025 formula (`src/lib/customs.ts`, cross-checked against core at build) | ✓ |
| `/cek-barang-terlarang/` · `/en/restricted-items/` | Restricted items checker → `POST /v1/restricted/check`, offline fallback over the seed snapshot | ✓ |
| `/bantuan/` · `/bantuan/<slug>/` | Help center (25 static articles incl. the 7 seed FAQ slugs; search merges `GET /v1/support/faq` when live) | ✓ |
| `/hapus-akun/` · `/en/delete-account/` | **Public account & data deletion page (Google Play requirement)** | ✓ |
| `/legal/` · `/legal/<slug>/` | 10 legal templates rendered from `../../docs/legal/*.md` with TOC; when the API is reachable the latest published **version & effective date** from `GET /v1/legal/documents` replace the static ones (with a notice if the server has a newer version than the static text) | ✓ |
| `/masuk/` | OTP login (e-mail / WhatsApp / SMS) → `/v1/auth/otp/*`; optional Google button; signup consent step (see *Consent versions*) | noindex |
| `/akun/` | Profile (`GET /v1/me`), data export, **delete account** (`POST /v1/privacy/delete-account`, 14-day grace, cancel) | noindex + robots Disallow |
| `/app/transactions/` | Deep-link fallback ("Buka di aplikasi"), reads `?id=` / path / hash, validates the id | noindex + robots Disallow |
| `/r/` | Referral landing, reads `?code=` / path / hash client-side | noindex |
| `404.html`, `robots.txt`, `sitemap-index.xml`, `site.webmanifest`, favicons, `og-image.png` | | |

## Environment variables (build time, `PUBLIC_*` are inlined — never secrets)

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_API_BASE_URL` | `https://api.antarkitaindonesia.com/jastipkita` (placeholder, not deployed) | API origin + prefix; the site calls `${PUBLIC_API_BASE_URL}/v1/...` |
| `PUBLIC_SUPPORT_WHATSAPP` | empty → "segera diumumkan" | CS WhatsApp number, digits only, e.g. `628xxxxxxxxxx` |
| `PUBLIC_SUPPORT_EMAIL` | empty → placeholder text | CS / privacy e-mail shown in footer, help & deletion pages |
| `PUBLIC_PLAY_STORE_URL` | empty → disabled "Segera hadir" button | Google Play listing |
| `PUBLIC_APP_STORE_URL` | empty → disabled "Segera hadir" button | App Store listing |
| `PUBLIC_ENABLE_GOOGLE_LOGIN` / `PUBLIC_GOOGLE_CLIENT_ID` | `false` / empty | Show "Masuk dengan Google" (GIS script loads only on click) |

Copy `.env.example` → `.env` (git-ignored). **API side:** set `WEB_BASE_URL=https://antarkitaindonesia.com/jastipkita` (the API builds legal page URLs as `${WEB_BASE_URL}/legal/<slug>/`) and add the origin `https://antarkitaindonesia.com` to `CORS_ORIGINS` (a CORS origin has no path), otherwise browsers block the calls and the site stays in offline mode.

## Develop, build, test

```bash
# from the repo root (Node ≥ 22.18, pnpm 10)
pnpm install --filter @jastipkita/web
pnpm --filter @jastipkita/web dev          # http://localhost:4321/jastipkita/
pnpm --filter @jastipkita/web build        # → apps/web/dist (everything under /jastipkita/)
pnpm --filter @jastipkita/web preview      # serves dist like production (dist at /jastipkita/, well-known/ at /.well-known/)
pnpm --filter @jastipkita/web check        # astro check (TypeScript 5)
pnpm --filter @jastipkita/web test         # unit tests (node --test) + Playwright smoke tests against dist
pnpm --filter @jastipkita/web screenshots  # screenshots/ (landing, jastip-jepang, kalkulator × desktop/mobile × light/dark)
```

`build` = `scripts/sync-content.mjs` (regenerates `src/data/restricted-items.generated.json` from `db/seeds/0101_restricted_items.sql`; keeps the committed file if `db/` is absent) → `astro build` → `scripts/postbuild.mjs` (rewrites `*.md` cross-links in legal docs, asserts the base path). Playwright uses the preinstalled Chromium (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`); never run `playwright install` in this environment.

`tests/api-contract.spec.ts` mocks the API in the browser to cover the 2026-09-27 contract: consent versions from requirements + one retry after 422, the front-matter fallback, legal version/effective date from `GET /v1/legal/documents`, and the new trust fields in trip discovery.

Smoke tests (`tests/smoke.spec.ts`) check every built page: HTTP 200, exactly one `<h1>`, title/description/canonical, `lang`, landmarks + skip link, JSON-LD parses, `noindex` where required, img alt, **no broken internal links/assets**, **no horizontal overflow at 390 px**, sitemap/robots content, legal TOC + template banner, offline calculator result (JPY 60.000 → Rp 1.885.000, matching `docs/research/01` §6), offline item checker, trip "segera hadir", deep-link validation/XSS, consent banner (no storage before a choice, **no third-party requests**), and the well-known JSON.

## Deployment to antarkitaindonesia.com/jastipkita

The apex domain is served by GitHub Pages from **`erzamadana-ui/antarkita-landing`** (DNS apex A records → GitHub, `CNAME` = `antarkitaindonesia.com`). JastipKita is deployed **into that repo** as the `jastipkita/` folder:

```bash
git clone git@github.com:erzamadana-ui/antarkita-landing.git ~/src/antarkita-landing
cd <this repo>
apps/web/scripts/deploy-to-landing.sh ~/src/antarkita-landing --robots   # builds, then syncs
cd ~/src/antarkita-landing && git status && git add jastipkita .well-known .nojekyll robots.txt && git commit -m "deploy: jastipkita" && git push
```

`deploy-to-landing.sh <landing-clone> [--robots] [--no-build] [--dry-run] [--force-nojekyll]` only touches:

- `jastipkita/` — mirror of `dist/` (rsync `--delete` scoped to that folder; `cp` fallback without rsync);
- `.well-known/assetlinks.json` and `.well-known/apple-app-site-association` (other `.well-known` files are kept);
- `.nojekyll` — created if missing so Pages serves the dot-folder (refused if the landing repo uses Jekyll `_config.yml`, unless `--force-nojekyll`);
- `robots.txt` — **only with `--robots`**: inserts/replaces the `# BEGIN JastipKita … # END JastipKita` block (idempotent). Crawlers read robots.txt **only at the domain root**; `/jastipkita/robots.txt` is informational.

It never touches `CNAME`, `index.html` or anything else, and never commits/pushes.

### Things that MUST live at the domain root (`antarkita-landing`)

| File | Why | Source |
|---|---|---|
| `/.well-known/assetlinks.json` | Android App Links for `com.antarkitaindonesia.jastipkita` — replace the SHA-256 placeholder with the **Play App Signing** certificate fingerprint | `well-known/assetlinks.json` |
| `/.well-known/apple-app-site-association` | iOS Universal Links for `/jastipkita/app/*` and `/jastipkita/r/*` — replace `TEAMID`; served as JSON without extension | `well-known/apple-app-site-association` |
| `/robots.txt` | merge the JastipKita block (`--robots`) | `dist/robots.txt` |
| `/404.html` | GitHub Pages has **one** 404 page per site. Paste `well-known/landing-404-snippet.html` into the landing 404 `<head>` so `/jastipkita/app/transactions/<id>` → `/jastipkita/app/transactions/?id=<id>`, `/jastipkita/r/<code>` → `/jastipkita/r/?code=<code>`, other `/jastipkita/*` misses → `/jastipkita/404.html` | snippet |
| `/.well-known/security.txt` | *(guidance)* RFC 9116 contact for vulnerability reports. Publish **only** once a monitored security mailbox exists; refresh `Expires` yearly | `well-known/security.txt.example` |

Verify after pushing: `https://antarkitaindonesia.com/.well-known/assetlinks.json` (Google's Statement List tester), the AASA file (`curl -I` → 200, `application/json`, no redirect), `https://antarkitaindonesia.com/jastipkita/sitemap-index.xml`, and submit the sitemap in Search Console for the `antarkitaindonesia.com` property.

## Consent versions (signup)

The API only accepts consent versions that match a published legal document (`422 CONSENT_VERSION_INVALID` otherwise — `docs/api/CHANGELOG.md`, 2026-09-27). The web never hard-codes a version:

1. OTP verify / Google sign-in is sent **without** consents first; existing users are simply signed in.
2. On `422 CONSENT_REQUIRED` the consent step is shown, listing the documents from `GET /v1/consents/requirements` (`signup.required` + `signup.optional`, exact `type`/`version`/title/URL). The OTP code is not consumed, so the same code is re-submitted with the consents.
3. If requirements are unreachable, versions/titles come from the **build-time fallback**: the `version` front-matter of `docs/legal/terms-of-service.md`, `privacy-policy.md`, `marketing-consent.md` (currently `0.1-template`, the same version the API seeds from `docs/legal`).
4. On `422 CONSENT_VERSION_INVALID` the requirements are re-fetched once (plus `details.allowedVersions` is applied) and the request is retried **once**; a second failure is shown to the user.

Code: `src/lib/consents.ts`, `src/scripts/login.ts`; covered by `tests/api-contract.spec.ts` (mocked API). When Compliance publishes a new legal version, bump the `version` front-matter in `docs/legal/*.md` together with the published text.

## Security (SEC-14 — shared origin) & storage

**Risk:** the site is served from `https://antarkitaindonesia.com/jastipkita/`, i.e. the **same origin** as every other AntarKita page on that domain. Any XSS on another page of `antarkitaindonesia.com` (outside this repo) runs with JastipKita's origin: it can read `sessionStorage`/`localStorage` of that tab and call the API as the signed-in user. The controls below reduce the blast radius but cannot remove it. **Recommendation before public launch: move the web to its own subdomain** (e.g. `jastip.antarkitaindonesia.com` or `jastipkita.antarkitaindonesia.com`), then set the API's `WEB_BASE_URL`/`CORS_ORIGINS`, App Links (`assetlinks.json`/AASA) and `site`/`base` in `astro.config.mjs` accordingly, and serve real security headers from the host/CDN.

**Content-Security-Policy** — GitHub Pages can't set headers, so every page carries `<meta http-equiv="Content-Security-Policy">` as the first element after charset/viewport (built by `src/lib/csp.ts`):

```
default-src 'self'; script-src 'self' 'sha256-<theme bootstrap>'; style-src 'self'; img-src 'self' data: https:;
font-src 'self'; connect-src 'self' <origin of PUBLIC_API_BASE_URL>; frame-src 'none'; manifest-src 'self';
worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'
```

- No inline code: scripts are external modules (`vite.build.assetsInlineLimit: 0`), stylesheets are external (`build.inlineStylesheets: 'never'`, fonts via `public/fonts/poppins.css`), former `style=""` attributes are utility classes (`src/styles/utilities.css`), no inline event handlers. The only inline `<script>` (theme bootstrap, must run before first paint) is allowed by its SHA-256 hash. JSON/JSON-LD data blocks are not executable and need no hash.
- With `PUBLIC_ENABLE_GOOGLE_LOGIN=true` the policy adds `https://accounts.google.com/gsi/*` to script/style/connect/frame-src.
- `scripts/postbuild.mjs` (via `scripts/csp-check.mjs`) **fails the build** if any page lacks the CSP/referrer meta, has an inline script without a matching hash, an inline style or an event handler, or a policy with `unsafe-inline`/`unsafe-eval`. Playwright re-checks every page statically and at runtime (no `securitypolicyviolation` events).
- **Not possible with a meta tag:** `frame-ancestors` (clickjacking), `report-uri`/`report-to`, `X-Frame-Options`, `X-Content-Type-Options`, HSTS. Set them as response headers once the site sits behind a host that supports headers (Cloudflare in front of Pages, or the dedicated subdomain): `Content-Security-Policy: … ; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
- `<meta name="referrer" content="strict-origin-when-cross-origin">` on every page.

**Storage** — every key is prefixed `jk:`; nothing is written before an explicit user action:

| Key | Store | Content | Cleared |
|---|---|---|---|
| — | memory | **access token** (never persisted) | page unload, logout |
| `jk:refresh` | sessionStorage (this tab) | refresh token; rotated on every page load via `POST /v1/auth/refresh` | tab close, logout, refresh failure |
| `jk:device` | sessionStorage | random per-tab device id (API stores only its HMAC) | tab close, logout |
| `jk:consent` | localStorage | banner choice (`necessary`/`analytics`) | logout |
| `jk:theme` | localStorage | theme picked with the toggle | logout |

Logout (`session.clear()` in `src/lib/api.ts`) calls `POST /v1/auth/logout` and removes the in-memory token and **every `jk:` key** from both storages. No analytics or third-party trackers are installed; if analytics are added later they must be gated on `jk:consent === 'analytics'` and allowed explicitly in the CSP.

> ⚠️ `docs/legal/cookie-policy.md` (published as version `0.1-template`, immutable) still lists the pre-SEC-14 key names (`jk-consent`, `jk-theme`, `jk-session`, `jk-device`) and says the access token is in sessionStorage. Update it in the **next legal version** (new version + re-seed), not by editing the published text.

## Honesty rules baked into the site

- No fabricated reviews/testimonials, no sample trips or fake travelers (trip search shows "segera hadir" until the API is live).
- SafePay copy states that funds are processed and held by a **licensed payment-gateway partner**, that JastipKita is **not a bank or e-wallet**, and that payments are **SANDBOX**.
- Customs numbers are labelled **Estimasi / bukan nasihat pajak** with rule source (PMK 34/2025), KMK rate reference and last-verified date.
- Company identity is a placeholder (`PT/CV — menunggu badan usaha`) — no registration numbers are invented.

## Open items for the owner

1. Incorporate the PT/CV, then fill every `[KURUNG SIKU]` in `docs/legal/*.md` and `SITE.companyName` in `src/config.ts`; get all 10 legal templates reviewed by counsel.
2. Decide CS channels → set `PUBLIC_SUPPORT_WHATSAPP` / `PUBLIC_SUPPORT_EMAIL`.
3. Deploy the API, allow CORS for `https://antarkitaindonesia.com`, set `PUBLIC_API_BASE_URL`.
4. Replace placeholders in `well-known/` (Play App Signing SHA-256, Apple Team ID) and paste the 404 snippet into the landing repo.
5. Update `src/data/kmk-rates.ts` weekly (or wire the Kemenkeu kurs API) — Customs uses the arrival-week KMK rate.
6. **Move the web to its own subdomain before public launch (SEC-14)** and add real security headers there (see *Security*).
7. Publish a new cookie-policy version with the `jk:` key names.
8. Brand risk: "JastipKita" name/trademark conflicts are documented in `docs/research/04-market-and-naming.md` — clear with a KI consultant before paid campaigns.
