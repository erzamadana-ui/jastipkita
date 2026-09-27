# 04 — SafePay: payments, escrow ledger, refunds & payouts

Owner: money group. Code: `apps/api/src/modules/{transactions,checkout,payments,webhooks,ledger,price-confirmation,purchase,delivery,cancellation,refunds,payouts,reconciliation}`,
jobs `apps/api/src/jobs/money.ts`, providers `apps/api/src/providers/{payment,insurance}`, migration `db/migrations/0040_money.sql`.
Binding rules: `docs/00-domain-model.md` (§4 transaction FSM, §9 buckets, §10 price lines, §15.5–15.8), `docs/research/02-xendit-integration.md`.

> **Status: SANDBOX.** Payments run against the MOCK provider (dev/test) or Xendit **test mode**. Live money requires
> `XENDIT_ENV=live` **and** `ALLOW_LIVE_PAYMENTS=true` (env validation refuses otherwise), a signed Xendit contract,
> a legal review of holding funds until delivery (research 02 §9) and the items in §10 below. Every payment/payout row
> carries `provider_env` (`TEST`/`LIVE`); the API returns `sandbox: true` unless `LIVE` and clients must show a
> **SANDBOX** badge.

## 1. Architecture

```
Buyer app ──POST /quote──▶ API ──core buildQuote──▶ quotes + quote_lines (11 lines, rule refs, FX lock)
          ──POST /checkout (Idempotency-Key)──▶ payments(PENDING) ──createCheckout──▶ Xendit Payment Session / MOCK
Xendit ──POST /v1/webhooks/payments/xendit (x-callback-token)──▶ inbox (payment_webhook_events, unique event id)
          └─▶ processPaymentEvent: verify amount/currency (+ GET /sessions/{id}) ─▶ payments SECURED
              ─▶ ledger PAYMENT_CAPTURED ─▶ transition_transaction(AWAITING_PAYMENT→PAYMENT_SECURED, SYSTEM)
Traveler ──price-check / purchase-proof / status / delivery──▶ FSM transitions (core guards → DB function)
Buyer ──confirm-receipt──▶ BUYER_CONFIRMED ─▶ SYSTEM completion: COMPLETION_RELEASE journal + payout SCHEDULED
Jobs ──process_payouts──▶ provider.payout ─▶ PAYOUT_PAID journal
```

* All money is **integer IDR**. Foreign item prices are converted once, at the quote's FX lock (`convert`, HALF_UP).
* Status changes only via `transition_transaction()` after the core guard check (`assertCanTransition`); secondary
  entities (payments, refunds, payouts, price confirmations, quotes, FX locks) are guarded by the DB FSM trigger
  (`status_transitions`) and the core FSMs (`paymentFsm`, `refundFsm`, `payoutFsm`, `priceConfirmationFsm`).
* Outbox events are written in the same DB transaction as the state change; the only external side effect run from
  an outbox subscriber is the protection-policy bind (`payment.secured` → `bindProtectionPolicy`).

## 2. Fund separation (buckets, §9)

Funds never touch a JastipKita bank account: cash sits in the provider balance (escrow sub-account per research 02 §10,
`PROVIDER_CASH`) and is **held by accounting** in these buckets until the transaction resolves.

| Bucket | Normal side | Owner | Holds |
|---|---|---|---|
| `PROVIDER_CASH` | debit | system | cash at the payment provider (external) |
| `PRODUCT_FUND` | credit | system | item price (+ supplemental top-ups) until completion/cancel |
| `CUSTOMS_RESERVE` | credit | system | estimated duty + import tax until completion/cancel |
| `CLEARING` | debit | system | traveler fee, protection, platform fee, service tax, payment fee until completion/cancel |
| `TRAVELER_EARNING` | credit | **traveler** | released earnings awaiting payout |
| `REFUND` | credit | **buyer** | refunds owed awaiting provider refund/disbursement |
| `PLATFORM_REVENUE` | credit | system | platform + protection fee (and retained fees on cancellation) |
| `TAX_PAYABLE` | credit | system | PPN on platform services |
| `PAYMENT_FEE` | debit | system | payment fee charged to the buyer (offsets gateway cost) |
| `PROMOTION_CREDIT` | debit | system | platform-funded discounts, JastipKita Credit, within-tolerance price absorption |

`v_transaction_ledger` gives the escrow per transaction (credit-positive for every bucket); `ledger_balances` gives
normal-side balances per account.

## 3. Journals

Posted only with `post_journal(kind, description, entries, transaction_id, idempotency_key, refs)`; corrections only
with `reverse_journal()` (compensating entries). No UPDATE/DELETE on ledger tables (append-only triggers, tested).

| Kind (idempotency key) | When | Debit | Credit |
|---|---|---|---|
| `PAYMENT_CAPTURED` (`capture:<paymentId>`) | checkout payment verified | PROVIDER_CASH = TOTAL paid; PROMOTION_CREDIT = discount + credit | PRODUCT_FUND = item; CUSTOMS_RESERVE = duty + import tax; CLEARING = traveler fee + protection + platform + service tax + payment fee |
| `SUPPLEMENTAL_CAPTURED` (`capture:<paymentId>`) | approved price increase paid | PROVIDER_CASH | PRODUCT_FUND |
| `LATE_PAYMENT_CAPTURED` (`capture:<paymentId>`) | funds after expiry / for a transaction that moved on | PROVIDER_CASH | REFUND(buyer) — auto-refund follows |
| `COMPLETION_RELEASE` (`release:<txId>`) | BUYER_CONFIRMED → COMPLETED | PRODUCT_FUND, CUSTOMS_RESERVE, CLEARING (all held); PROMOTION_CREDIT = within-tolerance increase above the held item fund | TRAVELER_EARNING(traveler) = approved actual price + customs actually paid (capped at reserve) + traveler fee; PLATFORM_REVENUE = platform + protection; TAX_PAYABLE = service tax; PAYMENT_FEE = payment fee; REFUND(buyer) = unused item fund + unused customs reserve |
| `CANCELLATION_SETTLEMENT` (`cancel-settle:<txId>`) | cancellation after payment (matrix) | PRODUCT_FUND, CUSTOMS_RESERVE, CLEARING (all held) | REFUND(buyer) = matrix refund; TRAVELER_EARNING = compensation (+ customs retained); PLATFORM_REVENUE = retained item/fees; TAX_PAYABLE; PAYMENT_FEE = retained payment fee; PROMOTION_CREDIT = unused discount + restored credit |
| `DISPUTE_REFUND_ALLOCATION` (`refund-alloc:<key>`) | `requestRefund()` (dispute/admin) | PRODUCT_FUND → CUSTOMS_RESERVE → CLEARING (in that order) | REFUND(buyer) |
| `REMAINDER_RELEASE` (`remainder:<txId>`) | all refunds of a REFUND_PENDING tx succeeded | whatever is still held | partial → traveler/revenue/tax/fee per quote; full → PROMOTION_CREDIT (promo share) / PLATFORM_REVENUE |
| `REFUND_PAID` (`refund-paid:<refundId>`) | provider refund / disbursement succeeded | REFUND(buyer) | PROVIDER_CASH |
| `PAYOUT_PAID` (`payout-paid:<payoutId>`) | traveler disbursement succeeded | TRAVELER_EARNING(traveler) | PROVIDER_CASH (net) + PAYMENT_FEE (payout fee, 0 today) |
| `REVERSAL` (`reversal:<journalId>`) | refund rejected after allocation | mirror of the original | mirror of the original |

### Invariants (asserted by tests)

1. Every journal balances (DB deferred constraint `JKL02`; JS pre-check `LEDGER_UNBALANCED`).
2. `PAYMENT_CAPTURED` credits exactly the quote's lines to their §10 buckets (`quote_lines.bucket`).
3. After COMPLETED + payout PAID: `PRODUCT_FUND = CUSTOMS_RESERVE = CLEARING = REFUND = TRAVELER_EARNING = PROMOTION_CREDIT = 0`
   for the transaction, and cash left at the provider equals `PLATFORM_REVENUE + TAX_PAYABLE + PAYMENT_FEE`
   (`transactions/happy-path.test.ts`, `ledger/ledger.test.ts`).
4. After a full refund (traveler cancel, price change rejected/expired, late payment) every bucket of the transaction,
   including `PROVIDER_CASH`, is 0; after a buyer cancel after payment only the retained payment fee remains.
5. `CANCELLATION_SETTLEMENT` balances for every allowed matrix row (property test over §8 stages × actors × causes).
6. The traveler is never paid twice: payouts are unique per transaction (`payouts_one_live_per_tx`) and `PAYOUT_PAID`
   is idempotent on the payout id; failed disbursements leave the earning in `TRAVELER_EARNING`.
7. Daily reconciliation: every SECURED payment has a capture journal whose PROVIDER_CASH debit equals the payment amount.

## 4. Webhook security & idempotency

* **Verification:** Xendit sends a static `x-callback-token`; the adapter compares SHA-256(received) and SHA-256(expected)
  in constant time (length is not leaked) and fails closed when either is missing. Unverified requests → `401`, **not stored**
  (an attacker must not pre-occupy an event id) and change nothing. The MOCK provider uses the shared `mock.ts`
  comparison (not constant-time; test only).
* **Re-verification (fail closed, security review SEC-03):** before securing funds the processor asks the provider
  (`GET /sessions/{id}`). If the provider does not report the session as paid, or the GET fails, nothing changes and the webhook
  answers 5xx (`PAYMENT_NOT_CONFIRMED_BY_PROVIDER` / `PROVIDER_RECHECK_UNAVAILABLE` in `payment_webhook_events.processing_error`,
  `ALERT payment.webhook_not_confirmed_by_provider` log) — the provider retries and `money.reconcile_pending_payments` settles it. The callback
  token alone never secures funds. The amount must equal `payments.amount_idr` in both the callback and the provider view, and the currency
  must be IDR.
  A mismatch never transitions: risk assessment `HOLD` + open risk review + `payment.amount_mismatch` outbox event +
  `ALERT` log line + payout hold flag.
* **Dedup:** `payment_webhook_events` unique `(provider, event_id)`; event id = `webhook-id` header or a stable id derived
  from the body. A processed duplicate returns `200 {status: DUPLICATE}`; an unprocessed one (earlier failure) is retried.
* **Order independence:** SUCCEEDED on SECURED → no-op; EXPIRED after SUCCEEDED → no-op; SUCCEEDED after EXPIRED (or for a
  transaction that moved on) → payment SECURED (`EXPIRED → SECURED` is a §15.5 edge) + `LATE_PAYMENT_CAPTURED` + automatic
  full refund (`LATE_PAYMENT`).
* **Retries:** processing errors return `500` so Xendit retries (6×); every step is idempotent (FSM checks, journal keys,
  `ON CONFLICT` on credit/promo side effects).
* **API idempotency:** financial mutations (`checkout`, `respond`, `confirm-receipt`, `cancel`) require `Idempotency-Key`;
  the first 2xx/4xx response is stored and replayed (network-loss retries get the original result, header
  `Idempotent-Replayed: true`). A different key while a checkout is pending → `409 PAYMENT_ALREADY_PENDING`.
  Provider calls carry our own keys: `pay:<paymentId>`, `refund:<refundId>`, `refund-payout:<refundId>`, `payout:<payoutId>`.

## 5. Checkout & price changes

* Quote = core `buildQuote` with a DB FX lock (`createFxLockFromConfig`, markup from `pricing.fx_markup`), customs
  estimate (`NON_PERSONAL`, `NO_RULE` blocks), restricted classification (`PROHIBITED` blocks; others need
  `acknowledgeRestricted`), buyer/traveler limits, minimum transaction, promotions (`evaluatePromotions` with usage
  from `promotion_redemptions`) and expiry-aware, non-withdrawable JastipKita Credit. Quote expiry = FX lock expiry.
  Channel limits from research 02 §1.3 (QRIS ≤ Rp10.000.000).
* Checkout: quote → `ACCEPTED`, FX lock → `CONSUMED`, credit `CHECKOUT_REDEEM` (reversed on expiry/failure),
  promo redemption `RESERVED` → `APPLIED` on capture (→ `EXPIRED`/`REVERSED` otherwise).
* Price check (traveler, PAYMENT_SECURED): within tolerance (`price_confirmation.toleranceBps/MaxIdr`) → PURCHASE_APPROVED
  with the **purchase ceiling** = actual price; otherwise a price confirmation (window `windowSeconds`).
  APPROVE with top-up → `SUPPLEMENTAL` payment → on capture SYSTEM `AWAITING_PAYMENT → PAYMENT_SECURED → PURCHASE_APPROVED`;
  REJECT → cancellation cause `PRICE_CHANGE_REJECTED` (full refund incl. payment fee, no trust penalty);
  expiry → REJECT. A supplemental payment that expires is treated like an expired confirmation (full refund, no penalty).
* Golden rule: purchase proofs are accepted only in PURCHASE_APPROVED and never above the ceiling.

## 6. Refund flow (§15.6)

1. Created as `REQUESTED` per secured payment (split across payments, never above what is refundable — DB trigger
   `jk_check_refund_total`). ≤ `money.policy.refundAutoApproveMaxIdr` (default Rp10.000.000, **assumption**) → `APPROVED`
   (SYSTEM), else `PENDING_APPROVAL` for maker-checker (`approveRefund`, approver ≠ requester).
2. Method chosen from the captured channel: `PROVIDER_REFUND` (QRIS, e-wallet, card) or `PAYOUT_TO_BUYER` (VA, retail —
   Xendit cannot refund them). A provider `supported:false` answer also switches to `PAYOUT_TO_BUYER`.
3. `PAYOUT_TO_BUYER` waits for `POST /refunds/{id}/destination` (bank account validated by the provider, stored AES-GCM
   encrypted with AAD `refund_destinations.account_number:<id>`, HMAC hash for dedupe, only `****1234` returned);
   `refund.destination_required` is emitted once.
4. Processor: `APPROVED/FAILED → PROCESSING` (attempts+1) → provider call outside the DB transaction → `SUCCEEDED`
   (payment `REFUNDED`/`PARTIALLY_REFUNDED`, `REFUND_PAID`) or `FAILED` (retried while attempts < 3; then admin).
5. When every refund of a `REFUND_PENDING` transaction succeeded → `REFUNDED` (cancellations, full refunds) or `COMPLETED`
   (dispute partial refund with the remainder released to the traveler).

## 7. Payout flow (§15.7)

Scheduled at completion (earning) or cancellation (traveler compensation) to the traveler's default payout account.
The processor checks `PAYOUT_CLEAR`: risk decision (payout hold flag from flagged proof / amount mismatch, or open
HOLD/BLOCK risk reviews), no open dispute, account `VERIFIED` (decrypted server-side only, AAD
`payout_accounts.account_number:<id>`). Risk/dispute → `ON_HOLD` (`payout.on_hold`); unverified account → stays
`SCHEDULED`. Disbursement failures retry with backoff (15 min × 2ⁿ) up to 3 attempts, then `ON_HOLD`.

## 8. Sandbox vs live switch

| Setting | Dev/test | Staging | Production |
|---|---|---|---|
| `PAYMENT_PROVIDER` | `mock` | `xendit` | `xendit` (mock refused by env validation) |
| `XENDIT_ENV` | — | `test` (keys `xnd_development_…`) | `live` only with `ALLOW_LIVE_PAYMENTS=true` (keys `xnd_production_…`) |
| `payments.provider_env` | `TEST` (DB CHECK: MOCK is never LIVE) | `TEST` | `LIVE` |
| Dev routes `/v1/dev/mock-checkout/*` | enabled | 404 | 404 |

The adapter refuses a development key in live mode and a production key in test mode.

## 9. Jobs (`src/jobs/money.ts`)

`money.expire_quotes_fx_locks` (60 s) · `money.expire_payments` (60 s, re-checks the provider first) ·
`money.expire_price_confirmations` (60 s) · `money.auto_confirm` (5 min, `delivery.autoConfirmHours`, no open dispute) ·
`money.complete_confirmed` (5 min) · `money.process_refunds` (2 min) · `money.process_payouts` (5 min) ·
`money.reconcile_pending_payments` (10 min, PENDING > 15 min → provider GET) · `money.daily_reconciliation` (daily,
`reconciliation_runs/items`, mismatch → `COMPLETED_WITH_DIFFS` + ALERT log). Outbox: `payment.secured` → protection bind.

## 10. Regulatory notes & open items (from research 01/02 — not legal advice)

* Hold funds only in the provider balance (Xendit is BI-licensed PJP Kategori 1/3); never in a JastipKita bank account.
  Holding until delivery (possibly > 30 days) must be confirmed in writing with Xendit and by legal review (`NEEDS_VERIFICATION`).
* JastipKita Credit is closed-loop and non-withdrawable (`withdrawable:false` in every response) to stay outside
  e-money rules.
* Refunds on VA/retail channels require disbursement (payout fee bearer — assumption: platform); QRIS refund window
  and partial support are `NEEDS_VERIFICATION`.
* Bank-account name validation (Iluma) is not wired: the Xendit adapter returns `valid:false (NAME_VALIDATION_UNAVAILABLE)`
  so accounts cannot be verified in Xendit mode yet — refund destinations are refused with
  `BANK_ACCOUNT_VALIDATION_UNAVAILABLE` rather than trusted blindly.
* Customs amounts are estimates (`isEstimate`); the traveler is reimbursed the declared amount up to the reserve,
  the rest of the reserve goes back to the buyer. PPMSE PPh 22 collection (PMK 37/2025) is out of scope until tax review.
* Payment Sessions idempotency header, payout v2 webhook names and payout fees are `NEEDS_VERIFICATION`.

---
*Catatan keterbatasan: angka biaya/limit berasal dari `business_configs` v1 (sebagian `is_assumption`); ambang auto-approve
refund Rp10.000.000 dan skema biaya payout adalah asumsi sampai kontrak Xendit ditandatangani. Seluruh integrasi berstatus SANDBOX.*
