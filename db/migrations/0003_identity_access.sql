-- 0003_identity_access.sql
-- Users, authentication, sessions, devices, RBAC, MFA, consents, files.
-- Hash columns (*_hash) are HMAC-SHA256 digests computed by the API with a server
-- key (bytea, 32 bytes). *_enc columns hold envelope-encrypted ciphertext; the DB
-- never sees the plaintext.
BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext UNIQUE,
  email_verified_at  timestamptz,
  phone_e164         text UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  phone_verified_at  timestamptz,
  password_hash      text,
  display_name       text CHECK (char_length(display_name) <= 80),
  avatar_file_id     uuid,                       -- FK added after files
  locale             text NOT NULL DEFAULT 'id' CHECK (locale IN ('id','en')),
  country_code       char(2) REFERENCES countries(code),
  status             text NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE','SUSPENDED','PENDING_DELETION','DELETED')),
  suspended_at       timestamptz,
  suspension_reason  text,
  kyc_level          smallint NOT NULL DEFAULT 1 CHECK (kyc_level BETWEEN 1 AND 5),
  active_mode        text NOT NULL DEFAULT 'BUYER' CHECK (active_mode IN ('BUYER','TRAVELER')),
  referral_code      text NOT NULL UNIQUE DEFAULT jk_crockford_random(8) CHECK (referral_code ~ '^[0-9A-Z]{4,16}$'),
  referred_by        uuid REFERENCES users(id),
  trust_score        smallint NOT NULL DEFAULT 50 CHECK (trust_score BETWEEN 0 AND 100),
  transaction_email  citext,
  last_login_at      timestamptz,
  deleted_at         timestamptz,
  anonymized_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (referred_by IS DISTINCT FROM id),
  CHECK (status <> 'DELETED' OR deleted_at IS NOT NULL),
  CHECK (email_verified_at IS NULL OR email IS NOT NULL),
  CHECK (phone_verified_at IS NULL OR phone_e164 IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS users_referred_by_idx ON users (referred_by);
CREATE INDEX IF NOT EXISTS users_country_code_idx ON users (country_code);
CREATE INDEX IF NOT EXISTS users_avatar_file_id_idx ON users (avatar_file_id);
CREATE INDEX IF NOT EXISTS users_status_created_idx ON users (status, created_at DESC);
CREATE INDEX IF NOT EXISTS users_pending_deletion_idx ON users (updated_at) WHERE status = 'PENDING_DELETION';
SELECT jk_attach_updated_at('users');
INSERT INTO jk_sensitive_columns VALUES
  ('users','email','contact PII'),
  ('users','phone_e164','contact PII'),
  ('users','transaction_email','contact PII'),
  ('users','display_name','PII')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS files (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid REFERENCES users(id),
  purpose          text NOT NULL CHECK (purpose IN ('KYC','RECEIPT','PRODUCT_PHOTO','TRIP_DOC','EVIDENCE',
                                                    'AVATAR','CHAT','DELIVERY_PROOF','EXPORT')),
  storage_provider text NOT NULL CHECK (storage_provider IN ('S3','R2','GCS','SUPABASE','AZURE','LOCAL','MOCK')),
  bucket           text NOT NULL DEFAULT 'default',
  storage_key      text NOT NULL,
  mime             text NOT NULL CHECK (mime ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'),
  size_bytes       bigint NOT NULL CHECK (size_bytes >= 0),
  sha256           bytea CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
  encrypted        boolean NOT NULL DEFAULT false,
  enc_key_id       text,
  scan_status      text NOT NULL DEFAULT 'PENDING' CHECK (scan_status IN ('PENDING','CLEAN','INFECTED','FAILED')),
  scanned_at       timestamptz,
  retention_until  timestamptz,
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_provider, bucket, storage_key),
  CHECK (NOT encrypted OR enc_key_id IS NOT NULL),
  -- KYC and trip documents must be envelope-encrypted at rest.
  CHECK (purpose NOT IN ('KYC','TRIP_DOC') OR encrypted)
);
CREATE INDEX IF NOT EXISTS files_owner_id_idx ON files (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS files_retention_idx ON files (retention_until) WHERE deleted_at IS NULL AND retention_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS files_scan_pending_idx ON files (created_at) WHERE scan_status = 'PENDING';
CREATE INDEX IF NOT EXISTS files_sha256_idx ON files (sha256) WHERE sha256 IS NOT NULL;
SELECT jk_attach_updated_at('files');
INSERT INTO jk_sensitive_columns VALUES ('files','storage_key','object path may embed identifiers') ON CONFLICT DO NOTHING;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_avatar_file_id_fkey') THEN
    ALTER TABLE users ADD CONSTRAINT users_avatar_file_id_fkey FOREIGN KEY (avatar_file_id) REFERENCES files(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS auth_identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('GOOGLE','APPLE','EMAIL','PHONE')),
  provider_subject text NOT NULL,
  email            citext,
  email_verified   boolean NOT NULL DEFAULT false,
  last_used_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);
CREATE INDEX IF NOT EXISTS auth_identities_user_id_idx ON auth_identities (user_id);
SELECT jk_attach_updated_at('auth_identities');
INSERT INTO jk_sensitive_columns VALUES ('auth_identities','*','provider subjects are emails/phones') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS devices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint_hash bytea NOT NULL UNIQUE,
  platform         text NOT NULL CHECK (platform IN ('IOS','ANDROID','WEB')),
  push_token       text,
  push_token_updated_at timestamptz,
  app_version      text,
  os_version       text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
SELECT jk_attach_updated_at('devices');
INSERT INTO jk_sensitive_columns VALUES ('devices','push_token','device credential') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS user_devices (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  trusted       boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  PRIMARY KEY (user_id, device_id)
);
-- device -> users lookup (multi-account-per-device fraud signal)
CREATE INDEX IF NOT EXISTS user_devices_device_id_idx ON user_devices (device_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id         uuid NOT NULL,
  token_hash        bytea NOT NULL UNIQUE,
  device_id         uuid REFERENCES devices(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  revoked_reason    text CHECK (revoked_reason IS NULL OR revoked_reason IN
                      ('ROTATED','LOGOUT','REUSE_DETECTED','PASSWORD_CHANGED','ADMIN','ACCOUNT_DELETED','EXPIRED')),
  replaced_by       uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  reuse_detected_at timestamptz,
  ip_hash           bytea,
  user_agent        text,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_active_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS refresh_tokens_family_id_idx ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_device_id_idx ON refresh_tokens (device_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_replaced_by_idx ON refresh_tokens (replaced_by);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);
INSERT INTO jk_sensitive_columns VALUES ('refresh_tokens','*','session credentials') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS otp_challenges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  channel          text NOT NULL CHECK (channel IN ('SMS','WHATSAPP','EMAIL')),
  destination_hash bytea NOT NULL,
  purpose          text NOT NULL CHECK (purpose IN ('REGISTER','LOGIN','VERIFY_PHONE','VERIFY_EMAIL',
                                                    'RESET_PASSWORD','STEP_UP','CHANGE_PHONE','CHANGE_EMAIL','DELIVERY')),
  code_hash        bytea NOT NULL,
  attempts         smallint NOT NULL DEFAULT 0,
  max_attempts     smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz,
  ip_hash          bytea,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (attempts BETWEEN 0 AND max_attempts),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS otp_challenges_destination_idx ON otp_challenges (destination_hash, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS otp_challenges_user_id_idx ON otp_challenges (user_id);
CREATE INDEX IF NOT EXISTS otp_challenges_ip_idx ON otp_challenges (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS otp_challenges_expires_at_idx ON otp_challenges (expires_at);
INSERT INTO jk_sensitive_columns VALUES ('otp_challenges','*','authentication secrets') ON CONFLICT DO NOTHING;

-- RBAC. roles/permissions keyed by code (seeded, referenced by code in API guards).
CREATE TABLE IF NOT EXISTS roles (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z_]*$'),
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
SELECT jk_attach_updated_at('roles');

CREATE TABLE IF NOT EXISTS permissions (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z][a-z_]*(\.[a-z_]+)+$'),
  description text NOT NULL,
  is_sensitive boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
SELECT jk_attach_updated_at('permissions');

CREATE TABLE IF NOT EXISTS role_permissions (
  role_code       text NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_code, permission_code)
);
CREATE INDEX IF NOT EXISTS role_permissions_permission_code_idx ON role_permissions (permission_code);

CREATE TABLE IF NOT EXISTS user_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  role_code   text NOT NULL REFERENCES roles(code),
  granted_by  uuid REFERENCES users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users(id),
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (granted_by IS DISTINCT FROM user_id),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_active_uq ON user_roles (user_id, role_code) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS user_roles_role_code_idx ON user_roles (role_code);
CREATE INDEX IF NOT EXISTS user_roles_granted_by_idx ON user_roles (granted_by);
CREATE INDEX IF NOT EXISTS user_roles_revoked_by_idx ON user_roles (revoked_by);
SELECT jk_attach_updated_at('user_roles');

CREATE OR REPLACE FUNCTION jk_user_has_role(p_user uuid, p_role text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id
                  WHERE ur.user_id = p_user AND ur.role_code = p_role
                    AND ur.revoked_at IS NULL AND u.status = 'ACTIVE')
$$;

CREATE OR REPLACE FUNCTION jk_user_has_permission(p_user uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM user_roles ur
                   JOIN role_permissions rp ON rp.role_code = ur.role_code
                   JOIN users u ON u.id = ur.user_id
                  WHERE ur.user_id = p_user AND rp.permission_code = p_permission
                    AND ur.revoked_at IS NULL AND u.status = 'ACTIVE')
$$;

CREATE TABLE IF NOT EXISTS mfa_factors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           text NOT NULL DEFAULT 'TOTP' CHECK (type IN ('TOTP')),
  label          text,
  secret_enc     bytea NOT NULL,
  enc_key_id     text NOT NULL,
  confirmed_at   timestamptz,
  last_used_step bigint,          -- TOTP time-step of last accepted code (replay protection)
  last_used_at   timestamptz,
  disabled_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mfa_factors_one_active_totp ON mfa_factors (user_id, type) WHERE disabled_at IS NULL;
SELECT jk_attach_updated_at('mfa_factors');
INSERT INTO jk_sensitive_columns VALUES ('mfa_factors','*','authentication secrets') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  bytea NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);
INSERT INTO jk_sensitive_columns VALUES ('mfa_recovery_codes','*','authentication secrets') ON CONFLICT DO NOTHING;

-- Consent ledger: append-only evidence of what the user agreed to and when.
CREATE TABLE IF NOT EXISTS consents (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  type        text NOT NULL CHECK (type IN ('TOS','PRIVACY','KYC','MARKETING','COOKIES','TRAVELER_AGREEMENT','PAYMENT_TERMS')),
  version     text NOT NULL,
  granted     boolean NOT NULL,
  locale      text CHECK (locale IN ('id','en')),
  source      text NOT NULL DEFAULT 'APP' CHECK (source IN ('APP','WEB','ADMIN','API')),
  ip_hash     bytea,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consents_user_type_idx ON consents (user_id, type, created_at DESC);
SELECT jk_make_append_only('consents');

CREATE OR REPLACE VIEW v_user_consents_current AS
SELECT DISTINCT ON (user_id, type) user_id, type, version, granted, created_at AS decided_at
  FROM consents
 ORDER BY user_id, type, created_at DESC, id DESC;

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category   text NOT NULL CHECK (category IN ('TRANSACTION','CHAT','TRIP','PROMOTION','REFERRAL','SECURITY','SYSTEM')),
  channel    text NOT NULL CHECK (channel IN ('PUSH','EMAIL','SMS','IN_APP')),
  enabled    boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category, channel),
  -- security notifications cannot be switched off entirely
  CHECK (category <> 'SECURITY' OR channel NOT IN ('IN_APP') OR enabled)
);
SELECT jk_attach_updated_at('notification_preferences');

-- Security log (append-only): logins, token reuse, MFA changes, role grants...
CREATE TABLE IF NOT EXISTS security_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid REFERENCES users(id),
  type       text NOT NULL CHECK (type ~ '^[A-Z][A-Z0-9_]*$'),
  severity   text NOT NULL DEFAULT 'LOW' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  device_id  uuid REFERENCES devices(id),
  ip_hash    bytea,
  user_agent text,
  meta       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_events_user_idx ON security_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS security_events_device_id_idx ON security_events (device_id);
CREATE INDEX IF NOT EXISTS security_events_high_idx ON security_events (created_at DESC) WHERE severity IN ('HIGH','CRITICAL');
SELECT jk_make_append_only('security_events');

COMMIT;
