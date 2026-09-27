-- 0070_legal_public_documents.sql
-- QA/E2E contract-gap range (0070-0079): public legal documents API (GET /v1/legal/documents, /v1/consents/requirements).
--   1. legal_documents.type accepts COMMUNITY_GUIDELINES (docs/legal/community-guidelines.md has no type yet)
--   2. legal_documents.summary      — one-line description shown in document lists (frontmatter `description`)
--   3. legal_documents.effective_at — when the version takes effect (NULL = effective when published)
-- Published rows stay immutable (jk_legal_document_guard compares whole rows, so the new columns are covered too).
-- Forward-only, idempotent (re-applied raw by db/scripts/test-db.sh). Additive only.
BEGIN;

ALTER TABLE legal_documents DROP CONSTRAINT IF EXISTS legal_documents_type_check;
ALTER TABLE legal_documents ADD CONSTRAINT legal_documents_type_check
  CHECK (type IN ('TOS','PRIVACY','KYC','MARKETING','COOKIES','TRAVELER_AGREEMENT','PAYMENT_TERMS','REFUND_POLICY',
                  'PROHIBITED_ITEMS','COMMUNITY_GUIDELINES'));

ALTER TABLE legal_documents ADD COLUMN IF NOT EXISTS summary text CHECK (summary IS NULL OR char_length(summary) <= 1000);
ALTER TABLE legal_documents ADD COLUMN IF NOT EXISTS effective_at timestamptz;

COMMENT ON COLUMN legal_documents.summary IS 'Short description for document lists (public API); immutable once published';
COMMENT ON COLUMN legal_documents.effective_at IS 'Effective date of this version; NULL = effective at published_at';

SELECT jk_apply_grants();

COMMIT;
