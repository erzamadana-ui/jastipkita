-- 0018 — per-handler outbox delivery bookkeeping.
-- The worker dispatches each outbox event to every subscribed handler (several module groups).
-- A handler that already succeeded for an event is recorded here and skipped on retries, so one
-- failing consumer never re-runs (or blocks) the others. Rows are purged with published events.
BEGIN;

CREATE TABLE IF NOT EXISTS outbox_handler_runs (
  event_id     uuid NOT NULL,
  handler      text NOT NULL CHECK (char_length(handler) BETWEEN 3 AND 200),
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, handler)
);
CREATE INDEX IF NOT EXISTS outbox_handler_runs_completed_idx ON outbox_handler_runs (completed_at);

INSERT INTO jk_grant_policies VALUES
  ('outbox_handler_runs', 'AUTO', 'AUTO', 'worker bookkeeping; deletable by retention job')
ON CONFLICT DO NOTHING;

SELECT jk_apply_grants();

COMMIT;
