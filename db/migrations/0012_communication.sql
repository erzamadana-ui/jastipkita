-- 0012_communication.sql
-- Chat (conversations/messages/read markers), notifications & deliveries, email suppressions.
BEGIN;

CREATE TABLE IF NOT EXISTS conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  uuid REFERENCES transactions(id),
  request_id      uuid REFERENCES requests(id),
  buyer_id        uuid NOT NULL REFERENCES users(id),
  traveler_id     uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','LOCKED','ARCHIVED')),
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (buyer_id <> traveler_id),
  CHECK (transaction_id IS NOT NULL OR request_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_tx_uq ON conversations (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS conversations_request_pair_uq ON conversations (request_id, traveler_id)
  WHERE transaction_id IS NULL AND request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_request_idx ON conversations (request_id);
CREATE INDEX IF NOT EXISTS conversations_buyer_idx ON conversations (buyer_id, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS conversations_traveler_idx ON conversations (traveler_id, last_message_at DESC NULLS LAST);
SELECT jk_attach_updated_at('conversations');

CREATE TABLE IF NOT EXISTS messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL REFERENCES conversations(id),
  sender_id         uuid REFERENCES users(id),        -- NULL for SYSTEM/STATUS messages
  type              text NOT NULL CHECK (type IN ('TEXT','IMAGE','PRODUCT','RECEIPT','SYSTEM','STATUS')),
  body              text CHECK (char_length(body) <= 4000),
  attachments       jsonb NOT NULL DEFAULT '[]',       -- [{fileId, mime, ...}]
  meta              jsonb NOT NULL DEFAULT '{}',
  moderation_status text NOT NULL DEFAULT 'CLEAN' CHECK (moderation_status IN ('CLEAN','FLAGGED','HIDDEN')),
  moderation_reason text,
  moderated_by      uuid REFERENCES users(id),
  moderated_at      timestamptz,
  edited_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CHECK (sender_id IS NOT NULL OR type IN ('SYSTEM','STATUS')),
  CHECK (moderation_status = 'CLEAN' OR moderation_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages (sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_moderated_by_idx ON messages (moderated_by);
CREATE INDEX IF NOT EXISTS messages_flagged_idx ON messages (created_at) WHERE moderation_status = 'FLAGGED';
INSERT INTO jk_sensitive_columns VALUES
  ('messages','body','private chat content'),
  ('messages','attachments','private chat content')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION jk_touch_conversation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE conversations SET last_message_at = NEW.created_at
   WHERE id = NEW.conversation_id AND (last_message_at IS NULL OR last_message_at < NEW.created_at);
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER trg_touch_conversation AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION jk_touch_conversation();

CREATE TABLE IF NOT EXISTS message_reads (
  conversation_id      uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id),
  last_read_message_id uuid REFERENCES messages(id),
  last_read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS message_reads_user_idx ON message_reads (user_id);
CREATE INDEX IF NOT EXISTS message_reads_message_idx ON message_reads (last_read_message_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  category   text NOT NULL DEFAULT 'SYSTEM' CHECK (category IN ('TRANSACTION','CHAT','TRIP','PROMOTION','REFERRAL','SECURITY','SYSTEM')),
  title      text NOT NULL,
  body       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',          -- deep link params, ids
  outbox_event_id uuid,                            -- dedupe against outbox redelivery
  read_at    timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, outbox_event_id)
);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_expiry_idx ON notifications (expires_at) WHERE expires_at IS NOT NULL;
INSERT INTO jk_sensitive_columns VALUES ('notifications','body','personalised message text') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('PUSH','EMAIL','SMS')),
  status          text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','FAILED','SKIPPED')),
  provider        text,
  provider_env    text CHECK (provider_env IN ('TEST','LIVE')),
  provider_ref    text,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error           text,
  skip_reason     text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, channel),
  CHECK (status <> 'SENT' OR sent_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS notification_deliveries_queue_idx ON notification_deliveries (created_at) WHERE status = 'QUEUED';
SELECT jk_attach_updated_at('notification_deliveries');

-- Suppression list keyed by HMAC of the normalized address (survives account deletion
-- without keeping the address itself).
CREATE TABLE IF NOT EXISTS email_suppressions (
  email_hash bytea PRIMARY KEY CHECK (octet_length(email_hash) = 32),
  reason     text NOT NULL CHECK (reason IN ('HARD_BOUNCE','COMPLAINT','UNSUBSCRIBE','MANUAL','ACCOUNT_DELETED')),
  scope      text NOT NULL DEFAULT 'MARKETING' CHECK (scope IN ('ALL','MARKETING')),
  source     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT jk_attach_updated_at('email_suppressions');

COMMIT;
