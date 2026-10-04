-- 0130_consumer_complaints.sql
-- Regulatory product features B1 (docs/checklists/launch-checklist.md L12; Permendag 19/2026, UU 8/1999):
--   support_tickets.category gains COMPLAINT — the "Layanan Pengaduan Konsumen" channel. Complaints default to
--   priority HIGH in the API (apps/api/src/modules/support); the first-response SLA comes from config `support.sla`.
-- L13 (AI-content label) needs no schema change: requests.source_type (URL/PHOTO/SEARCH) + requests.extraction (0007)
-- already record that product data came from POST /v1/requests/extract; the API derives `autoFill` from them.
-- Forward-only, idempotent (re-applied raw by db/scripts/test-db.sh). Additive only: every existing row stays valid.
BEGIN;

-- Fail fast instead of queueing behind long transactions on a live table (the swap needs a brief ACCESS EXCLUSIVE lock).
SET LOCAL lock_timeout = '10s';

-- NOT VALID + VALIDATE: the new constraint is a strict superset of the old one, so validation cannot fail; it is still
-- validated so the catalog marks it as trusted (convalidated = true) like every other CHECK in the schema.
ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS support_tickets_category_check;
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_category_check
  CHECK (category IN ('TRANSACTION','DISPUTE','REFUND','ACCOUNT','PAYMENT','CUSTOMS','OTHER','COMPLAINT')) NOT VALID;
ALTER TABLE support_tickets VALIDATE CONSTRAINT support_tickets_category_check;

COMMENT ON COLUMN support_tickets.category IS
  'TRANSACTION | DISPUTE | REFUND | ACCOUNT | PAYMENT | CUSTOMS | OTHER | COMPLAINT (consumer complaint channel, Permendag 19/2026 — default priority HIGH, 0130)';

SELECT jk_apply_grants();

COMMIT;
