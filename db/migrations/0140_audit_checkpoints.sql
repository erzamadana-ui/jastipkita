-- 0140_audit_checkpoints.sql
-- Launch checklist T12: daily checkpoints of the audit hash chain, anchored outside the database.
--
-- The job infra.audit_checkpoint (apps/api/src/modules/infra/audit-checkpoints.ts) reads the chain head in ONE snapshot
-- (audit_chain_head + count of audit_logs up to last_id), first verifies the segment since the previous checkpoint, then
-- writes the same JSON to object storage at audit-checkpoints/YYYY/MM/DD.json (production: a bucket with Object Lock /
-- WORM retention — see docs/08-backup-dr.md §9) and records the anchor here. A superuser who rewrites the whole chain
-- (and recomputes every hash and the head) still cannot change the WORM object, so the rewrite is detectable by
-- GET /v1/admin/infra/audit/checkpoints/verify.
--
-- Supersedes the never-written audit_chain_checkpoints (0004), which lacked the row count, the object digest and the
-- per-day uniqueness the job relies on. That table is kept (append-only, historical) — no data is dropped.
-- Forward-only, idempotent (re-applied raw by db/scripts/test-db.sh). Additive only.
BEGIN;

CREATE TABLE IF NOT EXISTS audit_checkpoints (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checkpoint_day     date NOT NULL,                     -- UTC calendar day; one checkpoint per day (job is idempotent)
  last_id            bigint NOT NULL CHECK (last_id >= 0),
  last_hash          bytea NOT NULL CHECK (octet_length(last_hash) = 32),
  row_count          bigint NOT NULL CHECK (row_count >= 0 AND row_count <= last_id),
  head_updated_at    timestamptz NOT NULL,              -- audit_chain_head.updated_at at checkpoint time
  storage_key        text NOT NULL,
  object_sha256      bytea NOT NULL CHECK (octet_length(object_sha256) = 32),  -- SHA-256 of the exact JSON bytes stored
  prev_object_sha256 bytea CHECK (prev_object_sha256 IS NULL OR octet_length(prev_object_sha256) = 32),  -- links the objects
  storage_mode       text NOT NULL CHECK (storage_mode IN ('MOCK','SANDBOX','LIVE')),
  created_by         text NOT NULL DEFAULT 'job:infra.audit_checkpoint' CHECK (created_by ~ '^[a-z]+:[a-z0-9_.-]{1,100}$'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_checkpoints_day_uq UNIQUE (checkpoint_day),
  CONSTRAINT audit_checkpoints_key_chk CHECK (storage_key = 'audit-checkpoints/' || to_char(checkpoint_day::timestamp, 'YYYY/MM/DD') || '.json')
);
CREATE INDEX IF NOT EXISTS audit_checkpoints_last_id_idx ON audit_checkpoints (last_id);
COMMENT ON TABLE audit_checkpoints IS
  'Append-only daily anchors of the audit hash chain (T12). Each row mirrors a JSON object in WORM storage (storage_key).';
COMMENT ON TABLE audit_chain_checkpoints IS 'Superseded by audit_checkpoints (0140); never written by the application.';

SELECT jk_make_append_only('audit_checkpoints');

INSERT INTO jk_grant_policies VALUES
  ('audit_checkpoints', 'AUTO', 'AUTO', 'append-only audit chain anchors written by the infra.audit_checkpoint job (SELECT, INSERT)')
ON CONFLICT DO NOTHING;

SELECT jk_apply_grants();

COMMIT;
