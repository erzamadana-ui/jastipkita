# ADR 0002 — Hono API on Cloudflare Workers, portable to Node

- Status: Accepted (2026-09)
- Deciders: owner (GM), engineering

## Context
The owner requires $0 hosting until traction is proven, but the product handles money and personal data and must be
able to move to a stronger runtime without a rewrite. Cloudflare Workers has a free tier with global edge and Cron
Triggers; it also has hard CPU/memory limits (10 ms CPU per invocation on Free).

## Decision
- HTTP framework: **Hono** with `@hono/zod-openapi` (standards-based `fetch` handler, OpenAPI 3.1 from the same zod
  schemas that validate requests).
- Only Web-standard APIs in runtime code (fetch, WebCrypto, streams); external services through `fetch`
  (aws4fetch for S3/R2 SigV4). PostgreSQL via postgres.js, which supports Workers TCP sockets
  (`compatibility_flags = ["nodejs_compat"]`).
- Two entry points over one `createApp(deps)`: `src/worker.ts` (Workers: `fetch` + `scheduled`) and
  `src/server.node.ts` / `src/worker.node.ts` (Node 22, containers: `apps/api/Dockerfile`).
- Background work is DB-driven (jobs/outbox tables, SKIP LOCKED) so it runs identically from a Cron Trigger or a
  Node loop.

## Consequences
- Staging runs on Workers Free (`infra/cloudflare/wrangler.toml`); production can choose Workers Paid or a Node
  container by configuration.
- Workers Free is tight: see `docs/01-architecture.md` §10 (measured ≈ 7 ms CPU per request for `createApp()` alone
  because `worker.ts` builds the app per request). Caching the app per isolate is a pending API change.
- Node-only modules (`node:fs`, `node:crypto` beyond WebCrypto) are not allowed in runtime code (only in tests/scripts).
- One DB connection per Worker request (no cross-request sockets) → pooled connection strings, `prepare: false`.

## Alternatives considered
- Express/Fastify on a VM — no free tier that is production-safe; always-on cost.
- Supabase Edge Functions/PostgREST — couples the API to one provider and exposes the schema.
- Cloud Run — generous free tier but needs a billing account; kept as the container target.
