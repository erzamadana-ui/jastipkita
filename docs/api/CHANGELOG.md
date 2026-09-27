# API contract changelog

For the Flutter (apps/mobile) and admin (apps/admin) teams. Generate clients from `docs/api/openapi.json`
(regenerated with `cd apps/api && npx tsx scripts/export-openapi.ts`). Newest first.

Legend: **ADD** backward-compatible addition · **CHG** changed value/behaviour of an existing field (check your client) ·
**DEP** deprecated but still returned · **DB** migration / seed.

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
