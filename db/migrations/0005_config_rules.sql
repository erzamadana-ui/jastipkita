-- 0005_config_rules.sql
-- Versioned business config (maker-checker), feature flags, experiments, customs &
-- restricted-item rules (exact column contracts shared with seed authors), FAQ, legal.
BEGIN;

-- ---------------------------------------------------------------------------
-- business_configs: one row per (key, version). Exactly one ACTIVE per key.
-- ACTIVE rows are immutable except ACTIVE -> SUPERSEDED; SUPERSEDED/REJECTED are frozen.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_configs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
  version        integer NOT NULL CHECK (version > 0),
  value          jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'DRAFT'
                 CHECK (status IN ('DRAFT','PENDING_APPROVAL','ACTIVE','SUPERSEDED','REJECTED')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  change_reason  text NOT NULL CHECK (char_length(change_reason) >= 3),
  is_assumption  boolean NOT NULL DEFAULT false,   -- value not yet validated (contract/tax/legal)
  notes          text,
  created_by     uuid REFERENCES users(id),        -- NULL = system seed
  approved_by    uuid REFERENCES users(id),
  approved_at    timestamptz,
  rejected_reason text,
  superseded_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, version),
  CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM created_by),   -- maker-checker
  CHECK (status NOT IN ('ACTIVE','SUPERSEDED') OR approved_at IS NOT NULL),
  CHECK (status <> 'SUPERSEDED' OR superseded_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS business_configs_one_active_per_key ON business_configs (key) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS business_configs_pending_idx ON business_configs (created_at) WHERE status = 'PENDING_APPROVAL';
CREATE INDEX IF NOT EXISTS business_configs_created_by_idx ON business_configs (created_by);
CREATE INDEX IF NOT EXISTS business_configs_approved_by_idx ON business_configs (approved_by);
SELECT jk_attach_updated_at('business_configs');

CREATE OR REPLACE FUNCTION jk_business_config_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mutable constant text[] := ARRAY['status','superseded_at','updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('ACTIVE','SUPERSEDED','REJECTED') THEN
      RAISE EXCEPTION USING ERRCODE = 'JK001',
        MESSAGE = format('business_configs %s v%s is %s and cannot be deleted', OLD.key, OLD.version, OLD.status);
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('SUPERSEDED','REJECTED') THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001',
      MESSAGE = format('business_configs %s v%s is %s and immutable', OLD.key, OLD.version, OLD.status);
  END IF;
  IF OLD.status = 'ACTIVE' THEN
    IF NEW.status NOT IN ('ACTIVE','SUPERSEDED')
       OR (to_jsonb(OLD) - v_mutable) IS DISTINCT FROM (to_jsonb(NEW) - v_mutable) THEN
      RAISE EXCEPTION USING ERRCODE = 'JK001',
        MESSAGE = format('business_configs %s v%s is ACTIVE and immutable; create a new version', OLD.key, OLD.version);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_business_config_guard BEFORE UPDATE OR DELETE ON business_configs
  FOR EACH ROW EXECUTE FUNCTION jk_business_config_guard();

-- Approves and activates a PENDING_APPROVAL version atomically: the previous ACTIVE
-- version becomes SUPERSEDED, an audit row is written. Approver must differ from maker.
CREATE OR REPLACE FUNCTION activate_business_config(p_config_id uuid, p_approver uuid)
RETURNS business_configs
LANGUAGE plpgsql AS $$
DECLARE
  v_new business_configs%ROWTYPE;
  v_old business_configs%ROWTYPE;
BEGIN
  SELECT * INTO v_new FROM business_configs WHERE id = p_config_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'JK404', MESSAGE = format('business_config %s not found', p_config_id);
  END IF;
  IF v_new.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION USING ERRCODE = 'JK422',
      MESSAGE = format('business_config %s v%s is %s, expected PENDING_APPROVAL', v_new.key, v_new.version, v_new.status);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('business_configs:' || v_new.key, 0));

  SELECT * INTO v_old FROM business_configs WHERE key = v_new.key AND status = 'ACTIVE' FOR UPDATE;
  IF FOUND THEN
    UPDATE business_configs SET status = 'SUPERSEDED', superseded_at = now() WHERE id = v_old.id;
  END IF;
  UPDATE business_configs
     SET status = 'ACTIVE', approved_by = p_approver, approved_at = now()
   WHERE id = p_config_id
  RETURNING * INTO v_new;

  PERFORM jk_audit('ADMIN', p_approver, 'config.activate', 'business_config', v_new.key,
                   CASE WHEN v_old.id IS NULL THEN NULL
                        ELSE jsonb_build_object('version', v_old.version, 'value', v_old.value) END,
                   jsonb_build_object('version', v_new.version, 'value', v_new.value),
                   jsonb_build_object('configId', v_new.id, 'makerId', v_new.created_by, 'reason', v_new.change_reason));
  PERFORM jk_outbox('business_config', v_new.key, 'config.activated',
                    jsonb_build_object('key', v_new.key, 'version', v_new.version));
  RETURN v_new;
END $$;

CREATE OR REPLACE VIEW v_business_configs_active AS
SELECT key, version, value, effective_from, is_assumption, approved_at
  FROM business_configs WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Feature flags & experiments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feature_flags (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]*$'),
  description text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  rollout_bps integer NOT NULL DEFAULT 0 CHECK (rollout_bps BETWEEN 0 AND 10000),
  rules       jsonb NOT NULL DEFAULT '{}',     -- targeting (platform, country, kyc_level, user allowlist)
  updated_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feature_flags_updated_by_idx ON feature_flags (updated_by);
SELECT jk_attach_updated_at('feature_flags');

CREATE TABLE IF NOT EXISTS experiments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name           text NOT NULL,
  description    text,
  status         text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','RUNNING','PAUSED','COMPLETED','ARCHIVED')),
  variants       jsonb NOT NULL,           -- [{"key":"A","weightBps":5000,"value":...}, ...]
  allocation_bps integer NOT NULL DEFAULT 10000 CHECK (allocation_bps BETWEEN 0 AND 10000),
  primary_metric text,
  starts_at      timestamptz,
  ends_at        timestamptz,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(variants) = 'array' AND jsonb_array_length(variants) >= 1),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS experiments_created_by_idx ON experiments (created_by);
SELECT jk_attach_updated_at('experiments');

CREATE TABLE IF NOT EXISTS experiment_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  anonymous_id  text,
  variant       text NOT NULL,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR anonymous_id IS NOT NULL),
  UNIQUE (experiment_id, user_id),
  UNIQUE (experiment_id, anonymous_id)
);
CREATE INDEX IF NOT EXISTS experiment_assignments_user_id_idx ON experiment_assignments (user_id);

-- ---------------------------------------------------------------------------
-- Versioned regulatory rules. EXACT column contracts (seed files 0100/0101 are
-- written by another author against these names/types). Extra columns below the
-- contract block are nullable or defaulted.
-- Semantics: effective_until is the LAST day in force (inclusive) for lookups.
-- ACTIVE rows are immutable except status -> RETIRED, effective_until and
-- verification metadata; publish changes as a new version.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customs_rules (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                    text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_.-]*$'),
  version                 integer NOT NULL CHECK (version > 0),
  origin_country          char(2) REFERENCES countries(code),
  destination_country     char(2) NOT NULL REFERENCES countries(code),
  hs_code_prefix          text CHECK (hs_code_prefix IS NULL OR hs_code_prefix ~ '^[0-9]{2,10}$'),
  category_code           text REFERENCES product_categories(code),
  treatment               text NOT NULL DEFAULT 'ANY' CHECK (treatment IN ('PERSONAL','NON_PERSONAL','ANY')),
  formula_code            text NOT NULL CHECK (formula_code IN ('ID_PASSENGER_V2025','FLAT_RATES','EXEMPT')),
  exemption_usd           numeric(14,2) CHECK (exemption_usd IS NULL OR exemption_usd >= 0),
  duty_rate               numeric(9,6) NOT NULL DEFAULT 0 CHECK (duty_rate >= 0),
  vat_rate                numeric(9,6) NOT NULL DEFAULT 0 CHECK (vat_rate >= 0),
  vat_dpp_factor          numeric(9,6) NOT NULL DEFAULT 1 CHECK (vat_dpp_factor > 0 AND vat_dpp_factor <= 1),
  luxury_tax_rate         numeric(9,6) NOT NULL DEFAULT 0 CHECK (luxury_tax_rate >= 0),
  income_tax_rate         numeric(9,6) NOT NULL DEFAULT 0 CHECK (income_tax_rate >= 0),
  income_tax_rate_no_npwp numeric(9,6) CHECK (income_tax_rate_no_npwp IS NULL OR income_tax_rate_no_npwp >= 0),
  rounding                text NOT NULL DEFAULT 'NONE' CHECK (rounding IN ('NONE','CEIL_1000','ROUND_1000','CEIL_100')),
  priority                integer NOT NULL DEFAULT 100,
  effective_from          date NOT NULL,
  effective_until         date,
  source_reference        text NOT NULL,
  source_url              text,
  last_verified_at        date NOT NULL,
  verified_by             text,
  notes                   text,
  status                  text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','ACTIVE','RETIRED')),
  -- extras
  created_by              uuid REFERENCES users(id),
  approved_by             uuid REFERENCES users(id),
  approved_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version),
  CHECK (effective_until IS NULL OR effective_until >= effective_from),
  CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM created_by)
);
-- Two ACTIVE versions of the same rule code must not overlap in time. Half-open
-- ranges so adjacent versions pass whether authors treat 'until' as inclusive or exclusive.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customs_rules_no_active_overlap') THEN
    ALTER TABLE customs_rules ADD CONSTRAINT customs_rules_no_active_overlap
      EXCLUDE USING gist (code WITH =, daterange(effective_from, effective_until, '[)') WITH &&)
      WHERE (status = 'ACTIVE');
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS customs_rules_lookup_idx ON customs_rules (destination_country, origin_country, priority)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS customs_rules_category_code_idx ON customs_rules (category_code);
CREATE INDEX IF NOT EXISTS customs_rules_origin_country_idx ON customs_rules (origin_country);
CREATE INDEX IF NOT EXISTS customs_rules_hs_prefix_idx ON customs_rules (hs_code_prefix text_pattern_ops) WHERE hs_code_prefix IS NOT NULL;
CREATE INDEX IF NOT EXISTS customs_rules_created_by_idx ON customs_rules (created_by);
CREATE INDEX IF NOT EXISTS customs_rules_approved_by_idx ON customs_rules (approved_by);
SELECT jk_attach_updated_at('customs_rules');

CREATE TABLE IF NOT EXISTS restricted_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_.-]*$'),
  version             integer NOT NULL CHECK (version > 0),
  origin_country      char(2) REFERENCES countries(code),
  destination_country char(2) NOT NULL REFERENCES countries(code),
  category_code       text REFERENCES product_categories(code),
  hs_code_prefix      text CHECK (hs_code_prefix IS NULL OR hs_code_prefix ~ '^[0-9]{2,10}$'),
  keywords            text[] NOT NULL DEFAULT '{}',
  classification      text NOT NULL CHECK (classification IN ('ALLOWED','RESTRICTED','DECLARATION_REQUIRED','PERMIT_REQUIRED','PROHIBITED')),
  max_quantity        integer CHECK (max_quantity IS NULL OR max_quantity > 0),
  max_value_usd       numeric(14,2) CHECK (max_value_usd IS NULL OR max_value_usd >= 0),
  permit_authority    text,
  airline_dg          boolean NOT NULL DEFAULT false,
  message_id          text NOT NULL,
  message_en          text NOT NULL,
  source_reference    text NOT NULL,
  source_url          text,
  effective_from      date NOT NULL,
  effective_until     date,
  last_verified_at    date NOT NULL,
  status              text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PENDING_APPROVAL','ACTIVE','RETIRED')),
  -- extras
  verified_by         text,
  notes               text,
  created_by          uuid REFERENCES users(id),
  approved_by         uuid REFERENCES users(id),
  approved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version),
  CHECK (effective_until IS NULL OR effective_until >= effective_from),
  CHECK (approved_by IS NULL OR approved_by IS DISTINCT FROM created_by)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restricted_items_no_active_overlap') THEN
    ALTER TABLE restricted_items ADD CONSTRAINT restricted_items_no_active_overlap
      EXCLUDE USING gist (code WITH =, daterange(effective_from, effective_until, '[)') WITH &&)
      WHERE (status = 'ACTIVE');
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS restricted_items_lookup_idx ON restricted_items (destination_country, origin_country, classification)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS restricted_items_category_code_idx ON restricted_items (category_code);
CREATE INDEX IF NOT EXISTS restricted_items_origin_country_idx ON restricted_items (origin_country);
CREATE INDEX IF NOT EXISTS restricted_items_keywords_gin ON restricted_items USING gin (keywords);
CREATE INDEX IF NOT EXISTS restricted_items_hs_prefix_idx ON restricted_items (hs_code_prefix text_pattern_ops) WHERE hs_code_prefix IS NOT NULL;
CREATE INDEX IF NOT EXISTS restricted_items_created_by_idx ON restricted_items (created_by);
CREATE INDEX IF NOT EXISTS restricted_items_approved_by_idx ON restricted_items (approved_by);
SELECT jk_attach_updated_at('restricted_items');

-- Shared guard for versioned rule tables.
CREATE OR REPLACE FUNCTION jk_versioned_rule_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_mutable constant text[] := ARRAY['status','effective_until','last_verified_at','verified_by','notes','updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('ACTIVE','RETIRED') THEN
      RAISE EXCEPTION USING ERRCODE = 'JK001',
        MESSAGE = format('%s %s v%s is %s and cannot be deleted', TG_TABLE_NAME, OLD.code, OLD.version, OLD.status);
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'RETIRED' AND to_jsonb(OLD) - 'updated_at' IS DISTINCT FROM to_jsonb(NEW) - 'updated_at' THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001',
      MESSAGE = format('%s %s v%s is RETIRED and immutable', TG_TABLE_NAME, OLD.code, OLD.version);
  END IF;
  IF OLD.status = 'ACTIVE' AND (NEW.status NOT IN ('ACTIVE','RETIRED')
       OR (to_jsonb(OLD) - v_mutable) IS DISTINCT FROM (to_jsonb(NEW) - v_mutable)) THEN
    RAISE EXCEPTION USING ERRCODE = 'JK001',
      MESSAGE = format('%s %s v%s is ACTIVE and immutable; publish a new version', TG_TABLE_NAME, OLD.code, OLD.version);
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_versioned_rule_guard BEFORE UPDATE OR DELETE ON customs_rules
  FOR EACH ROW EXECUTE FUNCTION jk_versioned_rule_guard();
CREATE OR REPLACE TRIGGER trg_versioned_rule_guard BEFORE UPDATE OR DELETE ON restricted_items
  FOR EACH ROW EXECUTE FUNCTION jk_versioned_rule_guard();

-- ---------------------------------------------------------------------------
-- Content: FAQ & legal documents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faq_articles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
  locale       text NOT NULL DEFAULT 'id' CHECK (locale IN ('id','en')),
  category     text NOT NULL CHECK (category IN ('GENERAL','BUYER','TRAVELER','PAYMENT','CUSTOMS','DELIVERY','DISPUTE','ACCOUNT','REFERRAL')),
  question     text NOT NULL,
  answer_md    text NOT NULL,
  tags         text[] NOT NULL DEFAULT '{}',
  sort_order   integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  published_at timestamptz,
  search_text  text GENERATED ALWAYS AS (question || ' ' || answer_md) STORED,
  created_by   uuid REFERENCES users(id),
  updated_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug, locale),
  CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS faq_articles_search_trgm ON faq_articles USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS faq_articles_published_idx ON faq_articles (locale, category, sort_order) WHERE status = 'PUBLISHED';
CREATE INDEX IF NOT EXISTS faq_articles_created_by_idx ON faq_articles (created_by);
CREATE INDEX IF NOT EXISTS faq_articles_updated_by_idx ON faq_articles (updated_by);
SELECT jk_attach_updated_at('faq_articles');

CREATE TABLE IF NOT EXISTS legal_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL CHECK (type IN ('TOS','PRIVACY','KYC','MARKETING','COOKIES','TRAVELER_AGREEMENT',
                                             'PAYMENT_TERMS','REFUND_POLICY','PROHIBITED_ITEMS')),
  version      text NOT NULL CHECK (version ~ '^[0-9A-Za-z._-]+$'),
  locale       text NOT NULL CHECK (locale IN ('id','en')),
  title        text NOT NULL,
  body_md      text NOT NULL,
  summary_of_changes text,
  published_at timestamptz,
  retired_at   timestamptz,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type, version, locale)
);
CREATE INDEX IF NOT EXISTS legal_documents_current_idx ON legal_documents (type, locale, published_at DESC) WHERE published_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS legal_documents_created_by_idx ON legal_documents (created_by);
SELECT jk_attach_updated_at('legal_documents');

-- Published legal text is evidence of what users consented to: immutable.
CREATE OR REPLACE FUNCTION jk_legal_document_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    IF TG_OP = 'DELETE' OR (to_jsonb(OLD) - ARRAY['retired_at','updated_at'])
                           IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['retired_at','updated_at']) THEN
      RAISE EXCEPTION USING ERRCODE = 'JK001',
        MESSAGE = format('legal document %s %s (%s) is published and immutable', OLD.type, OLD.version, OLD.locale);
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE OR REPLACE TRIGGER trg_legal_document_guard BEFORE UPDATE OR DELETE ON legal_documents
  FOR EACH ROW EXECUTE FUNCTION jk_legal_document_guard();

COMMIT;
