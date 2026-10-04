# Identity API — auth, me, files, KYC, privacy

Owner: identity group. Code: `apps/api/src/modules/{auth,me,files,kyc,privacy}`, routes registered in
`src/modules/identity.ts`, jobs in `src/jobs/identity.ts`, providers in `src/providers/{storage,sms,malware,kyc}`,
migration `db/migrations/0020_identity_runtime.sql`. Binding rules: `docs/00-domain-model.md` §2 (account levels),
§15.4 (KYC FSM); `docs/dev/api-module-guide.md` §4/§6.

All endpoints are under `/v1`, JSON camelCase, errors `{ error: { code, message, details, requestId } }`.
🔒 = `Authorization: Bearer <access JWT>`.

## 1. Endpoints

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /auth/otp/request` | public (LOGIN) / 🔒 (VERIFY_*, SENSITIVE_ACTION) | `{channel SMS\|WHATSAPP\|EMAIL, destination, purpose LOGIN\|VERIFY_PHONE\|VERIFY_EMAIL\|SENSITIVE_ACTION, locale?, action?, targetId?}` → `{challengeId, expiresAt, resendAvailableAt, devCode?}` — SENSITIVE_ACTION: see §3.1 |
| `POST /auth/otp/verify` | public / 🔒 | `{challengeId, code, device?, consents?}` → LOGIN `{purpose, verified, tokens, user, isNewUser}`; VERIFY_* `{purpose, verified, user}` · cookie transport (§3.3) |
| `POST /auth/google` | public | `{idToken, nonce?, device?, consents?}` → `{tokens, user, isNewUser}` (see *OAuth nonce*) · cookie transport |
| `POST /auth/apple` | public | `{identityToken, rawNonce (required by default), nonce?, fullName?, device?, consents?}` → `{tokens, user, isNewUser}` (see *OAuth nonce*) · cookie transport |
| `POST /auth/refresh` | public | `{refreshToken}` → `{tokens}` (rotation); cookie transport: empty body, token from the `jk_rt` cookie |
| `POST /auth/logout` | 🔒 or refresh token | bearer and/or `{refreshToken?}` (or the `jk_rt` cookie); cookie transport clears the cookie; no credential → 401 |
| `GET /auth/sessions` · `DELETE /auth/sessions/{id}` | 🔒 | |
| `POST /auth/mfa/totp/enroll` | 🔒 admin (any role), **fresh OTP-login session ≤ 15 min** | secret returned once; `403 MFA_ENROLL_FRESH_LOGIN_REQUIRED`, `409 MFA_ENROLLMENT_IN_PROGRESS` (other session), `409 MFA_ALREADY_ENROLLED` (reset = maker-checker, §3.2) |
| `POST /auth/mfa/totp/confirm` · `POST /auth/mfa/verify` | 🔒 | step-up token with `mfa_at`; confirm only from the enrolling session (`403 MFA_ENROLL_SESSION_MISMATCH`, `409 MFA_ENROLLMENT_EXPIRED` after 15 min) |
| `GET /me` · `PATCH /me` · `POST /me/mode` | 🔒 | `GET /me` returns `roles` + effective `permissions` (from `role_permissions`, `[]` for non-staff; UI hint only) and, for staff, `adminMfaPolicy` |
| `GET/POST /me/devices` · `DELETE /me/devices/{id}` | 🔒 | |
| `GET/POST /me/consents` | 🔒 | append-only; `version` must be one of `GET /consents/requirements` `acceptedVersions` (422 `CONSENT_VERSION_INVALID {allowedVersions}`) |
| `GET /legal/documents?locale&type` | public | current published version per type & locale: `{type, version, locale, title, summary, effectiveAt, publishedAt, slug, url, contentUrl, isTemplate, consentType}` (`Cache-Control: public, max-age=300`) |
| `GET /legal/documents/{type}?locale&version` | public | `{type}` = code (`TOS`) or slug (`terms-of-service`); markdown `bodyMd`, `retiredAt`, `requestedLocale` (falls back to `id`); `404 LEGAL_DOCUMENT_NOT_FOUND` |
| `GET /consents/requirements?locale` | public / 🔒 optional | `{signup: {required: [TOS, PRIVACY], optional: [MARKETING]}, kyc: {required: [KYC]}}` — each `{type, version, acceptedVersions, versionEnforced, title, summary, url, documentUrl}`; with a token also `granted, grantedVersion, upToDate` and `satisfied` per stage |
| `POST /files/uploads` · `POST /files/{id}/complete` · `GET /files/{id}` · `GET /files/{id}/url` · `GET /files/{id}/content` | 🔒 | |
| `GET /kyc/status` | 🔒 | |
| `POST /kyc/submissions` | 🔒 K2 | |
| `GET/POST /kyc/payout-accounts` · `DELETE /kyc/payout-accounts/{id}` · `POST /kyc/payout-accounts/{id}/default` | 🔒 K3 | masked only; POST and `/default` need `stepUp` (§3.1); `payoutsFrom` = end of the new-account payout cooldown (money.md §5.7), a default change re-points pending payouts |
| `POST /privacy/export` · `POST /privacy/delete-account` | 🔒 | |
| `GET /privacy/requests` · `POST /privacy/cancel-deletion` | 🔒 (also PENDING_DELETION) | |
| `PUT /dev/storage/upload/{token}` · `GET /dev/storage/download/{token}` | none | **development/test only** (404 otherwise), memory storage |

## 2. Login & registration

Registration is login: the first successful LOGIN verification (or first Google/Apple sign-in) creates the
account. **Registration is separate from KYC**: new accounts start at level 1; a verified phone raises them to
level 2 (`recomputeKycLevel`). A new account requires `consents` with `TOS` and `PRIVACY` granted
(`MARKETING` optional) — otherwise `422 CONSENT_REQUIRED` (for OTP the code is **not** consumed, so the client
resubmits the same code with the consents).

```mermaid
sequenceDiagram
  participant App
  participant API
  participant DB
  participant SMS as SMS/WA/E-mail provider
  App->>API: POST /auth/otp/request {channel, destination, purpose}
  API->>DB: advisory lock(destination HMAC); limits (cooldown 60 s, 5/h + 10/day per destination, 20/h per IP)
  API->>DB: INSERT otp_challenges (code HMAC, destination HMAC + AES-GCM ciphertext, expires +5 min)
  API->>SMS: send code (direct — the user is waiting; not via outbox)
  API-->>App: {challengeId, expiresAt, resendAvailableAt, devCode?}
  App->>API: POST /auth/otp/verify {challengeId, code, device?, consents?}
  API->>DB: lock challenge; expired? locked (5 attempts)? compare HMAC (constant time)
  alt wrong code
    API->>DB: attempts+1, security event (COMMITTED) → 400 OTP_INVALID / 429 OTP_LOCKED
  else correct
    API->>DB: find user by phone/e-mail, or signup-risk → create user + identity + consents
    API->>DB: device link, refresh-token family, LOGIN_SUCCESS, outbox user.registered / user.phone_verified / kyc.level_changed
    API-->>App: {tokens, user, isNewUser}
  end
```

* **OTP storage**: `code_hash = HMAC(pepper, "otp:<challengeId>:<code>")`; destination = HMAC (lookups, limits)
  + AES-256-GCM ciphertext bound by AAD `otp_challenges.destination:<id>` (needed to create/link the account;
  column added in 0020). A new code for the same destination+purpose supersedes older unused ones.
* **No enumeration**: `/otp/request` returns the same shape and status whether or not an account exists; the
  cooldown/limits are per destination, not per account.
* `devCode` is echoed only when `OTP_DEV_ECHO=true` (forbidden in staging/production by `env.ts`).
* Phone normalization: `08…` → `+628…`, `628…` → `+628…`, E.164 required. E-mail lower-cased.
* VERIFY_PHONE (🔒) sets `users.phone_e164` (409 `PHONE_IN_USE` if another account owns it) and raises level to 2.
  VERIFY_EMAIL (🔒) sets `transaction_email`; a phone-only account also gains that verified login e-mail.

### Google / Apple

```mermaid
sequenceDiagram
  App->>Google/Apple: sign-in with a fresh random nonce (Apple: SHA-256(rawNonce); web Google: GIS nonce)
  App->>API: POST /auth/google {idToken, nonce?} | /auth/apple {identityToken, rawNonce, fullName?}
  API->>JWKS: verify RS256 (cached remote JWKS; injectable resolver)
  API->>API: iss, aud ∈ *_CLIENT_IDS, exp (60 s tolerance), nonce (required per OAUTH_REQUIRE_NONCE), email_verified
  API->>DB: nonce not used yet? → identity (provider, sub) → user | verified e-mail → link | create (consents, signup risk) → record nonce
  API-->>App: {tokens, user, isNewUser}
```

* Google: JWKS `https://www.googleapis.com/oauth2/v3/certs`, `iss` ∈ {`accounts.google.com`, `https://accounts.google.com`},
  `aud` ∈ `GOOGLE_CLIENT_IDS`, **`email_verified` required** (`401 OAUTH_EMAIL_UNVERIFIED`).
* Apple: JWKS `https://appleid.apple.com/auth/keys`, `iss = https://appleid.apple.com`, `aud` ∈ `APPLE_CLIENT_IDS`.
  Private-relay e-mails are accepted.
* **Apple nonce** (replay protection): the app generates a random `rawNonce` (≥ 16 chars), passes `SHA-256(rawNonce)` as lowercase hex
  to `ASAuthorizationAppleIDRequest.nonce`, and sends `rawNonce` to `POST /auth/apple`. The API requires the identity token's `nonce`
  claim to equal `sha256hex(rawNonce)` (constant-time) — missing/mismatching claim → `401 OAUTH_TOKEN_INVALID {reason: NONCE_MISMATCH}`.
  The legacy `nonce` field (compared verbatim with the claim) still works; when both are sent they must agree. `fullName` is sent by Apple only on the first authorization and is stored
  only then (or if the stored name is empty).
* **OAuth nonce (SEC-15)**: env `OAUTH_REQUIRE_NONCE` = csv of providers whose requests **must** carry a nonce (`GOOGLE`, `APPLE`,
  or `none`; unset/empty = `APPLE`, validated by `env.ts`; production must include `APPLE`). Default rationale: every Apple client
  (mobile) sends `rawNonce`; the mobile Google flow (`google_sign_in`) does not send a nonce yet, the web does (GIS `nonce`, 256-bit
  random). A required provider without `rawNonce`/`nonce` → `401 OAUTH_NONCE_REQUIRED {provider}` (before any JWKS call). Google
  `nonce` is compared verbatim (constant-time) with the claim, min 16 chars. **Single use:** whenever a nonce was verified, the first
  *successful* sign-in records `(provider, SHA-256(nonce claim))` in `oauth_nonce_uses` until the token expires (migration 0110;
  concurrent requests with the same nonce are serialized by an advisory lock); presenting the same ID token again →
  `401 OAUTH_TOKEN_INVALID {reason: NONCE_REUSED}` + `LOGIN_FAILED` (MEDIUM). A `422 CONSENT_REQUIRED` answer does **not** consume the
  nonce, so the documented "re-submit the same token with consents" flow keeps working. Google tokens without a nonce are not single
  use (cached mobile tokens keep working) — add `GOOGLE` to `OAUTH_REQUIRE_NONCE` once the mobile app sends a nonce.
* Failures → `401 OAUTH_TOKEN_INVALID {reason: AUDIENCE_MISMATCH | TOKEN_EXPIRED | ISSUER_MISMATCH | SIGNATURE_INVALID | NONCE_MISMATCH | NONCE_REUSED | CLAIMS_INVALID}`,
  `401 OAUTH_NONCE_REQUIRED`
  + `LOGIN_FAILED` security event; JWKS outage → `503 OAUTH_UNAVAILABLE`; no client ids configured → `503 OAUTH_NOT_CONFIGURED`.
* **Account linking**: only when the provider asserts the e-mail is verified **and** our account's e-mail is
  verified (`users.email_verified_at`). E-mail OTP ↔ Google ↔ Apple with the same verified address land in one
  account (`ACCOUNT_LINKED` security event, MEDIUM). Apple without a verified e-mail signs in by `sub` only.
* The login e-mail is **not** the transaction e-mail. `PATCH /me {transactionEmail}` sends an e-mail OTP to the
  new address (`pendingVerification`) and the change is applied by `POST /auth/otp/verify` (🔒, VERIFY_EMAIL).
  Clearing it, or choosing the already-verified login e-mail, applies immediately.
* Tests inject keys with `configureOAuthKeys(deps, {google, apple})` (`jose.createLocalJWKSet`) — no network.

### Signup risk

`auth/risk.ts` gathers counts (no PII): accounts on the device fingerprint (HMAC) and those created in 24 h,
signups from the IP (HMAC) in 24 h (`USER_REGISTERED` security events), and re-registration of an e-mail from a
deleted account (`email_suppressions`) → `assessRisk('USER', …)` from `@jastipkita/core` with `risk.thresholds`
→ `recordRiskAssessment` (risk_assessments + risk_reviews for non-ALLOW). **BLOCK** → `403 SIGNUP_BLOCKED`
(assessment recorded against a throwaway subject id, `SIGNUP_BLOCKED` HIGH event); REVIEW/HOLD are allowed and recorded.

### Legal documents & consent versions

`legal_documents` holds the versioned texts (published = immutable evidence). `db/seeds/0200_legal_documents.sql` is **generated** from
`docs/legal/*.md` by `apps/api/scripts/gen-legal-seed.ts` (`--check` in CI; `legal.test.ts` fails when stale): 10 documents (incl.
`COMMUNITY_GUIDELINES`, migration 0070), version = the document's frontmatter `version` (default `0.1-template`; `COOKIES` is `0.3-template`
since 2026-10-04 — refresh-token cookie `jk_rt`), locale `id`, published `2026-09-27T00:00:00Z`, TEMPLATE banner kept verbatim. A changed
template needs a new frontmatter version (published rows are immutable); the web shows the same frontmatter version.
Consent validation (`me/repository acceptedConsentVersions`) accepts every published, non-retired version of the type — the same list
`GET /consents/requirements` returns — so an app that shows `version` and submits it never hits `CONSENT_VERSION_INVALID`.
Because the templates are published, **only `0.1-template` is accepted** for TOS/PRIVACY/KYC/MARKETING/TRAVELER_AGREEMENT/PAYMENT_TERMS (COOKIES: `0.3-template`, plus `0.1-template` in databases seeded before 2026-10-04)
until Compliance publishes a reviewed version (admin `POST /v1/admin/legal-documents` → publish; `retirePrevious` retires the template).

## 3. Sessions & MFA

* Access JWT HS256 (15 min, `sid` = refresh family, optional `mfa_at`); refresh token opaque 256-bit, SHA-256
  stored, 30 days, single use (`services/session.ts`). Reusing a rotated refresh token revokes the whole family
  and writes `REFRESH_TOKEN_REUSE` (HIGH). Every request re-checks that the family is unrevoked.
* `GET /auth/sessions` lists families with device/platform; `DELETE /auth/sessions/{id}` and logout revoke. Logout accepts the
  bearer token (verified strictly when sent, as before) and/or a refresh token (`{refreshToken}` body, or the `jk_rt` cookie with
  cookie transport) — any token of a family identifies it; a token whose session already ended is a no-op (`200`). Security event
  `LOGOUT {sessionId, via: ACCESS_TOKEN|REFRESH_TOKEN}`.
  Unlinking a device (`DELETE /me/devices/{id}`) also revokes its sessions and push token.
* **Admin TOTP (RFC 6238, SHA-1, 30 s, ±1 step)**: enroll (admins only; secret AES-GCM encrypted with AAD
  `mfa_factors.secret:<id>`, shown once) → confirm (activates, 10 one-time recovery codes stored as HMAC,
  returns a step-up token) → verify (step-up: new access token for the **same session** with `mfa_at`, used by
  `requireRecentMfa`). Replay protection: a code whose time-step ≤ `last_used_step` is rejected
  (`MFA_CODE_REPLAYED`). 5 failures in 15 min → `429 MFA_LOCKED`. Refreshing drops `mfa_at` (step-up again).
* **Session origin (SEC-13):** every refresh family records `auth_method` (`OTP` | `GOOGLE` | `APPLE`) and
  `session_started_at` at login; both are copied on rotation (a refreshed session keeps its original age).

### 3.1 Step-up OTP for sensitive money actions (SEC-12)
Changing where money goes needs more than a bearer token (a stolen access token must not be able to redirect a
refund or a payout):

| Action (`action`) | `targetId` | Protected endpoint |
|---|---|---|
| `REFUND_DESTINATION_SET` | refund id | `POST /v1/refunds/{id}/destination` |
| `PAYOUT_ACCOUNT_ADD` | own user id | `POST /v1/kyc/payout-accounts` |
| `PAYOUT_ACCOUNT_SET_DEFAULT` | payout account id | `POST /v1/kyc/payout-accounts/{id}/default` (not needed when it already is the default) |

1. `POST /auth/otp/request {purpose: SENSITIVE_ACTION, action, targetId, channel, destination}` (bearer). The
   destination must be the user's **verified** phone (SMS/WhatsApp) or verified login / transaction e-mail —
   otherwise `422 STEP_UP_DESTINATION_NOT_VERIFIED`. Missing action/target → `400 STEP_UP_ACTION_REQUIRED`;
   `PAYOUT_ACCOUNT_ADD` for another user → `422 STEP_UP_TARGET_INVALID`. Same resend cooldown / hourly / daily limits
   as other OTPs. The challenge row stores `action` + `target_id` (DB CHECK) and lives **10 minutes**.
2. Send `stepUp: {challengeId, code}` in the protected request body. The code is verified and consumed in its own
   committed transaction **before** the action (so a failed attempt counts even if the action fails later):
   none → `403 STEP_UP_REQUIRED {purpose, action, targetId}`; wrong / consumed / someone else's → `400 OTP_INVALID`;
   other action or target → `403 STEP_UP_MISMATCH` (+ `STEP_UP_TARGET_MISMATCH` security event); expired →
   `400 OTP_EXPIRED`; 5 wrong codes → `429 OTP_LOCKED`. Single use. Success writes `SENSITIVE_ACTION_VERIFIED`.
3. Holder-name check against the KYC identity (users with a verified identity, i.e. ≥ L3; tolerant token match —
   upper-case, accents and punctuation stripped, abbreviations/truncation accepted): a mismatch is **never
   auto-accepted** — a refund destination is stored `PENDING_REVIEW` (FINANCE: `/v1/admin/refund-destinations`), a
   payout account `NAME_MISMATCH` (admin payout-account queue → verification override). Without a verified identity
   the typed holder name is the reference (payout account mismatch → `422 BANK_ACCOUNT_NAME_MISMATCH`).

### 3.2 TOTP enrollment & reset (SEC-13)
TOTP enrollment is trust-on-first-use, so it is narrowed to the moment the admin has just proven possession of the
phone / e-mail:
* `POST /auth/mfa/totp/enroll` only from a session whose family was created by an **OTP login ≤ 15 minutes ago**
  (`SECURITY.MFA_ENROLL_FRESH_SESSION_SEC`); Google/Apple sessions and older (refreshed) sessions get
  `403 MFA_ENROLL_FRESH_LOGIN_REQUIRED` (+ `MFA_ENROLL_DENIED` security event).
* A pending (unconfirmed) factor belongs to the session that started it (`mfa_factors.enroll_session_id`): only that
  session can confirm it (`403 MFA_ENROLL_SESSION_MISMATCH`) or restart it; another session gets
  `409 MFA_ENROLLMENT_IN_PROGRESS {retryAfterSec}` until the pending factor is 15 minutes old. Confirming after 15 min →
  `409 MFA_ENROLLMENT_EXPIRED`.
* A **confirmed** factor is never replaced by self-service (`409 MFA_ALREADY_ENROLLED`). Reset = maker-checker:
  `POST /v1/admin/users/{id}/mfa-reset-requests {reason ≥ 10}` (rbac.manage + fresh MFA, not for yourself) →
  another **SUPER_ADMIN** (≠ requester, ≠ subject, fresh MFA) approves `POST /v1/admin/rbac/mfa-reset-requests/{id}/approve`
  (or rejects / the requester cancels `…/reject`). Applying disables the factor, deletes recovery codes, revokes every
  session (`MFA_RESET` HIGH security event, audit `auth.mfa_reset_applied`); the admin then logs in with OTP and
  enrolls again. `admin_mfa_reset_requests` is append-only history guarded by `trg_admin_mfa_reset_guard` (same
  checks in the DB, 72 h expiry, one pending request per user).

Security events written: `LOGIN_SUCCESS`, `LOGIN_FAILED`, `USER_REGISTERED`, `SIGNUP_BLOCKED`, `OTP_VERIFY_FAILED`,
`OTP_LOCKED`, `OTP_RATE_LIMITED`, `PHONE_VERIFIED`, `PHONE_CONFLICT`, `TRANSACTION_EMAIL_CHANGED`, `ACCOUNT_LINKED`,
`LOGOUT`, `SESSION_REVOKED`, `DEVICE_REMOVED`, `MFA_ENROLL_STARTED`, `MFA_ENABLED`, `MFA_VERIFIED`, `MFA_FAILED`,
`MFA_RECOVERY_CODE_USED`, `MFA_ENROLL_DENIED`, `MFA_RESET`, `SENSITIVE_ACTION_VERIFIED`, `STEP_UP_TARGET_MISMATCH`,
`REFUND_DESTINATION_NAME_MISMATCH`, `UPLOAD_TYPE_MISMATCH`, `MALWARE_UPLOAD`, `SENSITIVE_FILE_VIEWED`,
`KYC_DUPLICATE_IDENTITY`, `PAYOUT_ACCOUNT_INVALID`, `PAYOUT_ACCOUNT_NAME_MISMATCH`, `DATA_EXPORT_REQUESTED`,
`ACCOUNT_DELETION_REQUESTED`, `ACCOUNT_DELETION_CANCELLED` (+ `REFRESH_TOKEN_REUSE` from services/session).

### 3.3 Web cookie transport (SEC-14)

The public web stays at `https://antarkitaindonesia.com/jastipkita` (origin shared with other AntarKita pages — ADR 0007), so its
refresh token must never be readable by JavaScript. Mobile and admin keep the default **body transport** (nothing changes for them).
Code: `apps/api/src/modules/auth/cookie-transport.ts`; web client: `apps/web/src/lib/api.ts`.

| | Body transport (default) | Cookie transport (`X-JK-Token-Transport: cookie`) |
|---|---|---|
| Who | mobile, admin, any non-browser client | public web only (credentialed `fetch`, `credentials: 'include'`) |
| Login response (`otp/verify` LOGIN, `google`, `apple`) | `tokens.refreshToken` in JSON | `tokens.refreshToken` **omitted**; `Set-Cookie: jk_rt=<token>; Max-Age=<REFRESH_TOKEN_TTL_DAYS×86400>; Path=/v1/auth; HttpOnly; Secure; SameSite=Strict` (no `Domain` → host-only on the API host) |
| `POST /auth/refresh` | `{refreshToken}` required (400 otherwise) | body optional/empty; token from `jk_rt` (a body token, if sent, wins); cookie rotated and re-set; no cookie → `401 REFRESH_MISSING`; any 401/403 also clears the cookie |
| `POST /auth/logout` | bearer and/or `{refreshToken}` | bearer and/or the cookie; the cookie is always cleared (`Max-Age=0`) |
| Header `Cache-Control` on token responses | `no-store` | `no-store` |

* **CSRF / origin rules.** Every cookie-transport request must carry an `Origin` in the web allow-list = origin of `WEB_BASE_URL`
  plus `CORS_ORIGINS` (exact match; never `*`/`null`; the admin origin is **not** included) — checked before the cookie is read or set
  and before any side effect (an OTP is not consumed) → `403 ORIGIN_NOT_ALLOWED`. Together with `SameSite=Strict` (never sent on
  cross-site requests) and the custom header (forces a CORS preflight that only allow-listed origins pass) a third-party site cannot
  trigger refresh/logout. Without the header the cookie is ignored entirely.
* **CORS.** `Access-Control-Allow-Credentials: true` only for the web allow-list; admin and other allow-listed origins stay
  non-credentialed; `X-JK-Token-Transport` is an allowed request header.
* **Secure attribute.** Omitted only when `APP_ENV` is `development`/`test` (plain `http://localhost`); staging/production always set it.
* **Same-site requirement.** `SameSite=Strict` cookies flow on credentialed fetches only when the API host is *same-site* with the web:
  production `https://api.antarkitaindonesia.com` (or `jastipkita-api.antarkitaindonesia.com`) ↔ `https://antarkitaindonesia.com` ✓;
  local `localhost:8787` ↔ `localhost:4321` ✓. A staging API on `*.workers.dev` is cross-site: the browser drops the cookie, so a web
  session ends at the next page load (use a custom staging API domain under `antarkitaindonesia.com` to test web account flows).
* **Rotation & reuse detection are unchanged** (`services/session.ts`). Because the cookie is shared by all tabs of the browser, web
  clients must serialize refreshes across tabs (the web uses the Web Locks API, lock `jk:auth-refresh`); otherwise two tabs presenting the
  same token at once would trip reuse detection and revoke the session.
* **Web session lifecycle.** Access token in memory only; on page load an auth page restores the session silently with
  `POST /auth/refresh` (no body); a 401 is remembered for the page (anonymous visitors cost one request). Logout = `POST /auth/logout`
  (bearer if in memory + cookie), then every `jk:*` key is removed from web storage; the pre-2026-10-04 `jk:refresh` sessionStorage key is
  deleted on every page load. Cookie policy: `docs/legal/cookie-policy.md` 0.3-template.
* **Residual risk (accepted 2026-10-04).** Script injected into *another* page of `antarkitaindonesia.com` runs in the same origin: it
  can drive an open JastipKita tab and can call `/auth/refresh` with credentials (allow-listed Origin) to obtain 15-minute access tokens
  while it runs in the victim's browser. It cannot read or exfiltrate the refresh token. Mitigation outside this repo: CSP across the
  whole origin + security review of the other AntarKita pages (`docs/security/review-2026-09.md` SEC-14).

## 4. Files

| Purpose | Types | Max | At rest |
|---|---|---|---|
| KYC | jpeg/png/webp/heic | 10 MB | **AES-256-GCM envelope**, streamed only |
| TRIP_DOC | images + application/pdf | 10 MB | **envelope** (DB requires it) |
| RECEIPT | images + application/pdf | 10 MB | plain |
| EVIDENCE | images ≤ 10 MB, video/mp4 ≤ 50 MB | | plain |
| AVATAR, PRODUCT_PHOTO, CHAT, DELIVERY_PROOF | images | 10 MB | plain |
| EXPORT | server-generated JSON | | envelope, 7-day retention |

1. `POST /files/uploads {purpose, contentType, sizeBytes, sha256?}` → files row (`PENDING`) + presigned PUT
   (15 min). S3 presign signs `content-type` **and** `content-length` (= declared size).
2. Client PUTs the bytes (`upload.headers` exactly).
3. `POST /files/{id}/complete`: fetch object → size ≤ declared → **magic bytes vs declared type**
   (`422 FILE_TYPE_MISMATCH`, object deleted) → SHA-256 (vs declared: `FILE_CHECKSUM_MISMATCH`) → malware scan:
   `INFECTED` → object deleted, `scan_status=INFECTED`, `MALWARE_UPLOAD` (HIGH), `422 FILE_INFECTED`; scanner
   unavailable → `503 MALWARE_SCAN_UNAVAILABLE` (fail closed, retryable). KYC/TRIP_DOC: encrypted object written,
   **plaintext staging object deleted**. Idempotent once READY.
   Envelope format: `"JKE1" | u16 len | wrappedDEK | iv | ciphertext‖tag`; per-file random DEK, wrapped by the
   active KEK (`deps.crypto`, key id recorded → rotation re-wraps only the DEK); AAD `files.object:<fileId>`.
4. Download: `GET /files/{id}/url` → presigned GET (5 min) for plain files; for encrypted files
   `{url: ${API_BASE_URL}/v1/files/{id}/content, requiresAuth: true}` — streamed & decrypted by the API (`no-store`).
   **Every file URL the API returns is absolute** (`url`, `contentUrl`, `avatarUrl`, `imageUrl`: presigned storage URLs or
   `${API_BASE_URL}/v1/files/{id}/content`, which needs the bearer token and applies the access rules below).

Access: KYC → permission `kyc.review` only (not the owner; views audited `kyc.document_viewed`); TRIP_DOC → owner
or `trips.verify`; EXPORT → owner only; AVATAR → any signed-in user; RECEIPT/PRODUCT_PHOTO/DELIVERY_PROOF/CHAT/EVIDENCE
→ owner, counterparties found via `purchase_proofs`, `customs_declarations`, `deliveries`, `messages.attachments`
(conversation parties), `dispute_evidence`, `request_images` (buyer, offering/matched traveler, anyone while the
request is OPEN), plus staff with `disputes.manage` (all) / `transactions.read` (not CHAT/EVIDENCE). Others → `403 FILE_ACCESS_DENIED`.
The owner can always read metadata (`GET /files/{id}`).

**Adapters**
* `providers/storage/s3.ts` — S3-compatible (AWS S3, Cloudflare R2, MinIO) via aws4fetch SigV4. Path-style by
  default (`{S3_ENDPOINT}/{bucket}/{key}`); put `{bucket}` in `S3_ENDPOINT` for virtual-hosted addressing.
* `providers/malware/clamav-http.ts` — contract: `POST {CLAMAV_HTTP_URL}/scan`, body = raw bytes
  (`application/octet-stream`), response `{"status":"CLEAN"}` | `{"status":"INFECTED","signature":"…"}` |
  `{"status":"ERROR"}`; non-2xx/timeout (30 s) → FAILED. Also parses clamav-rest shapes
  (`{infected, viruses}`, `{data:{result:[{is_infected, viruses}]}}`). Deploy a clamd sidecar with a small HTTP shim.
* `providers/sms/twilio.ts` — Messages API (`/2010-04-01/Accounts/{SID}/Messages.json`, Basic auth), SMS and
  WhatsApp (`whatsapp:` prefix). WhatsApp business-initiated OTPs need an approved authentication template in
  Twilio; the free-text Body works in the sandbox / within a session. Errors never include the destination or code.

## 5. KYC levels

| Level | Evidence (recomputeKycLevel) |
|---|---|
| 1 REGISTERED | account |
| 2 PHONE_VERIFIED | `phone_verified_at` |
| 3 IDENTITY_VERIFIED | APPROVED identity (identity_records.verified_at) |
| 4 TRAVELER_VERIFIED | level ≥ 3 + VERIFIED enabled payout account + ≥ 1 trip with `trips.verified_at` |
| 5 TRUSTED_TRAVELER | **not here** — engagement trust job |

Recomputation only **raises** the level (downgrades are explicit admin/system actions), emits `kyc.level_changed`
and audits. It runs inline (phone verify, KYC approval, payout verification) and from the outbox consumers
`trip.verified`, `trip.status_changed` (to = VERIFIED) and `payout_account.verified`.

Submission (`POST /kyc/submissions`, K2, KYC consent required): `{idType KTP|PASSPORT, idNumber, fullName,
dateOfBirth, nationality?, documents:{idFront, idBack?, selfie, livenessFileIds?: string[1..5], liveness? | livenessFileId? (legacy single)}}`
(file ids, purpose KYC, READY). Every liveness capture is validated like the other documents (owner, purpose KYC, scan CLEAN, encrypted →
`422 KYC_DOCUMENTS_INVALID {missing}`); legacy + array are merged and de-duplicated (max 5 in total). Each capture becomes a `LIVENESS`
`kyc_documents` row and the provider receives all of them (`livenessFileKeys`, capture order; `livenessFileKey` = the first).
ID number / name / DOB → AES-GCM (AAD `identity_records.<col>:<id>`); `id_number_hash = HMAC("kyc_id:<type>:<nat>:<number>")`
(UNIQUE — one document = one account). A hash owned by another account → `409 IDENTITY_ALREADY_REGISTERED`,
risk assessment (`sharedIdentityHashAccounts` → REVIEW) and `KYC_DUPLICATE_IDENTITY` (HIGH); no submission row.
FSM §15.4 via core `kycSubmissionFsm`: PENDING → IN_REVIEW (SYSTEM) → provider result: `PASSED` → APPROVED
(guard KYC_CHECKS: liveness/face ≥ 0.8) → level 3; `FAILED` → REJECTED (reason); `MANUAL_REVIEW` (manual provider,
provider error) → stays IN_REVIEW for the admin queue. Events `kyc.submitted`, `kyc.approved`, `kyc.rejected`.

Payout accounts (K3): number encrypted (AAD `payout_accounts.account_number:<id>`), HMAC `bank_account:<bank>:<number>`
(same account on other users = risk signal), mask `****1234`. Name inquiry via `payment.validateBankAccount`
(MOCK/SANDBOX in dev/test); adding an account needs the SENSITIVE_ACTION step-up (§3.1, checked after the duplicate
check and before the bank inquiry). The bank holder name must match the verified identity name (tolerant token match)
→ `VERIFIED` (+ `payout_account.verified`, first verified becomes default) — mismatch with a verified identity →
stored `NAME_MISMATCH` (201, never default, admin review); mismatch without one → `422 BANK_ACCOUNT_NAME_MISMATCH`;
invalid `422 BANK_ACCOUNT_INVALID`, inquiry unavailable → stored `PENDING` (cannot be default). Only VERIFIED can be
default (switching the default needs a step-up too); delete is refused while payouts are pending
(`409 PAYOUT_ACCOUNT_IN_USE`). Responses show only the mask.

## 6. Privacy (UU PDP)

* **Export** `POST /privacy/export` → request `RECEIVED` + job `identity.privacy_export` → JSON of the user's own
  data (profile, identities, devices, sessions, consents, requests, KYC status with masked ID, payout masks,
  transaction summary without counterparties, requests, trips, messages they sent, ratings given/received (scores
  only), credits, 12 months of security events) → EXPORT file (envelope-encrypted, 7-day retention) →
  `COMPLETED` + `privacy.export_ready {requestId, userId}`. Download: `GET /files/{exportFileId}/url` (owner only).
* **Deletion** `POST /privacy/delete-account {confirm: true, reason?}` → `409 DELETION_BLOCKED` while there are
  non-terminal transactions, open disputes, unpaid payouts (SCHEDULED/ON_HOLD/PROCESSING/FAILED) or in-flight refunds.
  Otherwise: `PENDING_DELETION`, request IN_PROGRESS with `scheduledFor = now + 14 days`, **all sessions revoked**,
  `account.deletion_scheduled {requestId, userId, effectiveAt}`, audit. During the grace period the user can log in
  again (tokens issued, profile shows `deletionScheduledFor`), every other endpoint answers `403 ACCOUNT_INACTIVE`,
  and `GET /privacy/requests` / `POST /privacy/cancel-deletion` work. Refresh is refused for non-ACTIVE accounts
  (log in again). Job `identity.privacy.finalize_deletions` (hourly) adds the e-mail HMACs to `email_suppressions`
  and calls `anonymize_user()` (JK423 → retried, blockers recorded in `details`).
* **Jobs**: `identity.auth.purge_otp_idempotency` (hourly: OTP challenges expired > 24 h — the limit look-back —
  and expired idempotency keys); `identity.privacy.retention_purge` (daily): applies `data_retention_policies`
  (otp_challenges, refresh_tokens, idempotency_keys, notifications, analytics_events, outbox_events, jobs,
  identity_records/kyc_documents by `purge_after`, messages & delivery addresses after transaction close,
  trip-doc and chat files), deletes storage objects of files past `retention_until` and abandoned uploads;
  append-only / legally retained entities (`security_events`, `audit_logs`, `financial_records`,
  `payment_webhook_events`) are reported `SKIPPED_APPEND_ONLY_OR_LEGAL_RETENTION`.

## 7. Events

Produced: `user.registered {userId, method}`, `user.phone_verified {userId}`, `kyc.submitted|approved|rejected
{userId, submissionId, targetLevel, reason?}`, `kyc.level_changed {userId, from, to}`, `payout_account.verified
{userId, payoutAccountId}`, `privacy.export_ready {requestId, userId}`, `account.deletion_scheduled {requestId,
userId, effectiveAt}` (and `user.anonymized` via the DB). Consumed: `trip.verified`, `trip.status_changed`,
`payout_account.verified`. Payloads never contain PII.

## 8. Environment variables

`JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `ACCESS_TOKEN_TTL_SEC`, `REFRESH_TOKEN_TTL_DAYS`, `ADMIN_MFA_STEP_UP_SEC`,
`DATA_ENCRYPTION_KEYS` (KEKs, first = active), `HMAC_PEPPER`, `GOOGLE_CLIENT_IDS`, `APPLE_CLIENT_IDS`, `OAUTH_REQUIRE_NONCE`
(csv `GOOGLE,APPLE` | `none`, default `APPLE`, §2 *OAuth nonce*), `WEB_BASE_URL` + `CORS_ORIGINS` (web cookie-transport allow-list, §3.3), `OTP_DEV_ECHO`,
`SMS_PROVIDER` (`log`|`twilio`), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (used for SMS and, prefixed,
WhatsApp), `EMAIL_PROVIDER`/`EMAIL_FROM` (OTP e-mail), `STORAGE_PROVIDER` (`memory`|`s3`), `S3_ENDPOINT`, `S3_REGION`,
`S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `MALWARE_SCAN_PROVIDER` (`none`|`mock`|`clamav-http`),
`CLAMAV_HTTP_URL`, `KYC_PROVIDER` (`manual`|`mock`), `PAYMENT_PROVIDER` (bank name inquiry), `API_BASE_URL`
(streaming/dev URLs), `APP_ENV` (dev routes only in development/test).

Security constants (not business config): OTP 6 digits / 5 min / 5 attempts / 60 s cooldown / 5 per hour & 10 per
day per destination / 20 per hour per IP; MFA 5 failures per 15 min; upload URL 15 min; download URL 5 min;
deletion grace 14 days; export retention 7 days (`modules/auth/common.ts` → `SECURITY`).

---

**Catatan keterbatasan (footer):** integrasi SMS/WhatsApp (Twilio), S3/R2, ClamAV dan name-inquiry bank
diuji terhadap server/fetch palsu, bukan layanan live; mode MOCK/SANDBOX harus tetap diberi label. Usia minimal
KYC 17 tahun, retensi ekspor 7 hari, masa tenggang penghapusan 14 hari dan seluruh `data_retention_policies`
adalah **asumsi** yang menunggu review hukum. Level 5 dievaluasi oleh grup engagement. Rute dev storage dibatasi
body 1 MB oleh middleware global `app.ts` (unggahan > 1 MB di dev butuh pengecualian di file bersama).
