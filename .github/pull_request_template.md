## What & why
<!-- One paragraph. Link the issue/decision. -->

## Checklist (CONTRIBUTING.md)
- [ ] CI green
- [ ] Tests added/updated
- [ ] OpenAPI regenerated (if API changed)
- [ ] Domain doc updated first (if FSM / price lines / buckets changed)
- [ ] Security review: authz, validation, no secrets/PII, parameterized SQL, provider + MOCK
- [ ] Money review (payments/ledger/refunds/payouts/config) — second reviewer: @
- [ ] Migration review (new file in range, idempotent, FK indexes, `jk_apply_grants()`, no edit of applied migration, test-db.sh passes) — rollback/compensation plan:
- [ ] Integrations labelled honestly (MOCK/SANDBOX)
- [ ] `bash scripts/ci/secret-grep.sh` clean
