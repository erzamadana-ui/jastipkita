# ADR 0008 — Versioned business configuration with maker-checker

- Status: Accepted (2026-09)
- Deciders: owner (GM), engineering, finance

## Context
Fees, limits, referral amounts, cancellation matrices and customs/restricted-item rules change often and directly
move money. Changing them in code requires a deploy; changing them in a database row without controls lets one
person silently alter what buyers pay or travelers earn.

## Decision
- All business parameters live in `business_configs` (key → JSON, version, status DRAFT/PENDING_APPROVAL/ACTIVE/
  SUPERSEDED/REJECTED). Exactly one ACTIVE row per key; ACTIVE rows are immutable (DB guard). Defaults are seeded from
  `packages/core/src/config/business-config.defaults.json` and validated by core.
- Activation requires a second person: `approved_by <> created_by` (DB CHECK) via `activate_business_config()`,
  audited in the hash chain. Customs and restricted-item rules follow the same versioning (ACTIVE → RETIRED).
- The same maker-checker pattern protects settlement accounts (FINANCE_SUPER_ADMIN + fresh MFA), trust overrides,
  large refunds, privileged role grants and destructive DB operations (RESTORE/SWITCH/ROLLBACK/IMPORT).
- Every quote line stores `ruleRef` (config key + version) so any past price can be explained.

## Consequences
- No deploy is needed to change a fee, but two admins are needed — the owner must appoint at least two people with
  the right roles before launch.
- Seeds never modify ACTIVE rows: changing a default for an existing database is done through the Admin UI.
- Values marked "assumption" in the defaults (payment fees, service tax, limits, SLAs) must be reviewed before
  production (`docs/checklists/launch-checklist.md`).

## Alternatives considered
- Environment variables / feature-flag SaaS — no audit trail tied to money, no maker-checker.
