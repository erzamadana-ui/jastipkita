# Contributing to JastipKita

Read first: `CONVENTIONS.md` (binding), `docs/00-domain-model.md` (domain source of truth), `docs/dev/api-module-guide.md`
(API modules), `db/migrations/README.md` (migrations).

## Branches
- `main` — protected; every push deploys **staging** (after CI). Production deploys are manual.
- `develop` — integration branch; Dependabot PRs land here.
- `feat/<scope>-<short>`, `fix/<scope>-<short>`, `chore/…`, `docs/…` → PR into `develop`; release PR `develop` → `main`.
- Never push directly to `main`. Keep PRs small (< ~400 changed lines excluding generated files) — CI minutes are limited.

## Commits — Conventional Commits
`<type>(<scope>): <summary>` in English, imperative, ≤ 72 chars. Types: `feat`, `fix`, `docs`, `test`, `refactor`,
`perf`, `chore`, `ci`, `build`, `revert`. Scopes: `core`, `api`, `db`, `web`, `admin`, `mobile`, `infra`, `ci`, `brand`, `docs`.
Breaking change: `!` after the scope and a `BREAKING CHANGE:` footer.
Examples: `feat(api): add payout hold release endpoint`, `fix(db): index FK on refund_events.refund_id`.

## Pull request checklist
Copy into the PR description (the template does this):
- [ ] CI green (skipped jobs are fine when their inputs did not change).
- [ ] Tests added/updated for behaviour changes (core unit, API integration, SQL tests for DB rules).
- [ ] `docs/api/openapi.json` regenerated if routes/schemas changed (`pnpm --filter @jastipkita/api openapi`).
- [ ] Domain doc updated **first** if a state machine, price line or fund bucket changes (`docs/00-domain-model.md`).
- [ ] **Security review**: authz/ownership checks on new endpoints, input validated with zod, no secrets/PII in code, logs,
      fixtures or error messages, SQL parameterized, new external calls behind a provider interface with a MOCK.
- [ ] **Money review** (if touching payments/ledger/refunds/payouts/config): journals balance, idempotency keys, FSM-only
      status changes, audit as last statement, maker-checker preserved. Needs a second reviewer.
- [ ] **Migration review** (if `db/migrations/` changed): new file in your group's number range, exactly one `BEGIN;`/`COMMIT;`,
      idempotent, FK indexes, sensitive columns registered, ends with `SELECT jk_apply_grants();`, **no edit of an applied
      migration**, `bash db/scripts/test-db.sh` passes, rollback/compensation plan stated in the PR.
- [ ] Integrations still honestly labelled (MOCK/SANDBOX), nothing claims LIVE.
- [ ] User-facing text in Indonesian (+ English l10n where applicable).
- [ ] `bash scripts/ci/secret-grep.sh` clean.

## Local checks before pushing
```bash
pnpm --filter @jastipkita/core test && pnpm --filter @jastipkita/api typecheck
bash db/scripts/test-db.sh                 # when db/ changed
bash scripts/ci/secret-grep.sh
```

## Secrets
Never commit `.env`, keys, keystores, dumps or real customer data. Use `scripts/gen-secrets.sh` and the GitHub Environment
secrets described in `docs/07-deployment.md`. If you leak something: tell the owner immediately and follow
`docs/runbooks/security-incident.md` (rotate first).
