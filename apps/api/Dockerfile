# syntax=docker/dockerfile:1.7
# JastipKita API — Node 22 container (local dev via infra/docker/docker-compose.yml, or a Node host if the
# Workers free plan is outgrown — see docs/01-architecture.md §9). Build context = REPOSITORY ROOT:
#
#   docker build -f apps/api/Dockerfile -t jastipkita-api .
#   docker run --rm -p 8787:8787 --env-file infra/env/development.env jastipkita-api
#
# Stages: deps (pnpm fetch from the lockfile only) → build (offline install + esbuild bundle) → runtime (no
# node_modules, no package manager, non-root, read-only friendly). Secrets are NEVER baked in: pass them at run time.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

# ---- deps: download every package in the lockfile into the pnpm store (cached layer)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile

# ---- build: offline install of the API and its workspace deps, then bundle to plain ESM
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/design-tokens ./packages/design-tokens
COPY apps/api ./apps/api
COPY infra/docker/bundle-api.mjs ./infra/docker/bundle-api.mjs
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --filter "@jastipkita/api..."
RUN node infra/docker/bundle-api.mjs /out

# ---- runtime
FROM node:${NODE_VERSION}-alpine AS runtime
LABEL org.opencontainers.image.title="jastipkita-api" \
      org.opencontainers.image.description="JastipKita API (Hono on Node 22)" \
      org.opencontainers.image.source="https://github.com/erzamadana-ui/jastipkita"
ENV NODE_ENV=production \
    PORT=8787 \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=build --chown=node:node /out/ ./
USER node
EXPOSE 8787
# /health is a liveness probe that does not touch the database (/v1/health checks the DB and integrations).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# server.mjs = HTTP + in-process job loop (WORKER_ENABLED). For a separate job worker: CMD ["node", "worker.mjs"]
CMD ["node", "server.mjs"]
