-- 0050_engagement.sql
-- Engagement group (notifications, chat, ratings, disputes, referrals/credit, analytics, trust):
--   1. notification preference groups PAYMENT / ACCOUNT (API groups TRANSACTION, PAYMENT, CHAT,
--      PROMOTION, ACCOUNT) on notification_preferences.category and notifications.category
--   2. notifications.in_app: a notification row anchors PUSH/EMAIL deliveries even when the user
--      switched the IN_APP channel off for that group; in_app = false rows are hidden from the inbox
--   3. analytics_events.dedupe_key: idempotent ingestion (client eventId retries, server-side
--      events derived from the outbox)
--   4. messages: one system/status message per source outbox event per conversation (idempotency)
--   5. disputes.sla_breach / sla_breached_at: SLA breach flag written by the dispute SLA job
--   6. user_rating_summaries: Bayesian scores + effective (weighted) counts from core aggregateRatings
-- Irreversible only in the sense that dropping the new columns loses data; nothing is removed.
BEGIN;

-- 1. ------------------------------------------------------------------------
ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_category_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_category_check
  CHECK (category IN ('TRANSACTION','PAYMENT','CHAT','TRIP','PROMOTION','REFERRAL','ACCOUNT','SECURITY','SYSTEM'));
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_category_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_category_check
  CHECK (category IN ('TRANSACTION','PAYMENT','CHAT','TRIP','PROMOTION','REFERRAL','ACCOUNT','SECURITY','SYSTEM'));

-- 2. ------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS in_app boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN notifications.in_app IS
  'false = IN_APP channel disabled for this notification (row only anchors PUSH/EMAIL deliveries; hidden from GET /notifications)';
CREATE INDEX IF NOT EXISTS notifications_inbox_idx ON notifications (user_id, created_at DESC, id) WHERE in_app;
CREATE INDEX IF NOT EXISTS notifications_inbox_unread_idx ON notifications (user_id) WHERE in_app AND read_at IS NULL;

-- 3. ------------------------------------------------------------------------
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS dedupe_key text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analytics_events_dedupe_key_len') THEN
    ALTER TABLE analytics_events ADD CONSTRAINT analytics_events_dedupe_key_len
      CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 8 AND 200);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS analytics_events_dedupe_uq ON analytics_events (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- 4. ------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS messages_source_event_uq ON messages (conversation_id, (meta->>'sourceEventId'))
  WHERE meta ? 'sourceEventId';

-- 5. ------------------------------------------------------------------------
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS sla_breach text;
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS sla_breached_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'disputes_sla_breach_check') THEN
    ALTER TABLE disputes ADD CONSTRAINT disputes_sla_breach_check
      CHECK ((sla_breach IS NULL AND sla_breached_at IS NULL)
          OR (sla_breach IN ('EVIDENCE_OVERDUE','REVIEW_OVERDUE') AND sla_breached_at IS NOT NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS disputes_sla_breached_idx ON disputes (sla_breached_at) WHERE sla_breached_at IS NOT NULL AND status <> 'CLOSED';

-- 6. ------------------------------------------------------------------------
ALTER TABLE user_rating_summaries ADD COLUMN IF NOT EXISTS as_traveler_bayesian numeric(3,2);
ALTER TABLE user_rating_summaries ADD COLUMN IF NOT EXISTS as_traveler_effective numeric(10,2);
ALTER TABLE user_rating_summaries ADD COLUMN IF NOT EXISTS as_buyer_bayesian numeric(3,2);
ALTER TABLE user_rating_summaries ADD COLUMN IF NOT EXISTS as_buyer_effective numeric(10,2);
COMMENT ON COLUMN user_rating_summaries.as_traveler_bayesian IS
  'core aggregateRatings().bayesianScore (prior 4.0 x 5, abuse-weighted); maintained by the ratings service';

SELECT jk_apply_grants();

COMMIT;
