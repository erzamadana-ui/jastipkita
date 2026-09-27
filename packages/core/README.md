# @jastipkita/core

Pure domain engines for JastipKita: pricing, customs and tax, FX, state machines, matching, trust, fraud, limits, restricted items, cancellation, referral, promotions, rating, dispute, delivery and numbering.

- **Pure and deterministic.** There is no I/O, no runtime dependencies and no clock access. Every time-dependent function takes `now: Date`, and randomness comes in as caller-supplied bytes. Formatting is hand-written, with no `Intl`, so Node and Cloudflare Workers produce identical output.
- **Source-first.** `exports["."]` points to `./src/index.ts`, and consumers bundle the TypeScript (wrangler/esbuild, Vite, vitest). Imports are extensionless, which requires `moduleResolution: "Bundler"`.
- **Business outcomes are values; contract violations throw.** A failed guard, an exceeded limit or `NO_RULE` comes back as data. An unknown currency, non-integer money or a mismatched FX lock throws `CoreError { code, message, details }`.

```bash
pnpm --filter @jastipkita/core test        # vitest run (278 tests, incl. doc ↔ code FSM parity)
pnpm --filter @jastipkita/core typecheck   # tsc --noEmit (strict + noUncheckedIndexedAccess)
```

## Conventions

| Topic | Rule |
|---|---|
| Money | Integer **minor units** as `number` (IDR 0 dp, USD 2 dp, JPY/KRW/VND 0 dp, from `currencies.json`). Every input and output is checked with `Number.isSafeInteger` (IDR up to about 9×10^15 is exact). Intermediate products use BigInt. |
| Rates | Decimal strings with at most 10 dp (`numeric(20,10)`), meaning quote-per-1-base: JPY→IDR `"108.5"` means ¥1 = Rp108.5. Numbers are accepted and parsed via their shortest decimal representation (`0.1` → `"0.1"`). |
| Rounding | **HALF_UP** (half away from zero) at the *target* minor unit, applied once per computed amount (`amount × r1 × r2` rounds once). Customs rules can add `CEIL_1000` / `ROUND_1000` / `CEIL_100`. |
| Percentages | bps (`150` = 1.5%) for fees and tolerances; decimal rates (`"0.12"`) for tax rules, matching the DB. |
| Time | `Date` in, `Date` out. Document numbers use the WIB (UTC+7) date. |
| Guards | Fail-closed: a missing context field counts as "not satisfied". |

## Module map

| Module | Main exports |
|---|---|
| `money` | `CURRENCIES`, `toMinor`, `fromMinor`, `formatIdr`, `formatMoney`, `roundHalfUp`, `ceilTo`, `roundTo`, `applyBps`, `mulByRate(s)`, `bpsToRate`, `rateToBps`, `allocateProportionally`, `assertSafeInteger`, decimal helpers (`parseDecimal`, `divDecimal`, …) |
| `fx` | `convert`, `quoteRate`, `markupBpsFor`, `createFxLock`, `createFxLockFromConfig`, `isLockValid`, `fxAdjustment`, `crossRate`, `crossRateChecked`, `isRateStale`, `providerSupportsCurrency`, `assertRateAvailable` |
| `customs` | `CustomsRule`, `selectRule`, `rankCustomsRules`, `estimateCustoms`, `customsRuleRef` |
| `pricing` | `buildQuote`, `allocateFunds`, `computeTravelerFee`, `computeRateFee`, `computePaymentFee`, `gatewayFee` |
| `state-machine` | `createFsm`, `TRANSACTION_TRANSITIONS`, `canTransition`, `assertTransition`, `nextAllowed`, `isTerminal`, `purchaseGate`, `tripFsm`, `priceConfirmationFsm`, `disputeFsm`, `kycSubmissionFsm`, `paymentFsm`, `refundFsm`, `payoutFsm`, `quoteFsm`, `fxLockFsm` (+ each `*_TRANSITIONS` table) |
| `price-confirmation` | `evaluatePriceChange`, `windowExpiresAt`, `isWindowExpired`, `resolveExpired` |
| `matching` | `rankTravelersForRequest`, `rankRequestsForTrip`, `hardFilter`, `RankingStrategy`, `linearRankingStrategy` |
| `trust-score` | `computeTrustScore`, `applyOverride`, `effectiveTrustScore` |
| `fraud` | `assessRisk`, `assessReceipt`, `DEFAULT_RISK_RULES`, `createRiskRuleRegistry`, `RiskRule`, `decisionForScore`, `haversineKm` |
| `limits` | `computeTransactionLimit`, `checkLimit`, `trustMultiplierFor` |
| `restricted` | `classifyItem`, `keywordMatches`, `normalizeText`, `mostSevere` |
| `cancellation` | `evaluateCancellation`, `cancellationStage`, `findMatrixRow` |
| `referral` | `evaluateReferralReward`, `assignVariant`, `unitEconomicsGuardrail` |
| `promotions` | `evaluatePromotions` |
| `rating` | `validateRating`, `bayesianAverage`, `aggregateRatings` |
| `dispute` | `computeSla`, `canOpenDispute`, `validateDisputeResolution`, `slaBreach`, `appealDeadline` |
| `delivery` | `generatePin`, `verifyPinAttempt`, `constantTimeEqual`, `autoConfirmAt`, `qrExpiresAt` |
| `numbering` | `formatTransactionNumber`, `formatDocumentNumber`, `parseDocumentNumber` |
| `config` | `BusinessConfig` (types for every key), `DEFAULT_BUSINESS_CONFIG` (validated and deep-frozen), `validateBusinessConfig`, `validateBusinessConfigSet`, `PRODUCT_CATEGORIES`, `COUNTRIES` |
| `domain` | Status and enum lists from `docs/00-domain-model.md` (`TRANSACTION_STATUSES`, `FUND_BUCKETS`, `PRICE_LINE_TYPES`, `PRICE_LINE_BUCKET`, …) |

---

## Worked example: JPY → IDR landed cost

A buyer's first transaction: a ¥50,000 figure from Japan (HS 9503, `TOYS_HOBBIES`), paid via QRIS, with a Rp50,000 first-transaction promo and Rp25,000 of JastipKita Credit. Every number below comes from the code, and `src/readme-example.test.ts` pins them.

The customs rule is a **test fixture** (`src/testing/fixtures.ts`: 10% duty, VAT 12% × DPP 0.916667, PPh 20% without NPWP, `CEIL_1000`). It is not a legal reference.

```ts
import {
  DEFAULT_BUSINESS_CONFIG as cfg, crossRateChecked, crossRate, createFxLock, markupBpsFor,
  estimateCustoms, evaluatePromotions, computeRateFee, convert, buildQuote, allocateFunds,
} from '@jastipkita/core';

const now = new Date('2026-09-27T03:00:00Z');
const ecb = { base: 'EUR', asOf: new Date('2026-09-26T14:00:00Z'), rates: { JPY: '162.3', IDR: '17800', USD: '1.08' } };

const spot   = crossRateChecked(ecb, 'JPY', 'IDR', now, cfg['fx.lock'].maxRateAgeMinutes); // "109.6734442391"
const usdIdr = crossRate(ecb, 'USD', 'IDR');                                                // "16481.4814814815"
const lock = createFxLock({
  base: 'JPY', quote: 'IDR', spotRate: spot,
  markupBps: markupBpsFor('JPY', cfg['pricing.fx_markup']),           // 150
  now, lockMinutes: cfg['fx.lock'].lockMinutes,                        // 30
  rateAsOf: ecb.asOf, maxRateAgeMinutes: cfg['fx.lock'].maxRateAgeMinutes,
});                                                                    // lockedRate "111.3185459027", expires 03:30Z

const customs = estimateCustoms({
  originCountry: 'JP', destinationCountry: 'ID', hsCode: '9503.00', categoryCode: 'TOYS_HOBBIES',
  itemValueMinor: 50_000, currency: 'JPY', quantity: 1,
  fx: { itemToIdr: spot, usdToIdr: usdIdr }, date: now, rules: customsRulesFromDb,
});                                                                    // treatment defaults to NON_PERSONAL

const itemIdr = convert(50_000, 'JPY', 'IDR', lock.lockedRate);       // 5_565_927
const promotion = evaluatePromotions(
  { itemValueIdr: itemIdr, travelerFeeIdr: 0, platformFeeIdr: computeRateFee(itemIdr, cfg['pricing.platform_fee']),
    originCountry: 'JP', categoryCode: 'TOYS_HOBBIES' },
  promosFromDb, { id: buyerId, isFirstTransaction: true }, now,
);                                                                     // discountIdr 50_000

const quote = buildQuote({
  item: { unitPriceMinor: 50_000, currency: 'JPY', quantity: 1, unitWeightKg: 0.8 },
  fxLock: lock, travelerFee: { type: 'PERCENT', rateBps: 1000 }, customs,
  paymentChannel: 'QRIS', promotion, referralCreditAvailableIdr: 25_000, now, configVersion: 1,
}, cfg);
```

**Customs (`estimateCustoms`, `ID_PASSENGER_V2025`, NON_PERSONAL means no USD 500 exemption):**

| Step | Formula | Amount |
|---|---|---:|
| Nilai pabean (FOB) | ¥50.000 × 1 × kurs 109,6734442391 | Rp5.483.672 |
| Bea masuk | Rp5.483.672 × 10% → CEIL_1000 | Rp549.000 |
| Nilai impor | Rp5.483.672 + Rp549.000 | Rp6.032.672 |
| PPN impor | Rp6.032.672 × 0,916667 × 12% = 663.594 → CEIL_1000 | Rp664.000 |
| PPnBM | × 0% | Rp0 |
| PPh 22 impor (tanpa NPWP) | Rp6.032.672 × 20% = 1.206.534 → CEIL_1000 | Rp1.207.000 |
| **Total** | duty 549.000 + import tax 1.871.000 | **Rp2.420.000** |

Warning emitted: `EXEMPTION_NOT_APPLIED`.

**Quote (`buildQuote`), in §10 display order:**

| # | Line | How | Amount (IDR) | Bucket | Estimate |
|---|---|---|---:|---|:-:|
| 1 | ITEM_PRICE | ¥50.000 × 111,3185459027 (spot +1,5% markup) = 5.565.927,3 | 5.565.927 | PRODUCT_FUND | |
| 2 | TRAVELER_FEE | 10% of item = 556.592,7 (bounds: ≥ Rp25.000, ≤ 30%) | 556.593 | TRAVELER_EARNING | |
| 3 | CUSTOMS_DUTY | from customs | 549.000 | CUSTOMS_RESERVE | ✓ |
| 4 | IMPORT_TAX | PPN + PPnBM + PPh | 1.871.000 | CUSTOMS_RESERVE | ✓ |
| 5 | PROTECTION_FEE | 1,5% of item = 83.488,9 (min 5.000, max 300.000) | 83.489 | PLATFORM_REVENUE | |
| 6 | PLATFORM_FEE | 5% of item = 278.296,35 (min 10.000, max 750.000) | 278.296 | PLATFORM_REVENUE | |
| 7 | SERVICE_TAX | (83.489 + 278.296) × 0,916667 × 12% = 39.796,4 | 39.796 | TAX_PAYABLE | |
| 8 | PAYMENT_FEE | QRIS 0,7%, grossed-up (see below) | 62.522 | PAYMENT_FEE | |
| 9 | DISCOUNT | first-transaction promo | −50.000 | PROMOTION_CREDIT | |
| 10 | REFERRAL_CREDIT | JastipKita Credit | −25.000 | PROMOTION_CREDIT | |
| 11 | **TOTAL** | Σ lines 1–10 | **8.931.623** | CLEARING | ✓ |

The payment-fee gross-up works as follows:
- The pre-fee payable is 8.944.101 − 50.000 − 25.000 = **8.869.101**.
- The smallest total T with `T − payable ≥ fixed + ⌈T × 0,7%⌉` is T = ⌈8.869.101 × 10000 / 9930⌉ = **8.931.623**, so the fee is 62.522.
- The gateway charges ⌈8.931.623 × 0,7%⌉ = 62.522, which the fee covers exactly.

**Fund allocation (`allocateFunds(quote)`):** PRODUCT_FUND 5.565.927 · TRAVELER_EARNING 556.593 · CUSTOMS_RESERVE 2.420.000 · PLATFORM_REVENUE 361.785 · TAX_PAYABLE 39.796 · PAYMENT_FEE 62.522 · PROMOTION_CREDIT −75.000.

The buckets sum to TOTAL (8.931.623). The obligations (9.006.623) equal cash-in (8.931.623) plus promotion funding (75.000), so `balanced: true`.

---

## Engines: inputs, outputs, one example each

### money
`toMinor(amount, currency)` turns a decimal into minor units (half-up). `fromMinor(minor, currency)` returns an exact string. `formatIdr(n)` returns `"Rp1.250.000"`. `formatMoney(n, ccy, locale)` uses id-ID `.`/`,` or en `,`/`.`. `roundHalfUp`, `ceilTo/floorTo/roundTo(step)`, `applyBps`, `mulByRates` (single rounding) and `allocateProportionally` (largest remainder, always sums exactly) round out the module.

```ts
toMinor('12.345', 'USD')                        // 1235
fromMinor(1250, 'USD')                          // "12.50"
formatMoney(123456789, 'USD', 'id-ID')          // "$1.234.567,89"
roundHalfUp(1.005, 2)                           // 1.01   (Math.round gives 1.00)
mulByRates(1_000_000, ['0.12', '0.916667'])     // 110000 (110000.04 rounded once)
ceilTo(12_345, 1000)                            // 13000
```

### fx
`convert(amountMinor, from, to, rate)` computes `amount / 10^m(from) × rate × 10^m(to)` with half-up rounding. `quoteRate(spot, bps)` returns `spot × (1 + bps/10000)` at 10 dp. `createFxLock({base, quote, spotRate, markupBps, now, lockMinutes, rateAsOf?, maxRateAgeMinutes?})` returns `{ lockedRate, lockedAt, expiresAt, … }` and throws `FX_RATE_STALE` for old provider rates. `isLockValid(lock, now)` checks `[lockedAt, expiresAt)`. `fxAdjustment(oldLock, newRate, amount)` returns the re-quote delta. `crossRate(table, from, to)` returns `rates[to] / rates[from]`.

**Coverage and staleness:**
- Each currency in `currencies.json` carries `ecbReference` (`ECB_REFERENCE_CURRENCIES`, `isEcbReferenceCurrency`). TWD, VND, AED and SAR are not in the ECB set.
- A missing rate, or a non-ECB currency asked of an ECB-based provider (`frankfurter`/`ecb`), throws `FX_RATE_UNAVAILABLE` with `details.reason` `MISSING_FROM_TABLE` or `NOT_ECB_REFERENCE`. It never returns 0.
- `createFxLockFromConfig({base, quote, spotRate, rateAsOf, now}, cfg)` takes the lock window, per-currency markup, provider coverage and staleness limit from config. The limit is `fx.lock.maxRateAgeMinutes`, default **4320 = 72 h**, so a Friday ECB rate still locks on Monday.

```ts
fxAdjustment(lock /* 111.3185459027 */, quoteRate('111', 150) /* 112.665 */, 50_000)
// { oldQuoteMinor: 5_565_927, newQuoteMinor: 5_633_250, differenceMinor: 67_323, direction: 'BUYER_PAYS_MORE' }
```

### customs
`selectRule(rules, {originCountry, destinationCountry, hsCode, categoryCode, treatment, date})` filters to rules that are ACTIVE (§16 statuses: DRAFT, PENDING_APPROVAL, ACTIVE, RETIRED), effective on `date`, and match on destination, origin, category, HS prefix and treatment. Effectiveness follows §16: `effectiveFrom ≤ d ≤ effectiveUntil`, **inclusive** calendar dates, where `d` is the Asia/Jakarta calendar date of `date` (fixed +07:00). DB `YYYY-MM-DD` strings are used as-is; timestamps are converted to the WIB date. Among matching rules, the winner is decided in this order:
1. Most specific: longer HS prefix, then category, then origin, then exact treatment.
2. Higher `priority`.
3. Later `effectiveFrom`.
4. `id`.

`estimateCustoms(input)` returns `{ ruleId, ruleCode, ruleVersion, treatment, customsValueIdr, exemptionAppliedIdr, dutyIdr, vatIdr, luxuryTaxIdr, incomeTaxIdr, importTaxIdr, totalIdr, isEstimate: true, breakdownSteps[], sourceReference, lastVerifiedAt, warnings[] }`. If no rule matches, it returns `ruleId: null`, zero amounts and the warning `NO_RULE`, and pricing then raises the blocking issue `CUSTOMS_NO_RULE`. Other warnings are `HS_CODE_DEFAULTED` (the category's default HS was used), `EXEMPTION_NOT_APPLIED`, `ALLOWANCE_CAPPED` and `RULE_VERIFICATION_STALE` (older than 180 days).

Example, PERSONAL with NPWP: $600 at Rp16.000, exemption USD 500 = Rp8.000.000, taxable Rp1.600.000. That gives duty 160.000, PPN 194.000, PPh (10%) 176.000, for a **total of 530.000**. See the customs test file for the fully worked case.

### pricing
`buildQuote(input, config)` returns `{ lines[11], totalIdr, amounts, fxRate, expiresAt, paymentChannel, paymentFeeBearer, platformBornePaymentFeeIdr, adjustments[], issues[], blocksCheckout }`. Each line is `{ type, labelId, labelEn, amountIdr, bucket, isEstimate, ruleRef?, originalAmountIdr? }`.

Rules:
- **Traveler fee** can be FIXED, PERCENT (bps of the item) or PER_KG × total weight. It is clamped to at least `minIdr` and at most `maxRateBps` of the item, and the clamp is reported in `adjustments`.
- **Discount** is capped at item + traveler + protection + platform fees. Taxes and customs are never discounted.
- **Referral credit** is capped at the remaining payable. When the payable reaches 0, the payment fee is also 0.
- **Payment fee:** with `bearer: BUYER` it is grossed up by default (`grossUp: false` charges `fixed + ⌈payable × r⌉` and books the shortfall as platform-borne). With `bearer: PLATFORM` the line is 0 and `platformBornePaymentFeeIdr` carries the gateway cost; `allocateFunds` moves that cost from PLATFORM_REVENUE to the PAYMENT_FEE bucket.
- **FREE_PLATFORM_FEE** sets the PLATFORM_FEE line to 0 with `originalAmountIdr`, and service tax is recomputed on the waived base.
- **Blocking issues** are `FX_LOCK_EXPIRED`, `BELOW_MINIMUM_TRANSACTION`, `CUSTOMS_ESTIMATE_MISSING` and `CUSTOMS_NO_RULE`.

Invariants are tested over 200 seeds: Σ lines = TOTAL, TOTAL ≥ 0, allocation balanced, deterministic. See the worked example above.

### state-machine
`createFsm(def)` validates the definition at construction: known states, no exits from terminal states, existing guards, no duplicate edges. Each machine exposes `canTransition(from, to, actor, ctx)`, which returns `{ ok: true, transition } | { ok: false, code, message }`. The possible failure codes are `UNKNOWN_STATUS`, `TERMINAL_STATUS`, `INVALID_TRANSITION`, `ACTOR_NOT_ALLOWED` and the guard codes. It also exposes `assertTransition` (throws), `nextAllowed(from, actor)`, `nextAvailable(from, actor, ctx)` and `reachableFrom`.

`TRANSACTION_TRANSITIONS` is §4 verbatim (39 edges: 33 table rows, with the DISPUTED row expanded to its 7 source statuses), and its guards read `TransactionGuardContext`. `purchaseGate(status)` returns `{ canPurchase, banner, paymentBadge, tone, messageId, messageEn }`, and only `PURCHASE_APPROVED` can purchase. The §4 table includes the ADMIN override edges `{TRAVELING … OUT_FOR_DELIVERY} → REFUND_PENDING` (guard: matrix allows it and `adminApprovalRecorded`). `PRICE_CHANGE_PENDING → REFUND_PENDING` also allows TRAVELER, via the matrix.

The secondary machines are exactly §15: Trip (15.1), PriceConfirmation (15.2), Dispute (15.3), KYC submission (15.4), Payment (15.5), Refund (15.6, which adds PENDING_APPROVAL/CANCELLED plus maker-checker), Payout (15.7, which starts at `SCHEDULED` and has `CANCELLED`), and Quote / FX lock (15.8, all SYSTEM). Guard codes named in the doc (`UNVERIFIED_ACTIVE`, `HAS_CAPACITY`, `WINDOW_OPEN`, `EVIDENCE_DONE`, `KYC_CHECKS`, `AMOUNT_OK`, `RETRY_BUDGET`, `PAYOUT_CLEAR`, `HOLD_RELEASE`, …) are implemented under the same names.

**Drift guard:** `src/state-machine/spec-parity.test.ts` reads `docs/00-domain-model.md` from disk. It parses the §4 and §15.x tables (and the §15.8 prose), then asserts that the exported tables have identical (from, to, actor set) edges, the same states and the same named guard codes. Editing the doc without the code, or the code without the doc, fails CI.

```ts
canTransition('MATCHED', 'AWAITING_PAYMENT', 'BUYER', { quoteActive: true, fxLockValid: true, buyerKycLevel: 1, restrictedClassification: 'ALLOWED' })
// { ok: false, code: 'KYC_LEVEL_INSUFFICIENT', message: 'Buyer KYC level must be >= 2' }
nextAllowed('PAYMENT_SECURED', 'TRAVELER')   // ['PURCHASE_APPROVED', 'PRICE_CHANGE_PENDING', 'REFUND_PENDING']
purchaseGate('PAYMENT_SECURED')
// { canPurchase: false, banner: 'DO_NOT_PURCHASE', paymentBadge: 'PAYMENT_SECURED', tone: 'error',
//   messageId: 'JANGAN BELI DULU. Dana sudah aman, tunggu status Purchase Approved.', … }
```

### price-confirmation
`evaluatePriceChange({securedItemIdr, maxBudgetIdr, actualItemIdr, toleranceBps, toleranceMaxIdr})` returns `{ outcome: WITHIN_TOLERANCE | NEEDS_CONFIRMATION, differenceIdr, toleranceIdr, supplementalRequiredIdr, absorbedWithinToleranceIdr, refundDueIdr, exceedsMaxBudget, nextTransactionStatus }`. The tolerance is `min(secured × bps, maxIdr)`. A price decrease is auto-approved with `refundDueIdr`, while going over `maxBudgetIdr` always needs confirmation. `windowExpiresAt(now, 900)` returns `now` + 15 minutes. `resolveExpired(config)` gives REJECT → `REFUND_PENDING` by default.

```ts
evaluatePriceChange({ securedItemIdr: 5_565_927, maxBudgetIdr: 6_000_000, actualItemIdr: 5_685_927, toleranceBps: 200, toleranceMaxIdr: 50_000 })
// { outcome: 'NEEDS_CONFIRMATION', toleranceIdr: 50_000, supplementalRequiredIdr: 120_000, exceedsMaxBudget: false, nextTransactionStatus: 'PRICE_CHANGE_PENDING' }
```

### matching
`rankTravelersForRequest(request, [{trip, traveler}], weights, now, options?)` and `rankRequestsForTrip({trip, traveler}, [{request, buyer}], weights, now, options?)` both return `{ ranked: [{tripId, requestId, counterpartId, score 0–100, features, estimatedTravelerFeeIdr, reasons[]}], excluded: [{tripId, requestId, reasons[{code, message}]}], strategy }`.

**Hard filters** (all failing reasons are returned):
- Trip ACTIVE (or VERIFIED with `allowVerifiedTrips`)
- Same origin country
- Same destination country
- Arrives by `neededBy`
- Enough capacity
- Category not excluded
- Item not PROHIBITED
- Traveler limit ≥ item value
- Not the same user

**Soft factors** (0–1): `date`, `rating` (Bayesian, prior 4.0 × 5), `trust`, `price` (fee against the buyer's budget headroom), `capacity`, `history` (log-saturating) and `routeExactness` (1 for the same city, 0.5 for another city in the same country). `RankingStrategy { name, version, score(features, weights) }` is the plug-in point for an AI ranker; the default is `linearRankingStrategy`.

```ts
// request: ¥50.000 item (Rp5.565.927), max budget Rp7.000.000, needed by 10 Oct; trip arrives 3 Oct, Jakarta
// → score 84.87, reasons:
// ["Tiba 7 hari sebelum batas", "Trust Score 86", "Rating 4,8 (23 ulasan)", "30 transaksi selesai",
//  "Fee Rp556.593 masuk anggaran", "Sisa kapasitas 8,0 kg", "Kota tujuan cocok (Jakarta)"]
```

### trust-score
`computeTrustScore(signals, weights, now)` returns `{ score (int 0–100), components: [{key, value, weight, contribution, applicable, explanation}], version: 'trust-v1' }`.
- **Positives** use saturating curves and are normalized over the *applicable* positive weights, so a perfect profile reaches 100. Traveler-only signals (`onTimeDeliveryRate`, `verifiedTrips`) are excluded when null, so buyers are not penalized for lacking them.
- **Penalties** subtract up to their full weight: cancellation 10, dispute 15, fraud 30.
- **Overrides:** `applyOverride(result, {newScore, reason ≥ 10 chars, requestedBy, approvedBy ≠ requestedBy, approvedAt, expiresAt})` returns `{ score, previousScore, audit }`.

Example: a KYC 4 traveler with 12 transactions, 92% on-time, rating 4.8 (11 reviews), one cancellation (8%) and one failed payment scores **77**. The components are kyc 16.67, completed 10.87, value 7.86, age 7.29, on-time 12.27, trips 5.14, payment 8.00, rating 11.83 and cancellation −2.80.

### fraud
`assessRisk(subjectType, signals, thresholds, rules?)` returns `{ score 0–100, decision ALLOW|REVIEW|HOLD|BLOCK, reasons[{code, category, weight, message, minDecision?}], engineVersion }`. The score is a weighted sum clamped to 100. The decision comes from `risk.thresholds` (40/70/90), raised to any rule's `minDecision` floor: self-referral → BLOCK, receipt reuse or repeat chargebacks → HOLD, shared identity → REVIEW.

The rule families are MULTI_ACCOUNT, DEVICE_ABUSE, RAPID_ACCOUNT_CREATION, SUSPICIOUS_TRANSACTION, PAYMENT_ANOMALY, REFUND_ABUSE, REFERRAL_ABUSE, LOCATION_ANOMALY (impossible travel above 900 km/h, trip origin against device country), TRAVELER_BEHAVIOR and CHARGEBACK_RISK. `createRiskRuleRegistry().register(mlRule)` adds an ML scorer as just another `RiskRule`.

`assessReceipt(proof, history)` flags duplicate image hash, receipt number or serial; a purchase before PAYMENT_SECURED or before approval; a future timestamp; price or currency mismatch; merchant mismatch; and a missing serial or video. It also returns `proofComplete` and `priceWithinApproved`, which feed the PURCHASED guard directly.

```ts
assessRisk('REFERRAL', { referral: { referrerId: 'a', refereeId: 'b', sharedDevice: true, sharedIp: true }, accountsCreatedFromDeviceLast24h: 3 })
// score 60 → REVIEW: REFERRAL_SHARED_DEVICE 30, SIGNUP_BURST_DEVICE 20, REFERRAL_SHARED_IP 10
```

### limits
`computeTransactionLimit({kycLevel, trustScore, completedTransactions, productRisk, countryRisk, role, monthUsedIdr}, cfg['limits.transaction'])` returns `{ perTransactionMaxIdr, monthlyRemainingIdr, effectiveMaxIdr, reasons[], … }`. The per-transaction limit is `floor₁₀₀₀(base[KYC, role] × trust tier × product risk × country risk)`, using exact decimal multiplication. The new-traveler cap applies when `completedTransactions < threshold`. `checkLimit(amount, input, cfg)` returns `{ ok } | { ok: false, code: KYC_LEVEL_TOO_LOW | PER_TRANSACTION_LIMIT_EXCEEDED | MONTHLY_LIMIT_EXCEEDED }`.

```ts
// Buyer, KYC 3, trust 72, MEDIUM product risk: 15.000.000 × 1,5 × 0,8 = 18.000.000
// reasons: "Batas dasar pembeli KYC level 3: Rp15.000.000", "Trust Score 72 → ×1,5", "Risiko produk MEDIUM → ×0,8"
```

### restricted
`classifyItem({origin, destination, categoryCode, hsCode, productName, quantity, valueUsd}, rules, date)` returns `{ classification, blocksCheckout, requiresAcknowledgement, matches[], permitAuthorities[], airlineDg: boolean, dgNotes[], messagesId[], messagesEn[] }`. The most severe classification wins.
- **Rule data (§16):** only ACTIVE rules are used. Effective dates are inclusive WIB calendar dates, exactly as for customs. `airlineDg` is a boolean (DB `airline_dg`), and a richer handling hint may go in the optional `dgNote`.
- **Selectors:** every selector set on a rule must match (category AND HS prefix AND any keyword). A rule with no selectors applies to the whole route.
- **Keywords:** matching is lowercase, accent-insensitive (NFKD) and word-bounded. CJK and Thai fall back to substring matching.
- **Limits:** exceeding `maxQuantity` or `maxValueUsd` escalates that match to PROHIBITED.

```ts
classifyItem({ origin: 'JP', destination: 'ID', categoryCode: 'BATTERIES_POWERBANK', productName: 'Anker Power-Bank 20000mAh', quantity: 3, … }, rules, now)
// PROHIBITED (rule RESTRICTED, maxQuantity 2 exceeded), airlineDg true, dgNotes ['Kabin saja'],
// messageId "Power bank hanya di kabin, maks. 2 unit. (Melebihi batas: 3 > 2.)"
```

### cancellation
`evaluateCancellation({status, actor, cause?, quoteLines, paymentCaptured}, matrix)` maps the status to a stage and picks the matrix row.

**Row matching:** (stage, actor, cause) → (stage, actor, no cause) → (stage, ANY). A cause row only ever matches its own cause. `cause: 'PRICE_CHANGE_REJECTED'` gives the buyer a no-fault full refund, including the payment fee, with trust penalty 0. SYSTEM and ADMIN rows exist for AFTER_PAYMENT, BEFORE_PURCHASE and AFTER_PURCHASE. If no row matches and money was captured, the result is `NO_MATRIX_ROW` with `requiresAdminApproval`.

**Transition path:** it is `['REFUND_PENDING']` whenever §4 has a direct edge, which now includes ADMIN during travel and after arrival. Only DELIVERED still goes through `['DISPUTED', 'REFUND_PENDING']`.

It returns `{ allowed, stage, matrixActor, matrixCause, reason, refundIdr, refundByLine, retainedByLine, travelerCompensationIdr, platformRetainedIdr, paymentFeeRetainedIdr, customsRetainedIdr, serviceTaxRetainedIdr, promoConsumedIdr, creditRestoredIdr, discountReversedIdr, trustPenalty, penalizedActor, requiresAdminApproval, transitionPath, fsmPermitsActor }`.

Reconciliation, tested over 200 seeds:
`refund + compensation + platformRetained + paymentFeeRetained + customsRetained + serviceTaxRetained = paid + promoConsumed`.
Promotions never become cash: retained fees are charged to cash first, an unused discount goes back to the budget, and referral credit returns to the wallet.

Example, the quote above cancelled by the buyer at PURCHASE_APPROVED (stage BEFORE_PURCHASE):
- Refund: **8.654.396**
- Traveler compensation: 55.659 (max(10.000, 10% × 556.593))
- Platform keeps 139.148 (50% of the platform fee)
- Service tax retained: 19.898
- Payment fee retained: 62.522
- Credit restored: 25.000; discount reversed: 50.000
- Trust penalty: 3

### referral
`evaluateReferralReward({program, referrer, referee, qualifyingTransaction, monthRewardedIdr, alreadyRewarded?, signals: {decision}, now}, cfg)` returns `{ status: GRANTED | PENDING_REVIEW | REJECTED, referrerRewardIdr, refereeRewardIdr, cappedByMonthlyLimit, variant, expiresAt, withdrawable, reasons[] }`.
- **BUYER program:** the referee's first transaction must be COMPLETED with value ≥ Rp500.000.
- **TRAVELER program:** the referrer is paid after the referee completes N transactions.
- **Monthly cap:** it caps the referrer partially and never touches the referee's reward.
- **Fraud gate:** HOLD or BLOCK means no reward; REVIEW means the reward is held for review.
- **Experiments:** `assignVariant(userId, key, variants)` uses FNV-1a over the sorted variants, so it is deterministic.
- **Guardrail:** `unitEconomicsGuardrail({cac, ltv, fraudRate}, guardrails)` returns `{ allowIncrease, pause, cacToLtv, reasons }`.

```ts
// referrer already got Rp240.000 this month (cap Rp250.000) → referrer 10.000 (capped), referee 25.000, expires +90 days, withdrawable false
```

### promotions
`evaluatePromotions(cart, promos, user, now)` returns `{ applied[], discountIdr, cashbackIdr, freePlatformFee, promoIds, rejected[{promoId, code, reason}] }`.
- **Types:** PROMO_CODE, FIRST_TRANSACTION, COUNTRY, TRAVELER, CAMPAIGN, CASHBACK and FREE_PLATFORM_FEE.
- **Conditions:** date window, minimum item value, origin countries, categories, segments, and per-user, global and budget limits. A budget partially caps a cash discount but rejects a partial fee waiver.
- **Stacking:** at most one discount-class promo (highest value, then priority, then id) plus at most one cashback. Referral credit is always applied separately by pricing.

Example: HEMAT10 (10%, cap 150.000) on a Rp2.000.000 cart gives `discountIdr: 150.000`. A 5% cashback capped at 75.000 stacks with it, and the other discount promos are rejected as `NOT_STACKABLE`.

### rating
- `validateRating(input)` checks that the transaction is COMPLETED only, that the rater is a party (not a self-rating), one rating per side, a 14-day window, integers 1–5, an OVERALL score, and known dimensions.
- `bayesianAverage(sum, count, priorMean, priorWeight)`.
- `aggregateRatings(ratings, {flaggedRaterIds, linkedRaterIds})` gives linked raters weight 0, flagged raters 0.25, and outliers (≥ 2 from the median) on transactions below Rp250.000 weight 0.25.

```ts
// ratings 5, 5, 1 (Rp120.000 tx), 5 (linked account)
// → rawAverage 4.00, weightedAverage 4.56, effectiveCount 2.25, bayesianScore 4.17
```

### dispute
- `computeSla(openedAt, cfg['dispute.sla'])` returns `{ evidenceDueAt, reviewDueAt }`.
- `canOpenDispute(txStatus, deliveredAt, now, sla)` allows PURCHASED through DELIVERED; once DELIVERED, only within 72 hours.
- `validateDisputeResolution({resolution, refundIdr, capturedIdr, alreadyRefundedIdr})` enforces refund ≤ captured − already refunded, an exact amount for a full refund, and 0 < partial < remaining. It returns `nextTransactionStatus`.

```ts
computeSla(new Date('2026-10-05T10:00:00Z'), sla)   // evidenceDueAt 2026-10-08T10:00Z, reviewDueAt 2026-10-13T10:00Z
```

### delivery
- `generatePin(bytes, 6)` takes CSPRNG bytes from the caller and uses rejection sampling: bytes ≥ 250 are dropped, so each digit is exactly uniform.
- `verifyPinAttempt({attempts, maxAttempts, matches})` returns `VERIFIED | WRONG_PIN | LOCKED`.
- `autoConfirmAt(deliveredAt, 48)` gives the auto-confirm time.

```ts
generatePin(new Uint8Array([12, 250, 7, 99, 255, 180, 3, 41, 66, 8]), 6)   // "279031" (250 and 255 rejected)
verifyPinAttempt({ attempts: 4, maxAttempts: 5, matches: false })          // { code: 'LOCKED', attempts: 5, attemptsRemaining: 0 }
```

### numbering
`formatTransactionNumber(date, bytes)` returns `JK-YYMMDD-XXXXXX`, using the WIB date and 6 Crockford base32 characters built from 30 random bits with no modulo bias. `formatDocumentNumber('DSP' | 'RFD' | 'TKT' | 'PO', …)` covers the other document types. `parseDocumentNumber` normalizes lowercase and I/L/O.

```ts
formatTransactionNumber(new Date('2026-09-27T18:30:00Z'), new Uint8Array([0x3a, 0x7f, 0x12, 0xc4]))   // "JK-260928-79ZH5H"
```

### config
`BusinessConfig` has a typed interface per key. `DEFAULT_BUSINESS_CONFIG` is validated at import and deep-frozen. `validateBusinessConfig(key, value)` returns `{ ok: true, value } | { ok: false, errors[{path, message}] }`. It rejects:
- unknown or missing fields
- negative amounts
- bps above 10.000 (payment rates must be below 10.000 so the gross-up is solvable)
- min > max
- unordered risk thresholds or trust tiers
- duplicate or missing cancellation-matrix rows (every stage needs a BUYER or ANY row, and allowed post-payment rows need all 8 refund lines)

```ts
validateBusinessConfig('pricing.platform_fee', { rateBps: 12000, minIdr: -5, maxIdr: 750000 })
// { ok: false, errors: [{ path: 'pricing.platform_fee.rateBps', message: 'must be between 0 and 10000' },
//                       { path: 'pricing.platform_fee.minIdr', message: 'must be between 0 and 1000000000000' }] }
```

---

## Decisions where the spec was ambiguous

1. **Purchase banner.** The doc's golden rule wins: `PAYMENT_SECURED` and `PRICE_CHANGE_PENDING` show `DO_NOT_PURCHASE`, and the secured state is surfaced as a separate `paymentBadge: 'PAYMENT_SECURED'`.
2. **Customs `itemValueMinor`** is the unit FOB value and is multiplied by `quantity`. A missing HS code falls back to the category's `defaultHs`, with a warning. Rule `priority` means higher wins.
3. **Import value** uses the *rounded* duty. FLAT_RATES means each rate applies directly to the full customs value, with no exemption and no cascade.
4. **Price tolerance.** An increase within tolerance is auto-approved and not collected from the buyer (`absorbedWithinToleranceIdr`). Any decrease is auto-approved with `refundDueIdr`. Exceeding the max budget always needs confirmation.
5. **Traveler-fee bounds** clamp rather than reject. If the minimum is above the 30% cap (tiny items), the minimum wins.
6. **Discount eligible base** is item + traveler + protection + platform fees; taxes and customs are never discounted. Service tax is charged on gross fees, except that FREE_PLATFORM_FEE waives the fee itself, so there is no tax on 0.
7. **Restricted `maxQuantity` / `maxValueUsd`** are the allowed maximum under a rule; exceeding one escalates to PROHIBITED.
8. **Trust score** normalizes positives over the applicable weights (config positives sum to 90), so a clean veteran can reach 100.
9. **Cancellation with no matrix row.** If payment is not captured, SYSTEM or ADMIN may cancel with no money moving. Otherwise the result is `NO_MATRIX_ROW` plus `requiresAdminApproval`. A cause that has no row falls back to the actor's generic row.
10. **§15.8 actors.** The prose lists `(SYSTEM)` once per sentence, so every Quote and FX-lock edge is SYSTEM-only.
11. **Guards beyond the doc's named codes**, all fail-closed:
    - Trip `MARK_FULL`: TRAVELER at will, SYSTEM only at 0 kg.
    - `DOCUMENT_VERIFIED`.
    - `REASON_REQUIRED` for KYC/refund rejection and payout hold.
    - Refund `ABOVE_AUTO_APPROVE` / `MAKER_CHECKER`, and SYSTEM `AMOUNT_OK` also requires being under the auto-approve limit.
    - Payment `PAYMENT_VERIFIED` (also for late funds after EXPIRED/FAILED).
12. **Rule-date timezone.** The §16 inclusive dates are compared as Asia/Jakarta calendar dates via a pure +07:00 offset (no tz database).
13. **`rankRequestsForTrip`** takes `{trip, traveler}`, because the same-user and traveler-limit filters need the traveler.
