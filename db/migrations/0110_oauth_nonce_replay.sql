-- 0110_oauth_nonce_replay.sql
-- SEC-15 (docs/security/review-2026-09.md): replay of a captured Google/Apple ID token.
--   An ID token whose nonce was verified by the API (Apple: always — OAUTH_REQUIRE_NONCE default APPLE; Google: when
--   the client sends one, the web does) is SINGLE USE: the first successful sign-in records (provider, SHA-256(nonce
--   claim)) until the token expires; presenting the same token again → 401 OAUTH_TOKEN_INVALID {reason: NONCE_REUSED}.
--   Rows hold no personal data (no user id, no token) and are purged by the API after expiry.
-- Forward-only, idempotent (re-applied raw by db/scripts/test-db.sh). Additive only.
BEGIN;

CREATE TABLE IF NOT EXISTS oauth_nonce_uses (
  provider    text        NOT NULL CHECK (provider IN ('GOOGLE','APPLE')),
  nonce_hash  bytea       NOT NULL CHECK (octet_length(nonce_hash) = 32),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, nonce_hash)
);
CREATE INDEX IF NOT EXISTS oauth_nonce_uses_expires_at_idx ON oauth_nonce_uses (expires_at);
COMMENT ON TABLE oauth_nonce_uses IS
  'SEC-15: nonces of Google/Apple ID tokens already used for a successful sign-in (single use until expires_at = token exp + 60 s). No PII.';
COMMENT ON COLUMN oauth_nonce_uses.nonce_hash IS 'SHA-256 of the verified ID-token nonce claim.';

SELECT jk_apply_grants();

COMMIT;
