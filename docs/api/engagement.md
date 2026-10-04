# Engagement API — notifications, chat, ratings, disputes, referrals & credit, promotions, support, analytics, trust

Owner: engagement group. Code: `apps/api/src/modules/{notifications,chat,ratings,disputes,referrals,credits,promotions,support,analytics,trust}`,
outbox/jobs in `apps/api/src/jobs/engagement.ts`, providers in `apps/api/src/providers/{email,push}`, migration `db/migrations/0050_engagement.sql`.
Binding references: `docs/00-domain-model.md` (§2 level 5, §4, §6/§15.3, §12), `docs/dev/api-module-guide.md` §4/§6, `packages/core` engines.

---

## 1. Endpoints (`/v1`)

| Method & path | Auth | Notes |
|---|---|---|
| `GET /notifications` | bearer | inbox (`in_app` rows only), `?limit&cursor&unreadOnly=true` |
| `GET /notifications/unread-count` | bearer | badge |
| `POST /notifications/{id}/read` · `POST /notifications/read-all` | bearer | 404 for other users' ids |
| `GET/PUT /notifications/preferences` | bearer | groups × channels, `locked` combos → `422 PREFERENCE_LOCKED` |
| `GET /conversations` | bearer | one conversation per transaction, counterpart public name, last message preview, unread count |
| `GET /conversations/{id}` | bearer | one `Conversation` (same shape as the list item); participants only (others: 404) |
| `GET /transactions/{id}/conversation` | bearer | parties only (others: 404) → `{conversationId, transactionId, created, conversation}`; creates the conversation lazily (same rules as the MATCHED outbox handler, idempotent) when the transaction reached MATCHED; `409 CONVERSATION_NOT_AVAILABLE` before that |
| `GET /conversations/{id}/messages` | bearer | participants only (others: 404), newest first, µs-precise cursor; `attachments[] {fileId, mime, contentUrl}` (absolute) |
| `POST /conversations/{id}/messages` | bearer | `TEXT`, `IMAGE`, `PRODUCT`, `RECEIPT`; `SYSTEM`/`STATUS` → `403 MESSAGE_TYPE_SYSTEM_ONLY`; 30/min/user |
| `POST /conversations/{id}/read` | bearer | body optional `{messageId}` (default: latest) |
| `POST /transactions/{id}/ratings` | bearer | after `COMPLETED`, once per side, 14-day window |
| `GET /users/{id}/rating-summary` | public | as traveler / as buyer: count, average, weighted, Bayesian, effective count |
| `POST /transactions/{id}/disputes` | bearer | buyer or traveler, `PURCHASED…DELIVERED`, window after delivery |
| `GET /disputes/mine` · `GET /disputes/{id}` | bearer | both parties see evidence metadata + timeline + `allowedActions` |
| `POST /disputes/{id}/evidence` | bearer | files / chat messages / notes |
| `GET /disputes/{id}/evidence/{evidenceId}/file-url` | bearer | 5-minute presigned download, participants only (additional helper endpoint) |
| `POST /disputes/{id}/appeal` · `POST /disputes/{id}/withdraw` | bearer | see §6 |
| `GET /referrals/me` · `POST /referrals/apply` | bearer | see §7 |
| `GET /credits` | bearer | balance, available, expiring soon (30 d), history (cursor) |
| `POST /promotions/validate` | bearer | preview only — **no redemption** (money group reserves/redeems at checkout) |
| `GET /promotions/active` | public | no budget / usage / funding / targeting fields |
| `GET /support/faq` · `GET /support/faq/{slug}` | public | locale with Indonesian fallback, pg_trgm search |
| `GET /support/complaint-info` | public | consumer complaint channel (L12, Permendag 19/2026): published channels, SLA by priority, government escalation — §8.1; 120 req/min/IP, `Cache-Control: public, max-age=300` |
| `POST /support/tickets` · `GET /support/tickets` · `GET /support/tickets/{id}` · `POST /support/tickets/{id}/messages` | bearer | `TKT-…`, SLA by priority (config `support.sla`); category `COMPLAINT` = consumer complaint |
| `POST /analytics/events` | optional | ≤ 50 events, anonymous with `anonymousId`, allowlist, PII stripping, 120 req/min/IP |

All routes are `createRoute` (OpenAPI), errors use the standard `{error:{code,message,details,requestId}}` shape.

---

## 2. Notifications

### 2.1 Pipeline & idempotency
Outbox event → builder (`notifications/handlers.ts`) → intents `{userId, template, role, transactionId, refs, vars}` → dispatcher:

1. Load recipient (locale, e-mail destination, status; `DELETED`/anonymized users are skipped) and the transaction view from the DB (payloads carry ids only — never PII).
2. Resolve channels = template channels ∩ preferences, **plus** the template's `critical` channels (always on); marketing templates need `MARKETING` consent for PUSH/EMAIL.
3. One DB transaction: `notifications` row (`UNIQUE (user_id, outbox_event_id)`) + one `notification_deliveries` row per PUSH/EMAIL (`UNIQUE (notification_id, channel)`), `SKIPPED` with `skip_reason` when disabled.
4. Each `QUEUED`/`FAILED` delivery is claimed with `SELECT … FOR UPDATE SKIP LOCKED` and sent; the outcome (`SENT`, `SKIPPED` + reason, `FAILED` + error, `provider`, `provider_env TEST|LIVE`, `provider_ref`) is written in the same transaction.
5. Provider failures never fail the outbox event: the delivery goes `FAILED` and a job is queued on `engagement.notifications` (`retry_delivery`, dedupe `delivery:<id>`, max 5 attempts, exponential backoff). The retry re-renders from the stored notification (`data.vars`, fresh DB facts).

→ Idempotent per **(eventId, user, channel)**; duplicate outbox delivery creates no second row, push or e-mail. E-mails also send `Idempotency-Key: notif-<deliveryId>` to Resend.

`notifications.in_app = false` (migration 0050) keeps the row as the delivery anchor when the user switched IN_APP off; such rows are hidden from the inbox.
Skip reasons: `PREFERENCE_DISABLED`, `NO_MARKETING_CONSENT`, `NO_EMAIL`, `SUPPRESSED` (`email_suppressions`, HMAC `hashIdentifier('email', lower(trim(address)))`; scope `ALL` blocks everything, `MARKETING` only marketing), `NO_DEVICE`, `NO_VALID_DEVICE`.

**E-mail destination:** `users.transaction_email` if set, else the login e-mail when verified.
**Push:** all non-revoked devices of the user with a push token; tokens the provider reports invalid are set to `NULL` in `devices`. Android channel id per group (`transactions`, `payments`, `chat`, `promotions`, `account`).

### 2.2 Preferences (groups × channels)

| Group | PUSH | EMAIL | IN_APP | Locked (cannot disable) |
|---|---|---|---|---|
| TRANSACTION | on | on | on | IN_APP |
| PAYMENT | on | on | on | IN_APP, EMAIL (records of money movements) |
| CHAT | on | off | off | — |
| PROMOTION | on* | off* | on | — (*requires MARKETING consent) |
| ACCOUNT | on | on | on | IN_APP |

Critical templates override preferences on the listed channels: payment secured, refunds, final receipt, disputes (opened/updated/resolved/appealed), KYC rejected, data export, account deletion (EMAIL); **price change requested** (EMAIL + PUSH: 15-minute window with money at stake); account deletion (IN_APP too).

### 2.3 Event → notification matrix

| Event (producer) | Condition | Recipient(s) | Template | Group | Channels | Critical |
|---|---|---|---|---|---|---|
| `user.registered` (identity) | — | user | `account.welcome` | ACCOUNT | IN_APP, EMAIL | — |
| `user.phone_verified` | — | user | `account.phone_verified` | ACCOUNT | IN_APP, PUSH | — |
| `kyc.submitted` / `kyc.approved` | — | user | `kyc.submitted` / `kyc.approved` | ACCOUNT | all | — |
| `kyc.rejected` | — | user | `kyc.rejected` (reason ≤ 300 chars) | ACCOUNT | all | EMAIL |
| `kyc.level_changed` | to 5 or from 5 only | user | `kyc.trusted_traveler` (granted/revoked + facts) | ACCOUNT | all | — |
| `payout_account.verified` | — | traveler | `payout_account.verified` (bank + mask) | ACCOUNT | all | — |
| `trip.verified` | — | traveler | `trip.verified` | TRANSACTION | all | — |
| `request.created` | — | buyer | `request.created` | TRANSACTION | all | — |
| `offer.created` | initiatedBy TRAVELER → buyer; BUYER → traveler | counterparty | `offer.created` | TRANSACTION | IN_APP, PUSH | — |
| `offer.accepted` | only without `transactionId` (else MATCHED notifies) | initiator | `offer.accepted` | TRANSACTION | IN_APP, PUSH | — |
| `offer.declined` / `offer.expired` | — | initiator | same key | TRANSACTION | IN_APP, PUSH | — |
| `transaction.status_changed` → `MATCHED` | not from AWAITING_PAYMENT | buyer (traveler matched), traveler (request accepted, DO NOT PURCHASE) | `transaction.matched` | TRANSACTION | all | — |
| `payment.checkout_created` (money) | — | buyer | `payment.checkout_created` | PAYMENT | all | (EMAIL locked) |
| `payment.expired` / `payment.failed` | — | buyer | same key | PAYMENT | all | (EMAIL locked) |
| `transaction.status_changed` → `PAYMENT_SECURED` | from AWAITING_PAYMENT | buyer (breakdown), traveler (DO NOT PURCHASE, item+fee only) | `transaction.payment_secured` | PAYMENT | all | EMAIL |
| `price_confirmation.requested` | — | buyer | `price.change_requested` (original/actual/diff, deadline) | PAYMENT | all | EMAIL, PUSH |
| `price_confirmation.resolved` | buyer always; traveler unless APPROVED | both | `price.change_result` | PAYMENT | all | (EMAIL locked) |
| `price_confirmation.clarification_requested` (money) | — | traveler (buyer's question, contacts masked, ≤ 300 chars; answer deadline; DO NOT PURCHASE) | `price.clarification_requested` | PAYMENT | all | EMAIL, PUSH |
| `→ PURCHASE_APPROVED` | traveler always; buyer only from PAYMENT_SECURED | both | `transaction.purchase_approved` | TRANSACTION | all | — |
| `→ PURCHASED` | — | buyer | `transaction.purchased` | TRANSACTION | all | — |
| `purchase.proof_submitted` | not `flagged` | buyer | `purchase.receipt_available` | TRANSACTION | all | — |
| `→ TRAVELING` / `ARRIVED` / `CUSTOMS_PROCESS` / `READY_FOR_HANDOVER` / `OUT_FOR_DELIVERY` | — | buyer | `transaction.traveling` / `.arrived` / `.customs` / `.ready_for_handover` / `.out_for_delivery` (courier + tracking no.) | TRANSACTION | all | — |
| `delivery.pin_ready` | — | buyer | `delivery.pin_ready` (**no PIN**) | TRANSACTION | all | — |
| `→ DELIVERED` | — | buyer (confirm or dispute within `dispute.sla.openWindowHoursAfterDelivery`), traveler | `transaction.delivered` | TRANSACTION | all | — |
| `→ BUYER_CONFIRMED` | not from DISPUTED | traveler | `transaction.buyer_confirmed` | TRANSACTION | all | — |
| `→ COMPLETED` | — | both (rating prompt) | `transaction.completed` | TRANSACTION | all | — |
| `→ CANCELLED` | not `meta.cause = TRIP_CANCELLED` (dedicated event below) | both (traveler: DO NOT PURCHASE) | `transaction.cancelled` | TRANSACTION | all | — |
| `transaction.trip_cancelled` (money, `trip.cancelled` consumer) | — | buyer (refund amount or "no charge") + traveler (trust penalty) | `transaction.trip_cancelled` | TRANSACTION | all | EMAIL |
| `→ DISPUTED / REFUND_PENDING / REFUNDED / AWAITING_PAYMENT / PRICE_CHANGE_PENDING` | covered by the dedicated events | — | — | — | — | — |
| `refund.requested` / `refund.succeeded` / `refund.failed` (money) | — | buyer | `refund.*` (refund number; `refund.requested` says "to your bank account" for `PAYOUT_TO_BUYER`, "to the original payment method" otherwise) | PAYMENT | all | EMAIL |
| `refund.destination_required` (money) | refund needs a buyer bank account (VA/retail) — also after FINANCE rejects a destination | buyer (amount, "add a bank account", step-up OTP hint) | `refund.destination_required` | PAYMENT | all | EMAIL, PUSH |
| `refund.destination_set` (money / admin review) | — | buyer (bank + mask; "under review" when `PENDING_REVIEW`) — security confirmation | `refund.destination_updated` | PAYMENT | all | EMAIL, PUSH |
| `payout.scheduled` / `paid` / `failed` / `on_hold` (money) | — | traveler | `payout.*` (payout number, account mask) | PAYMENT | all | (EMAIL locked) |
| `receipt.final_available` (money) | — | buyer | `receipt.final` | PAYMENT | all | EMAIL |
| `dispute.opened` (engagement) | — | opener ("received") + counterparty (evidence deadline) | `dispute.opened` | TRANSACTION | all | EMAIL |
| `dispute.status_changed` (DB) | skip →RESOLVED/APPEALED and the SYSTEM OPEN→EVIDENCE_COLLECTION hop | both | `dispute.updated` | TRANSACTION | all | EMAIL |
| `dispute.resolved` (admin) | — | both (resolution, amount, appeal deadline) | `dispute.resolved` | TRANSACTION | all | EMAIL |
| `dispute.appealed` (engagement) | — | both | `dispute.appealed` | TRANSACTION | all | EMAIL |
| `dispute.evidence_added` (engagement) | — | the other party | `dispute.evidence_added` | TRANSACTION | IN_APP, PUSH | — |
| `chat.message_created` (engagement) | not HIDDEN | recipient (masked preview) | `chat.message` | CHAT | IN_APP (default off), PUSH | — |
| `referral.rewarded` (engagement) | — | recipient of the credit | `referral.rewarded` | ACCOUNT | all | — |
| `credit.cashback_granted` (engagement) | — | buyer | `credit.cashback_granted` | ACCOUNT | all | — |
| `support.ticket_updated` | skipped when `actorType = USER` | ticket owner | `support.ticket_updated` | ACCOUNT | all | — |
| `privacy.export_ready` / `account.deletion_scheduled` (identity) | — | user | same key | ACCOUNT | all | EMAIL (+IN_APP for deletion) |

### 2.4 E-mail lifecycle coverage (brief §18)
`notifications/lifecycle.ts` is the source of truth and `templates.test.ts` asserts every step maps, through the real outbox builders, to a template with an EMAIL channel that renders in `id` and `en`:
account registration · KYC submitted/approved/rejected · request created · traveler matched · request accepted · payment (checkout created) · payment secured · price adjustment requested · price clarification requested (traveler) · price approval result · trip cancelled by traveler (both) · refund destination required / updated · product purchased · receipt available · traveler departure · traveler arrival · customs · out for delivery · ready for handover · PIN/QR ready · item received · transaction completed · traveler payout (scheduled, paid) · refund (requested, succeeded, failed) · dispute opened/updated/resolved · final receipt.

### 2.5 Templates
56 templates in `notifications/templates/catalog.ts` (key = `notifications.event_type`), Indonesian default + English by `users.locale`, "kamu" register (BRAND-GUIDE §4). Each renders in-app/push `{title, body}` and an e-mail `{subject, html, text}`:

- **Content:** greeting (first name), paragraphs, optional highlight (success = emerald-700 banner "Pembayaran aman / PAYMENT SECURED"; danger = "JANGAN BELI DULU / DO NOT PURCHASE"), summary table (transaction number, product, traveler **public name** "Dimas P." / buyer public name for travelers, status), **price breakdown table** from the active/accepted quote's `quote_lines` in §10 order with "(estimasi)" markers and the customs note (travelers only see item price + traveler fee), CTA.
- **Links:** CTA → `${WEB_BASE_URL}/app/transactions/{id}` (web fallback; a universal link opens the app), secondary `jastipkita://transactions/{id}`, receipt `${WEB_BASE_URL}/app/transactions/{id}/receipt`; disputes/chat/wallet/verification/support have their own paths.
- **Brand & a11y:** logo `${WEB_BASE_URL}/brand/logo-email.png` (alt "JastipKita"), Poppins with system fallbacks, table layout with inline CSS, `role="presentation"` layout tables, real `<th scope="col">` in the price table, `lang` attribute, token colours with AA contrast (white on emerald-700, ink on orange-50, cobalt-500 CTA), `color-scheme: light dark` + `prefers-color-scheme` overrides (navy-950 background, cobalt-400 button with navy label), tabular figures for money, "Rp 1.234.567".
- **Footer:** "E-mail ini dikirim otomatis …", Help Center, notification settings, Terms, Privacy, tagline.
- **Escaping:** every dynamic value is HTML-escaped (test covers `<script>` in product names).

**Security decision — delivery PIN/QR:** the PIN is never placed in an outbox payload, notification row, push or e-mail. `delivery.pin_ready` only says the PIN is ready and must be opened in the app ("PIN tidak pernah dikirim lewat e-mail, SMS, atau notifikasi"), plus "Jangan berikan PIN sebelum barang sesuai". Reason: e-mail/push are not end-to-end protected, are mirrored to other devices and lock screens, and the PIN is the buyer's proof of receipt that releases funds.

### 2.6 Providers
| Provider | Env | Behaviour |
|---|---|---|
| `log` (MOCK) | `EMAIL_PROVIDER=log`, `PUSH_PROVIDER=log` | dev/test; deliveries stored with `provider_env = TEST` |
| Resend (`providers/email/resend.ts`) | `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO?` | `POST https://api.resend.com/emails`, `Idempotency-Key`, tags sanitised to `[A-Za-z0-9_-]`, 429/5xx → retryable error |
| FCM HTTP v1 (`providers/push/fcm.ts`) | `PUSH_PROVIDER=fcm`, `FCM_SERVICE_ACCOUNT_JSON` (raw JSON or base64), `FCM_PROJECT_ID?` | service-account JWT (RS256, jose) → OAuth token cached until 60 s before expiry; one `messages:send` per token; `UNREGISTERED` / `INVALID_ARGUMENT` / 404 → `invalidTokens`; 401 refreshes the token once; all-transient failure throws (retry) |

Both adapters use `fetch` only (Node + Workers) and are unit-tested with an injected fake fetch.

---

## 3. Chat

- **Lifecycle:** the outbox handler creates the conversation when a transaction reaches `MATCHED` (participants buyer & traveler; a pre-match conversation for the same request+traveler is adopted). Every later status change posts a `STATUS` message in Indonesian (`CHAT_STATUS_TEXT`), idempotent per source outbox event (`messages_source_event_uq`). The handler also ensures the conversation exists for later events (robust to a failed MATCHED handler).
- **Access:** participants only; everyone else gets `404 CONVERSATION_NOT_FOUND` (no existence leak). Admin read/moderation belongs to the admin group (`chat.moderate`).
- **Types:** `TEXT` (1–4000 chars), `IMAGE` (1–5 files owned by the sender, purpose `CHAT`, scan `CLEAN`, `image/*`, optional caption), `PRODUCT` (`requestId` must be the conversation's request), `RECEIPT` (traveler only; `purchaseProofId` of this transaction). `SYSTEM`/`STATUS` are platform-only (403).
- **Ordering:** messages use `clock_timestamp()` and µs-precise cursors, so pagination never skips rows created in the same millisecond.
- **Events:** `chat.message_created {conversationId, messageId, senderId, recipientId, type, flagged}` → push to the recipient.

### 3.1 Moderation policy (`chat/moderation.ts`)
| Detector | Reason code | Masked |
|---|---|---|
| e-mail addresses | `CONTACT_EMAIL` | yes |
| wa.me / whatsapp / t.me / line.me / instagram / link shorteners | `CONTACT_LINK` | yes |
| Indonesian mobile (+62/62/08…) and +CC numbers | `CONTACT_PHONE` | yes |
| 8–18 digit runs (not money: "Rp 15.000.000", "…rb", "…juta" are ignored) | `BANK_ACCOUNT` | yes |
| phrases: "transfer langsung", "bayar di luar", "di luar aplikasi", "norek", "tanpa safepay", … ; bank keyword + account number | `OFF_PLATFORM_PAYMENT` | no (nothing to hide) |
| "lewat wa", "nomor wa", "id line", … | `CONTACT_LINK` | no |

Decision: the message **is delivered** (conversation keeps flowing) with `moderation_status = FLAGGED`, `moderation_reason` = comma-separated codes, the sensitive spans replaced by `[disembunyikan]` in `meta.maskedBody`. **Both participants** (and the push preview) see the masked text — UI spec §5.17 "Tidak ada nomor rekening di chat (di-mask)" — and the API returns `moderation {status, reasons}` so the app shows the inline warning. The original text is kept for moderators and dispute evidence (legal hold via `anonymize_user`). A `SYSTEM` safety tip is posted after each flagged message ("Demi keamanan, jangan bayar atau bertukar kontak di luar JastipKita …"). `HIDDEN` (set by admins) is returned as "Pesan disembunyikan oleh moderator." without attachments.

---

## 4. Ratings
- Only after `COMPLETED`, within **14 days** of `completed_at`, **once per side** (`UNIQUE (transaction_id, rater_id)`), direction from the role (`BUYER_TO_TRAVELER` / `TRAVELER_TO_BUYER`), validated by core `validateRating`.
- Dimensions: `overall` (required), `communication`, and for buyer→traveler `accuracy`, `timeliness`; for traveler→buyer `timeliness` means responsiveness at handover (core `RESPONSIVENESS`); `accuracy` from a traveler → `422 DIMENSION_NOT_APPLICABLE`.
- Comment ≤ 1000 chars; light filter masks common ID/EN profanity (`g*****`) and contact details (`PROFANITY_MASKED`, `CONTACT_MASKED` in `moderation_reason`); the rating stays published.
- Anti-abuse (core `aggregateRatings`): rater linked to the ratee (shared device / payout account / identity) → weight 0 (`LINKED_ACCOUNT`); raters confirmed as fraud by RISK → 0.25; outliers (≥ 2 from the median) on transactions < Rp250.000 → 0.25. Weights are re-computed for all ratings of the ratee on every new rating; `user_rating_summaries.as_*_bayesian` (prior 4.0 × 5 over the weighted ratings) and `as_*_effective` (Σ weights) are maintained next to the trigger-maintained count/avg/weighted.
- Emits `rating.created` → Trust Score recompute of the ratee.

---

## 5. Disputes (user side)
- **Open:** buyer or traveler of the transaction; statuses `PURCHASED…DELIVERED` (§4), after delivery only within `dispute.sla.openWindowHoursAfterDelivery` (core `canOpenDispute`, FSM guard `DISPUTE_WINDOW`); one active dispute per transaction. One DB transaction: `disputes` (`DSP-…`, `evidence_due_at` / `sla_due_at` from core `computeSla`) → `transition_transaction(→ DISPUTED)` → `transition_dispute(OPEN → EVIDENCE_COLLECTION, SYSTEM)` (case accepted, evidence window starts) → `dispute.opened` → audit `dispute.opened`.
- **Evidence:** types `PHOTO | VIDEO | RECEIPT | CHAT | TRACKING | DELIVERY_PROOF | OTHER`; allowed in `OPEN`, `EVIDENCE_COLLECTION` (until `evidence_due_at`) and `APPEALED`. A party may cite its own files (purposes EVIDENCE/CHAT/RECEIPT/PRODUCT_PHOTO/DELIVERY_PROOF, not infected) or any file attached to this transaction's purchase proof, delivery, customs declaration or price confirmation, and any message of the transaction's chat. Both parties see evidence metadata; file contents via `GET /disputes/{id}/evidence/{evidenceId}/file-url`. Emits `dispute.evidence_added`.
- **Appeal:** either party, once (`appealed_at IS NULL`), within `dispute.sla.appealWindowHours` of `resolved_at`, `transition_dispute(RESOLVED → APPEALED)`; the review SLA restarts (`sla_due_at = now + reviewHours`, breach flag cleared). Emits `dispute.appealed`.
- **Withdraw:** opener only, `OPEN`/`EVIDENCE_COLLECTION` → `CLOSED`. §4 has no `DISPUTED → <previous status>` edge: when a **buyer** withdraws a dispute opened on a `DELIVERED` item, the transaction moves `DISPUTED → BUYER_CONFIRMED` (SYSTEM, no-refund settlement, guard `disputeResolution: OTHER`) and resumes payout; any other withdrawal leaves the transaction `DISPUTED` and returns `transactionFollowUp: ADMIN_REQUIRED` (spec gap reported).
- **SLA job** (`engagement.dispute_sla`, 5 min): OPEN → EVIDENCE_COLLECTION (fills missing deadlines); EVIDENCE_COLLECTION past `evidence_due_at` → UNDER_REVIEW (guard `EVIDENCE_DONE`); core `slaBreach` past `sla_due_at` → `disputes.sla_breach` + `sla_breached_at` (0050) + `dispute.sla_breached` event, once; RESOLVED past the appeal window → CLOSED. Resolution itself is ADMIN (admin group).

---

## 6. Referrals & JastipKita Credit

### 6.1 Rules (all amounts from `referral.buyer` / `referral.traveler`)
| Rule | Buyer program | Traveler program |
|---|---|---|
| Apply | new users only: ≤ 7 days after signup **and** before their first `PAYMENT_SECURED`; one referral per referee; no self-referral (`422 SELF_REFERRAL`); program = `TRAVELER` when the account is in traveler mode (or explicit) | same |
| Qualifies when | referee's **first** transaction is `COMPLETED` with value before credits ≥ `minFirstTransactionIdr` (Rp500.000) | referred traveler completed `requiredCompletedTransactions` (2) |
| Reward | referrer & referee `referrerCreditIdr` / `refereeCreditIdr` (Rp25.000 each; experiment variant via core `assignVariant` when `experiment.enabled`) | referrer Rp50.000 |
| Monthly cap | referrer Rp250.000 / calendar month (WIB) — partial cap, never the referee | Rp250.000 |
| Credit | `credit_entries` `REFERRAL_REWARD`, expiry `creditExpiryDays` (90 d), **not withdrawable**, idempotency `referral:<id>:referrer|referee` | same |
| Expiry of the invitation | ASSUMPTION: PENDING referrals expire after 180 days (`engagement.referral_expiry`) | same |

### 6.2 Fraud gate (core `assessRisk('REFERRAL')`)
Signals (peppered hashes only): shared device (`user_devices`), shared IP (`refresh_tokens.ip_hash`), shared payout bank account (`payout_accounts.account_number_hash`), shared identity (`identity_records.id_number_hash`, unique by schema), referrer referrals in 24 h, accounts on the referee's device / created from it in 24 h.
- **Apply time:** `BLOCK` (self-referral / identity reuse) → `422 REFERRAL_NOT_ELIGIBLE` + USER risk assessment; weaker signals are only noted in `fraud_reasons` (stage APPLY).
- **Reward time (COMPLETED):** assessment recorded for the referral; `BLOCK`/`HOLD` (e.g. same bank account) → `REJECTED` (no credit); `REVIEW` (e.g. shared device + IP) → `QUALIFIED` with computed amounts held for RISK (risk review opened; release by the admin group); `ALLOW` → `REWARDED` + credits + `referral.rewarded` per recipient + audit `referral.rewarded`.

### 6.3 Credit ledger
Balance = Σ `credit_entries.amount_idr` (append-only, non-negative trigger). Lots are consumed **earliest expiry first** (`credits/ledger.ts`); the hourly `engagement.credit_expiry` job writes one `EXPIRY` entry per expired lot remainder (idempotency `credit-expiry:<lotId>`, advisory lock shared with the non-negative trigger, audit `credit.expired`). `GET /credits` returns balance, available (excluding lots past expiry not yet written off), lots expiring within 30 days, and labelled history.

### 6.4 Unit-economics guardrail (`engagement.referral_guardrail`, daily)
| Metric | Definition |
|---|---|
| CAC proxy | Σ `REFERRAL_REWARD` credit granted in the last 90 days ÷ referrals `REWARDED` in the same window (credit cost per acquired transacting user, both sides) |
| LTV proxy | last 180 days: Σ (platform revenue − promo cost) of COMPLETED transactions (`v_completed_transaction_lines`) ÷ distinct buyers who completed one (contribution per active buyer — a conservative floor) |
| Fraud rate | referrals evaluated at reward time in 90 days whose latest REFERRAL assessment ≠ ALLOW ÷ all evaluated |
| Verdict | core `unitEconomicsGuardrail` with `referral.buyer.guardrails` (`pauseIfCacAboveLtvRatio` 0.33, `pauseIfFraudRateAbove` 5 %) |

When the verdict is "do not increase / pause": warning log + one `security_events` row `REFERRAL_GUARDRAIL_TRIPPED` (MEDIUM, metrics in `meta`) per WIB day. Amounts are never changed automatically (config is maker-checker).

---

## 7. Promotions (user side)
- `POST /promotions/validate {transactionId, code}`: caller must be the buyer, transaction `MATCHED` or `AWAITING_PAYMENT`, quote required. Cart = ITEM_PRICE / TRAVELER_FEE / PLATFORM_FEE of the quote in effect, origin = trip origin, category = request category; user = first transaction? + per-promo usage. Core `evaluatePromotions` (same stacking as pricing: one discount-class + one cashback). Returns `valid`, `discountIdr`, `cashbackIdr`, `freePlatformFee`, `reason` code + Indonesian message, and `otherApplied` automatic promos. **No redemption is written.**
- `GET /promotions/active`: `ACTIVE` within dates, not `TRAVELER`-targeted, no `userSegments`, `conditions.public !== false`; exposes code, name, description, type, benefit (kind/rate/amount/cap), public conditions, dates.
- **JSON contract** for `promotions.conditions` / `benefit` (admin group writes them): `conditions {minItemValueIdr?, originCountries?, categories?, firstTransactionOnly?, travelerIds?, userSegments?, priority?, public?, cashbackExpiryDays?}`, `benefit {kind: PERCENT (rateBps, capIdr?, base?) | FIXED (amountIdr) | FREE_PLATFORM_FEE | CASHBACK_CREDIT (rateBps | amountIdr, capIdr?, base?)}`; invalid benefits are ignored. Mapper: `promotions/mapper.ts`.
- **Cashback:** on `COMPLETED`, each `promotion_redemptions` row (`RESERVED`/`APPLIED`) of a cashback promotion becomes a `PROMO_CASHBACK` credit of `amount_idr` (expiry `conditions.cashbackExpiryDays`, default 90 d; idempotency `cashback:<redemptionId>`) + `credit.cashback_granted` + audit.

---

## 8. Support & FAQ
- FAQ: `PUBLISHED` only; `?locale=en` falls back to the Indonesian article per slug; `?category=`; `?q=` uses pg_trgm (`word_similarity` on question 60 % + full text 40 % + substring bonus; matches substring, trigram ≥ 0.35 or exact tag) — typo tolerant ("safepey" → SafePay).
- Tickets: categories `TRANSACTION | DISPUTE | REFUND | ACCOUNT | PAYMENT | CUSTOMS | OTHER | COMPLAINT` (COMPLAINT added by migration 0130), optional link to **my** transaction or dispute (dispute implies its transaction), attachments = my files. Priority: optional body `priority` `LOW | NORMAL | HIGH`; default `HIGH` for COMPLAINT / DISPUTE / REFUND / PAYMENT, else `NORMAL` (`URGENT` is agent-only → `400`; agents re-prioritise via `PATCH /v1/admin/support/tickets/{id}`, which recomputes the SLA while there is no first response). First-response SLA = `created_at + support.sla.hoursByPriority[priority]` (`sla_due_at`; versioned config, maker-checker — defaults URGENT 4 h, HIGH 12 h, NORMAL 24 h, LOW 72 h, flagged **ASUMSI** until reviewed after soft launch). User replies reopen `PENDING_USER` / `RESOLVED` → `OPEN`; `CLOSED` → `422 TICKET_CLOSED`. Internal agent notes are never returned. Emits `support.ticket_updated {ticketId, userId, status, actorType: USER, action, priority, category}`; admin-produced updates (no `actorType` or `AGENT`) notify the user.

### 8.1 Consumer complaint channel — `GET /v1/support/complaint-info` (launch checklist L12)
Public, no auth, no personal data. Backs the web pages `/pengaduan/` · `/en/complaints/` and the app screen *Bantuan → Pengaduan konsumen*
(which files `POST /support/tickets` with `category: COMPLAINT`). Response `ComplaintInfo`:

| Field | Source | Notes |
|---|---|---|
| `channels.inApp` | constant | `{ticketCategory: COMPLAINT, endpoint: /v1/support/tickets}` |
| `channels.whatsapp` | env `SUPPORT_WHATSAPP` | `{number (digits), url: https://wa.me/…}` or **null** while not announced ("segera diumumkan") |
| `channels.email` | env `SUPPORT_EMAIL` | string or **null** |
| `channels.webUrl` | env `WEB_BASE_URL` | `${WEB_BASE_URL}/pengaduan/` |
| `sla` | config `support.sla` | `{basis: FIRST_RESPONSE, complaintPriority: HIGH, complaintFirstResponseHours, hoursByPriority {URGENT, HIGH, NORMAL, LOW}, configKey, isAssumption: true}` — a new ACTIVE config version changes it without a deploy |
| `escalation` | `modules/support/complaint-info.ts` | government channel (below), `verification {status, accessedAt, sources[]}`, `outOfCourt` (BPSK) |
| `disputeFlow` | constant | paid transactions go through `POST /v1/transactions/{id}/disputes` (funds stay in SafePay; payouts wait while a dispute is open) |
| `legalBasis` | constant | UU 8/1999, PP 80/2019, Permendag 19/2026 |

`SUPPORT_WHATSAPP` / `SUPPORT_EMAIL` are optional public values (validated at boot: phone digits / e-mail address; empty = unset),
overridable per environment from GitHub Variables (`scripts/ci/worker-config.ts`); keep them equal to the web's `PUBLIC_SUPPORT_*`.

**Government escalation channel** — verified **2026-10-04** (`status: VERIFIED`):
Direktorat Jenderal Perlindungan Konsumen dan Tertib Niaga (**Ditjen PKTN**), Direktorat Pemberdayaan Konsumen, Kementerian Perdagangan RI —
WhatsApp **0853-1111-1010**, e-mail **pengaduan.konsumen@kemendag.go.id**, telepon **(021) 3441839**, web
`https://ditjenpktn.kemendag.go.id/konsultasi-online`. Sources (accessed 2026-10-04):
[ditjenpktn.kemendag.go.id/konsultasi-online](https://ditjenpktn.kemendag.go.id/konsultasi-online) (official page: WhatsApp, e-mail, phone),
[ANTARA 29-04-2025](https://www.antaranews.com/berita/4801037/kemendag-catat-1657-layanan-konsumen-sepanjang-januari-maret-2025)
(WhatsApp, e-mail, phone, SIMPKTN), [Katadata 21-05-2026](https://katadata.co.id/amp/digital/e-commerce/6a0e5f3d6976b/kemendag-panggil-shopee-soal-aduan-barang-tak-sesuai-dan-shopee-paylater)
(WhatsApp + "identitas, kronologi, bukti pendukung"). Not published by us: the SIMPKTN portal (`simpktn.kemendag.go.id`) — on 2026-10-04 a
search-engine listing showed a gambling-spam title for that domain although the page itself served the official portal → **perlu verifikasi**
before linking it. Ministry contact data changes without notice: re-verify before launch and update `ESCALATION_ACCESSED_AT`.
Permendag 19/2026 requires a complaint service (Pasal 10–14 per `docs/research/05-legal-regulatory.md`); the exact response deadline it
imposes, if any, was **not** verified from the regulation text — our SLA is an internal target, not a statutory figure.

---

## 9. Analytics
`POST /analytics/events`: ≤ 50 events, `platform` IOS/ANDROID/WEB, signed-in (Bearer) or `anonymousId`; events outside the allowlist or with `occurredAt` older than 30 days / > 10 min in the future are rejected per index (202 partial acceptance); optional client `eventId` makes retries idempotent (`analytics_events.dedupe_key`, 0050). Properties: ≤ 20 flat keys (`^[a-zA-Z][a-zA-Z0-9_]{0,39}$`), strings ≤ 200 chars, arrays ≤ 10 short strings, ≤ 2 KB; PII-looking keys (email, phone, name, address, password, token, passport, account/card number, lat/lng, ip, pin, otp, nik, …) are dropped and e-mail/phone/≥ 8-digit values redacted to `[REDACTED]`. Rate limit 120 req/min per IP.

### 9.1 Event dictionary
| Event | Source | Meaning / key properties |
|---|---|---|
| `app_install`, `app_open` | client | install / cold start |
| `signup_started` | client | auth screen opened |
| `signup_completed` | **server** (`user.registered`) + client | account created; `method` |
| `kyc_started` | client | KYC stepper opened |
| `kyc_submitted` | **server** (`kyc.submitted`) + client | `targetLevel` |
| `request_started` | client | request form opened |
| `request_created` | **server** (`request.created`) + client | `requestId` |
| `recommendations_viewed` | client | matching list viewed |
| `offer_sent` | **server** (`offer.created`) | initiator; `offerId`, `initiatedBy` |
| `offer_accepted` | **server** (`offer.accepted`) | accepting side; `offerId` |
| `checkout_started` | client | checkout screen |
| `payment_initiated` | **server** (`payment.checkout_created`) | `transactionId`, `amountIdr` |
| `payment_secured` | **server** (→ PAYMENT_SECURED from AWAITING_PAYMENT) | buyer; `transactionId` |
| `purchase_completed` | **server** (→ PURCHASED) | traveler |
| `delivery_confirmed` | **server** (DELIVERED → BUYER_CONFIRMED) | buyer; `auto` (auto-confirm) |
| `transaction_completed` | **server** (→ COMPLETED) | buyer |
| `repeat_transaction` | **server** (→ COMPLETED, buyer's ≥ 2nd) | `completedCount` |
| `referral_shared` | client | `channel` |
| `referral_applied` | **server** (`POST /referrals/apply`) | `program` |
| `search` | client | `query` (redacted) |
| `screen_view` | client | `screen` |

Server events use `platform = SERVER`, `properties.source = server` and dedupe key `srv:<outboxEventId>:<event>:<userId>`, so funnel metrics never depend on clients.

---

## 10. Trust Score
- **Engine:** core `computeTrustScore(signals, trust.weights, now)`; `trust_scores.components = {engine, computedScore, items[], override?}`, `version` = `trust.weights` config version; the DB trigger appends `trust_score_history` (only when score/components change) and syncs `users.trust_score`. Audit `trust.recomputed` when the score changes.
- **Signals (DB):** KYC level; COMPLETED transactions (count, Σ `total_idr`); account age; cancellations initiated by the user (excluding a buyer rejecting a price change — §5 no fault — and dispute outcomes) ÷ transactions taken part in; disputes lost (traveler side of refund resolutions; buyer-opened disputes resolved NO_REFUND); on-time delivery (traveler: delivered on/before `needed_by`, else trip arrival + 7 d; null for buyers → excluded); verified trips (null for non-travelers); fraud (confirmed fraud reviews = CRITICAL, USER HOLD/BLOCK/REVIEW assessments in 180 d); failed payments as buyer (chargebacks = 0 until a feed exists — ASSUMPTION); abuse-weighted rating average and effective count.
- **Recompute triggers (outbox):** `transaction.status_changed` → DELIVERED, COMPLETED, CANCELLED, REFUND_PENDING, REFUNDED (both parties); `dispute.status_changed` → RESOLVED/CLOSED and `dispute.resolved` (both parties); `kyc.approved`, `kyc.level_changed`; `rating.created` (ratee); `trip.verified`; `payment.failed`; `risk.review_resolved` (contract for admin: `{reviewId, subjectType, subjectId, status, userId?}`). Hourly `engagement.trust_sweep`: expired overrides, fraud reviews resolved after the last recompute.
- **Overrides:** an `APPLIED` override (admin maker-checker, `apply_trust_score_override`) with `valid_until` null or in the future keeps its score; the computed breakdown is still refreshed. After `valid_until` the computed score takes over and `override_id` is cleared.
- **KYC level 5 (TRUSTED_TRAVELER, §2):** level ≥ 4 and ≥ 10 COMPLETED as traveler and trust ≥ 80 and dispute rate < 3 % (disputes on the traveler's transactions, excluding withdrawn ones ÷ traveler transactions delivered or completed). 4 → 5 when met, 5 → 4 when no longer met; `users.kyc_level` updated, `kyc.level_changed {userId, from, to, reason: TRUSTED_TRAVELER_GRANTED|REVOKED, source: trust_score_job, facts}`, audit `kyc.level_changed`, owner notified (`kyc.trusted_traveler`, no public announcement).

---

## 11. Events
**Consumed:** `transaction.status_changed`, `dispute.status_changed`, `user.registered`, `user.phone_verified`, `kyc.submitted`, `kyc.approved`, `kyc.rejected`, `kyc.level_changed`, `payout_account.verified`, `trip.verified`, `request.created`, `offer.created|accepted|declined|expired`, `payment.checkout_created|expired|failed`, `price_confirmation.requested|resolved|clarification_requested`, `transaction.trip_cancelled`, `purchase.proof_submitted`, `delivery.pin_ready`, `refund.requested|succeeded|failed|destination_required|destination_set`, `payout.scheduled|paid|failed|on_hold`, `receipt.final_available`, `dispute.opened|evidence_added|resolved|appealed`, `chat.message_created`, `referral.rewarded`, `support.ticket_updated`, `privacy.export_ready`, `account.deletion_scheduled`, `config.activated` (config cache), `rating.created`, `credit.cashback_granted`, `risk.review_resolved`.
Not consumed on purpose: `payment.secured` (the PAYMENT_SECURED status change notifies), `trip.status_changed`, `user.anonymized` (`anonymize_user()` already removes notifications/devices).

**Emitted:** `dispute.opened`, `dispute.evidence_added`, `dispute.appealed`, `dispute.sla_breached` (new), `chat.message_created`, `referral.rewarded` (+ `role`, `program`, `expiresAt`), `support.ticket_updated` (+ `actorType`, `action`), `kyc.level_changed` (level 5 only), `rating.created` (new), `credit.cashback_granted` (new). DB functions emit `dispute.status_changed` / `transaction.status_changed` for our transitions.

## 12. Scheduled jobs & queues
| Name | Every | Purpose |
|---|---|---|
| `engagement.dispute_sla` | 5 min | §5 SLA moves, breach flags, auto-close |
| `engagement.credit_expiry` | 1 h | EXPIRY entries per expired lot |
| `engagement.referral_expiry` | 1 h | PENDING → EXPIRED after 180 days |
| `engagement.trust_sweep` | 1 h | expired overrides, resolved fraud reviews |
| `engagement.referral_guardrail` | 24 h | unit-economics guardrail |
| queue `engagement.notifications` | — | `retry_delivery` (5 attempts, backoff) |

---

*Data & scope limitations:* (1) chargebacks are counted as 0 in the Trust Score until a chargeback feed exists; (2) "shared identity" can only match through `identity_records.id_number_hash`, which is unique per account by schema, so it is effectively always false; (3) referral invitation TTL (180 days) and ticket SLA hours are assumptions, not config keys; (4) LTV/CAC are proxies from quote lines and credit cost, not ledger-grade finance figures; (5) e-mail suppression matching assumes identity hashes e-mails as `hashIdentifier('email', lower(trim(address)))`; (6) Resend/FCM adapters are verified with fake transports only — live delivery depends on credentials, sender domain (SPF/DKIM) and FCM project setup; (7) `DISPUTED → previous status` is missing from §4, so pre-delivery dispute withdrawals need ops follow-up.
