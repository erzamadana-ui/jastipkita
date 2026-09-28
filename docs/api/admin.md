# Admin API — back office, finance controls, DB & Infra Center

Owner: admin group. Code: `apps/api/src/modules/admin/**` (one folder per area: `routes.ts` + `service.ts` + tests),
`apps/api/src/modules/admin.ts` (registration), `apps/api/src/modules/infra/**` (DB & Infra Center),
`apps/api/src/providers/db-admin/**` (generic + Neon adapter), `apps/api/src/jobs/admin.ts`, migration
`db/migrations/0060_admin.sql`, scripts `apps/api/scripts/{create-admin,gen-migration-manifest}.ts`.
Binding references: `docs/00-domain-model.md` (§2 KYC levels, §3/§4 FSMs, §15.4 KYC FSM, §16 versioned rules),
`docs/04-payments-ledger.md`, `docs/09-security.md`, `docs/06-observability.md` (health + alert thresholds).

Every admin route is `createRoute` (OpenAPI tag `Admin · …`) and runs
`requireAuth → requireAdmin → requirePermission(<least privilege>)` (+ `requireRecentMfa` for sensitive writes,
+ `requireIdempotency` for financial writes). `requireAdmin` = an admin role **and an MFA-verified session**
(TOTP/recovery code verified in this session within `ADMIN_SESSION_MFA_MAX_AGE_SEC`, default 12 h, recorded server-side in
`refresh_tokens.mfa_verified_at` and kept across refresh) — security review SEC-01. Only `POST /v1/auth/mfa/totp/enroll` uses the
role-only guard `requireAdminRole`. Every write is audited through `services/audit.ts` / `jk_audit` into the
hash-chained `audit_logs` with `before`/`after` (never raw PII) and `meta.actorRoles` + `meta.requestId`. The DB session
of every admin write carries `jk.actor_type='ADMIN'`, `jk.actor_id`, `jk.request_id`, so DB-side FSM events and
guard triggers see the real admin.

Errors use the standard `{error:{code,message,details,requestId}}` shape. Admin-specific codes:
`ADMIN_ONLY` (403, no admin role), `PERMISSION_DENIED` (403, `details.missing`), `MFA_REQUIRED` (403: `details.scope = SESSION` → the
session never passed MFA or it is older than 12 h; no scope → step-up older than 15 min), `IDEMPOTENCY_KEY_REQUIRED` (400), `MAKER_CHECKER_VIOLATION` (403), `ROLE_REQUIRED` (403, e.g. FINANCE_SUPER_ADMIN).

---

## 1. Endpoint catalogue (151 operations)

Legend: **M** = fresh MFA (≤ 15 min) required · **I** = `Idempotency-Key` header required (declared as the `idempotency-key` header parameter in
OpenAPI for every such operation) · **MC** = maker-checker. Every operation has a stable `operationId` (see `docs/api/CHANGELOG.md`).

### Dashboard & analytics — `analytics.read`
| Method & path | Notes |
|---|---|
| `GET /v1/admin/dashboard/kpis?from&to` | 27 KPIs, each `{key,label,value,unit,definition,sampleSize,dataQuality}`; breakdowns (transactions by status, payments by channel, fraud reviews by subject, support backlog by priority); system-health summary. WIB inclusive dates, default last 30 days, max 366 |
| `GET /v1/admin/dashboard/timeseries?metric&interval=day\|week&from&to` | `gmv, net_revenue, transactions_created, transactions_completed, payments_secured_idr, signups, disputes_opened, refunds_succeeded_idr`; zero-filled buckets |
| `GET /v1/admin/dashboard/funnel?from&to` | INSTALL → SIGNUP → … → MATCH → PAYMENT → COMPLETED → REPEAT with definitions |

`dataQuality` is non-null when the sample is empty or `< 30` ("Sampel kecil …") — the UI must show it next to the number.

### Users & RBAC
| Method & path | Permission | Notes |
|---|---|---|
| `GET /v1/admin/users?q&status&role&kycLevel` | users.read | e-mail / phone (08…/+62…) / name / id search; **masked** (`r***@example.com`, `+6281****890`, `Rina P.`) |
| `GET /v1/admin/users/{id}` | users.read | KYC, trust, risk reviews, tx summary (buyer/traveler), sessions, devices count — masked |
| `POST /v1/admin/users/{id}/reveal-contact` | users.read **M** | `{reason}` → unmasked e-mail/phone/name; audit `users.pii_revealed` + security event `ADMIN_PII_REVEALED` |
| `POST /v1/admin/users/{id}/suspend` · `/reactivate` | users.suspend **M** | `{reason}`; revokes all refresh tokens; never yourself |
| `POST /v1/admin/users/{id}/force-logout` | users.suspend | revokes all sessions |
| `GET /v1/admin/rbac/roles` | rbac.manage | roles + permissions (+ `privileged`) |
| `POST /v1/admin/users/{id}/roles` | rbac.manage **M** | non-privileged role → granted (200); `SUPER_ADMIN`/`FINANCE_SUPER_ADMIN` → **MC** request (202 `PENDING_APPROVAL`, 72 h) |
| `DELETE /v1/admin/users/{id}/roles/{roleCode}` | rbac.manage **M** | `{reason}`; never your own SUPER_ADMIN, never the last SUPER_ADMIN |
| `GET /v1/admin/rbac/role-requests?status` | rbac.manage | |
| `POST /v1/admin/rbac/role-requests/{id}/approve` · `/reject` | rbac.manage **M** | approver must be an active SUPER_ADMIN ≠ requester ≠ subject (API + DB trigger); requester rejecting = `CANCELLED` |
| `POST /v1/admin/users/{id}/mfa-reset-requests` | rbac.manage **M MC** | SEC-13: `{reason ≥ 10}` → `202 PENDING` (72 h); not for yourself; the subject must have a confirmed TOTP factor; one pending request per user (`409 MFA_RESET_PENDING`) |
| `GET /v1/admin/rbac/mfa-reset-requests?status` | rbac.manage | |
| `POST /v1/admin/rbac/mfa-reset-requests/{id}/approve` · `/reject` | rbac.manage **M MC** | approver = active SUPER_ADMIN ≠ requester ≠ subject (API + DB trigger `trg_admin_mfa_reset_guard`); apply → factor disabled, recovery codes deleted, all sessions revoked, `MFA_RESET` (HIGH); requester rejecting = `CANCELLED` |

### KYC & payout accounts — `kyc.review`
| Method & path | Notes |
|---|---|
| `GET /v1/admin/kyc/submissions?status` | queue (default PENDING/IN_REVIEW), waiting hours |
| `GET /v1/admin/kyc/submissions/{id}` | documents with `content.url` = `GET /v1/files/{fileId}/content` (streamed, owner/admin, audited by files module), identity **masked** (`••••••••1234`, `Siti R.`), duplicate-identity flag, history; audited `kyc.submission_viewed` |
| `POST …/{id}/approve` **M** | `{livenessPassed, documentMatches, note?}` → FSM §15.4 guards (`PENDING→IN_REVIEW→APPROVED`), identity verified, docs ACCEPTED, `kyc.approved`, level recompute (→ 3) |
| `POST …/{id}/reject` **M** | `{reason, code?}` → `kyc.rejected` |
| `GET /v1/admin/kyc/payout-accounts` | unverified / failed / name-mismatch accounts (masked) |
| `POST /v1/admin/kyc/payout-accounts/{id}/verification-override` **M** | `{status: VERIFIED\|FAILED, reason}`; VERIFIED → `payout_account.verified` + level recompute |

### Trips — `trips.verify`
`GET /v1/admin/trips/verifications` (queue) · `GET /v1/admin/trips/{id}` (documents, timeline) ·
`POST /v1/admin/trips/{id}/verification/approve` (`trip_verifications` APPROVED, `transition_trip → VERIFIED` as ADMIN,
event `trip.verified {tripId, travelerId, verifiedBy:'ADMIN'}` → identity job recomputes level 4) ·
`POST …/verification/reject` `{reason}` (→ DRAFT). An admin can never verify their own trip.

### Transactions
| Method & path | Permission | Notes |
|---|---|---|
| `GET /v1/admin/transactions?status&q&buyerId&travelerId&from&to` | transactions.read | `q` = number prefix |
| `GET /v1/admin/transactions/{id}` | transactions.read | item, masked parties, quote, payments (sandbox flag), refunds, payouts (masked destination), **ledger** (journals + entries + escrow buckets + `balanced`), price confirmations, proofs, delivery, disputes, events, `adminAllowedTransitions` |
| `POST /v1/admin/transactions/{id}/cancel` | transactions.override **M I** | `{reason, cause?, approvalNote}` → cancellation matrix as ADMIN (money `cancelInTx`), refunds processed; `DISPUTED` → 422 `USE_DISPUTE_RESOLUTION` |
| `POST /v1/admin/transactions/{id}/refund` | transactions.override + refunds.request **M I** | `{amountIdr, reason, remainderTo: TRAVELER\|NONE}` → money `requestRefund` (reason ADMIN); above `money.policy.refundAutoApproveMaxIdr` → `PENDING_APPROVAL` (**MC**) |

### Disputes — `disputes.manage`
| Method & path | Notes |
|---|---|
| `GET /v1/admin/disputes?status&assignee=me\|none\|<id>&sla=BREACHED\|DUE_SOON` | `slaState` ON_TRACK / DUE_SOON / BREACHED |
| `GET /v1/admin/disputes/{id}` | evidence (`fileUrlEndpoint` and `contentUrl` are absolute URLs), timeline, escrow held, pre-dispute status, refunds, `allowedActions` |
| `POST …/{id}/assign` | `{assigneeId?}` (default me; assignee needs disputes.manage) |
| `POST …/{id}/request-evidence` | `{note, dueHours}` → EVIDENCE_COLLECTION |
| `POST …/{id}/review` | → UNDER_REVIEW; while the evidence window is open → 422 `EVIDENCE_WINDOW_OPEN` unless `closeEvidenceWindow:true` |
| `POST …/{id}/resolve` **M I** | `{resolution, amountIdr?, note, releaseBeforeDelivery?}` — see §3 |
| `POST …/{id}/close` | RESOLVED → CLOSED; OPEN/EVIDENCE_COLLECTION only when the item was DELIVERED (→ BUYER_CONFIRMED → COMPLETED), else 422 `RESOLUTION_REQUIRED` |

### Refunds & payouts
| Method & path | Permission | Notes |
|---|---|---|
| `GET /v1/admin/refunds?status` | refunds.approve | default `PENDING_APPROVAL`; `canApprove=false` for the requester |
| `POST /v1/admin/refunds/{id}/approve` · `/reject` | refunds.approve **M I MC** | approve → money `approveRefund` + processor; reject `{reason}` reverses the allocation, `transactionFollowUp: REVIEW_REQUIRED` when nothing else is open |
| `GET /v1/admin/payouts?status&travelerId` | payouts.manage | masked destination, `canRelease` |
| `POST /v1/admin/payouts/{id}/hold` | payouts.manage **M I** | `{reason}` → ON_HOLD, `held_by`; event `payout.on_hold` |
| `POST /v1/admin/payouts/{id}/release` | payouts.manage **M I MC** | releaser ≠ holder (API + DB CHECK `payouts_hold_release_maker_checker`); 422 `RISK_REVIEW_OPEN` while a review on the transaction is open; clears `transactions.payout_hold_reason`; warning `DISPUTE_NOT_CLOSED`; event `payout.scheduled`. SYSTEM `DISPUTE_OPEN` holds are released automatically once the dispute is CLOSED and no risk review is open (money.md §5.2) — this route is for the rest |
| `GET /v1/admin/refund-destinations?status` | refunds.approve | SEC-12 review queue (default `PENDING_REVIEW`): masked account, `nameMatch`, amount, `canReview` |
| `POST /v1/admin/refund-destinations/{id}/review` | refunds.approve **M I MC** | `{decision: APPROVE\|REJECT, note}`; reviewer ≠ buyer; APPROVE → VALID + refund processed; REJECT → REJECTED, buyer asked again (`refund.destination_required`); audit `refund.destination_reviewed` |
| `POST /v1/admin/payouts/{id}/retry` | payouts.manage **M I** | FAILED → SCHEDULED now, attempts reset |

### Reconciliation — `finance.reports.read`
| Method & path | Permission | Notes |
|---|---|---|
| `GET /v1/admin/reconciliation/runs?status` | finance.reports.read | newest first; totals (`payments`, `mismatches`, `providerSecuredIdr`, `internalCapturedIdr`), `openItems`, `resolvedItems`, `manual`, `sandbox` |
| `GET /v1/admin/reconciliation/runs/{id}/items?status` | finance.reports.read | default open differences (`MISMATCH`, `MISSING_INTERNAL`, `MISSING_PROVIDER`); `diffIdr` = provider − ledger; linked transaction number |
| `POST /v1/admin/reconciliation/items/{id}/resolve` | finance.reports.read + payouts.manage **M** | `{note ≥ 10}` → RESOLVED (resolver + note stored); 409 `RECONCILIATION_ITEM_NOT_OPEN`; no money moves; audit `reconciliation.item_resolved` |
| `POST /v1/admin/reconciliation/runs` | finance.reports.read + payouts.manage **M I** | `{periodStart, periodEnd, reason}` (≤ 31 days, not in the future) → same comparison as the daily job; `created_by` set; audit `reconciliation.manual_run` |

### Business config — maker-checker
`GET /v1/admin/config` (all keys + active version + pending count + `assumptions`) · `GET /v1/admin/config/{key}` (history with diff
vs active) · `GET /v1/admin/config/{key}/diff?version&against` — `config.read`.
`POST /v1/admin/config/{key}/versions` `{value, changeReason, isAssumption, notes?}` — `config.propose` **M**; validated by
`@jastipkita/core validateBusinessConfig` (422 `CONFIG_INVALID` with errors), one pending version per key (409), no-op → 422.
`POST /v1/admin/config-versions/{id}/approve` · `/reject` — `config.approve` **M MC** (approver ≠ proposer; DB guard too);
approve → `activate_business_config()` + in-process cache invalidated (other instances: TTL).

### Customs rules & restricted items — `customs.rules.manage` / `restricted.rules.manage` (11 routes each)
`GET /v1/admin/customs-rules?status&code` · `GET …/{id}` · `POST …` (new DRAFT; version = max+1 per code) · `PATCH …/{id}` (DRAFT only;
never resets unsent fields) · `POST …/{id}/discard` `{reason}` (DRAFT → RETIRED; rule tables are append-only, no DELETE) ·
`POST …/{id}/submit` · `POST …/{id}/approve` **M MC** (the previous ACTIVE version of the code is closed the day before
`effectiveFrom`, or RETIRED if it starts later) · `POST …/{id}/reject` `{reason}` (→ DRAFT, note appended) · `POST …/{id}/retire` **M** ·
`POST …/{id}/reverify` `{lastVerifiedAt, verifiedBy}` · `POST …/{id}/preview` (sample item: customs estimate with the rules in force
vs. with this version replacing its code, `delta`; restricted: classification before/after). Same set under `/v1/admin/restricted-items`.
`sourceReference` + `lastVerifiedAt` are mandatory on create (regulatory traceability).

### Settlement accounts (platform bank accounts)
| Method & path | Permission | Notes |
|---|---|---|
| `GET /v1/admin/settlement-accounts` | finance.settlement.read_masked | `accountMask`, `holderNameMask`, `secretConfigured` — never the number, never the secret ref |
| `GET /v1/admin/settlement-accounts/changes?status` | finance.settlement.read_masked | `canApprove` |
| `POST /v1/admin/settlement-accounts/changes` | finance.settlement.request_change **M I** | CREATE / UPDATE / DISABLE / SET_PRIMARY (201) — see §4 |
| `POST …/changes/{id}/approve` · `/reject` | finance.settlement.approve_change **M I** | approve: role FINANCE_SUPER_ADMIN, ≠ requester (**MC**), within 72 h, MFA ≤ 15 min (DB guard uses DB time) → `apply_settlement_account_change()` |

### Promotions & referrals
`promotions.manage`: `GET/POST /v1/admin/promotions`, `GET/PATCH /v1/admin/promotions/{id}` (edit only DRAFT/PAUSED, budget never below used),
`POST …/{id}/activate` **M MC** (activator ≠ creator), `POST …/{id}/pause` · `/end` `{reason}`.
`referrals.manage`: `GET /v1/admin/referrals/stats` (CAC proxy, LTV proxy, conversion, fraud rate, repeat rate, gross margin — each with
`definition` + `dataQuality`; guardrail verdict from `unitEconomicsGuardrail`), `GET /v1/admin/referrals?status`,
`POST …/{id}/reject` (PENDING/QUALIFIED), `POST …/{id}/hold` (QUALIFIED only → opens a REFERRAL risk review),
`POST …/{id}/release` **M I** (only when no open review; → REWARDED, credits with idempotency `referral:{id}:referrer|referee`, `referral.rewarded`).
Reward amounts/caps are only changed through business config (`referral.buyer` / `referral.traveler`).

### Risk & trust
`risk.read`: `GET /v1/admin/risk/reviews?status&subjectType&assignee`, `GET /v1/admin/risk/reviews/{id}` (assessment, subject users), `GET /v1/admin/trust/overrides?status`.
`risk.review`: `POST …/reviews/{id}/assign`, `POST …/reviews/{id}/resolve` **M** `{outcome: CLEARED|CONFIRMED_FRAUD, notes, suspendUser?}` —
CLEARED clears the transaction payout hold when no other review is open; CONFIRMED_FRAUD sets `payout_hold_reason=CONFIRMED_FRAUD` and holds SCHEDULED payouts (USER subject: all of the user's); `suspendUser` additionally needs users.suspend.
Emits `risk.review_resolved {reviewId, subjectType, subjectId, userId, userIds, outcome, status}`.
Trust overrides: `POST /v1/admin/trust/overrides` `{userId, newScore, reason, validUntil?}` — trust.override.request **M**;
`POST …/{id}/approve` · `/reject` — trust.override.approve **M MC** (≠ requester ≠ subject) → `apply_trust_score_override()`.

### Support & chat moderation
`support.tickets.manage`: `GET /v1/admin/support/tickets?status&priority&assignee&sla`, `GET /v1/admin/support/sla` (per priority, first-response
median + met ratio, definition), `GET …/tickets/{id}`, `POST …/{id}/assign`, `POST …/{id}/reply` `{body, internal, status?}` (public reply →
PENDING_USER + first response; internal notes never reach the user; event `support.ticket_updated`), `PATCH …/{id}` `{status?, priority?, note?}`
(priority change before first response recomputes `sla_due_at`).
`chat.moderate`: `GET /v1/admin/chat/flagged?status=FLAGGED,HIDDEN` (masked text only), `POST /v1/admin/chat/messages/{id}/reveal` `{reason}`
(audited `chat.message_revealed`), `POST …/{id}/hide` · `/unhide` `{reason}`,
`GET /v1/admin/chat/conversations/{id}/messages?disputeId|ticketId&reason` — only with an OPEN dispute or OPEN ticket linked to the
conversation's transaction (403 `CHAT_ACCESS_SCOPE_REQUIRED` / `CHAT_ACCESS_OUT_OF_SCOPE`), audited `chat.conversation_viewed`.

### FAQ & legal documents
`faq.manage`: `GET/POST /v1/admin/faq`, `GET/PATCH/DELETE /v1/admin/faq/{id}` (DELETE drafts only), `POST …/{id}/publish|archive|unpublish`.
`legal.documents.manage`: `GET /v1/admin/legal-documents?type&locale` (`current` = latest published = what users see),
`GET …/{id}`, `POST …` (new version; optional `summary`, `effectiveAt`), `PATCH …/{id}` (unpublished only; `summary`, `effectiveAt` editable),
`POST …/{id}/publish` **M** (`retirePrevious` default true; immutable afterwards), `POST …/{id}/retire` **M**. Types include
`COMMUNITY_GUIDELINES` (migration 0070). The 10 seeded templates (version `0.1-template`, TEMPLATE banner) are what users see and consent to
until reviewed versions are published — publishing a TOS/PRIVACY/KYC/MARKETING/… version changes the consent version the API accepts
(`GET /v1/consents/requirements`).

### Audit & system
`audit.read`: `GET /v1/admin/audit-logs?actorId&actorType&entityType&entityId&action=finance.*&from&to&limit&cursor` (id cursor, newest first,
includes the row hash), `GET /v1/admin/audit-logs/verify?fromId&toId` (`verify_audit_chain()`, head + last external checkpoint).
`infra.db.read`: `GET /v1/admin/system/health`, `GET /v1/admin/system/alerts` — fields and thresholds in `docs/06-observability.md`.

### DB & Infra Center — see §6
`infra.db.read` (READ) / `infra.db.read + infra.db.operate` + fresh MFA + role SUPER_ADMIN (OPERATE):
`GET /v1/admin/infra/db/health | provider | migrations | storage | backups | operations | operations/{id}`, `POST …/connection-test` (READ);
`POST …/backups | restores | exports | operations/{id}/approve | operations/{id}/cancel | migration-workflows | migration-workflows/{id}/steps/{step} | …/steps/{step}/approve` (OPERATE).

---

## 2. Permission matrix highlights (seed `db/scripts/gen-reference-seed.mjs`)

| Role | Can | Cannot |
|---|---|---|
| SUPER_ADMIN | everything below except the settlement approval; the only role with `rbac.manage`, `infra.db.*`, `trust.override.approve` | `finance.settlement.approve_change` |
| FINANCE_SUPER_ADMIN | FINANCE + `config.approve` + `finance.settlement.approve_change` | propose config, users.suspend, infra |
| FINANCE | users.read, transactions.read, refunds request/approve, payouts, settlement read + request, config.read, audit.read, analytics | approve settlement changes, override transactions |
| OPERATIONS | KYC, trips, transactions (read + override), disputes, refunds.request, support, chat, config.read, risk.read, analytics | refunds.approve, payouts, infra (see §8) |
| RISK | users.read/suspend, KYC, transactions.read, risk read/review, trust.override.request, audit, config.read | trust.override.approve |
| SUPPORT | users.read, transactions.read, tickets, chat moderation, refunds.request, FAQ | refunds.approve, disputes, suspend |
| MARKETING | promotions, referrals, analytics, FAQ, config read/propose | users.read (no PII), settlement |
| COMPLIANCE | users.read, transactions.read, KYC, customs/restricted rules, legal docs, audit, config read/propose, risk.read | money |

Maker-checker everywhere money or privilege moves: privileged role grants, business config, rules, promotions activation,
refunds above the auto-approve ceiling, payout hold → release, settlement accounts, trust overrides, DB restore / migration plan / SWITCH / ROLLBACK.
Where the DB already enforces it (config, rules, promotions, settlement, trust, payouts, role requests, db_operations) the API check is a
friendlier early error, not the only line of defence.

---

## 3. Dispute resolution → money

`resolve` (UNDER_REVIEW only) records the resolution, transitions the dispute to RESOLVED and **executes it when the transaction is still DISPUTED**:

| Resolution | Execution |
|---|---|
| `REFUND_FULL`, `RETURN_AND_REFUND` | money `requestRefund(reason DISPUTE_RESOLUTION, remainderTo NONE)` for everything still held (min(escrow, refundable payments)) → processor → REFUNDED |
| `REFUND_PARTIAL` | `amountIdr` required and **< held**; remainder released to the traveler → COMPLETED + payout |
| `NO_REFUND`, `OTHER` | DISPUTED → BUYER_CONFIRMED → `completeTransaction` (release + payout). If the dispute was opened **before delivery**, `releaseBeforeDelivery:true` is required (422 `PRE_DELIVERY_RELEASE_CONFIRMATION_REQUIRED`) |

Refund idempotency key `dispute:{id}:v{version}` — a retried resolve never double-refunds. Appeal re-resolution (transaction no longer
DISPUTED): same direction → `ALREADY_EXECUTED`; different → `MANUAL_FOLLOW_UP` (use an admin refund / finance ticket).
Event `dispute.resolved {disputeId, number, transactionId, buyerId, travelerId, resolution, resolutionAmountIdr, appealDeadline, execution}`.
The payout processor treats a RESOLVED-but-not-CLOSED dispute as open (money design) — close the dispute after the appeal window.

---

## 4. Settlement account change procedure (the account number never touches the API or the DB)

1. **Ops (secret-store owner)** adds the account to the server secret store as JSON in `SETTLEMENT_SECRETS_JSON`
   (Workers secret / env), e.g. `{"SETTLEMENT_MAIN": {"bankCode": "BCA", "accountNumber": "…", "holderName": "PT …"}}`, and redeploys.
   Names: `^[A-Z][A-Z0-9_]{2,63}$`.
2. **FINANCE** calls `POST /v1/admin/settlement-accounts/changes` with `secretRef: "SETTLEMENT_MAIN"` (the NAME, never the number),
   `accountMask: "****0961"` (must equal the last digits of the secret's number → else 422 `SETTLEMENT_MASK_MISMATCH`),
   `bankCode` (must match the secret → `SETTLEMENT_BANK_MISMATCH`), `holderNameMask`, `label`, `purpose`, `reason`. Unknown secret →
   422 `SETTLEMENT_SECRET_NOT_FOUND`. The row stores only `secret://SETTLEMENT_MAIN` + masks.
3. **Another FINANCE_SUPER_ADMIN** (fresh MFA) approves within 72 h → the secret is re-checked → `apply_settlement_account_change()`.
4. Responses and audit rows never contain the number or the `secret://` reference (`secretConfigured: true|false` only).

---

## 5. Events emitted (outbox)

`trip.verified`, `kyc.approved`, `kyc.rejected`, `payout_account.verified`, `dispute.resolved`, `payout.on_hold`, `payout.scheduled`
(`kind: HOLD_RELEASED`; the payout job emits `HOLD_AUTO_RELEASED`), `refund.destination_set` / `refund.destination_required` (refund
destination review), `referral.rewarded`, `risk.review_resolved`, `support.ticket_updated` (actorType AGENT). Money/FSM events
(`transaction.status_changed`, `refund.*`, `dispute.status_changed`, `kyc.level_changed`, …) come from the reused wave-A services / DB functions.

---

## 6. DB & Infra Center — scope and safety decisions

* **Credentials are never returned or editable.** Responses show the provider name, masked host (`ep***.neon.tech`: first 2 characters of the first label + registrable domain), port, a
  2-letter database prefix and SSL flag. Errors are scrubbed of connection strings. Provider keys (e.g. `NEON_API_KEY`) live only in the
  secret store.
* **No DDL from the UI.** Schema migrations run from CI (`db/scripts/migrate.sh`, forward-only, checksummed). The build embeds
  `src/modules/infra/migration-manifest.ts` (SHA-256 per migration file, same as `schema_migrations.checksum`);
  `GET …/migrations` shows APPLIED / PENDING / CHECKSUM_DRIFT / UNKNOWN_IN_BUILD and `inSync`.
* **8-step migration workflow** (`db_operations` type MIGRATION + `db_operation_steps`): PRE_CHECK → BACKUP → SCHEMA_MIGRATION →
  DATA_MIGRATION → VALIDATION → SWITCH → MONITORING (→ ROLLBACK only after a FAILED step). Plan approved by a second SUPER_ADMIN; order
  enforced; DONE needs every checklist item; PRE_CHECK/BACKUP/SCHEMA_MIGRATION/VALIDATION/MONITORING can't be skipped; SCHEMA_MIGRATION DONE
  only when `schema_migrations` contains the target version; SWITCH and ROLLBACK need a second SUPER_ADMIN; MONITORING DONE → SUCCEEDED.
  Evidence = links/ids only.
* **Backups / restore:** `DB_ADMIN_PROVIDER=generic` (default) → backups & PITR are managed outside the app (422
  `BACKUP_MANAGED_OUTSIDE_APP` / `RESTORE_MANAGED_OUTSIDE_APP`; record manual restore tests as operations). `neon` → Neon API v2 adapter:
  backup = branch, restore **always to a NEW branch** (from a backup branch and/or a point in time), after a second SUPER_ADMIN approves.
  Never in place.
* **Export** = anonymized daily aggregates only (funnel, GMV, take rate, analytics event counts), produced by the `admin.export` worker job
  into an encrypted `EXPORT` file owned by the requester (7-day retention), downloadable via `/v1/files/{id}/content|url`.
* Connection test (3 × `SELECT 1`) is logged as `db_operations CONNECTION_TEST`. Stale operations expire (see observability doc).

---

## 7. Bootstrap: first SUPER_ADMIN

```
cd apps/api && DATABASE_URL=postgres://<owner-or-migrator>@<host>/<db> npx tsx scripts/create-admin.ts --email founder@jastipkita.id --reason "admin pertama"
# --role OPERATIONS   any role code        --dry-run   no changes        --break-glass   incident recovery only
```
The user must already exist (signed up normally, e-mail verified, ACTIVE) — the CLI never creates accounts or passwords. Privileged roles
are refused once an active SUPER_ADMIN exists (use the maker-checker flow) unless `--break-glass`, which raises a CRITICAL
`ADMIN_BREAK_GLASS_GRANT` security event. Every grant is audited (`rbac.role_granted_cli`). Afterwards the admin enrols TOTP
(`POST /v1/auth/mfa/totp/enroll` → `/confirm`) and steps up with `POST /v1/auth/mfa/verify` before sensitive actions.

---

## 8. Deviations & open items

* Rule drafts are **discarded** (`POST …/{id}/discard`, DRAFT → RETIRED) instead of deleted: `customs_rules` / `restricted_items` are
  NO_DELETE for the app role by design.
* OPERATIONS has no `infra.db.read` in the seed (only SUPER_ADMIN). If ops should see the read-only DB center, add
  `('OPERATIONS','infra.db.read')` to `db/scripts/gen-reference-seed.mjs` (the seed deletes unlisted role_permissions, so a migration can't).
* Public legal endpoints now exist: `GET /v1/legal/documents`, `GET /v1/legal/documents/{type}`, `GET /v1/consents/requirements` (identity API).
* Other groups adding migrations must regenerate the manifest (`npx tsx scripts/gen-migration-manifest.ts`); `migration-manifest.test.ts`
  fails otherwise, and CI can run `--check`.
* Business-config cache invalidation is per instance; other instances pick the change up on the cache TTL.
