# Database migrations

Plain SQL, forward-only, PostgreSQL 15+ (Neon, Supabase, RDS, Cloud SQL, local 16).
Schema documentation: [`docs/03-database.md`](../../docs/03-database.md).

## Layout

```
db/
  migrations/NNNN_description.sql   forward migrations (this folder)
  rollback/NNNN_down.sql            down scripts — ONLY for reversible migrations
  seeds/NNNN_*.sql                  idempotent reference data (0001 generated, 01xx regulatory rules)
  scripts/migrate.sh                runner (psql only)
  scripts/seed.sh                   applies every seeds/*.sql in lexical order
  scripts/gen-reference-seed.mjs    generates seeds/0001_reference.sql from JSON config + docs/00-domain-model.md
  scripts/test-db.sh                fresh DB → migrations → seeds → idempotency → rollback → tests
  tests/*.sql                       SQL tests (DO blocks, "PASS:" notices)
```

## Ordering

Files are applied in lexical order of their 4-digit prefix. A migration may only depend on
lower-numbered ones. Current set:

| # | File | Contents | Reversible |
|---|---|---|---|
| 0001 | foundation | extensions, `schema_migrations`, `set_updated_at()`, append-only helpers, numbering, generic FSM guard, grant registries | no |
| 0002 | reference | currencies, countries, product_categories | no |
| 0003 | identity_access | users, auth, sessions, OTP, devices, RBAC, MFA, consents, security events, files | no |
| 0004 | audit_outbox_jobs | hash-chained `audit_logs`, outbox, job queue, idempotency keys | no |
| 0005 | config_rules | business_configs, feature flags, experiments, customs_rules, restricted_items, FAQ, legal docs | no |
| 0006 | kyc | KYC submissions/documents, identity_records, payout_accounts | no |
| 0007 | trips_requests | trips (+FSM), trip verifications, requests, offers | no |
| 0008 | transactions | transactions (+FSM), FX, quotes & lines, price confirmations, purchase proofs, customs declarations, deliveries | no |
| 0009 | payments_ledger | payments, webhook inbox, ledger, refunds, payouts, settlement accounts (maker-checker), reconciliation | no |
| 0010 | growth | referrals, credit ledger, promotions | no |
| 0011 | trust_risk | trust scores/history/overrides, risk assessments/reviews, limits usage view | no |
| 0012 | communication | conversations, messages, notifications, email suppressions | no |
| 0013 | disputes_support | ratings, disputes (+FSM), evidence, insurance, support tickets | no |
| 0014 | privacy_ops | privacy requests, retention policies, `anonymize_user()`, analytics events, db operations, health checks | no |
| 0015 | analytics_views | `v_funnel_daily`, `v_gmv_daily`, `v_take_rate`, `v_refund_rate`, `v_dispute_rate`, `v_traveler_utilization` | **yes** → `rollback/0015_down.sql` |
| 0016 | roles_grants | `jk_migrator` / `jk_app` / `jk_readonly`, ownership, `jk_apply_grants()` | **yes** → `rollback/0016_down.sql` |
| 0017 | spec_alignment | domain model rev. 2: `currencies.ecb_reference`, inclusive `'[]'` rule-date exclusion + `*_in_force()` helpers, `status_transitions.actor_types`, KYC statuses §15.4, initial-state guards | no (KYC status remap) |

## File contract

* Each file contains exactly one `BEGIN;` line and one `COMMIT;` line, so it can also be
  applied by hand with `psql -f`. The runner strips those two lines and wraps the body **and**
  its `schema_migrations` row in a single transaction under an advisory lock
  (`pg_advisory_xact_lock(727372010)`), so a migration is either fully applied and recorded or
  not at all. A second runner started concurrently waits, then sees the row and skips.
* **Idempotent where reasonable**: `CREATE TABLE/INDEX IF NOT EXISTS`, `CREATE OR REPLACE`
  functions/views/triggers, guarded `ALTER TABLE ... ADD CONSTRAINT` (DO block on `pg_constraint`),
  `ON CONFLICT DO NOTHING` for registry rows. `test-db.sh` re-applies every file raw to prove it.
* Enumerations are `text` + `CHECK (col IN (...))` (no Postgres ENUM types). To add a value,
  `ALTER TABLE ... DROP CONSTRAINT ...; ADD CONSTRAINT ...` in a new migration.
* Every new table must: add `updated_at` via `SELECT jk_attach_updated_at('t')` (if it has one),
  index every FK (a test fails otherwise), register sensitive columns in `jk_sensitive_columns`
  (anything not matching `*_enc`, `*_hash`, `password*`, `*secret*`, `*token*` that jk_readonly must not
  read), call `jk_make_append_only('t')` / `jk_make_restricted('t', cols...)` for log tables, and
  **end with `SELECT jk_apply_grants();`** (the runner also calls it after the last migration).

## Checksums

`schema_migrations(version, name, checksum, applied_at, execution_ms, applied_by)`.
`checksum` is the SHA-256 (hex) of the file bytes. The runner refuses to continue when an applied
file changed on disk (`--verify` reports it). **Never edit an applied migration**: add a new one.

## Running

```bash
export DATABASE_URL=postgres://...          # or PGHOST/PGUSER/PGDATABASE
db/scripts/migrate.sh                        # apply pending
db/scripts/migrate.sh --to 0016              # apply pending up to and including 0016
db/scripts/migrate.sh --status               # list
db/scripts/migrate.sh --verify               # checksum drift check (CI)
db/scripts/seed.sh                           # reference data (idempotent, run on every deploy)
node db/scripts/gen-reference-seed.mjs --check   # CI: generated seed is up to date
bash db/scripts/test-db.sh                   # full test run on a scratch database
```

After 0016 has been applied in a database, the runner and `seed.sh` execute as `jk_migrator`
(`SET LOCAL ROLE` / `-c role=`) so new objects are owned by it and inherit its default privileges.
The account running migrations must be a member of `jk_migrator` (0016 grants this to the
account that applied it).

## Rollback approach

Migrations are **forward-only**. Production rollback means one of:

1. **Compensating migration** (preferred): a new, higher-numbered migration that undoes or fixes
   the change (e.g. re-add a dropped column, restore a constraint, `reverse_journal()` for
   ledger data). This keeps `schema_migrations` monotonic and auditable.
2. **Restore from backup / point-in-time recovery** when data was damaged: restore to a new
   branch/instance at a timestamp before the migration (Neon branch, Supabase PITR, RDS PITR,
   Cloud SQL PITR), verify, then switch the application (record it in `db_operations` with type
   `RESTORE`/`SWITCH` — both require a second approver).
3. **Down script** — only for migrations whose reversal cannot lose business data (views,
   grants). Available: `rollback/0015_down.sql`, `rollback/0016_down.sql`. The runner only
   allows rolling back the **latest** applied migration:

   ```bash
   db/scripts/migrate.sh --rollback 0016
   db/scripts/migrate.sh --rollback 0015
   ```

   Rolling back 0015/0016 therefore requires that 0017+ are not applied (e.g. a DB migrated with
   `--to 0016`, which is how `test-db.sh` exercises them).
   `0016_down.sql` revokes privileges and returns ownership to the session user but does **not**
   drop the cluster-wide roles (other databases may use them); drop them manually if needed.

Migrations 0001–0014 and 0017 are **irreversible**: their down would drop tables holding financial,
audit or personal data. Always take a backup (or create a provider branch) before applying
migrations to production.

## Seeds

* `seeds/0001_reference.sql` is **generated** — edit the JSON in `packages/core/src/config/`,
  `docs/00-domain-model.md` (§4 and §15.1–§15.7 state-machine tables are parsed; §15.8 is hard-coded)
  or the static data in `scripts/gen-reference-seed.mjs`, then run `node db/scripts/gen-reference-seed.mjs`.
  A status the DB CHECKs don't accept makes the generator fail: add a migration first.
* `seeds/0100_customs_rules.sql`, `seeds/0101_restricted_items.sql` are maintained by the
  customs/compliance workstream against the column contracts in 0005.
* ACTIVE `business_configs` rows are immutable: re-running the seed never changes them. Changing a
  default for an existing database = propose a new version via Admin (maker-checker).

## Error codes raised by database functions

| SQLSTATE | Meaning |
|---|---|
| `JK001` | append-only / immutable row violation |
| `JK403` | actor not allowed (FSM actor, approver lacks role/permission, stale MFA) |
| `JK404` | entity not found |
| `JK409` | optimistic-lock version conflict (`DETAIL` carries `currentVersion`) |
| `JK422` | illegal state transition / status changed outside its function |
| `JK423` | precondition failed (e.g. `anonymize_user` with active transactions) |
| `JKC01` | credit balance would go negative |
| `JKL01` / `JKL02` / `JKL03` | journal < 2 entries / journal unbalanced / account not ACTIVE |
| `JKQ01` | quote lines do not sum to TOTAL |
