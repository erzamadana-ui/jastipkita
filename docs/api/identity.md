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
| `POST /auth/otp/request` | public (LOGIN) / 🔒 (VERIFY_*) | `{channel SMS\|WHATSAPP\|EMAIL, destination, purpose LOGIN\|VERIFY_PHONE\|VERIFY_EMAIL, locale?}` → `{challengeId, expiresAt, resendAvailableAt, devCode?}` |
| `POST /auth/otp/verify` | public / 🔒 | `{challengeId, code, device?, consents?}` → LOGIN `{purpose, verified, tokens, user, isNewUser}`; VERIFY_* `{purpose, verified, user}` |
| `POST /auth/google` | public | `{idToken, nonce?, device?, consents?}` → `{tokens, user, isNewUser}` |
| `POST /auth/apple` | public | `{identityToken, nonce?, fullName?, device?, consents?}` → `{tokens, user, isNewUser}` |
| `POST /auth/refresh` | public | `{refreshToken}` → `{tokens}` (rotation) |
| `POST /auth/logout` · `GET /auth/sessions` · `DELETE /auth/sessions/{id}` | 🔒 | |
| `POST /auth/mfa/totp/enroll` | 🔒 admin (any role) | secret returned once |
| `POST /auth/mfa/totp/confirm` · `POST /auth/mfa/verify` | 🔒 | step-up token with `mfa_at` |
| `GET /me` · `PATCH /me` · `POST /me/mode` | 🔒 | |
| `GET/POST /me/devices` · `DELETE /me/devices/{id}` | 🔒 | |
| `GET/POST /me/consents` | 🔒 | append-only |
| `POST /files/uploads` · `POST /files/{id}/complete` · `GET /files/{id}` · `GET /files/{id}/url` · `GET /files/{id}/content` | 🔒 | |
| `GET /kyc/status` | 🔒 | |
| `POST /kyc/submissions` | 🔒 K2 | |
| `GET/POST /kyc/payout-accounts` · `DELETE /kyc/payout-accounts/{id}` · `POST /kyc/payout-accounts/{id}/default` | 🔒 K3 | masked only |
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
  App->>Google/Apple: native sign-in (nonce optional)
  App->>API: POST /auth/google {idToken} | /auth/apple {identityToken, fullName?}
  API->>JWKS: verify RS256 (cached remote JWKS; injectable resolver)
  API->>API: iss, aud ∈ *_CLIENT_IDS, exp (60 s tolerance), nonce, email_verified
  API->>DB: identity (provider, sub) → user | verified e-mail → link | create (consents, signup risk)
  API-->>App: {tokens, user, isNewUser}
```

* Google: JWKS `https://www.googleapis.com/oauth2/v3/certs`, `iss` ∈ {`accounts.google.com`, `https://accounts.google.com`},
  `aud` ∈ `GOOGLE_CLIENT_IDS`, **`email_verified` required** (`401 OAUTH_EMAIL_UNVERIFIED`).
* Apple: JWKS `https://appleid.apple.com/auth/keys`, `iss = https://appleid.apple.com`, `aud` ∈ `APPLE_CLIENT_IDS`.
  Private-relay e-mails are accepted. `fullName` is sent by Apple only on the first authorization and is stored
  only then (or if the stored name is empty).
* Failures → `401 OAUTH_TOKEN_INVALID {reason: AUDIENCE_MISMATCH | TOKEN_EXPIRED | ISSUER_MISMATCH | SIGNATURE_INVALID | NONCE_MISMATCH | CLAIMS_INVALID}`
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

## 3. Sessions & MFA

* Access JWT HS256 (15 min, `sid` = refresh family, optional `mfa_at`); refresh token opaque 256-bit, SHA-256
  stored, 30 days, single use (`services/session.ts`). Reusing a rotated refresh token revokes the whole family
  and writes `REFRESH_TOKEN_REUSE` (HIGH). Every request re-checks that the family is unrevoked.
* `GET /auth/sessions` lists families with device/platform; `DELETE /auth/sessions/{id}` and logout revoke.
  Unlinking a device (`DELETE /me/devices/{id}`) also revokes its sessions and push token.
* **Admin TOTP (RFC 6238, SHA-1, 30 s, ±1 step)**: enroll (admins only; secret AES-GCM encrypted with AAD
  `mfa_factors.secret:<id>`, shown once) → confirm (activates, 10 one-time recovery codes stored as HMAC,
  returns a step-up token) → verify (step-up: new access token for the **same session** with `mfa_at`, used by
  `requireRecentMfa`). Replay protection: a code whose time-step ≤ `last_used_step` is rejected
  (`MFA_CODE_REPLAYED`). 5 failures in 15 min → `429 MFA_LOCKED`. Refreshing drops `mfa_at` (step-up again).

Security events written: `LOGIN_SUCCESS`, `LOGIN_FAILED`, `USER_REGISTERED`, `SIGNUP_BLOCKED`, `OTP_VERIFY_FAILED`,
`OTP_LOCKED`, `OTP_RATE_LIMITED`, `PHONE_VERIFIED`, `PHONE_CONFLICT`, `TRANSACTION_EMAIL_CHANGED`, `ACCOUNT_LINKED`,
`LOGOUT`, `SESSION_REVOKED`, `DEVICE_REMOVED`, `MFA_ENROLL_STARTED`, `MFA_ENABLED`, `MFA_VERIFIED`, `MFA_FAILED`,
`MFA_RECOVERY_CODE_USED`, `UPLOAD_TYPE_MISMATCH`, `MALWARE_UPLOAD`, `SENSITIVE_FILE_VIEWED`,
`KYC_DUPLICATE_IDENTITY`, `PAYOUT_ACCOUNT_INVALID`, `PAYOUT_ACCOUNT_NAME_MISMATCH`, `DATA_EXPORT_REQUESTED`,
`ACCOUNT_DELETION_REQUESTED`, `ACCOUNT_DELETION_CANCELLED` (+ `REFRESH_TOKEN_REUSE` from services/session).

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
   `{url: /v1/files/{id}/content, requiresAuth: true}` — streamed & decrypted by the API (`no-store`).

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
dateOfBirth, nationality?, documents:{idFront, idBack?, selfie, liveness?}}` (file ids, purpose KYC, READY).
ID number / name / DOB → AES-GCM (AAD `identity_records.<col>:<id>`); `id_number_hash = HMAC("kyc_id:<type>:<nat>:<number>")`
(UNIQUE — one document = one account). A hash owned by another account → `409 IDENTITY_ALREADY_REGISTERED`,
risk assessment (`sharedIdentityHashAccounts` → REVIEW) and `KYC_DUPLICATE_IDENTITY` (HIGH); no submission row.
FSM §15.4 via core `kycSubmissionFsm`: PENDING → IN_REVIEW (SYSTEM) → provider result: `PASSED` → APPROVED
(guard KYC_CHECKS: liveness/face ≥ 0.8) → level 3; `FAILED` → REJECTED (reason); `MANUAL_REVIEW` (manual provider,
provider error) → stays IN_REVIEW for the admin queue. Events `kyc.submitted`, `kyc.approved`, `kyc.rejected`.

Payout accounts (K3): number encrypted (AAD `payout_accounts.account_number:<id>`), HMAC `bank_account:<bank>:<number>`
(same account on other users = risk signal), mask `****1234`. Name inquiry via `payment.validateBankAccount`
(MOCK/SANDBOX in dev/test); the bank holder name must match the verified identity name (tolerant token match) →
`VERIFIED` (+ `payout_account.verified`, first verified becomes default) — mismatch `422 BANK_ACCOUNT_NAME_MISMATCH`,
invalid `422 BANK_ACCOUNT_INVALID`, inquiry unavailable → stored `PENDING` (cannot be default). Only VERIFIED can be
default; delete is refused while payouts are pending (`409 PAYOUT_ACCOUNT_IN_USE`). Responses show only the mask.

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
`DATA_ENCRYPTION_KEYS` (KEKs, first = active), `HMAC_PEPPER`, `GOOGLE_CLIENT_IDS`, `APPLE_CLIENT_IDS`, `OTP_DEV_ECHO`,
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
