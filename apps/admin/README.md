# JastipKita Admin

Static single-page back office for JastipKita operations, finance, trust & safety and platform admins.
It talks only to the JastipKita API (`/v1/admin/*`, `/v1/auth/*`, `/v1/me`, `/v1/files/*`); there is no server
component and no secret in the bundle.

| | |
|---|---|
| Stack | Vite 8 · React 19 · TypeScript 5.9 · React Router 8 · TanStack Query 5 · openapi-fetch 0.17 (types from openapi-typescript 7) |
| UI | Own small component set on `@jastipkita/design-tokens` (Poppins, `--jk-*` tokens), light/dark, desktop-first (≥ 1024 px, usable at 768 px) |
| Tests | Vitest 5 + Testing Library (jsdom) · Playwright 1.56 smoke + screenshots against the built SPA with a mocked API |

## Environment

Build-time only (`VITE_*` values are inlined into the JavaScript and are **public**). See `.env.example`.

| Variable | Example | Meaning |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:8787` · `https://jastipkita-api-staging.<sub>.workers.dev` | API origin, no trailing slash. Also the only non-self origin allowed by the CSP `connect-src`. |
| `VITE_APP_ENV` | `development` · `staging` · `production` | Anything but `production` shows the environment badge. The SANDBOX ribbon is driven by the API's integration modes, not by this value. |
| `VITE_BASE_PATH` | `/` | Public base path of the SPA (`/jastipkita-admin/` when served from a sub-path). |

The API must list the admin origin in `ADMIN_BASE_URL` (CORS), e.g. `https://staging.jastipkita-admin.pages.dev`.

## Develop

```bash
# once, from the repo root (installs only this app and its workspace deps)
cd /path/to/jastipkita && pnpm install --filter @jastipkita/admin

cd apps/admin
cp .env.example .env.local          # point VITE_API_BASE_URL at a local/staging API
pnpm dev                            # http://localhost:5173 (add it to the API's ADMIN_BASE_URL for CORS)
```

Sign-in: e-mail OTP → TOTP (enrol with a QR code on first login, then verify every session). Only users with an admin
role (`GET /v1/me` roles) get past the login gate; navigation and buttons follow the permission map.

| Script | What it does |
|---|---|
| `pnpm gen:api` | Regenerates `src/api/schema.d.ts` from `docs/api/openapi.json` and `src/api/form-schemas.json` (JSON Schemas for the promotion/config forms). Run after every API contract change (`docs/api/CHANGELOG.md`). |
| `pnpm typecheck` | `tsc --noEmit` for the app and for the Node-side configs/tests. |
| `pnpm test` | Unit/component tests (refresh single-flight, MFA step-up retry, idempotency-key reuse, permission nav, KPI definitions, maker-checker button states, QR encoder, formatters). |
| `pnpm build` / `pnpm preview` | Production build to `dist/` (+ `_headers`, `robots.txt`) / serve it on :4173. |
| `pnpm test:e2e` | Builds to `dist-e2e/` and runs the Playwright smoke (login → dashboard → refund approval with MFA step-up → config propose/approve) with every API call mocked through `page.route`. |
| `pnpm screenshots` | Light + dark screenshots of dashboard, transaction detail/ledger, config diff and DB center into `screenshots/`. |

Playwright uses the pre-installed browsers: `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` (the default in
`playwright.config.ts`). Do not run `playwright install` in CI images that already ship browsers.

## Build & deploy (static hosting, never indexed)

`pnpm --filter @jastipkita/admin build` with the three variables set produces `apps/admin/dist/`:

- `index.html` with a strict CSP `<meta>` (no inline script/style, no third-party origin; `connect-src` = self + API),
  `<meta name="robots" content="noindex,nofollow">`, `referrer: no-referrer`.
- `_headers` (Cloudflare Pages): the same CSP plus `frame-ancestors 'none'`, `X-Robots-Tag: noindex, nofollow, noarchive`,
  `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, `COOP`, a restrictive `Permissions-Policy`, `Cache-Control: no-store`
  for HTML and long-lived caching for hashed `/assets/*`.
- `robots.txt` = `Disallow: /`.

**Cloudflare Pages (recommended, what `.github/workflows/deploy-staging.yml` does):**
`wrangler pages deploy apps/admin/dist --project-name jastipkita-admin --branch staging`. Pages serves `index.html`
for unknown paths (SPA fallback) because there is no `404.html`. Rollback: Pages → Deployments → Rollback.

**GitHub Pages (only if Pages is not an option):** use a separate, private-content repo (never the public landing
repo), copy `index.html` to `404.html` for deep links, set `VITE_BASE_PATH=/<repo>/`. GitHub Pages ignores `_headers`,
so frame-ancestors / X-Robots-Tag are lost — the meta tags remain, but prefer Cloudflare.

**Put Cloudflare Access in front of the admin host** (Zero Trust → Access → Applications → Self-hosted, policy: staff
e-mails only). MFA in the app is still enforced by the API; Access adds a second, network-level gate and keeps the
login page itself away from scanners.

## Security notes

- **Tokens.** The access token lives only in memory. The refresh token is kept in `sessionStorage` (`jk_admin_rt`) so a
  reload or new route in the same tab stays signed in; it is gone when the tab closes and is never in `localStorage` or a
  cookie. Trade-off: script running in the page (XSS) could read it — mitigated by the strict CSP (no inline/third-party
  script), no `dangerouslySetInnerHTML` (the Markdown preview renders React elements), short token lifetimes and
  server-side session revocation. An HttpOnly-cookie refresh flow would need an API change.
- **Refresh** is single-flight: parallel 401s trigger exactly one `POST /v1/auth/refresh`, then every request is replayed.
  A refresh drops the MFA freshness claim (API rule), so the next sensitive action asks for TOTP again.
- **MFA step-up.** Sensitive actions carry a lock icon. On `403 MFA_REQUIRED` the app opens the TOTP/recovery-code dialog
  (`POST /v1/auth/mfa/verify`) and retries the same request once. The top bar shows the remaining MFA window (15 min).
- **Idempotency.** Every money/admin write that the API marks with `Idempotency-Key` gets one UUID per logical action; the
  key is reused on network errors, 5xx, MFA step-up and `IDEMPOTENCY_IN_PROGRESS`, and dropped after a definitive answer.
- **Maker-checker** buttons are enabled only from the API flags (`canApprove`, `canRelease`, `allowedActions`) plus the
  mirrored permission map (`src/auth/permissions.ts`, from `db/scripts/gen-reference-seed.mjs`). Blocked buttons stay
  focusable and announce why. The server remains the authority.
- **PII.** Lists show masked data. Reveal requires a reason + MFA and is audited; revealed values live only in component state
  (never the query cache or storage) and are cleared after 60 s. KYC/evidence documents are fetched as blobs from `/v1/files/{id}/content` with the bearer token, shown via
  short-lived object URLs (images/PDF/video only, no SVG) and revoked on close — never cached or persisted.
- **Chats** are opened only with a `disputeId`/`ticketId` scope and a written reason (API-enforced, audited).
- **Settlement accounts:** the admin never enters an account number. An operator puts the real number in the server secret
  store (`SETTLEMENT_SECRETS_JSON`); the admin form takes only the secret name (`secretRef`) and a mask such as
  `****0961`, and rejects anything that looks like an account number. Approval needs `FINANCE_SUPER_ADMIN` + MFA and a
  second person.
- **DB & Infra Center** shows masked hosts and health only. Credentials, connection strings and provider keys are never
  sent to the browser; migrations run from CI — the UI records and approves the 8-step workflow.
- **KPIs** always show their definition and data-quality note (small samples, SANDBOX money).

## Layout

```
src/api/        schema.d.ts (generated), client (auth middleware), mfa, idempotency, typed admin wrappers
src/auth/       AuthProvider, MfaProvider, permission map + navigation
src/components/ Table, Drawer/Dialog (focus trap), Toast, Badge, KPI tile, SVG charts, forms, viewers
src/pages/      11 screen groups (dashboard, users/KYC/trips, transactions, disputes, finance, risk & growth,
                config & customs rules, finance settlement, support & chat, content & audit, DB & infra)
e2e/            Playwright smoke + screenshots with a mocked API
```
