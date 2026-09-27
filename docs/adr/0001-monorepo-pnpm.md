# ADR 0001 — Monorepo with pnpm workspaces

- Status: Accepted (2026-09)
- Deciders: owner (GM), engineering

## Context
JastipKita has one domain model shared by the API, the admin SPA, the public website and (as generated constants)
the Flutter app: price breakdown lines, state machines, customs estimates, fee formulas. Divergent copies of these
rules would show a buyer one price on the website and charge another at checkout. The team is small and partly
made of parallel AI agents, so cross-cutting changes must land atomically and be reviewable in one PR.

## Decision
One Git repository, pnpm workspaces (`pnpm-workspace.yaml`): `apps/api`, `apps/web`, `apps/admin`, `packages/*`.
`packages/core` holds pure TypeScript engines (no I/O) consumed from source; `packages/design-tokens` generates CSS,
TS and Dart tokens. The Flutter app (`apps/mobile`) lives in the same repo but outside the pnpm workspace. pnpm 10 is
pinned through `packageManager`; CI installs with `--frozen-lockfile`.

## Consequences
- One PR can change a fee rule, its tests, the API and the web calculator together; CI runs only affected jobs
  (`scripts/ci/detect-changes.sh`) to save Actions minutes.
- The lockfile is shared: concurrent dependency changes by different contributors conflict and must be rebased.
- pnpm's strict `node_modules` layout catches undeclared imports early; Docker builds use `pnpm fetch` + offline
  install (`apps/api/Dockerfile`).
- Dart cannot import TypeScript: mobile consumes generated tokens and the API, not `packages/core`.

## Alternatives considered
- Polyrepo per app — rejected: rule drift, multi-PR releases.
- npm/yarn workspaces — workable; pnpm chosen for disk efficiency, strictness and speed.
- Nx/Turborepo — not needed at this size; can be added later without restructuring.
