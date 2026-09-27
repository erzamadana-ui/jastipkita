# Money API — transactions after MATCHED, SafePay, price confirmation, delivery, refunds, payouts

Owner: money group. Code: `apps/api/src/modules/{transactions,checkout,payments,webhooks,ledger,price-confirmation,purchase,delivery,cancellation,refunds,payouts,reconciliation}`,
routes registered in `src/modules/money.ts`, jobs in `src/jobs/money.ts`, providers in `src/providers/{payment,insurance}`,
migration `db/migrations/0040_money.sql`. Ledger & flows: [`docs/04-payments-ledger.md`](../04-payments-ledger.md).

All endpoints are under `/v1`, JSON camelCase, IDR integers, ISO-8601 UTC. 🔒 bearer · 💰 `Idempotency-Key` required ·
(K2) KYC ≥ 2. Non-parties of a transaction always get `404 TRANSACTION_NOT_FOUND`.

## 1. Endpoints

| Endpoint | Who | Notes |
|---|---|---|
| `GET /transactions?role=buyer\|traveler&status=A,B&limit&cursor` | 🔒 party | `{data: TransactionSummary[], nextCursor}` — number, status, `item {productName, imageUrl, …}`, `counterparty {id, role, displayName, avatarUrl}`, `totalIdr`, `updatedAt`; traveler rows carry `purchaseGate` |
| `GET /transactions/{id}` | 🔒 party | `TransactionDetail` (fully typed, see §1.1): item, public profiles, trip route, `purchaseCeilingIdr`, active quote + 11 lines + `paymentOptions`, payments (checkout URL buyer-only), price confirmations, purchase proof (+ its files, no fraud data), customs declaration, delivery (**never the PIN**; buyer `pinAvailable`), refunds, payout (traveler), `conversationId`, `purchaseGate` (traveler), `allowedActions` |
| `GET /transactions/{id}/cancel/preview?cause=` | 🔒 party | `CancellationPreview`: exactly what `POST /cancel` would do for the caller now (`evaluateCancellation` + the same guards) — `allowed`, `stage`, `reason`, `refundIdr`, `refundByLine`, `retainedByLine`, `travelerCompensationIdr`, `trustPenalty`, `requiresAdminApproval`, `canCancel`, `blockedBy {code, message}`. No writes, no locks |
| `GET /transactions/{id}/timeline` | 🔒 party | `transaction_events` (actor type, reason, safe meta) |
| `POST /transactions/{id}/quote` | 🔒 buyer, MATCHED | `{channel?: VA\|QRIS\|EWALLET\|CARD, promoCode?, useCredit?}` → `201 Quote` (lines, `paymentOptions[]`, `estimateBadges`, `fx{spotRate, markupBps, lockedRate, lockedAt, expiresAt}`, customs, restricted, limits, promotion, credit `withdrawable:false`) |
| `POST /transactions/{id}/checkout` | 🔒💰 K2 buyer | `{quoteId, channel?, acknowledgeRestricted?}` → `201 {paymentId, checkoutUrl, expiresAt, amountIdr, provider, providerEnv, sandbox}` |
| `GET /transactions/{id}/payment` | 🔒 party | `{data: Payment[], current}` |
| `POST /webhooks/payments/{xendit\|mock}` | provider | raw JSON; `x-callback-token`; `200 {status: PROCESSED\|DUPLICATE\|IGNORED, eventId, outcome}`, `401` unverified, `500` retry |
| `GET /dev/mock-checkout/{ref}` · `POST /dev/mock-checkout/{ref}/pay\|expire?channel=` | none | **development/test + MOCK only** (404 otherwise); `pay` builds the mock webhook and runs the webhook code path |
| `POST /transactions/{id}/price-check` | 🔒 traveler, PAYMENT_SECURED | `{actualUnitPriceMinor, currency, receiptFileId?, photoFileId?, notes?}` → `{outcome, evaluation, transactionStatus, purchaseCeiling?, priceConfirmation?}` |
| `POST /transactions/{id}/price-confirmations/{pcId}/respond` | 🔒💰 buyer | `{action: APPROVE\|REJECT\|CLARIFY, note?}` → `{transactionStatus, priceConfirmation, payment? (SUPPLEMENTAL), cancellation?}` |
| `POST /transactions/{id}/price-confirmations/{pcId}/clarify` | 🔒 traveler | `{note, actualUnitPriceMinor?, receiptFileId?}` → PENDING, window reset, `round+1` |
| `POST /transactions/{id}/purchase-proof` | 🔒 traveler, PURCHASE_APPROVED | `{receiptFileId, productPhotoFileIds[1..10], videoFileId?, serialNumber?, receiptNumber?, merchantName, actualPriceMinor (receipt total), currency, purchasedAt}` → `201 {proofId, status: ACCEPTED\|FLAGGED, flagged, transactionStatus: PURCHASED}` |
| `POST /transactions/{id}/status` | 🔒 traveler | `{to: TRAVELING\|ARRIVED\|CUSTOMS_PROCESS\|READY_FOR_HANDOVER}` (core guards: trip TRAVELING, trip arrived, customs proof) |
| `POST /transactions/{id}/customs-declaration` | 🔒 traveler | `{dutyPaidIdr, vatPaidIdr, incomeTaxPaidIdr, luxuryTaxPaidIdr?, receiptFileId (if > 0), declarationRef?, …}` |
| `POST /transactions/{id}/delivery` | 🔒 traveler | `{method: MEETUP\|COURIER\|PARTNER_LOGISTICS, meetupPoint? (MEETUP), courierName?, trackingNumber?, address? (encrypted), addressCity?, scheduledAt?}`; MEETUP emits `delivery.pin_ready` |
| `GET /transactions/{id}/delivery/pin` | 🔒 **buyer only** | `{pin, qrToken, qrPayload, qrExpiresAt, attemptsRemaining}` — rotated on each reveal, `Cache-Control: no-store`; `423 PIN_LOCKED` |
| `POST /transactions/{id}/delivery/verify` | 🔒 traveler | `{pin}` or `{qrToken}` → DELIVERED (`confirmedVia` PIN/QR); repeat → `alreadyConfirmed:true`; `422 PIN_INVALID {attemptsRemaining}`; `423 PIN_LOCKED` after `delivery.maxPinAttempts` |
| `POST /transactions/{id}/delivery/shipped` | 🔒 traveler | `{trackingNumber, courierName?}` → OUT_FOR_DELIVERY (idempotent) |
| `POST /transactions/{id}/delivery/delivered` | 🔒 traveler | `{proofFileIds[]}` → DELIVERED (idempotent) |
| `POST /transactions/{id}/confirm-receipt` | 🔒💰 buyer | DELIVERED → BUYER_CONFIRMED → COMPLETED (release + payout); idempotent |
| `POST /transactions/{id}/cancel` | 🔒💰 party | preview first with `GET …/cancel/preview`; `{reason, cause?}` → `{status, cancellation{stage, refundIdr, travelerCompensationIdr, …, trustPenalty}, refunds[]}`; `422 CANCELLATION_NOT_ALLOWED` (e.g. "Barang sudah dibeli; gunakan Dispute Center"), `422 ADMIN_APPROVAL_REQUIRED` |
| `GET /transactions/{id}/refunds` | 🔒 party | method, status, `destinationRequired`, masked destination |
| `POST /refunds/{id}/destination` | 🔒 buyer of the refund | `{bankCode, accountNumber, accountHolderName}` (provider-validated, encrypted) → `{accountMask: "****1234", validationStatus}` |
| `GET /payouts/mine` | 🔒 traveler | `{data[], nextCursor, summary{scheduledIdr, paidIdr, heldIdr, processingIdr, failedIdr}}` — destination masked |

### 1.1 Transaction detail contract (`TransactionDetail`)

| Field | Content |
|---|---|
| `item` | `productName, productUrl, merchantName, merchantCountry, categoryCode, hsCode, variant, quantity, unitPriceMinor, currency` (+ deprecated alias `priceCurrency`), `imageUrl` (first request image, absolute), `maxBudgetIdr` (buyer only) |
| `buyer` / `traveler` | `TransactionParty`: `id, displayName` (**first name + last initial**), `avatarUrl` (absolute, or null), `trustScore` 0–100, `trustTier {tier: EXCELLENT\|GOOD\|FAIR\|LOW, label, labelEn}`, `trustBadge`, `kycLevel`, `identityVerified`, `ratingSummary {asTraveler, asBuyer: {average, count}}`, `memberSince` (+ deprecated `rating`) |
| `trip` | `TripRoute`: `id, status, originCountry, originCity, destinationCountry, destinationCity, departureDate, arrivalDate` |
| `purchaseCeilingIdr` · `autoConfirmAt` · `deliveryMethod` | ceiling set at PURCHASE_APPROVED (deprecated object form `purchaseCeiling {minor, idr}` kept) |
| `quote` | `Quote` incl. 11 `lines` and `paymentOptions` |
| `priceConfirmations[]` | typed `PriceConfirmation` (original/actual minor + IDR, supplemental, window, round) |
| `purchaseProof` | `PurchaseProof`: merchant, price, time, file ids + `files[] {id, kind RECEIPT\|PRODUCT_PHOTO\|VIDEO, mime, sizeBytes, contentUrl}` — only the files the proof references; serial number for the buyer once DELIVERED; never fraud data |
| `delivery` | `Delivery`: method/status/courier/tracking/meetup/proof ids; `pin {locked, attemptsRemaining, revealEndpoint (buyer)}`; buyer only: `pinAvailable` (a PIN/QR can be revealed now). Never the PIN, QR token or hashes |
| `payout` | traveler only (null for the buyer): `id, number, status, amountIdr, netIdr, holdReason, scheduledAt, paidAt` |
| `conversationId` | chat of this transaction (null until created; `GET /transactions/{id}/conversation` creates it lazily) |
| `purchaseGate` · `allowedActions` | unchanged |

### 1.2 Payment options in the quote

`paymentOptions[]` = one entry per channel configured in `pricing.payment_fees` (display order VA, QRIS, EWALLET, CARD, …):
`{channel, label, feeIdr, totalIdr, bearer, refundable, minAmountIdr, maxAmountIdr, available, unavailableReason, selected}`.
The payment fee is the last component of the total, so every option is `(TOTAL − PAYMENT_FEE of the priced channel) + computePaymentFee(channel)` —
identical to re-quoting with that channel. `refundable: false` for VA and retail outlets (Xendit cannot refund them; refunds are paid out to a
buyer bank account, `destinationRequired`), `maxAmountIdr` = per-transaction channel cap (QRIS Rp10.000.000, VA Rp50.000.000);
`available: false` + `unavailableReason ABOVE_CHANNEL_MAX|BELOW_CHANNEL_MIN` when the total is outside it. Checkout still requires a quote priced
for the chosen channel (`CHANNEL_MISMATCH` otherwise) — re-quote with `channel` to switch. Quotes created before this change return `[]`.

`allowedActions` values: `QUOTE, CHECKOUT, PAY, CANCEL, PRICE_CHECK, RESPOND_PRICE_CONFIRMATION, REJECT_PRICE_CONFIRMATION,
CLARIFY_PRICE, SUBMIT_PURCHASE_PROOF, UPDATE_STATUS:<to>, SET_DELIVERY, CUSTOMS_DECLARATION, VIEW_HANDOVER_PIN,
VERIFY_HANDOVER, MARK_SHIPPED, MARK_DELIVERED, CONFIRM_RECEIPT, OPEN_DISPUTE` (the endpoint re-checks everything).

## 2. Main error codes

`QUOTE_NOT_ALLOWED`, `ITEM_PRICE_MISSING`, `CATEGORY_REQUIRED`, `FX_RATE_UNAVAILABLE`, `FX_RATE_STALE`, `CUSTOMS_NO_RULE`,
`ITEM_PROHIBITED`, `BELOW_MINIMUM_TRANSACTION`, `CHANNEL_LIMIT_EXCEEDED`, `LIMIT_EXCEEDED`, `QUOTE_NOT_ACTIVE`, `QUOTE_EXPIRED`,
`FX_LOCK_EXPIRED`, `CHANNEL_MISMATCH`, `RESTRICTED_NOT_ACKNOWLEDGED`, `CREDIT_INSUFFICIENT`, `PAYMENT_ALREADY_PENDING` (409),
`IDEMPOTENCY_KEY_REQUIRED` (400), `IDEMPOTENCY_KEY_REUSED`, `PRICE_CHECK_NOT_ALLOWED`, `CURRENCY_MISMATCH`,
`PRICE_CONFIRMATION_EXPIRED`, `PRICE_CONFIRMATION_NOT_OPEN`, `PURCHASE_NOT_APPROVED` (`details.banner = DO_NOT_PURCHASE`),
`PURCHASE_PRICE_EXCEEDS_APPROVED`, `SERIAL_REQUIRED`, `VIDEO_REQUIRED`, `FILE_INVALID`, `FILE_NOT_SCANNED`,
`FILE_PURPOSE_INVALID`, core guard codes (`TRIP_NOT_TRAVELING`, `CUSTOMS_PROOF_MISSING`, `DISPUTE_OPEN`, …),
`PIN_INVALID`, `PIN_LOCKED` (423), `CANCELLATION_NOT_ALLOWED`, `ADMIN_APPROVAL_REQUIRED`, `BANK_ACCOUNT_INVALID`,
`BANK_ACCOUNT_VALIDATION_UNAVAILABLE`, `WEBHOOK_UNAUTHORIZED` (401).

## 3. Events (outbox)

Catalogue events produced: `payment.checkout_created`, `payment.secured`, `payment.expired`, `payment.failed`,
`price_confirmation.requested`, `price_confirmation.resolved`, `purchase.proof_submitted`, `delivery.pin_ready` (no PIN),
`refund.requested`, `refund.succeeded`, `refund.failed`, `payout.scheduled`, `payout.paid`, `payout.failed`,
`payout.on_hold`, `receipt.final_available` (+ `transaction.status_changed` from the DB function).

Additional events (proposed for the catalogue):

| Event | Payload | Consumer |
|---|---|---|
| `transaction.cancelled_with_penalty` | transactionId, userId, role, trustPenalty, stage, cause, eventAt | engagement trust job (Trust Score cancellation penalty) |
| `payment.amount_mismatch` | paymentId, transactionId, expectedIdr, receivedIdr, currency | admin/risk alerting |
| `refund.destination_required` | refundId, transactionId, buyerId, amountIdr | engagement (ask buyer for a bank account) |
| `price_confirmation.clarification_requested` | same as `price_confirmation.requested` + status | engagement (notify traveler) |

## 4. Service functions for other groups

```ts
// src/modules/refunds/service.ts — admin / dispute resolution (inside the caller's DB transaction)
requestRefund(deps, db: TxSql, transactionId: string, {
  amountIdr, reasonCode: 'DISPUTE_RESOLUTION' | 'ADMIN' | …, reasonNote?, requestedBy: string | null,
  actorType: 'ADMIN' | 'SYSTEM', remainderTo: 'TRAVELER' | 'NONE',
  disputeResolution?: DisputeResolution, adminApprovalRecorded?: boolean, idempotencyKey: string,
}): Promise<RefundRow[]>
approveRefund(deps, refundId, adminUserId): Promise<RefundRow>          // maker-checker (PENDING_APPROVAL → APPROVED)
rejectRefund(deps, refundId, adminUserId, reason): Promise<RefundRow>   // reverses the allocation journal
processRefunds(deps, { transactionId? }): Promise<{processed, succeeded, failed, awaitingDestination}>

// src/modules/cancellation/service.ts — admin cancellation / override
cancelInTx(deps, db: TxSql, tx: TxRow, { actor, actorId, reason, cause?, refundReasonCode?, adminApprovalRecorded? })

// src/modules/transactions/completion.ts
completeTransaction(deps, transactionId)                              // BUYER_CONFIRMED → COMPLETED (idempotent)

// src/modules/payouts/service.ts
processPayouts(deps, { transactionId? }) · payoutRiskDecision(db, tx) · schedulePayout(deps, db, tx, {amountIdr, kind})

// src/modules/payments/service.ts
processPaymentEvent(deps, PaymentEventInput) · expireDuePayments(deps) · expireQuotesAndLocks(deps)

// src/modules/reconciliation/service.ts
pollPendingPayments(deps) · runDailyReconciliation(deps, { start, end }?)
```

Admin payout hold release (`ON_HOLD → SCHEDULED`, approver recorded) and refund approval UI belong to the admin group;
they should clear `transactions.payout_hold_reason` when a risk review is CLEARED.

---
*Catatan keterbatasan: SafePay berstatus SANDBOX (MOCK / Xendit test mode); nilai validasi rekening Xendit (Iluma) belum
tersedia; ambang auto-approve refund dan biaya payout adalah asumsi.*
