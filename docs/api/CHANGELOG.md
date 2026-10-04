# API contract changelog

For the Flutter (apps/mobile) and admin (apps/admin) teams. Generate clients from `docs/api/openapi.json`
(regenerated with `cd apps/api && npx tsx scripts/export-openapi.ts`). Newest first.

Legend: **ADD** backward-compatible addition · **CHG** changed value/behaviour of an existing field (check your client) ·
**DEP** deprecated but still returned · **DB** migration / seed.

---

## 2026-10-04

OpenAPI regeneration pending (lead). Entries are grouped per workstream; agents append their own bullets.

### Regulatory B1 — consumer complaint channel (L12) & AI-content label (L13), Permendag 19/2026 · UU 8/1999
- **DB** `0130_consumer_complaints.sql`: `support_tickets.category` accepts `COMPLAINT` (CHECK swapped NOT VALID → VALIDATE, additive).
- **ADD** `GET /v1/support/complaint-info` (public, 120 req/min/IP, `Cache-Control: public, max-age=300`) → `ComplaintInfo {channels, sla,
  escalation, disputeFlow, legalBasis}`: JastipKita channels from new optional env `SUPPORT_WHATSAPP` / `SUPPORT_EMAIL` (null when unset),
  first-response SLA by priority from config `support.sla`, government escalation (Ditjen PKTN Kemendag, verified 2026-10-04) — engagement.md §8.1.
- **ADD** `POST /v1/support/tickets` category `COMPLAINT` (default priority `HIGH`) and optional body `priority` `LOW | NORMAL | HIGH`
  (`URGENT` stays agent-only → 400). `SupportTicket.category` may now be `COMPLAINT` — clients must render unknown/new categories gracefully.
- **CHG** `POST /v1/support/tickets`: `slaDueAt` now uses the ACTIVE `support.sla` config (was a hard-coded table with the same default
  values), consistent with the admin queue. `support.ticket_updated` payload adds `category`.
- **ADD** `RequestOwner.autoFill` / `RequestListing.autoFill` (`RequestAutoFill {sourceType, mode} | null`): set when product data came
  from `POST /v1/requests/extract` (sourceType URL/PHOTO/SEARCH + non-empty `extraction`). Show the AI-content label when non-null — marketplace.md §2.2.
- Mobile (same change set): *Bantuan → Pengaduan konsumen* screen (files COMPLAINT, shows SLA + escalation), auto-fill labels in the
  create-request form and on request detail. Web: `/pengaduan/`, `/en/complaints/` (footer + help center links).

### Auth A1 — web refresh token in an HttpOnly cookie (SEC-14) · OAuth nonce required + single use (SEC-15)
Mobile & admin: **no action needed** unless noted (body transport is unchanged and stays the default).
- **ADD** request header `X-JK-Token-Transport: cookie | body` on `POST /v1/auth/{otp/verify,google,apple,refresh,logout}` (web only).
  `cookie` → the API sets `jk_rt` (`HttpOnly; Secure; SameSite=Strict; Path=/v1/auth; Max-Age = REFRESH_TOKEN_TTL_DAYS`, no `Domain`) and
  **omits** `tokens.refreshToken` from the body; refresh/logout read the cookie. Requires an `Origin` in the web allow-list
  (`WEB_BASE_URL` origin + `CORS_ORIGINS`) → else `403 ORIGIN_NOT_ALLOWED` (checked before any side effect). identity.md §3.3.
- **CHG (schema only)** `Tokens.refreshToken` is now **optional** in OpenAPI: always present with body transport, absent only with
  cookie transport. Generated TS clients: guard before storing (admin `api/session.ts` already does). Mobile (hand-written) unaffected.
- **CHG** `POST /v1/auth/refresh`: body optional (`Refresh.refreshToken` optional); cookie transport without a cookie → `401 REFRESH_MISSING`;
  a failed cookie refresh clears the cookie. Body transport without a token → `400 VALIDATION_ERROR` as before.
- **CHG** `POST /v1/auth/logout`: bearer no longer mandatory — accepts the bearer (still verified strictly when sent) and/or a refresh
  token (`Logout {refreshToken?}` body, or the cookie); no credential → `401`; a token whose session already ended → `200` (idempotent).
- **CHG** CORS: `Access-Control-Allow-Credentials: true` for the web origins only (admin stays without credentials, never `*`);
  `X-JK-Token-Transport` added to the allowed request headers. Token responses carry `Cache-Control: no-store`.
- **CHG** `POST /v1/auth/apple`: a nonce is **required** by default (`rawNonce`, or the legacy hashed `nonce`) → `401 OAUTH_NONCE_REQUIRED
  {provider}`. The mobile app already always sends `rawNonce`.
- **ADD** env `OAUTH_REQUIRE_NONCE` (csv `GOOGLE,APPLE` | `none`; empty = `APPLE`; production must include `APPLE`). Google stays optional
  until the mobile Google flow sends a nonce (web sends one now) — **Eng-Mobile:** pass a nonce to Google sign-in, then ops adds `GOOGLE`.
- **CHG** `POST /v1/auth/google`: `nonce` min length 16. A verified nonce (either provider) makes the ID token **single use**: replay →
  `401 OAUTH_TOKEN_INVALID {reason: NONCE_REUSED}`. `422 CONSENT_REQUIRED` does not consume it (re-submitting the same token with consents works).
- **DB** `0110_oauth_nonce_replay.sql`: table `oauth_nonce_uses (provider, nonce_hash, expires_at)` — no PII, purged after expiry.
- **DB** seed `0200_legal_documents.sql` regenerated: the generator now uses each document's frontmatter `version`; `COOKIES` → `0.3-template`
  (new strictly-necessary cookie `jk_rt`, sessionStorage `jk:refresh` removed). Other documents stay `0.1-template`.

### Money & marketplace A2 — new payout account cooldown · SEC-18 file responses · SEC-19 week precision for anonymous trip discovery
Decisions by the CEO on the Commissioner's delegation (2026-10-04). **Mobile:** read `cooldownUntil` / `payoutsFrom` (optional
display) and make sure discovery always sends the bearer (it does today). **Web:** done (week ranges). **Admin:** done (payout list).
- **ADD** config `money.policy.newPayoutAccountCooldownHours` (int 0–720, default **24**; optional in versions stored before today —
  readers merge the default). A payout account added, verified or made default less than N hours ago receives no payout: the payout is
  scheduled at `max(normal schedule, ready time)` with ready time = latest of `created_at` / `verified_at` / `default_since` + N, and the
  processor re-checks it (money.md §5.7).
- **DB** `0120_payout_account_cooldown.sql`: `payout_accounts.default_since` (when the account became the default, NULL otherwise),
  maintained by trigger `trg_payout_account_default_since` for every writer (explicit value of the same statement wins, else `now()`;
  immutable while the account stays default) + CHECK `is_default = (default_since IS NOT NULL)`; existing defaults backfilled
  (no retroactive cooldown). Seed `0001_reference.sql` regenerated (new `money.policy` key).
- **ADD** `GET /v1/payouts/mine` → `data[].cooldownUntil` (ISO or null); `GET /v1/admin/payouts` → `cooldownUntil` (SCHEDULED / ON_HOLD /
  FAILED only); `PayoutAccount.payoutsFrom` on `GET/POST /v1/kyc/payout-accounts` and `POST …/{id}/default`.
- **CHG** a default change (`POST /v1/kyc/payout-accounts/{id}/default`, adding an account as default, removing the default → another
  promoted) **re-points** the traveler's SCHEDULED / ON_HOLD / FAILED payouts to the new default and pushes SCHEDULED ones to its ready
  time (audit `payout.destination_changed`; event `payout.scheduled {kind: DESTINATION_CHANGED, cooldownUntil}`). The old account is then
  no longer "in use" and can be removed. The processor applies the same rule to default changes made outside the API (admin override):
  re-point + defer (`payout.scheduled {kind: ACCOUNT_COOLDOWN}`, audit `payout.cooldown_deferred`). `processPayouts()` result adds `deferred`.
- **CHG** `payout.scheduled` payload adds `cooldownUntil` (+ `scheduledFor` everywhere); the traveler notification says when the
  payout is released and why ("rekening payout baru"), and warns on a destination change ("Bukan kamu?").
- **CHG** (SEC-18) file responses: `Content-Disposition: inline` **only** for raster images (jpeg/png/webp/heic) — PDF, MP4, exports and
  unknown types are `attachment`; responses the API serves (`/v1/files/{id}/content`, dev storage) add `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox` (a route's own CSP now wins over the API-wide one).
  Presigned S3/R2 GET URLs pin `response-content-type` + `response-content-disposition` (signed); a presign without a known type is
  `attachment`. `StorageProvider.presignDownload` takes optional `contentType` / `disposition`.
- **ADD/CHG** (SEC-19) `TripPublic` (discovery, trip detail public view, matching/offers) adds `datePrecision: DAY | WEEK`,
  `departureWindow` / `arrivalWindow` `{from, to}`. `GET /v1/trips` and `GET /v1/trips/{id}` without a bearer answer **WEEK**: windows =
  ISO week Mon–Sun and `departureDate` / `arrivalDate` = the window's Monday (**not** the exact date — render the window); date filters are
  evaluated per whole week, results ordered by (week, id). With a valid bearer of an ACTIVE account: **DAY**, exact dates as before.
  A bearer that does not verify now answers `401` on these two routes (was: silently anonymous) so the app refreshes and retries;
  non-ACTIVE accounts are served like anonymous visitors. Anonymous responses `Cache-Control: public, max-age=30`, signed-in
  `private, no-store`, both `Vary: Authorization`. Cursors are precision-specific.

### Operations D — audit checkpoints (T12), worker heartbeat & alerting as code (T6), restore drill (T5)
- **DB** `0140_audit_checkpoints.sql`: append-only `audit_checkpoints` (one row per UTC day: `last_id`, `last_hash`, `row_count`,
  `storage_key` `audit-checkpoints/YYYY/MM/DD.json`, `object_sha256`, `prev_object_sha256`, `storage_mode`); jk_app SELECT/INSERT only.
  The unused `audit_chain_checkpoints` (0004) is marked superseded (kept, not dropped).
- **ADD** `GET /v1/admin/infra/audit/checkpoints/verify` (`infra.db.read`, read-only) → `status OK | BROKEN | NO_CHECKPOINT`, `checkpoint`,
  `anchor {hashMatches, rowCountMatches}`, `segment {fromId, toId, rowsSinceCheckpoint, brokenAtId}`, `history`, `storage {status MATCH |
  MISMATCH | MISSING | ERROR | SKIPPED, mode, key}`, `findings[]`, `warnings[]`, `recent[]` (last 10) — admin.md §6. Admin web: card
  "Checkpoint rantai audit (WORM)" in DB & Infra Center → Backup & restore (calls the route with a raw authenticated GET until
  `schema.d.ts` is regenerated).
- **ADD** `GET /v1/health/worker` (public, 60 req/min/IP, `Cache-Control: no-store`) → `WorkerHeartbeat {status ok|stale,
  lastScheduledJobAt, ageSec, staleAfterSec, checkedAt}`; **503** when no scheduled job finished within 3 cron intervals (production
  900 s, other environments 2700 s). For external uptime checkers; no sensitive data.
- **ADD** worker job `infra.audit_checkpoint` (daily, new job group `jobs/infra.ts`): verifies the chain since the previous checkpoint,
  then stores the head in `audit_checkpoints` + storage; a broken chain is never anchored (CRITICAL `AUDIT_CHAIN_BROKEN` security event,
  log `ALERT audit.checkpoint_refused`). Audit action `infra.audit_checkpoint_created`.
- **ADD** log line `ALERT ops.alert_opened` (`code`, `severity`, `value`, `threshold`) once per in-app alert opening, after COMMIT
  (`admin.alerts_evaluate`) — the hook for log-based paging (`infra/monitoring/alerts.yaml`).
- Ops tooling (no API change): `db/scripts/restore-test.sh` (dump → restore into a fresh DB → 8 integrity checks → report,
  optional `db_operations` RESTORE_TEST row), `infra/monitoring/alerts.yaml`, runbooks `secret-rotation.md`, `cloudflare-waf.md`.

---

## 2026-09-28 (sore) — SEC-16 / SEC-17 / SEC-20, effective permissions, admin reconciliation

OpenAPI regenerated (256 paths). No client action required; admin web already consumes `permissions` and the reconciliation routes.

- **ADD** `GET /v1/me` → `adminMfaPolicy {stepUpSec, sessionMaxAgeSec}` for staff (`null` otherwise); the admin MFA countdown uses it.
- **ADD** `GET /v1/admin/disputes/{id}` → `transaction.refundableIdr`: the amount a REFUND_FULL resolution refunds (and the exclusive
  upper bound of REFUND_PARTIAL); the admin resolve dialog previews with it.
- **ADD** Admin reconciliation: `GET /v1/admin/reconciliation/runs`, `GET /v1/admin/reconciliation/runs/{id}/items`,
  `POST /v1/admin/reconciliation/items/{id}/resolve` (M), `POST /v1/admin/reconciliation/runs` (M I) — see `docs/api/admin.md`.

- **ADD** `GET /v1/me` → `permissions: string[]` — effective permission codes of the active roles (`role_permissions`), `[]` for
  non-staff. UI hint only; every admin route still enforces RBAC. Admin web now prefers it over its mirrored role matrix.
- **CHG** `DELETE /v1/admin/users/{id}/roles/{roleCode}` also revokes **every session** of the subject (SEC-16): the next call with the
  old token answers `401`, the user logs in again. Audit/security event carry `sessionsRevoked`.
- **CHG** `POST /v1/kyc/payout-accounts` without a verified identity record: a bank-name match is stored as `verificationStatus: PENDING`
  (not `VERIFIED`, not default, does not unlock level 4) until admin review (SEC-17). With a verified identity nothing changes.
- **CHG** error bodies for DB rule violations (SEC-20): custom `JK*` codes answer fixed Indonesian text instead of the raw DB message;
  `details` is empty except `JK409` (`currentVersion`, `currentStatus`), `JK422`/`JK403`/`JK404` (unchanged) and `JK423` (blockers);
  `409 DUPLICATE` no longer includes the constraint name; ledger/quote invariants (`JKL*`, `JKQ01`) answer **500**.

---

## 2026-09-28 — QA follow-ups + SEC-12 / SEC-13 (`docs/checklists/test-scenarios.md`, `docs/security/review-2026-09.md`)

OpenAPI regenerated (253 paths; 6 new admin operations, new request fields). **Mobile/web action required** for the
step-up OTP (payout accounts, refund destinations) — without it these calls now answer `403 STEP_UP_REQUIRED`.

### Identity — SEC-12 step-up for money destinations
- **ADD** `POST /v1/auth/otp/request` purpose `SENSITIVE_ACTION` with `action` (`REFUND_DESTINATION_SET` | `PAYOUT_ACCOUNT_ADD` |
  `PAYOUT_ACCOUNT_SET_DEFAULT`) + `targetId` (refund id / own user id / payout account id); bearer required; destination must be the
  verified phone or e-mail (`422 STEP_UP_DESTINATION_NOT_VERIFIED`); code valid 10 min, single use. Schema `StepUpProof {challengeId, code}`.
- **CHG** `POST /v1/kyc/payout-accounts` and `POST /v1/kyc/payout-accounts/{id}/default` (unless already default) require body `stepUp`
  (`403 STEP_UP_REQUIRED {purpose, action, targetId}`, `403 STEP_UP_MISMATCH`, `400 OTP_INVALID | OTP_EXPIRED`). `/default` now accepts an
  optional JSON body.
- **CHG** `POST /v1/kyc/payout-accounts`: with a verified identity (≥ L3) a bank holder name that differs from the KYC name is stored with
  `verificationStatus: NAME_MISMATCH` (201, never default, admin review) instead of `422 BANK_ACCOUNT_NAME_MISMATCH` (still returned when
  the user has no verified identity).

### Identity — SEC-13 TOTP enrollment
- **CHG** `POST /v1/auth/mfa/totp/enroll` only from a session created by an OTP login ≤ 15 min ago (`403 MFA_ENROLL_FRESH_LOGIN_REQUIRED`);
  a pending enrollment of another session → `409 MFA_ENROLLMENT_IN_PROGRESS {retryAfterSec}`; confirmed factor → `409 MFA_ALREADY_ENROLLED`.
  Admin SPA: if enrollment is refused, send the admin through the OTP login again.
- **CHG** `POST /v1/auth/mfa/totp/confirm` only from the enrolling session (`403 MFA_ENROLL_SESSION_MISMATCH`), within 15 min
  (`409 MFA_ENROLLMENT_EXPIRED`).
- **ADD** Admin: `POST /v1/admin/users/{id}/mfa-reset-requests`, `GET /v1/admin/rbac/mfa-reset-requests`,
  `POST /v1/admin/rbac/mfa-reset-requests/{id}/approve|reject` (maker-checker; another SUPER_ADMIN approves).

### Money
- **CHG** `POST /v1/refunds/{id}/destination` requires `stepUp` (action `REFUND_DESTINATION_SET`, targetId = refund id); response adds
  `refundId`, `reviewRequired` and `validationStatus` may be `PENDING_REVIEW` (holder name ≠ verified identity; paid only after FINANCE
  approval), `validatedAt` may be null.
- **ADD** Admin: `GET /v1/admin/refund-destinations?status`, `POST /v1/admin/refund-destinations/{id}/review {decision, note}`.
- **CHG** Trip cancelled by the traveler (`trip.cancelled`) now settles every open transaction (BUG-QA-01/02): unpaid → CANCELLED (open
  invoice expired, provider session cancelled), paid → REFUND_PENDING → REFUNDED incl. payment fee + traveler penalty; both parties get
  `transaction.trip_cancelled`. `POST /v1/trips/{id}/cancel` → `409 TRIP_HAS_PURCHASED_TRANSACTIONS {transactionIds}` once goods were bought.
- **ADD** `POST /v1/transactions/{id}/quote` and `/checkout` → `422 TRIP_NOT_AVAILABLE {tripStatus}` for a CANCELLED/COMPLETED trip; a
  payment webhook for such a trip is recorded and auto-refunded (late-payment path).
- **CHG** Idempotency: a `429` (and 5xx) is no longer stored/replayed — retry with the same key after `Retry-After` (BUG-QA-05). Money
  routes rate-limit before the idempotency claim (new limits: checkout 10/min, confirm-receipt, price respond, cancel 30/min per user;
  admin money writes 60/min).
- **CHG** `POST /v1/transactions/{id}/cancel` → `refunds[]` carries the status after processing (BUG-QA-06).
- **CHG** Payout holds placed because of a dispute are released automatically once the dispute is CLOSED and no risk review is open
  (`payout.scheduled {kind: HOLD_AUTO_RELEASED}`); manual FINANCE release for everything else.
- **CHG** Purchase proof: a merchant name that differs from the request's merchant is a low-weight REVIEW signal (proof ACCEPTED, payout
  not held); brand store vs shop domain counts as the same merchant (`merchantsMatch`, money.md §5.5).

### Engagement
- **ADD** Notification templates `refund.destination_required`, `refund.destination_updated`, `price.clarification_requested`,
  `transaction.trip_cancelled` (in-app + push + e-mail, ID/EN; critical channels in engagement.md §2.3). `refund.requested` copy no longer
  promises the original payment method for bank-disbursed refunds.

### DB
- **DB** `0090_qa_security_followups`: `otp_challenges` purpose `SENSITIVE_ACTION` + `action`/`target_id`; `refund_destinations`
  `PENDING_REVIEW`/`REJECTED`, `name_match`, review columns, `step_up_challenge_id`; `refresh_tokens.auth_method`/`session_started_at`;
  `mfa_factors.enroll_session_id`; table `admin_mfa_reset_requests` + guard trigger; grants re-applied. Seed: payout edge
  `ON_HOLD → SCHEDULED` allows SYSTEM (auto-release).

---

## 2026-09-28 — security review (`docs/security/review-2026-09.md`)

OpenAPI document unchanged (no path/schema changes); the behaviour below changed.

### Admin (all `/v1/admin/*`) — SEC-01
- **CHG** Every admin operation now requires an **MFA-verified session**, not only sensitive writes: an admin whose session never passed
  TOTP/recovery code (or passed it more than `ADMIN_SESSION_MFA_MAX_AGE_SEC`, default 12 h, ago) gets
  `403 MFA_REQUIRED` with `details.scope = "SESSION"`. `POST /v1/auth/mfa/totp/confirm` and `POST /v1/auth/mfa/verify` mark the session
  (server-side, survives `POST /v1/auth/refresh`), so the Admin SPA's existing step-up flow (verify → retry) handles it. Sensitive writes still
  need a step-up ≤ 15 min (`403 MFA_REQUIRED` without `scope`). The SPA now also runs the step-up for queries that fail with MFA_REQUIRED.
- **CHG** Staff access to other users' files (`GET /v1/files/{id}`, `/url`, `/content` via `kyc.review`, `trips.verify`, `disputes.manage`,
  `transactions.read`) requires the same MFA-verified session (`403 MFA_REQUIRED`).
- **CHG** `POST /v1/auth/mfa/totp/enroll` needs only an admin role (not a verified session — otherwise nobody could enrol) and is
  rate-limited to 10/hour per user.

### Money
- **ADD** `POST /v1/transactions/{id}/checkout` → `422 PROMO_NO_LONGER_VALID` `{promoId, reason: NOT_ACTIVE | OUTSIDE_DATE_WINDOW |
  PER_USER_LIMIT_REACHED | GLOBAL_LIMIT_REACHED | BUDGET_EXHAUSTED | NOT_FIRST_TRANSACTION}` when a promotion applied by the quote is no
  longer available at checkout (SEC-02). Clients: request a new quote (it will no longer carry the discount), then checkout.
- **CHG** `POST /v1/webhooks/payments/{provider}`: a payment callback the provider's own API does not confirm (status not paid, or the
  re-check unavailable) now answers `500 WEBHOOK_PROCESSING_FAILED` and changes nothing; the provider retries and the PENDING-payment
  reconciliation settles it (SEC-03). Previously the callback token alone secured the payment.
- **CHG** Idempotency: concurrent retries of a key whose first attempt failed now get `409 IDEMPOTENCY_IN_PROGRESS` except one (SEC-04).

### Identity
- **CHG** `POST /v1/auth/logout` and `DELETE /v1/auth/sessions/{id}` also stop push notifications of that account on the session's device
  (the device is re-linked on the next login) (SEC-07).
- **CHG** Client IP for rate limits / OTP quotas: `CF-Connecting-IP`, else the **right-most** `X-Forwarded-For` entry (SEC-06).

### Config
- **CHG** `APP_ENV=production` refuses to start with `EMAIL_PROVIDER=log`, `SMS_PROVIDER=log`, `KYC_PROVIDER=mock`, or a malware scanner other
  than `clamav-http` with `CLAMAV_HTTP_URL` (SEC-08). **ADD** `ADMIN_SESSION_MFA_MAX_AGE_SEC` (900–604800, default 43200).

### Database
- **DB** `0080_security_hardening`: `refresh_tokens.mfa_verified_at`; `refund_destinations` ciphertext columns nullable (only after
  anonymization, CHECK paired); `anonymize_user()` also scrubs refund bank destinations and offer/invite messages (SEC-09).

---

## 2026-09-27 — contract gaps (Flutter & admin)

### OpenAPI document (all clients)
- **ADD** Every operation now has an `operationId` (273 operations, unique, camelCase). Rule: `method + PascalCase(path without /v1)`,
  path parameters become `By<Param>` — e.g. `GET /v1/transactions/{id}` → `getTransactionsById`,
  `POST /v1/transactions/{id}/price-confirmations/{pcId}/respond` → `postTransactionsByIdPriceConfirmationsByPcIdRespond`.
  It only changes if the path changes. Duplicates fail app start-up (`assignOperationIds`) and `test/openapi-contract.test.ts`.
- **CHG** Emoji removed from operation summaries/descriptions (e.g. checkout, cancel, confirm-receipt, price-confirmation respond,
  `me/mode`, OTP verify). Text only.
- **CHG** All 16 operations that require `Idempotency-Key` (4 money + 12 admin) declare the same header parameter
  (`name: idempotency-key`, `in: header`, required, 8–255 chars) from the shared `IdempotencyHeader`. Only the parameter description text
  changed; behaviour (400 `IDEMPOTENCY_KEY_REQUIRED`, replay, 422 `IDEMPOTENCY_KEY_REUSED`) is unchanged.
- **ADD** New components: `TransactionSummary`, `TransactionParty`, `TransactionItem`, `TripRoute`, `PriceConfirmation`, `PurchaseProof`,
  `PurchaseProofFile`, `CustomsDeclaration`, `Delivery`, `Refund`, `TransactionPayout`, `RatingSummaryCompact`, `PaymentOption`,
  `CancellationPreview`, `TrustTier`, `TrustBadge`, `TransactionConversation`, `RequestImage`, `LegalDocumentSummary`, `LegalDocumentList`,
  `LegalDocument`, `ConsentRequirement`, `ConsentRequirements`.

### Transactions (money)
- **CHG** `GET /v1/transactions/{id}` (`TransactionDetail`) is now fully typed (was loose objects). Existing fields keep their names and values
  except `buyer.displayName` / `traveler.displayName`, now **first name + last initial** ("Budi S.") like every other public profile (privacy fix).
  `status` is typed as the transaction status enum.
- **ADD** detail fields: `item.currency`, `item.imageUrl`; `buyer`/`traveler` → `avatarUrl`, `trustScore`, `trustTier`, `trustBadge`,
  `identityVerified`, `ratingSummary {asTraveler, asBuyer}`; `trip` (route + dates); `purchaseCeilingIdr`; `purchaseProof.files[]`
  (`{id, kind, mime, sizeBytes, contentUrl}` — only the proof's own files); `delivery.pinAvailable` (buyer only); `payout.scheduledAt`
  (traveler only; `payout` is always null for the buyer); `conversationId`; `quote.paymentOptions`.
- **DEP** `item.priceCurrency` (use `item.currency`), `purchaseCeiling {minor, idr}` (use `purchaseCeilingIdr`), party `rating`
  (use `ratingSummary`; `rating` stays null when the user has no rating row).
- **ADD** `GET /v1/transactions` list items: `item.imageUrl`, `counterparty {id, role, displayName, avatarUrl}`, `purchaseCeilingIdr`.
- **ADD** `GET /v1/transactions/{id}/cancel/preview?cause=` → `CancellationPreview`: `allowed`, `stage`, `reasonCode`, `reason`, `refundIdr`,
  `refundByLine`, `retainedByLine`, `travelerCompensationIdr`, `platformRetainedIdr`, `paymentFeeRetainedIdr`, `serviceTaxRetainedIdr`,
  `customsRetainedIdr`, `creditRestoredIdr`, `discountReversedIdr`, `trustPenalty`, `penalizedActor`, `requiresAdminApproval`,
  `fsmPermitsActor`, `transitionPath`, `canCancel`, `blockedBy {code, message}`. Same evaluation code path as `POST /cancel`
  (tested: preview == executed outcome). No side effects.
- **ADD** `POST /v1/transactions/{id}/quote` (and `quote` in the detail) → `paymentOptions[]`
  `{channel, label, feeIdr, totalIdr, bearer, refundable, minAmountIdr, maxAmountIdr, available, unavailableReason, selected}` for every
  configured channel (VA, QRIS, EWALLET, CARD). `totalIdr` equals what re-quoting with that channel returns. `refundable: false` for VA/retail.
  Quotes created before this release return `[]`. Checkout still needs a quote priced for the chosen channel.
- **ADD** `Quote` schema now also documents `item`, `configVersions`, `ruleRefs`, typed `fx`, `customs`, `restricted`, `promotion`, `credit`, `limits`.

### Public profiles (marketplace)
- **ADD** `PublicProfile` (trip discovery `GET /v1/trips`, `GET /v1/trips/{id}`, recommendations, offers, request listings):
  `trustScore` (0–100), `trustTier {tier EXCELLENT|GOOD|FAIR|LOW, label, labelEn}`, `kycLevel`.
- **CHG** Request `images[]`: uploaded photos now return an absolute `url` (was `null`) and a new `contentUrl`; merchant URLs unchanged
  (`contentUrl: null`).

### Chat (engagement)
- **ADD** `GET /v1/conversations/{id}` (participants only, 404 otherwise).
- **ADD** `GET /v1/transactions/{id}/conversation` → `{conversationId, transactionId, created, conversation}`; creates the conversation lazily
  once the transaction reached MATCHED; `409 CONVERSATION_NOT_AVAILABLE` before; 404 for non-parties.
- **ADD** message `attachments[].contentUrl` (absolute).

### Identity
- **ADD** `POST /v1/kyc/submissions` `documents.livenessFileIds: string[1..5]` (+ alias `documents.livenessFileId`); legacy
  `documents.liveness` kept. Each capture is validated (owner, purpose KYC, scan CLEAN) → `422 KYC_DOCUMENTS_INVALID {missing}`;
  > 5 in total → 422. All captures reach the KYC provider (`livenessFileKeys`).
- **ADD** `POST /v1/auth/apple` `rawNonce` (16–256 chars): the token `nonce` claim must equal `sha256hex(rawNonce)` (constant-time), else
  `401 OAUTH_TOKEN_INVALID {reason: NONCE_MISMATCH}`. Legacy `nonce` (verbatim compare) unchanged.
- **ADD** `GET /v1/legal/documents?locale&type`, `GET /v1/legal/documents/{type}?locale&version` (type code or slug; markdown body),
  `GET /v1/consents/requirements?locale` (signup: TOS + PRIVACY required, MARKETING optional; KYC: KYC required; `version` +
  `acceptedVersions`; with a token also `granted/upToDate/satisfied`). Public, rate limited, `Cache-Control: public, max-age=300` for documents.
- **CHG** Consent versions are now **enforced**: the seeded templates are published, so `POST /v1/me/consents` and signup `consents` accept
  only `0.1-template` for TOS/PRIVACY/KYC/MARKETING/COOKIES/TRAVELER_AGREEMENT/PAYMENT_TERMS (others → `422 CONSENT_VERSION_INVALID
  {allowedVersions}`). Clients must read the version from `GET /v1/consents/requirements` (the Flutter consent screen already retries with
  `allowedVersions`). Hard-coded `AppConfig.consentVersion` values such as `2026-09` are rejected.
  **Action for web:** `apps/web/src/lib/api.ts` `LEGAL_CONSENT_VERSION = '2026-09'` has no retry → web signup (`/masuk`) returns 422
  after this release until it reads `GET /v1/consents/requirements` (or is set to `0.1-template`). Deploy together.
  **Action for Flutter:** the signup consent screen retries with `allowedVersions`, but the KYC consent step
  (`kyc_submission_screen.dart` → `grantKycConsent(AppConfig.consentVersion)`) does not → KYC consent fails with the default
  `CONSENT_VERSION=2026-09`. Use `kyc.required[0].version` from `GET /v1/consents/requirements` (or build with `--dart-define=CONSENT_VERSION=0.1-template`).

### Admin
- **ADD** `POST/PATCH /v1/admin/legal-documents`: `summary`, `effectiveAt`; responses include `summary`, `effectiveAt`; type
  `COMMUNITY_GUIDELINES` accepted.
- **CHG** `GET /v1/admin/disputes/{id}` evidence `fileUrlEndpoint` is now absolute; **ADD** `contentUrl`.

### Files
- **CHG** Rule: every file URL the API returns (`url`, `contentUrl`, `avatarUrl`, `imageUrl`, `fileUrlEndpoint`) is absolute — presigned
  storage URLs or `${API_BASE_URL}/v1/files/{id}/content` (bearer token required).

### Database
- **DB** Migration `0070_legal_public_documents.sql`: `legal_documents.type` + `COMMUNITY_GUIDELINES`, new nullable columns `summary`,
  `effective_at`. Forward-only, idempotent, no down script.
- **DB** Seed `0200_legal_documents.sql` (generated by `apps/api/scripts/gen-legal-seed.ts` from `docs/legal/*.md`): 10 published
  documents, version `0.1-template`, locale `id`, TEMPLATE banner preserved. Seeds run on every deploy.

---
*Catatan keterbatasan: teks legal yang di-seed adalah TEMPLATE yang belum direview konsultan hukum, namun berstatus PUBLISHED (immutable) di
setiap lingkungan yang menjalankan seed — termasuk produksi — sehingga pengguna menyetujui versi `0.1-template` sampai Compliance menerbitkan
versi final. Batas nominal kanal (QRIS Rp10.000.000, VA Rp10.000–Rp50.000.000; E-Wallet/Kartu NEEDS_VERIFICATION) dan status refundable per
kanal berasal dari riset Xendit (`docs/research/02-xendit-integration.md`), bukan kontrak. Rentang tier Trust Score mengikuti design tokens,
bukan konfigurasi bisnis. `paymentOptions` untuk quote lama bernilai `[]`.*

## 2026-09-28
- `TransactionDetail.purchaseCeilingMinor` (merchant-currency minor units) added; `purchaseCeiling` remains deprecated but present.
- Admin user detail: `mfa {enrolled, pendingEnrollment}`.
- Refunds: `destinationRequired` is true again after a destination is REJECTED/INVALID.
- Legal: cookie-policy 0.2-template (storage keys `jk:*`, refresh token in sessionStorage, access token memory-only).
