-- 0002_reference.sql
-- Reference data keyed by natural codes (seeded from packages/core/src/config/*.json).
-- Deliberate exception to the uuid-PK rule: these rows are referenced by code across
-- the system and in config JSON, so the code IS the identity.
BEGIN;

CREATE TABLE IF NOT EXISTS currencies (
  code        char(3) PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  minor_units smallint NOT NULL CHECK (minor_units BETWEEN 0 AND 4),
  name        text NOT NULL,
  symbol      text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
SELECT jk_attach_updated_at('currencies');

CREATE TABLE IF NOT EXISTS countries (
  code           char(2) PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
  name_id        text NOT NULL,
  name_en        text NOT NULL,
  currency_code  char(3) NOT NULL REFERENCES currencies(code),
  is_origin      boolean NOT NULL DEFAULT false,
  is_destination boolean NOT NULL DEFAULT false,
  risk_level     text NOT NULL DEFAULT 'MEDIUM' CHECK (risk_level IN ('LOW','MEDIUM','HIGH')),
  activation     text NOT NULL DEFAULT 'INACTIVE' CHECK (activation IN ('ACTIVE','SOFT_LAUNCH','INACTIVE')),
  slug           text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS countries_currency_code_idx ON countries (currency_code);
SELECT jk_attach_updated_at('countries');

CREATE TABLE IF NOT EXISTS product_categories (
  code              text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  parent_code       text REFERENCES product_categories(code),
  name_id           text NOT NULL,
  name_en           text NOT NULL,
  risk_level        text NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH')),
  requires_serial   boolean NOT NULL DEFAULT false,
  requires_video    boolean NOT NULL DEFAULT false,
  default_weight_kg numeric(6,3) CHECK (default_weight_kg IS NULL OR default_weight_kg > 0),
  default_hs_code   text CHECK (default_hs_code IS NULL OR default_hs_code ~ '^[0-9]{2,10}$'),
  is_active         boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_categories_parent_code_idx ON product_categories (parent_code);
SELECT jk_attach_updated_at('product_categories');

COMMIT;
