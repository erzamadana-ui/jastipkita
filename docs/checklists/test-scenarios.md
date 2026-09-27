# Test scenarios & traceability matrix — 2026-09-28

Product-brief requirement → where it is tested → status in the run of **2026-09-28** (QA). The brief itself is summarised in
[`docs/00-domain-model.md`](../00-domain-model.md) and [`docs/api/*.md`](../api/); requirements are numbered **R01–R42** here
in the order of the brief's feature list.

```bash
cd apps/api && npx vitest run test/e2e     # E2E journeys + mandatory scenarios (HTTP only)
cd apps/api && npx vitest run              # full API suite (module + security + e2e)
cd packages/core && npx vitest run         # pure engines
node tests/load/run.mjs                    # load test → docs/checklists/load-test-2026-09.md
```

**Status legend** — **PASS** automated and green in this run · **BUG** a failing test marked `it.fails` documents a defect
(§3) — it turns red ("expected to fail") once fixed, then drop `.fails` · **PARTIAL** core behaviour automated, listed gap not
· **DOC** documentation/checklist only · **NOT RUN** tests exist outside `apps/api`/`packages/core` and were not executed here.

**Run of 2026-09-28 (after the QA/SEC fix round):** `test/e2e` 8 files, **47 passed, 0 expected-fail** (the six BUG tests were
flipped to normal tests and extended); full API suite **85 files, 540 passed, 0 failed, 0 skipped** (new:
`test/security/step-up-mfa-enrollment.test.ts`); `packages/core` 21 files / 282 passed; `tsc --noEmit -p apps/api` clean;
`bash db/scripts/test-db.sh` 359 passed / 0 failed (new `db/tests/140_qa_security_followups.sql`). First run of the day (before the
fixes): e2e 40 passed + 6 expected-fail, API 521 passed + 6 expected-fail.

## 1. E2E journeys (`apps/api/test/e2e/`, HTTP only)

Every actor signs up through `POST /v1/auth/otp/request|verify` with the `devCode`, consents read from
`GET /v1/consents/requirements`, phone via `VERIFY_PHONE`, files via presigned dev storage (`/v1/files/uploads` → PUT →
`/complete`), admins step up with a real TOTP (`/v1/auth/mfa/totp/enroll|confirm`, `/v1/auth/mfa/verify`). Shortcuts, all
documented in `support.ts`: admin **role grants** inserted into `user_roles` (bootstrap), provider overrides (fake merchant
`fetch` for URL extraction, bank-name inquiry), DB **reads** for assertions, clock advances for time-based jobs.

| ID | Journey | File › tests | Status |
|---|---|---|---|
| J1 | Happy path: sign-up → consents → phone L2 → KYC (admin, TOTP) L3 → payout account → trip + e-ticket → admin verifies → publish → L4 → request from URL → recommendations → offer → MATCHED → quote (11 lines, `paymentOptions`) → checkout (Idempotency-Key) → webhook → PAYMENT_SECURED → DO NOT PURCHASE gate (proof refused) → price check +1 % → PURCHASE_APPROVED → proof (receipt PDF + photo) → TRAVELING → ARRIVED → CUSTOMS_PROCESS + declaration → READY_FOR_HANDOVER → PIN → DELIVERED → confirm → COMPLETED → payout PAID → ratings both ways; exact e-mail template list per role; no PIN in any e-mail/push/chat; chat STATUS messages; ledger (held buckets 0, revenue = quote, tolerance absorbed by platform); admin ledger `balanced`, KPI GMV, audit chain | `j1-happy-path.test.ts` › 13 tests (`onboarding …`, `request from a merchant URL …`, `quote: 11 price lines …`, `checkout with Idempotency-Key …`, `golden rule: DO NOT PURCHASE …`, `price check within tolerance …`, `travel: …`, `meet-up: …`, `buyer confirms receipt …`, `ratings both ways …`, `notifications: …`, `chat: …`, `admin: …`) | PASS |
| J2 | Price change +10 % → approve → SUPPLEMENTAL checkout → webhook → PURCHASE_APPROVED at new ceiling → COMPLETED; payout = new price | `j2-j3-price-change.test.ts` › `J2 … +10% at the store → …` | PASS |
| J3 | Price change rejected → REFUNDED incl. payment fee, cause `PRICE_CHANGE_REJECTED`, no penalty event, Trust Score cancellation component 0, capacity released, request CLOSED | `j2-j3-price-change.test.ts` › `J3 … buyer rejects → …` | PASS |
| J4 | DAMAGED_ITEM dispute after delivery, evidence from both sides → admin assign/review/resolve REFUND_PARTIAL Rp300.000 (MFA + Idempotency-Key, replay) → refund SUCCEEDED, COMPLETED → payout ON_HOLD until dispute CLOSED + FINANCE release → PAID; refund + payout + platform take = amount paid | `j4-dispute.test.ts` › `runs end to end …` | PASS |
| J5 | Traveler cancels after payment: preview == outcome, full refund incl. payment fee, penalty 5 (event + Trust Score component < 0), buyer not penalised, ledger drained | `j5-traveler-cancel.test.ts` › `preview == outcome …` · `cancel response refunds[] carries the fresh status …` (BUG-QA-06 fixed) | PASS |
| J6 | COURIER + tracking → OUT_FOR_DELIVERY (tracking no. in e-mail) → DELIVERED with proof → +47 h still DELIVERED → +49 h auto-confirm (SYSTEM, `confirmed_via AUTO`) → COMPLETED → PAID; sessions renewed through `/v1/auth/refresh`; late manual confirm harmless | `j6-courier-autoconfirm.test.ts` | PASS |
| J7 | Referral: code + share link, self-referral refused, first tx ≥ Rp500.000 COMPLETED → Rp25.000 credit each (non-withdrawable, e-mail); credit applied at next checkout, restored on invoice expiry, consumed on payment (PROMOTION_CREDIT debit); shared-device (+IP) referral → QUALIFIED held, risk review, no credit, release blocked | `j7-referral.test.ts` › 4 tests | PASS |
| J8 | Privacy: export (worker, encrypted, own data only, owner-only download, e-mail) · deletion 409 while tx open → cancel → 202, 14-day grace, sessions revoked, limited re-login, worker anonymizes, counterparty sees no PII | `j8-privacy.test.ts` › 3 tests | PASS |

## 2. Brief — mandatory test scenarios

| Scenario | E2E (HTTP) | Module-level (existing) | Status |
|---|---|---|---|
| Payment duplicate | `mandatory-scenarios.test.ts` › `payment duplicate: same Idempotency-Key replays; another key while pending → 409; concurrent double-submit → one payment; duplicate provider notifications → one capture` | `checkout.test.ts` › `payment duplicate: …`; `test/security/money-abuse.test.ts` › `double checkout with different idempotency keys …` | PASS |
| Webhook retry | `mandatory-scenarios.test.ts` › `provider re-verification fails once → 500 … exactly once` (+ 5 parallel re-deliveries) | `webhooks.test.ts` › `webhook retry: …`; `test/security/webhook-authenticity.test.ts` | PASS |
| Traveler cancellation | J5; `mandatory-scenarios.test.ts` › `after PURCHASED the traveler cannot cancel …`, `trip cancelled with a PAID transaction → consumer …`, `trip with a PURCHASED transaction cannot be cancelled (409)`, `MATCHED …`/`AWAITING_PAYMENT on a cancelled trip …`, `webhook for a checkout whose trip was cancelled …` (BUG-QA-01/02 fixed) | `cancellation.test.ts` › `traveler cancels after payment …` | PASS |
| Refund | J3, J4, J5; `mandatory-scenarios.test.ts` › `VA cannot be refunded by the provider → buyer adds a destination → worker disburses → REFUNDED` | `cancellation.test.ts` › `refunds` block (step-up); `admin/finance/finance.test.ts`; `test/security/step-up-mfa-enrollment.test.ts` (PENDING_REVIEW → FINANCE) | PASS (BUG-QA-03 fixed) |
| Dispute | J4 (partial); `mandatory-scenarios.test.ts` › `ITEM_NOT_RECEIVED opened while TRAVELING … REFUND_FULL` | `disputes/disputes.test.ts`, `admin/disputes/disputes.test.ts` | PASS |
| FX expiration | `mandatory-scenarios.test.ts` › `checkout after the FX lock expired → 422 … invoice expiry → MATCHED; a late payment is auto-refunded` | `checkout.test.ts` › `FX expiration: …`; `webhooks.test.ts` › `late payment after expiry …` | PASS |
| Price change | J2, J3; `mandatory-scenarios.test.ts` › `confirmation window expires without an answer → EXPIRED …` | `price-confirmation.test.ts` (6 tests); mandatory › `the traveler is notified of the clarification request …` | PASS (BUG-QA-04 fixed) |
| Network loss (retry same key after timeout) | `mandatory-scenarios.test.ts` › `client times out while the provider is slow → … 409 IN_PROGRESS → … replays the original 201; one payment, one provider session`; J2 approval replay | `checkout.test.ts` › `payment duplicate …` (replay); `test/security/idempotency-race.test.ts` (+ `BUG-QA-05 transient responses are never replayed`); mandatory › `retry after Retry-After with the SAME key → 201` | PASS (BUG-QA-05 fixed) |
| Duplicate delivery confirmation | `mandatory-scenarios.test.ts` › `PIN twice, QR after PIN, confirm-receipt twice … and the auto-confirm job → one transition each, one payout, one release` | `delivery.test.ts` › `duplicate delivery confirmation: …` | PASS |
| Fraudulent referral | `j7-referral.test.ts` › `mandatory scenario — fraudulent referral: …` | `referrals.test.ts` › `fraudulent referral: …`, `shared device alone …` | PASS |

## 3. Bugs found (were `it.fails`; all FIXED 2026-09-28 — tests flipped to normal passing tests)

| ID | Sev. | Defect (exact behaviour) | Test | Owner · Status |
|---|---|---|---|---|
| BUG-QA-01 | **High** | `POST /v1/trips/{id}/cancel` succeeds while the trip has a **paid** transaction; `trip.cancelled {openTransactionIds}` is emitted but **no outbox consumer exists** (`src/jobs/*.ts`), so the transaction stays `PAYMENT_SECURED` on a CANCELLED trip — no refund, no notification, no penalty; escrow never released. Expected: cancellation matrix (traveler, AFTER_PAYMENT → full refund incl. fee, penalty 5). | `mandatory-scenarios.test.ts` › `trip cancelled with a PAID transaction → consumer: … REFUNDED …`, `trip with a PURCHASED transaction cannot be cancelled (409)` | money + marketplace · **PASS** (fixed: `cancellation/trip-cancelled.ts` consumer; money.md §5.1) |
| BUG-QA-02 | **High** | Same root cause: a `MATCHED` transaction of a cancelled trip stays MATCHED and quote/checkout do not check the trip — the buyer can still quote (201), check out (201) and pay (webhook → `PAYMENT_SECURED`) for a trip that no longer exists. | `mandatory-scenarios.test.ts` › `MATCHED transaction on a cancelled trip: quote refused (422 TRIP_NOT_AVAILABLE) …`, `AWAITING_PAYMENT on a cancelled trip …`, `webhook for a checkout whose trip was cancelled …` | money · **PASS** (fixed: `TRIP_NOT_AVAILABLE` guard, late-payment path, consumer) |
| BUG-QA-03 | Medium | VA/retail refunds need a buyer bank account; `refund.destination_required` is emitted but has **no consumer/template**. The buyer only receives `refund.requested` saying the money returns "ke metode pembayaran asal" (wrong for VA) → refund waits silently (`REFUND_PENDING`) for a destination nobody asked for. | `mandatory-scenarios.test.ts` › `VA cannot be refunded …` (notification + e-mail), `refund.requested for a bank-disbursed refund does not promise the original payment method …` | engagement · **PASS** (fixed: templates `refund.destination_required` / `refund.destination_updated`) |
| BUG-QA-04 | Medium | Buyer `CLARIFY` on a price change emits `price_confirmation.clarification_requested` with **no consumer**: the traveler gets no notification while the 15-min window runs (CLARIFICATION_REQUESTED → EXPIRED → full refund). | `mandatory-scenarios.test.ts` › `the traveler is notified of the clarification request (in-app + e-mail) …` | engagement · **PASS** (fixed: template `price.clarification_requested`) |
| BUG-QA-05 | Medium | On money routes `rateLimit` runs **after** `requireIdempotency` (`checkout/routes.ts`); the limiter's 429 is stored as the COMPLETED idempotent response and **replayed for 24 h** (`idempotent-replayed: true`, status 429) — a client that retries with the same key after `Retry-After` can never succeed. | `mandatory-scenarios.test.ts` › `retry after Retry-After with the SAME key → 201 …`; `test/security/idempotency-race.test.ts` › `BUG-QA-05 …` | security/money · **PASS** (fixed: rate limit before idempotency on all money routes; 429/5xx → key FAILED) |
| BUG-QA-06 | Low | `POST /v1/transactions/{id}/cancel` refreshes `status` after `processRefunds()` but returns `refunds[]` from the pre-processing snapshot: `status: REFUNDED` with `refunds[0].status: APPROVED` (also replayed by the Idempotency-Key). | `j5-traveler-cancel.test.ts` › `cancel response refunds[] carries the fresh status (SUCCEEDED) — also in the idempotent replay` | money · **PASS** (fixed: refunds re-read after processing) |

**Observations (not filed as bugs — product/ops decisions to confirm):**
* ~~URL extraction stores the **domain** as merchant … `MERCHANT_MISMATCH`-flagged → payout ON_HOLD~~ — **resolved 2026-09-28**:
  brand vs domain is normalized (`merchantsMatch`, official brand store = match) and a remaining mismatch is only a low-weight
  REVIEW signal that does not hold the payout (money.md §5.5; `purchase.test.ts` › `merchant: brand store vs URL domain …`).
* ~~After a dispute … closing does **not** release it~~ — **resolved 2026-09-28**: a SYSTEM `DISPUTE_OPEN` hold is auto-released
  once the dispute is CLOSED and no risk review is open; FINANCE release stays for admin holds / open reviews (J4 asserts the
  auto-release; `admin/finance/finance.test.ts` › `payout dispute hold auto-release (SYSTEM)`).
* Within-tolerance price increases (≤ 2 %, ≤ Rp50.000) are absorbed by the platform (PROMOTION_CREDIT debit); the §04 invariant
  "PROMOTION_CREDIT = 0 after completion" holds only at the quoted price (J1 asserts the absorbed amount).
* A cancellation after payment ends the transaction REFUNDED, and `REFUNDED → request CLOSED` (marketplace §6) — after a
  traveler cancels, the buyer's request is closed rather than reopened for another traveler (J3 asserts CLOSED; only a
  pre-payment CANCELLED reopens it).
* Payment webhooks are rate-limited per IP (600/min) — see load test F2.

## 4. Traceability matrix (R01–R42)

| # | Requirement (brief → spec) | E2E evidence | Module / unit evidence | Status |
|---|---|---|---|---|
| R01 | **Auth methods**: phone/WhatsApp/e-mail OTP, Google, Apple, sessions & refresh rotation, admin TOTP MFA (identity §2–3) | all journeys (e-mail OTP + `VERIFY_PHONE`), `adminWithMfa` (enroll/confirm/verify), J6 refresh after 49 h, J8 re-login | `auth/otp.test.ts` (13), `auth/oauth-session-mfa.test.ts`, `auth/apple-nonce.test.ts`, `test/security/admin-session-mfa.test.ts`, `session-device.test.ts` | PASS |
| R02 | **KYC levels 1–5** (domain §2, identity §5) | J1: L1 → L2 (phone) → L3 (admin approve) → L4 (payout + verified trip, drain) | `kyc/kyc.test.ts`, `kyc/liveness.test.ts`, `admin/kyc/kyc.test.ts`; L5: `trust/trust.test.ts` › `KYC level 5 …` | PASS (L5 module only) |
| R03 | **Trip statuses** DRAFT…COMPLETED/CANCELLED (§3, §15.1) | J1 full chain incl. `complete`; trip cancel in mandatory scenarios | `trips/trips.test.ts` (lifecycle, automation job, unverified-active flag) | PASS (BUG-QA-01/02 fixed) |
| R04 | **Request sources** URL / photo / search / manual (marketplace §2.2, §5) | all journeys: URL → extract (fake merchant page) → create | `requests/extraction.test.ts` (JSON-LD, OG, photo, search, SSRF), `requests/requests.test.ts` | PASS |
| R05 | **Matching** (recommended travelers/requests, ranking reasons) | J1/all: `GET /requests/{id}/recommended-travelers` contains the trip | `matching/matching.test.ts`, core `matching.test.ts` | PASS |
| R06 | **Offers → MATCHED** (accept, concurrency, capacity) | all journeys: traveler offer → buyer accept | `offers/offers.test.ts` (incl. two accepts racing) | PASS |
| R07 | **Transparent price** — 11 lines in §10 order, buckets, estimate flags, payment options | J1 quote test (order, sum = TOTAL, buckets, `paymentOptions` VA/QRIS/EWALLET/CARD, VA non-refundable) | `transactions/happy-path.test.ts`, `transactions/contract.test.ts`, core `pricing.test.ts` | PASS |
| R08 | **Customs & tax engine** (NON_PERSONAL default, PMK 34/2025, declaration) | J1 customs declaration with receipt, `CUSTOMS_PROOF_MISSING` guard; load test `customs/estimate` | `customs/customs.test.ts`, core `customs.test.ts`, `purchase/purchase.test.ts` › customs | PASS |
| R09 | **FX lock** (markup, 30-min lock, expiry) | J1 quote `fx`; mandatory FX expiration | `fx/fx.test.ts`, `checkout.test.ts` › FX expiration, core `fx.test.ts` | PASS |
| R10 | **Price confirmation** (tolerance, approve/supplemental, reject, clarify, expiry) | J1 (+1 % within tolerance), J2, J3, mandatory price-change expiry | `price-confirmation.test.ts`, `transactions/read.test.ts` › supplemental never paid | PASS (BUG-QA-04 fixed) |
| R11 | **SafePay** escrow (quote → checkout → webhook → buckets → release/payout) | J1 ledger & payout, J2, J4, J6 | `happy-path.test.ts`, `ledger/ledger.test.ts` | PASS |
| R12 | **Payment security gate** (signature, provider re-check, amount/currency, dedup) | mandatory: forged token 401 (not stored), amount mismatch → HOLD, webhook retry | `webhooks.test.ts`, `test/security/webhook-authenticity.test.ts` | PASS |
| R13 | **Settlement account masking** (platform accounts, maker-checker) | — | `admin/settlement/settlement.test.ts` (4) | PASS (module) |
| R14 | **Purchase proof** (golden rule, ceiling, files, fraud flags) | J1: proof refused before approval (DO_NOT_PURCHASE), above ceiling refused, receipt PDF + photo accepted | `purchase/purchase.test.ts` (7) | PASS |
| R15 | **Delivery PIN / QR / courier / auto-confirm** | J1 PIN (buyer-only, `no-store`), J6 courier + auto-confirm, mandatory duplicate confirmation (PIN, QR) | `delivery/delivery.test.ts` (brute-force lock, QR once) | PASS |
| R16 | **Transaction state machine** (§4, single path, events + audit) | J1 timeline = full §4 path; J2–J6 alternate edges | core `state-machine.test.ts`, `spec-parity.test.ts` | PASS |
| R17 | **Notifications list** (event → template matrix, critical channels, no PIN) | J1 exact e-mail template sequence for buyer (16) and traveler (13); J2–J8 price/refund/dispute/referral/privacy e-mails | `notifications/notifications.test.ts`, `templates.test.ts` (lifecycle coverage) | PASS (BUG-QA-03/04 fixed) |
| R18 | **Trust Score** (components, penalties, overrides) | J3 (no penalty for price reject), J5 (traveler penalised, buyer not) | `trust/trust.test.ts`, core `trust-score.test.ts`, `admin/risk/risk.test.ts` › overrides | PASS |
| R19 | **Fraud engine** (risk decisions, receipt reuse, PIN brute force, amount mismatch, referral gate) | mandatory amount mismatch → HOLD; J7 shared-device referral held | core `fraud.test.ts`, `purchase.test.ts` › receipt reuse, `delivery.test.ts` › brute force, `admin/risk/risk.test.ts` | PASS |
| R20 | **Transaction limits** (KYC × trust × risk, new traveler cap, channel caps) | — (journeys stay under the limits) | core `limits.test.ts`, `checkout.test.ts` › QRIS cap / buyer limit, `contract.test.ts` › channel caps | PASS (module) |
| R21 | **Restricted items** (5 classes, acknowledgement, PROHIBITED blocks) | journeys publish with `acknowledgeRestriction`, checkout with `acknowledgeRestricted` | `restricted/restricted.test.ts`, `checkout.test.ts`, `requests.test.ts`, `offers.test.ts` › re-check at accept, core `restricted.test.ts` | PASS |
| R22 | **Cancellation matrix** (stages × actors, preview == outcome) | J5 preview/outcome (traveler vs buyer), J8 buyer cancel at MATCHED, mandatory after-PURCHASED 422 | `cancellation.test.ts`, `contract.test.ts` › preview, core `cancellation.test.ts` | PASS (BUG-QA-01/06 fixed) |
| R23 | **Dispute center** (open window, evidence, SLA, resolution → money, appeal, withdraw) | J4, mandatory dispute | `disputes/disputes.test.ts` (SLA, appeal, withdraw), `admin/disputes/disputes.test.ts`, core `dispute.test.ts` | PASS (appeal/withdraw module only) |
| R24 | **Insurance abstraction** (JastipKita Protection, SANDBOX insurer) | — | `happy-path.test.ts` › `protection policy is bound …` | PARTIAL (bind only; no claim flow exists) |
| R25 | **Refunds** (provider refund, VA disbursement + destination, maker-checker, retries) | J3, J4, J5, mandatory VA refund, late payment auto-refund | `cancellation.test.ts` › refunds, `admin/finance/finance.test.ts` | PASS (BUG-QA-03 fixed) |
| R26 | **Chat** (conversation per tx, STATUS messages, moderation, access) | J1 conversation, ≥ 10 STATUS msgs, SYSTEM refused, stranger 404; J8 messages in export | `chat/chat.test.ts`, `conversation-lookup.test.ts`, `moderation.test.ts`, `admin/support` › chat moderation | PASS |
| R27 | **Ratings** (after COMPLETED, once per side, anti-abuse) | J1 both directions + public summary | `ratings/ratings.test.ts`, core `rating.test.ts` | PASS |
| R28 | **Referral** (codes, rewards, caps, fraud gate, credit ledger) | J7 | `referrals/referrals.test.ts`, `credits/credits.test.ts`, `admin/growth/growth.test.ts`, core `referral.test.ts` | PASS |
| R29 | **Promotions** (codes, stacking, cashback, limits) | — (J7 covers credit, not promo codes) | `promotions/promotions.test.ts`, `checkout.test.ts` › promo, `test/security/money-abuse.test.ts`, core `promotions.test.ts` | PASS (module) |
| R30 | **Admin RBAC** (8 roles, least privilege, MFA, maker-checker) | journeys: OPERATIONS+COMPLIANCE admin; J4 OPERATIONS denied payout release (403), FINANCE releases; J7 MARKETING referral view; J8 admin cannot download export | `test/security/admin-rbac-matrix.test.ts`, `admin/users/users.test.ts`, every `admin/*` test | PASS |
| R31 | **Dynamic config** (versioned business config, maker-checker) | — | `admin/config/config.test.ts`, core `config.test.ts` | PASS (module) |
| R32 | **DB center** (read-only health, migrations, backups/restore to new branch, 8-step workflow) | — | `infra/infra.test.ts`, `infra/migration-manifest.test.ts`, `providers/db-admin/neon.test.ts` | PASS (module) |
| R33 | **Backup / DR docs** | — | `docs/08-backup-dr.md`, `docs/runbooks/db-restore.md`, `.github/workflows/db-backup.yml` | DOC (restore drill not automated) |
| R34 | **Support** (FAQ search, tickets, SLA, agent replies) | — | `support/support.test.ts`, `admin/support/support.test.ts` | PASS (module) |
| R35 | **Legal** (published templates, consent versions) | all journeys read consent versions from `/v1/consents/requirements`; KYC consent | `legal/legal.test.ts`, `admin/content/content.test.ts` | PASS (texts are TEMPLATE, not legally reviewed) |
| R36 | **Security** (IDOR, SSRF, webhook authenticity, encryption at rest, headers) | journeys: PIN never leaked, checkout URL buyer-only, stranger 404 on chat, forged webhook 401, export owner-only | `test/security/*` (11 files), `files/files.test.ts`, `kyc.test.ts` › no leaks | PASS |
| R37 | **Privacy** (UU PDP export, deletion, retention) | J8 | `privacy/privacy.test.ts` | PASS |
| R38 | **Observability** (health, alerts, audit chain, KPI snapshots) | J1 audit chain verify + dashboard KPIs; load test outbox lag | `admin/audit/audit.test.ts`, `test/smoke.test.ts` › health | PASS (alert delivery to on-call = DOC) |
| R39 | **Analytics** (event allowlist, PII stripping, server funnel events, dashboard) | J1 KPIs (GMV, completed, revenue) | `analytics/analytics.test.ts`, `admin/dashboard/dashboard.test.ts` | PASS |
| R40 | **SEO** (canonical, JSON-LD, sitemap, robots) | — | `apps/web/tests/smoke.spec.ts` (Playwright) | NOT RUN (needs web build + browsers) |
| R41 | **Store readiness** (iOS/Android) | — | `docs/checklists/store-checklist.md`; Flutter `apps/mobile/test/*` | DOC / NOT RUN |
| R42 | **CI/CD & tests** | this matrix; `tests/load/run.mjs` | `.github/workflows/ci.yml` (core, db, api typecheck+test, web, admin, mobile), `deploy-*.yml` | PASS locally (API/core); workflows NOT RUN here |

## 5. Gaps worth automating next

1. Web Playwright smoke (R40) and Flutter tests (R41) in this environment; admin app (`apps/admin`) vitest.
2. Dispute appeal + pre-delivery withdraw as an E2E (module-covered only; withdraw leaves the tx DISPUTED by design gap §4).
3. Promotion code + cashback through a full journey; KYC level 5 through real completions (needs ≥ 10 journeys — soak test).
4. Backup restore drill (R33) as a scheduled staging job with evidence in `db_operations`.
5. Load test against staging (see `load-test-2026-09.md` §6).

---
*Catatan keterbatasan: status di atas hanya berlaku untuk run 2026-09-28 di satu VM lokal (PostgreSQL 16, provider MOCK/SANDBOX);
klien mobile/web/admin belum diperbarui untuk step-up OTP (SEC-12) dan tidak dijalankan di sini.
Penomoran R01–R42 dibuat QA dari daftar fitur brief (brief asli tidak tersedia sebagai dokumen bernomor). Severity bug adalah
usulan QA, keputusan prioritas ada di lead/GM.*
