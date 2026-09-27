# JastipKita

**Titip Mudah, Aman, Terpercaya.** — marketplace P2P jasa titip (jastip): penitip di Indonesia menitip belanja ke
traveler terverifikasi di luar negeri (awal: JP, SG, KR, MY, AU, US). Dana pembeli ditahan melalui mitra pembayaran
berlisensi Bank Indonesia (**SafePay**, via Xendit) sampai barang diterima; setiap transaksi menampilkan landed cost lengkap
(harga, traveler fee, estimasi bea & pajak, fee platform).

> **Status: pra-peluncuran.** Tidak ada yang live. Semua integrasi MOCK/SANDBOX (tabel di bawah). Production butuh
> persetujuan owner (`docs/checklists/launch-checklist.md`).

## Monorepo
| Path | Isi | Stack |
|---|---|---|
| `packages/core` | engine domain murni: pricing, customs/tax, FX, state machines, matching, trust, fraud, limits, restricted items, cancellation, referral, promo | TypeScript, tanpa I/O |
| `packages/design-tokens` | token warna/tipografi → CSS, TS, Dart | Node script |
| `apps/api` | HTTP API `/v1` + job worker | Hono, zod-openapi, postgres.js — Cloudflare Workers & Node 22 |
| `db/` | migrasi SQL (forward-only), seed, runner psql, tes SQL | PostgreSQL 16/17 |
| `apps/web` | situs publik `antarkitaindonesia.com/jastipkita/` | Astro (static) |
| `apps/admin` | admin SPA (RBAC + MFA), tidak diindeks | React (sedang dibangun) |
| `apps/mobile` | aplikasi Android/iOS/web, mode penitip & traveler | Flutter (sedang dibangun) |
| `infra/` | `cloudflare/wrangler.toml`, `docker/` (compose dev, bundler), `env/*.env.example` | — |
| `scripts/` | `gen-secrets.sh`, helper CI (`scripts/ci/`) | bash, Node |
| `brand/` | logo, ikon aplikasi, splash, aset toko | — |
| `docs/` | arsitektur, domain, DB, pembayaran, API, deployment, keamanan, privasi, runbook, checklist | Markdown |

## Quick start (lokal)
Prasyarat: Node 22, `corepack enable` (pnpm 10 dari `packageManager`), PostgreSQL 16 **atau** Docker, `psql`.

```bash
pnpm install

# database lokal (Docker) + migrasi + seed + role API dev
docker compose -f infra/docker/docker-compose.yml up -d db
docker compose -f infra/docker/docker-compose.yml --profile tools run --rm migrate
#   tanpa Docker: DATABASE_URL=postgres://postgres@localhost:5432/jastipkita_dev bash db/scripts/migrate.sh && … seed.sh

# konfigurasi API (file .env tidak di-commit)
cp infra/env/development.env.example apps/api/.env
bash scripts/gen-secrets.sh development >> apps/api/.env    # JWT_SECRET, DATA_ENCRYPTION_KEYS, HMAC_PEPPER (baris terakhir menang)

# jalankan API (server.node.ts membaca process.env; muat .env ke shell dulu)
set -a && . apps/api/.env && set +a && pnpm dev:api
curl -s localhost:8787/v1/health        # status ok, integrations MOCK
open http://localhost:8787/v1/openapi.json
```
Dev: OTP dikembalikan di respons (`OTP_DEV_ECHO=true`), pembayaran disimulasikan di `/v1/dev/mock-checkout/{ref}`,
unggahan di memori. Web: `pnpm dev:web` (http://localhost:4321/jastipkita/).

## Tes
```bash
pnpm --filter @jastipkita/core test                     # 280+ unit test engine (doc ↔ code FSM parity)
bash db/scripts/test-db.sh                              # 325 cek SQL: FSM, append-only, ledger, audit chain, grants, rollback
TEST_PG_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm --filter @jastipkita/api test   # integrasi API (butuh superuser)
pnpm --filter @jastipkita/api typecheck
pnpm --filter @jastipkita/api openapi                   # regenerasi docs/api/openapi.json (CI gagal bila basi)
bash scripts/ci/secret-grep.sh                          # penjaga secret sebelum commit
```

## CI/CD (`.github/workflows/`)
| Workflow | Pemicu | Isi |
|---|---|---|
| `ci.yml` | push/PR `main`, `develop` | core, db (PG 16 & 17 + parity Neon), api (tes, OpenAPI, bundle Worker & container), web, admin, mobile (Flutter), secret scan (guard + gitleaks), dependency audit (pnpm audit, OSV, Semgrep) |
| `codeql.yml` | push/PR `main`, mingguan | nonaktif sampai `CODEQL_ENABLED=true` (repo private butuh lisensi) |
| `deploy-staging.yml` | CI sukses di `main`, manual | migrasi Neon → deploy Worker + secret → smoke → web (antarkita-landing) → admin (Pages) |
| `deploy-production.yml` | manual saja | gerbang aktor/konfirmasi/CI/keputusan LIVE → backup → migrasi → deploy → smoke → rollback |
| `db-backup.yml` | harian 02:17 WIB, manual | `pg_dump` → age → artifact (14 hari) (+ R2) |
| `mobile-release.yml` | manual | AAB/APK bertanda tangan; iOS skeleton (nonaktif) |

## Deployment
Staging $0: Neon Free (`aws-ap-southeast-1`) + Cloudflare Workers Free + R2 + GitHub Pages. Panduan langkah demi langkah
untuk owner: **`docs/07-deployment.md`**. Batas & risiko paket gratis: `docs/01-architecture.md` §10.

## Status integrasi
| Integrasi | Dev | Staging (rencana) | Production |
|---|---|---|---|
| Pembayaran (Xendit) | MOCK | SANDBOX (test mode) | belum — LIVE butuh kontrak + review hukum + keputusan owner |
| E-mail (Resend) | MOCK (log) | MOCK → LIVE bila `RESEND_API_KEY` diisi | belum |
| SMS/WhatsApp OTP (Twilio) | MOCK | MOCK | belum (berbayar) |
| Push (FCM) | MOCK | MOCK | belum |
| Storage (S3/R2) | MOCK (memori) / MinIO | R2 | belum |
| Kurs (Frankfurter/ECB) | MOCK (statis) | referensi ECB | belum |
| KYC | manual review | manual review | manual review |
| Pemindai malware (ClamAV) | MOCK | MOCK (tidak bisa di Workers) | belum |
| Asuransi proteksi | MOCK | MOCK | belum ada mitra |
| Validasi nama rekening (Iluma) | MOCK | tidak tersedia | belum |
`GET /v1/health → integrations` selalu melaporkan mode sebenarnya; klien wajib menampilkan badge SANDBOX.

## Dokumentasi
- Domain (sumber kebenaran): `docs/00-domain-model.md` · Arsitektur & ADR: `docs/01-architecture.md`, `docs/adr/`
- Database: `docs/03-database.md`, `db/migrations/README.md` · Pembayaran & ledger: `docs/04-payments-ledger.md`
- API: `docs/api/*.md`, `docs/api/openapi.json`, `docs/dev/api-module-guide.md` · Desain: `docs/05-ui-design-system.md`, `brand/BRAND-GUIDE.md`
- Deployment: `docs/07-deployment.md` · Backup & DR: `docs/08-backup-dr.md` · Keamanan: `docs/09-security.md` · Privasi (UU PDP): `docs/10-privacy.md`
- Checklist: `docs/checklists/{security,store,launch}-checklist.md` · Runbook: `docs/runbooks/` · Growth: `docs/marketing/launch-plan.md`
- Riset regulasi & integrasi: `docs/research/`
- Kontribusi: `CONTRIBUTING.md` · Konvensi: `CONVENTIONS.md` · Keamanan (lapor celah): `SECURITY.md`
