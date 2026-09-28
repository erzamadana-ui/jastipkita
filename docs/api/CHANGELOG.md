# API contract changelog

For the Flutter (apps/mobile) and admin (apps/admin) teams. Generate clients from `docs/api/openapi.json`
(regenerated with `cd apps/api && npx tsx scripts/export-openapi.ts`). Newest first.

Legend: **ADD** backward-compatible addition · **CHG** changed value/behaviour of an existing field (check your client) ·
**DEP** deprecated but still returned · **DB** migration / seed.

---

## 2026-09-28 (sore) — SEC-16 / SEC-17 / SEC-20 + effective permissions

OpenAPI regenerated (253 paths). No client action required; admin web already consumes `permissions`.

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
