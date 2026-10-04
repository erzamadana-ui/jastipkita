# Marketplace API (catalog · FX · customs · restricted · trips · requests · matching · offers)

Owner: marketplace group. Code: `apps/api/src/modules/{catalog,fx,customs,restricted,trips,requests,matching,offers}`,
`apps/api/src/providers/{fx,extraction}`, `apps/api/src/jobs/marketplace.ts`, migration `db/migrations/0030_marketplace_capacity.sql`.
Binding references: `docs/00-domain-model.md` (§3/§15.1 trip FSM, §4 transaction start, §7 restricted items, §16 rule dates),
`docs/dev/api-module-guide.md`, `packages/core/README.md`.

All money is integer IDR (or integer minor units + ISO currency for foreign prices). Timestamps are ISO-8601 UTC; calendar
dates (`YYYY-MM-DD`: trip dates, `neededBy`, rule dates) are **WIB (Asia/Jakarta)** calendar days.

---

## 1. Endpoints

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /v1/catalog/countries?role=origin\|destination` | public | origins: `is_origin` and activation `SOFT_LAUNCH`/`ACTIVE`; destinations: `ACTIVE` (ID). `Cache-Control: public, max-age=300` |
| `GET /v1/catalog/categories` · `GET /v1/catalog/currencies` | public | cacheable; currencies carry `minorUnits` and `ecbReference` (FX coverage) |
| `GET /v1/fx/rates?base=&quote=IDR` | public | spot + markup-applied rate, `asOf`, `source`, `pivot`; without `base` → every active currency (unavailable ones listed separately) |
| `POST /v1/fx/locks` {base, quote} | 🔒 | ACTIVE `fx_locks` row, window & markup from config |
| `POST /v1/customs/estimate` | public | calculator; NON_PERSONAL default + PERSONAL comparison |
| `POST /v1/restricted/check` | public | classification + ID/EN messages (`locale` body field or `Accept-Language`) |
| `GET /v1/trips` | optional | discovery (ACTIVE, not departed); no PII; anonymous → dates at ISO-week precision, signed-in → exact (SEC-19, §2.1a) |
| `POST /v1/trips` · `GET /v1/trips/mine` · `PATCH /v1/trips/{id}` | 🔒 | create DRAFT, own list, status-dependent edits |
| `GET /v1/trips/{id}` | optional | owner → `view: OWNER`; others → `view: PUBLIC` for ACTIVE/FULL/TRAVELING/COMPLETED, else 404; public view week-coarsened for anonymous visitors (§2.1a) |
| `POST /v1/trips/{id}/verification` | 🔒 | TRIP_DOC file (owned, scan CLEAN) → `trip_verifications` PENDING; DRAFT → VERIFICATION_PENDING |
| `POST /v1/trips/{id}/publish` | 🔒 K3 | VERIFIED → ACTIVE; DRAFT/VERIFICATION_PENDING → ACTIVE only if `trips.allowUnverifiedActive` |
| `POST /v1/trips/{id}/depart\|complete\|cancel` | 🔒 | via `transition_trip`; cancel → `trip.cancelled` event (money settles every open transaction, money.md §5.1); `409 TRIP_HAS_PURCHASED_TRANSACTIONS {transactionIds}` when goods were already bought |
| `GET /v1/trips/{id}/recommended-requests` | 🔒 owner | matching |
| `POST /v1/requests/extract` {url\|fileId\|query} | 🔒 | heuristic extraction (20/min/user) |
| `POST /v1/requests` · `GET /v1/requests/mine` · `PATCH /v1/requests/{id}` | 🔒 | CRUD (DRAFT or OPEN with `publish: true`) |
| `GET /v1/requests/open` | 🔒 | traveler view: OPEN requests matching the caller's ACTIVE trips |
| `GET /v1/requests/{id}` | 🔒 | buyer → `OWNER`; travelers → `LISTING` (OPEN, or requests they made an offer on) |
| `POST /v1/requests/{id}/publish\|cancel` | 🔒 buyer | |
| `GET /v1/requests/{id}/recommended-travelers` | 🔒 buyer | matching |
| `POST /v1/requests/{id}/offers` | 🔒 K3 | traveler offer |
| `POST /v1/trips/{id}/invites` {requestId} | 🔒 buyer | buyer invites a traveler's trip |
| `GET /v1/requests/{id}/offers` · `GET /v1/offers/mine?role=traveler\|buyer&status=` | 🔒 | |
| `POST /v1/offers/{id}/accept\|decline\|withdraw` | 🔒 | accept/decline = counterparty of the initiator; withdraw = initiator |

Error codes are UPPER_SNAKE with Indonesian messages; the most important: `FX_RATE_STALE` (503), `FX_RATE_UNAVAILABLE`
(503 no data / 422 currency not covered), `COUNTRY_NOT_SUPPORTED`, `CATEGORY_UNKNOWN`, `DATE_IN_PAST`,
`CAPACITY_TOO_LARGE`, `MAX_ACTIVE_TRIPS`, `TRIP_FIELD_LOCKED`, `TRIP_NOT_VERIFIED`, `KYC_LEVEL_REQUIRED`, `FILE_NOT_READY`,
`BELOW_MINIMUM_TRANSACTION`, `BUDGET_BELOW_ITEM_VALUE`, `RESTRICTION_ACK_REQUIRED`, `ITEM_PROHIBITED`,
`REQUEST_HAS_PENDING_OFFERS`, `URL_NOT_ALLOWED`, `ROUTE_MISMATCH`, `ARRIVES_TOO_LATE`, `CAPACITY_INSUFFICIENT`,
`TRAVELER_LIMIT_EXCEEDED`, `FEE_OUT_OF_BOUNDS`, `OFFER_ALREADY_PENDING`, `NOT_COUNTERPARTY`, `OFFER_EXPIRED`,
`OFFER_ALREADY_ACCEPTED`, `REQUEST_ALREADY_MATCHED`.

---

## 2. Flows

### 2.1 Trip (§3 / §15.1)
```
POST /trips (DRAFT) ──verification──▶ VERIFICATION_PENDING ──admin approves──▶ VERIFIED ──publish (K3)──▶ ACTIVE ⇄ FULL
        │                                   │ (allowUnverifiedActive=true: publish directly)          │
        └───────────────────────────────────┴──────────────────────────────── depart / job ──▶ TRAVELING ──▶ COMPLETED
any non-terminal ──cancel──▶ CANCELLED   (pending offers WITHDRAWN; open transactions → `trip.cancelled` event → money consumer; refused once a transaction is PURCHASED or later)
```
- Every status change: core `tripFsm.canTransition` (guards `UNVERIFIED_ACTIVE`, `HAS_CAPACITY`, `MARK_FULL`) → `transition_trip()`
  (writes `trip_events`, `trip.status_changed`, audit).
- Create validation: departure ≥ today (WIB), arrival ≥ departure, capacity ≤ `trips.maxCapacityKg` (2 dp), live (non-terminal)
  trips < `trips.maxActiveTripsPerTraveler` (serialized per traveler with an advisory lock), origin = supported origin,
  destination = ACTIVE destination, excluded categories exist, PERCENT fee ≤ `pricing.traveler_fee_bounds.maxRateBps`.
- Editable fields: DRAFT = all; VERIFICATION_PENDING/VERIFIED/ACTIVE/FULL = `capacityKg, maxItems, fee, excludedCategories,
  notes, returnDate` (route & dates are what the documents prove); TRAVELING = `notes`; terminal = none. Capacity/max items can
  never drop below what is reserved.
- `depart` is allowed from the day before `departureDate` (time zones); `complete` requires every transaction of the trip to be
  handed over (DELIVERED/BUYER_CONFIRMED/COMPLETED/CANCELLED/REFUNDED).
- **Capacity accounting** (`trip_capacity_reservations`, migration 0030): one row per transaction (kg ceil-rounded to 0.01,
  items = quantity), running totals in `trips.reserved_kg/reserved_items`. After every change `syncTripFullness` moves
  ACTIVE → FULL (SYSTEM) when effective remaining capacity is 0 (kg or item count exhausted) and FULL → ACTIVE when capacity
  returns. Release is idempotent (`released_at`).

### 2.2 Request
- `POST /requests/extract` returns *drafts* (never persisted). `POST /requests` persists; `publish: true` creates it OPEN.
- Validation on create/patch/publish: merchant country = supported origin, destination ACTIVE, category & currency exist,
  `neededBy` ≥ today, item value at **spot** FX (`unitPriceMinor × quantity`) ≥ `pricing.minimum_transaction.minItemValueIdr`,
  `maxBudgetIdr` ≥ item value.
- Restriction: `classifyRequestItem` stores `restriction_class` + `restriction_rule_ref`. PROHIBITED may be drafted but never
  published (also a DB CHECK). Any other non-ALLOWED class needs `acknowledgeRestriction: true` → `restriction_ack_at`; the ack
  is cleared whenever an edit changes the classification.
- OPEN requests expire at the end of `neededBy` (WIB) or after **30 days** (`REQUEST_TTL_DAYS`, assumption — no config key).
- While offers are pending, item fields (name, category, HS, quantity, price, currency, weight, merchant/destination country)
  are locked (`REQUEST_HAS_PENDING_OFFERS`). Optional optimistic lock via `version`.
- Traveler/listing view never includes `notes`, buyer e-mail/phone/name — only the buyer's public profile (first name +
  initial, badge, rating as buyer, completed count).
- `autoFill` (owner **and** listing view, also in offers / recommendations): `{sourceType: URL|PHOTO|SEARCH, mode: MOCK|SANDBOX|LIVE|null}`
  when the product data came from `POST /requests/extract`, else `null`. Rule: `sourceType ≠ MANUAL` **and** the create body carried a
  non-empty `extraction` object (the app sends `{mode, confidence}` of the draft it applied; `mode` outside the enum → `null`). Derived
  from `requests.source_type` + `requests.extraction` (0007) — no extra column; it survives edits (the request was still created from
  extraction). **L13 / Permendag 19/2026 AI-content label:** clients show *"Diisi otomatis (AI/ekstraksi otomatis) — periksa kembali
  sebelum menitip"* next to auto-filled fields in the create form and a small label on the request detail. The wording says
  "AI/ekstraksi otomatis" because the current `heuristic` provider parses merchant metadata and is not an AI model (no AI claim beyond
  what runs); the photo path is designed for an AI provider.
- `images[]` = `{fileId, url, contentUrl}`: `url` is always absolute (merchant image URL, or `${API_BASE_URL}/v1/files/{id}/content`
  for uploaded photos); `contentUrl` is the API URL for uploaded photos (null for merchant URLs).

### 2.1a Trip date precision for anonymous visitors (SEC-19, decision 2026-10-04)
Anonymous visitors see trip dates at **week** precision, signed-in users see **exact** dates. Every `TripPublic` (discovery, the
public trip detail, matching recommendations, offers) carries:

| Field | DAY (bearer of an ACTIVE account) | WEEK (no bearer; non-ACTIVE account) |
|---|---|---|
| `datePrecision` | `DAY` | `WEEK` |
| `departureWindow` / `arrivalWindow` `{from, to}` | `from = to =` the exact date | ISO week (Monday–Sunday) containing the date |
| `departureDate` / `arrivalDate` | exact date | **the window's Monday** (kept for older clients — never present it as the exact date) |

- Trip dates are itinerary calendar dates (DB `date`), so the week is the ISO week of that date; "today" is the Asia/Jakarta date.
- WEEK requests: date filters work per whole week — `departureFrom` → Monday of its week, `departureTo` / `arrivalBy` → Sunday of their
  week, and "not departed yet" starts at the Monday of the current week — so a day-precise filter cannot single out one day; results
  are ordered by (departure week, trip id), keyset cursor on the same key (cursors are precision-specific).
- Bearer handling on `GET /v1/trips` and `GET /v1/trips/{id}`: no `Authorization` header → anonymous; a header that does not verify →
  `401` (the app refreshes and retries instead of silently receiving coarse dates); suspended/deleting accounts → served as anonymous.
- Caching: anonymous `Cache-Control: public, max-age=30`, signed-in `private, no-store`, both `Vary: Authorization`.
- Clients: the web island (anonymous) renders "12–18 Okt 2026" ranges + a note that exact dates appear after login in the app; the
  mobile app is signed-in only (discovery screens sit behind the auth redirect and every call carries the bearer) → always DAY.
- **Residual (accepted):** a listing disappears when the trip leaves `ACTIVE` (the traveler departs or the automation job sets
  `TRAVELING` on the departure date, or it becomes `FULL`), so someone polling daily can still infer the departure day; a public trip
  detail with status `TRAVELING` tells that the traveler is abroad now (by design of the listing); first name + initial and the city
  pair remain visible.

### Public profile (`PublicProfile`) — discovery, recommendations, offers, request listings
`{id, displayName (first name + last initial), trustBadge {tier, label} (from the KYC level), trustScore (0–100), trustTier
{tier EXCELLENT|GOOD|FAIR|LOW, label, labelEn}, kycLevel, identityVerified, rating {average, count} (role shown), completedTransactions}`.
Tier bands mirror the design tokens: EXCELLENT 85–100 "Sangat tepercaya", GOOD 70–84 "Baik", FAIR 40–69 "Cukup", LOW 0–39 "Rendah".
The same score/tier appear in the transaction parties (`TransactionParty`, money API).

### 2.3 Offers → transaction start (§4 REQUEST_CREATED → MATCHED)
- Traveler offer (K3): own ACTIVE, not departed trip; same origin/destination country; trip arrives by `neededBy`; category not
  excluded; item not PROHIBITED; capacity (kg + items); traveler limit (below); fee within `pricing.traveler_fee_bounds`
  (`[minIdr, max(minIdr, itemValue × maxRateBps)]`; default = core `computeTravelerFee` from the trip fee spec). One PENDING
  offer per (request, trip). Offers expire after **48 h** (`OFFER_TTL_HOURS`, assumption) or with the request.
- Buyer invite: same checks, fee from the trip spec, traveler must be KYC ≥ 3.
- **Accept** (counterparty only; a traveler accepting needs K3) — ONE DB transaction:
  1. lock `requests` → `offers` → `trips` (same order everywhere; trip cancel/depart lock offers before the trip),
  2. offer PENDING & not expired, request OPEN, re-classify the item with today's rules (PROHIBITED → refused),
     re-check route/dates/capacity/limits, core guard `canTransition('REQUEST_CREATED','MATCHED', actor, ctx)`,
  3. insert `transactions` (status REQUEST_CREATED, `number` = core `formatTransactionNumber(now, CSPRNG 4 bytes)` →
     `JK-YYMMDD-XXXXXX` WIB date; inserted in a SAVEPOINT and retried on `transactions_number_key` collisions),
  4. reserve capacity (ACTIVE → FULL automation), 5. `transition_transaction(id, 1, 'MATCHED', BUYER|TRAVELER, …)`
     (writes `transaction_events`, `transaction.status_changed`, audit), 6. offer ACCEPTED, request MATCHED, other pending
     offers DECLINED (`OTHER_OFFER_ACCEPTED`), `offer.accepted` event.
  Concurrent accepts serialize on the request row lock: exactly one transaction is created, the others get 409
  (`REQUEST_ALREADY_MATCHED` / `OFFER_NOT_PENDING` / `OFFER_ALREADY_ACCEPTED`); `transactions_one_live_per_request` is the
  final DB safety net.
- The agreed traveler fee lives on the offer (`transactions.offer_id → offers.traveler_fee_idr`) for the money group's quote.

---

## 3. Matching model
- Candidates from the DB (≤ 200): for a request → ACTIVE, not departed trips on the same origin/destination country
  (traveler account ACTIVE, not the buyer); for a trip → OPEN, unexpired requests on the trip's route.
- Signals: trip (dates as WIB start-of-day, effective remaining kg, excluded categories, fee spec), request (item value at spot
  FX, unit weight = `est_weight_kg` → category default → 0.5 kg, `neededBy` = end of WIB day, budget, restriction class),
  user (`users.trust_score`, `user_rating_summaries` weighted/avg + count, COMPLETED transaction counts), traveler limit =
  core `computeTransactionLimit` with `limits.transaction` (product risk = category risk, country risk = origin risk,
  month usage = live transactions' `total_idr` this WIB month; KYC < 3 → 0).
- Ranking: core `rankTravelersForRequest` / `rankRequestsForTrip` with `matching.weights` and
  `pricing.traveler_fee_bounds`; hard filters exclude, soft features (date, rating, trust, price, capacity, history,
  routeExactness) are scored 0–100. Reasons are the core's Indonesian strings (e.g. "Tiba 7 hari sebelum batas",
  "Trust Score 86", "Kota tujuan cocok (Jakarta)").
- **RankingStrategy seam**: `useRankingStrategy(strategy)` in `modules/matching/service.ts` swaps the scorer (default core
  `linearRankingStrategy`); responses echo `strategy {name, version}`.

---

## 4. FX, customs and restricted items (usage for other groups)

```ts
import { getSpotRate, createFxLock, refreshFxRates } from '../fx/service';            // apps/api/src/modules/fx/service.ts
getSpotRate(db: Db, deps: FxDeps, base: string, quote: string): Promise<SpotRate>      // mid rate, no markup
createFxLock(db: Db, deps: FxDeps, input: { base: string; quote?: string /*IDR*/; userId?: string | null }): Promise<FxLockDto>
import { estimateCustomsForItem } from '../customs/service';                          // apps/api/src/modules/customs/service.ts
estimateCustomsForItem(db: Db, deps: FxDeps, input: EstimateCustomsInput): Promise<CustomsEstimate /* core */>
import { classifyRequestItem } from '../restricted/service';                          // apps/api/src/modules/restricted/service.ts
classifyRequestItem(db: Db, deps: FxDeps, input: ClassifyRequestItemInput): Promise<ItemClassification /* core result + ruleRef, valueUsd */>
import { reserveTripCapacity, releaseTripCapacity } from '../trips/service';
```
`FxDeps = Pick<AppDeps, 'config' | 'clock' | 'providers' | 'logger'>` (a full `AppDeps` works). `db` may be the caller's
transaction.

- **FX**: the provider snapshot is stored in `fx_rates` against a pivot (Frankfurter/ECB = EUR, static MOCK = USD); cross rates
  are derived with core `crossRate`/`crossRateChecked` (never stored). Staleness = `fx.lock.maxRateAgeMinutes` (default 4320 =
  72 h, so Friday's ECB rate still works on Monday). Missing/stale data triggers one on-demand refresh (backed off 60 s per
  provider), then `FX_RATE_UNAVAILABLE` / `FX_RATE_STALE`. `quoteRate = spot × (1 + markupBps)` with
  `pricing.fx_markup` (per currency). `createFxLock` uses core `createFxLockFromConfig`; coverage is checked against the
  *actual* provider (ECB set for Frankfurter). `fx_locks.source_rate_id` = the oldest leg used.
- **Frankfurter adapter** (`providers/fx/frankfurter.ts`, source `frankfurter-ecb`, mode LIVE): `GET {FX_FRANKFURTER_BASE_URL}/latest?base=EUR&symbols=…`
  (v1, ECB data), 5 s timeout, non-ECB symbols never requested, payload validated, `asOf = <ECB date>T14:00:00Z` (≈16:00 CET
  publication, never the fetch time; clamped to now). Enable with `FX_PROVIDER=frankfurter`; default stays `static` (MOCK).
- **Customs**: rules = `customs_rules_in_force(<WIB date>)` (0017, §16 inclusive dates, ACTIVE only) mapped to core
  `CustomsRule` (numerics/dates as strings). Core `estimateCustoms`, treatment default **NON_PERSONAL** (jastip, PMK 34/2025
  Pasal 24(3)); the public calculator adds a PERSONAL comparison (education only), `sourceReference`, `sourceUrl`,
  `lastVerifiedAt`, `ruleRef`, `isEstimate: true` and a KMK-rate disclaimer. Customs value uses the **spot** rate.
- **Restricted**: rules = `restricted_items_in_force(<WIB date>)`; core `classifyItem` (most severe wins; quantity/value limits
  escalate to PROHIBITED). `valueUsd` = unit price × qty converted at spot (skipped → `valueCheckSkipped` if FX is missing).
  `blocksCheckout` = PROHIBITED; `requiresAcknowledgement` = any other non-ALLOWED class.

---

## 5. Extraction & SSRF policy
`providers/extraction/heuristic.ts` (`EXTRACTION_PROVIDER=heuristic`, default; APP_ENV=test always gets the MOCK and tests
inject a heuristic instance with a fake `fetch`/`resolve`).
- URL: parse JSON-LD `Product`/`ProductGroup` (incl. `@graph`, arrays, `offers` Offer/AggregateOffer/`priceSpecification`),
  then OpenGraph/product meta (`og:title`, `og:image`, `product:price:amount/currency`, `og:site_name`, itemprop), `<title>`.
  Prices are normalised per currency minor units (`¥12,800` → 12800, `1.234,56` EUR → 1234.56) and converted with core
  `toMinor`. Merchant domain → country (amazon.co.jp/rakuten/uniqlo `/jp/`/*.co.jp → JP; oliveyoung.co.kr/musinsa/coupang/*.kr → KR;
  lazada.sg/shopee.sg/*.com.sg → SG; *.com.my → MY; *.com.au → AU; amazon.com/target/bestbuy/sephora.com → US), falling back
  to the TLD, then the currency. Category guessed by keywords (core `keywordMatches`). A page that cannot be fetched still
  returns the URL-derived merchant/country with `MANUAL_INPUT_REQUIRED`.
- Photo: returns `needsManualInput` (`AI_EXTRACTION_NOT_CONFIGURED`) — the provider interface is ready for an AI implementation.
- Search: a structured draft (name, category guess, merchant country hint).
- **SSRF guard** (`providers/extraction/ssrf.ts`), applied to the original URL and **every redirect target**:
  `http`/`https` only; no `user:pass@`; ports 80/443 only; hostnames `localhost`, `*.localhost`, `*.local`, `*.internal`,
  `*.home.arpa`, `*.lan`, metadata names and single-label hosts refused; IP literals (WHATWG-normalised, so decimal/hex/octal
  forms are caught) and **every DNS answer** must be public — blocked: 0/8, 10/8, 100.64/10 (CGNAT, incl. 100.100.100.200),
  127/8, 169.254/16 (metadata 169.254.169.254), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15,
  198.51.100/24, 203.0.113/24, 224/4+, `::`, `::1`, IPv4-mapped/compatible, NAT64 `64:ff9b::/96`, 6to4 `2002::/16` (embedded
  IPv4 checked), `fc00::/7` (incl. `fd00:ec2::254`), `fe80::/10`, `fec0::/10`, `ff00::/8`, `2001:db8::/32`.
  `redirect: 'manual'`, max **3** redirects, **5 s** overall timeout, body capped at **1 MB** (truncated + `CONTENT_TRUNCATED`),
  HTML content types only. Violations → 422 `URL_NOT_ALLOWED` with `details.reason`.
  *Known limitation*: the resolved IP is not pinned for the connection (DNS rebinding with TTL 0 can race the check); run the
  API behind an egress proxy with the same deny-list in production (Workers cannot reach private networks).

---

## 6. Jobs (`src/jobs/marketplace.ts`)
| Job | Every | What |
|---|---|---|
| `marketplace.fx_refresh` | 1 h | provider snapshot → `fx_rates` (idempotent per `as_of`) |
| `marketplace.expire_offers` | 5 min | PENDING offers past `expires_at` → EXPIRED (`offer.expired`) |
| `marketplace.expire_requests` | 15 min | DRAFT/OPEN past `expires_at` or `needed_by` → EXPIRED (+ pending offers EXPIRED, `request.expired`) |
| `marketplace.trip_automation` | 15 min | ACTIVE/FULL with departure date ≤ today → TRAVELING (pending offers expire); TRAVELING with arrival < today and all transactions terminal → COMPLETED; never-published DRAFT/VERIFICATION_PENDING/VERIFIED past departure → CANCELLED (`trip.cancelled`) — all SYSTEM via `transition_trip` |
| outbox `transaction.status_changed` | — | CANCELLED/REFUNDED → release capacity (FULL → ACTIVE); CANCELLED → request back to OPEN (`request.reopened`) or EXPIRED; REFUNDED/COMPLETED → request CLOSED. Idempotent. |

---

## 7. Events emitted (outbox, no PII)
| Event | Payload |
|---|---|
| `request.created` | requestId, buyerId, status, merchantCountry, destinationCountry, categoryCode, restrictionClass |
| `request.published` · `request.cancelled` · `request.expired` · `request.reopened` | requestId, buyerId (+ reason / transactionId) |
| `offer.created` | offerId, requestId, tripId, buyerId, travelerId, initiatedBy, travelerFeeIdr |
| `offer.accepted` | … + transactionId, transactionNumber, acceptedBy, travelerFeeIdr |
| `offer.declined` · `offer.withdrawn` · `offer.expired` | … + status, reason |
| `trip.cancelled` | tripId, travelerId, actorType, reason, openTransactionIds[] (money group applies the cancellation matrix as the TRAVELER — `cancellation/trip-cancelled.ts`) |
| (DB) `trip.status_changed`, `transaction.status_changed` | from `transition_trip` / `transition_transaction` |

---

## 8. Assumptions & open points
- `REQUEST_TTL_DAYS = 30` and `OFFER_TTL_HOURS = 48` are code constants (no business-config keys yet) — **assumption**.
- Publish requires K3 (endpoint catalogue "K3/K4"; §1 says K4 for verified trips, but K4 itself needs a verified trip).
- Customs/restricted valuation uses market spot (ECB) rates, not the weekly KMK rate Bea Cukai uses (disclaimed in responses).
- Traveler monthly usage counts `transactions.total_idr` (null until the money group quotes) — approximate until quotes exist.
- Data rules (customs/restricted seeds) are research-grade, not verified by a customs broker (see research doc).
