-- 0080_security_hardening.sql
-- Security review 2026-09 (docs/security/review-2026-09.md) — range 0080-0089.
--   SEC-01: admin sessions must be MFA-verified SERVER-SIDE. The admin SPA's login-time TOTP gate was a
--           sessionStorage flag only, so an admin whose OTP was phished/SIM-swapped could call every
--           /v1/admin/* read (and non-step-up writes) and stream KYC documents without ever passing TOTP.
--           refresh_tokens.mfa_verified_at records the last TOTP/recovery-code verification of the session
--           (refresh-token family); it is copied forward on rotation and read by requireAdmin.
-- Forward-only, idempotent (re-applied raw by db/scripts/test-db.sh). Additive only.
BEGIN;

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;
COMMENT ON COLUMN refresh_tokens.mfa_verified_at IS
  'Last MFA (TOTP / recovery code) verification of this session family; copied on rotation. Admin routes require it (SEC-01).';

--   SEC-09: anonymize_user() predates the money/engagement migrations and left the buyer's refund bank destination
--           (account number + holder name ciphertext, 0040) and free-text offer/invite messages behind. The ciphertext
--           columns become nullable (NULL only after anonymization) and the function is redefined with both scrubs.
ALTER TABLE refund_destinations ALTER COLUMN account_number_enc DROP NOT NULL;
ALTER TABLE refund_destinations ALTER COLUMN holder_name_enc DROP NOT NULL;
ALTER TABLE refund_destinations ALTER COLUMN enc_key_id DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refund_destinations_anonymized_chk') THEN
    ALTER TABLE refund_destinations ADD CONSTRAINT refund_destinations_anonymized_chk
      CHECK ((account_number_enc IS NULL) = (holder_name_enc IS NULL) AND (account_number_enc IS NULL OR enc_key_id IS NOT NULL));
  END IF;
END $$;

-- anonymize_user(): body of 0014 + refund_destinations + offers.message (SEC-09).
CREATE OR REPLACE FUNCTION anonymize_user(p_user uuid, p_actor uuid DEFAULT NULL, p_purge_kyc boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_user users%ROWTYPE;
  v_blockers jsonb;
  v_kyc_days integer;
  v_purge_at timestamptz;
  v_credit bigint;
  v_counts jsonb := '{}';
  v_n integer;
BEGIN
  SELECT * INTO v_user FROM users WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'JK404', MESSAGE = format('user %s not found', p_user);
  END IF;
  IF v_user.anonymized_at IS NOT NULL THEN
    RETURN jsonb_build_object('userId', p_user, 'alreadyAnonymized', true);
  END IF;

  SELECT jsonb_strip_nulls(jsonb_build_object(
    'activeTransactions', nullif((SELECT count(*) FROM transactions
                                   WHERE (buyer_id = p_user OR traveler_id = p_user)
                                     AND status NOT IN ('COMPLETED','CANCELLED','REFUNDED')), 0),
    'openDisputes', nullif((SELECT count(*) FROM disputes d JOIN transactions t ON t.id = d.transaction_id
                             WHERE d.status <> 'CLOSED' AND (t.buyer_id = p_user OR t.traveler_id = p_user)), 0),
    'pendingPayouts', nullif((SELECT count(*) FROM payouts
                               WHERE traveler_id = p_user AND status IN ('SCHEDULED','ON_HOLD','PROCESSING')), 0),
    'inflightRefunds', nullif((SELECT count(*) FROM refunds r JOIN transactions t ON t.id = r.transaction_id
                                WHERE t.buyer_id = p_user AND r.status NOT IN ('SUCCEEDED','REJECTED','CANCELLED')), 0)))
    INTO v_blockers;
  IF v_blockers <> '{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = 'JK423',
      MESSAGE = format('user %s cannot be anonymized yet', p_user), DETAIL = v_blockers::text;
  END IF;

  SELECT retention_days INTO v_kyc_days FROM data_retention_policies WHERE entity = 'identity_records' AND enabled;
  v_purge_at := CASE WHEN p_purge_kyc THEN now() ELSE now() + make_interval(days => coalesce(v_kyc_days, 1825)) END;

  -- 1. Profile & contact data
  UPDATE users
     SET email = NULL, email_verified_at = NULL, phone_e164 = NULL, phone_verified_at = NULL,
         password_hash = NULL, display_name = NULL, avatar_file_id = NULL, transaction_email = NULL,
         last_login_at = NULL, suspension_reason = NULL,
         status = 'DELETED', deleted_at = coalesce(deleted_at, now()), anonymized_at = now()
   WHERE id = p_user;

  -- 2. Credentials, sessions, device links, personal settings, inbox
  DELETE FROM auth_identities WHERE user_id = p_user;          GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('authIdentities', v_n);
  DELETE FROM refresh_tokens WHERE user_id = p_user;           GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('refreshTokens', v_n);
  DELETE FROM otp_challenges WHERE user_id = p_user;
  DELETE FROM mfa_recovery_codes WHERE user_id = p_user;
  DELETE FROM mfa_factors WHERE user_id = p_user;
  DELETE FROM user_devices WHERE user_id = p_user;
  DELETE FROM notification_preferences WHERE user_id = p_user;
  DELETE FROM notifications WHERE user_id = p_user;            GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('notifications', v_n);
  DELETE FROM idempotency_keys WHERE user_id = p_user;
  DELETE FROM experiment_assignments WHERE user_id = p_user;
  DELETE FROM analytics_events WHERE user_id = p_user;         GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('analyticsEvents', v_n);
  UPDATE user_roles SET revoked_at = now(), revoked_by = p_actor, reason = 'account anonymized'
   WHERE user_id = p_user AND revoked_at IS NULL;

  -- 3. Bank accounts: keep hash + mask (payout history, fraud dedupe), drop ciphertext & name
  UPDATE payout_accounts
     SET account_number_enc = NULL, holder_name = 'REDACTED', is_default = false,
         disabled_at = coalesce(disabled_at, now())
   WHERE user_id = p_user;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('payoutAccounts', v_n);
  -- SEC-09: refund bank destinations (0040) hold the buyer's account number + holder name ciphertext
  UPDATE refund_destinations
     SET account_number_enc = NULL, holder_name_enc = NULL, enc_key_id = NULL
   WHERE buyer_id = p_user AND account_number_enc IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('refundDestinations', v_n);

  -- 4. KYC: purge now or schedule per retention policy
  IF p_purge_kyc THEN
    DELETE FROM identity_records WHERE user_id = p_user;
  ELSE
    UPDATE identity_records SET purge_after = v_purge_at WHERE user_id = p_user;
  END IF;
  UPDATE kyc_documents SET purge_after = v_purge_at WHERE user_id = p_user AND purged_at IS NULL;
  UPDATE files SET retention_until = v_purge_at WHERE owner_id = p_user AND purpose = 'KYC' AND deleted_at IS NULL;

  -- 5. Personal files (avatar, chat attachments, exports) -> purge job deletes objects
  UPDATE files SET retention_until = now()
   WHERE owner_id = p_user AND purpose IN ('AVATAR','CHAT','EXPORT') AND deleted_at IS NULL;

  -- 6. Free text written by the user
  UPDATE messages m
     SET body = NULL, attachments = '[]', meta = '{}', deleted_at = coalesce(m.deleted_at, now())
   WHERE m.sender_id = p_user
     AND NOT EXISTS (SELECT 1 FROM dispute_evidence de WHERE de.message_id = m.id);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('messagesScrubbed', v_n);
  UPDATE ticket_messages SET body = '[dihapus atas permintaan pengguna]', attachments = '[]' WHERE author_id = p_user;
  UPDATE support_tickets SET subject = '[dihapus]' WHERE user_id = p_user;
  UPDATE ratings SET comment = NULL WHERE rater_id = p_user AND comment IS NOT NULL;
  UPDATE requests SET notes = NULL, extraction = '{}' WHERE buyer_id = p_user;
  UPDATE trips SET notes = NULL WHERE traveler_id = p_user AND notes IS NOT NULL;
  -- SEC-09: free-text offer/invite messages written by the user (traveler offers, buyer invites)
  UPDATE offers o SET message = NULL
   WHERE o.message IS NOT NULL
     AND ((o.initiated_by = 'TRAVELER' AND o.traveler_id = p_user)
          OR (o.initiated_by = 'BUYER' AND EXISTS (SELECT 1 FROM requests r WHERE r.id = o.request_id AND r.buyer_id = p_user)));

  -- 7. Delivery addresses / meetup points / one-time secrets
  UPDATE deliveries d
     SET address_enc = NULL, enc_key_id = NULL, meetup_point = NULL, pin_hash = NULL, qr_token_hash = NULL
    FROM transactions t
   WHERE t.id = d.transaction_id AND t.buyer_id = p_user;

  -- 8. Forfeit remaining JastipKita Credit (non-withdrawable by policy)
  SELECT coalesce(sum(amount_idr), 0) INTO v_credit FROM credit_entries WHERE user_id = p_user;
  IF v_credit > 0 THEN
    INSERT INTO credit_entries (user_id, amount_idr, reason, reference_type, reference_id, note)
    VALUES (p_user, -v_credit, 'EXPIRY', 'account_deletion', p_user, 'forfeited on account anonymization');
  END IF;
  v_counts := v_counts || jsonb_build_object('creditForfeitedIdr', v_credit);

  -- 9. Record (no PII) + notify downstream processors (storage purge, email/push providers)
  PERFORM jk_outbox('user', p_user::text, 'user.anonymized',
                    jsonb_build_object('userId', p_user, 'kycPurgeAt', v_purge_at));
  PERFORM jk_audit(CASE WHEN p_actor IS NULL THEN 'SYSTEM' ELSE 'ADMIN' END, p_actor, 'privacy.user_anonymized',
                   'user', p_user::text, NULL, v_counts,
                   jsonb_build_object('purgeKycNow', p_purge_kyc, 'kycPurgeAt', v_purge_at));
  RETURN jsonb_build_object('userId', p_user, 'anonymizedAt', now(), 'kycPurgeAt', v_purge_at) || v_counts;
END $$;

SELECT jk_apply_grants();

COMMIT;
