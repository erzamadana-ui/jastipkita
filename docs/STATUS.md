# Status Serah Terima — JastipKita (2026-09-28)

> **Ringkas:** kode seluruh produk (API, database, aplikasi Flutter, web publik, admin) sudah dibangun, dites otomatis, dan
> lulus CI di GitHub. **Belum ada yang live.** Semua integrasi berjalan **MOCK/SANDBOX**; staging belum dinyalakan karena
> butuh akun & secret yang harus dibuat owner sendiri (gratis). Production, pembayaran LIVE, submit toko aplikasi, badan
> usaha dan iklan berbayar **tidak dilakukan** — menunggu keputusan owner (lihat §5).

Repo: `github.com/erzamadana-ui/jastipkita` (private) · salinan lokal Mac: `~/Developer/jastipkita` · commit terakhir
`7615e97`. Detail per requirement & tes: [`checklists/test-scenarios.md`](checklists/test-scenarios.md) (R01–R42).

## 1. Apa yang sudah jadi

Status: **SELESAI** = kode + tes otomatis hijau · **MOCK/SANDBOX** = kode jadi, penyedia nyata belum dihubungkan ·
**TEMPLATE** = dokumen siap, wajib direview profesional · **OWNER** = butuh keputusan/akun/biaya owner.

| # | Area (master prompt) | Bukti utama | Status |
|---|---|---|---|
| 1 | Riset regulasi, pajak/bea, PSP, FX, pasar & nama | `docs/research/01–05` | SELESAI (riset desk, bukan opini hukum) |
| 2 | Arsitektur, ADR, domain model (sumber kebenaran FSM & aturan) | `docs/00-domain-model.md`, `docs/01-architecture.md`, `docs/adr/0001–0008` | SELESAI |
| 3 | Database: 26 migrasi, ledger double-entry, audit hash-chain, append-only, FSM di DB, role `jk_app/jk_readonly` | `db/migrations/`, `db/tests/`, `docs/03-database.md` | SELESAI (359 cek SQL, PG 16 & 17) |
| 4 | API `/v1` 283 operasi (151 admin) + OpenAPI | `apps/api/`, `docs/api/openapi.json`, `docs/api/*.md` | SELESAI |
| 5 | Brand: logo (tas belanja + pesawat + orbit), ikon, splash, aset toko, design tokens | `brand/`, `packages/design-tokens/`, `docs/05-ui-design-system.md` | SELESAI |
| 6 | Aplikasi Flutter satu app, mode Penitip & Traveler (37 layar), Material 3 / Liquid Glass selektif | `apps/mobile/` | SELESAI (analyze + test + APK debug + web build di CI) |
| 7 | Web publik: landing, halaman negara (SEO), trip discovery, kalkulator bea, cek barang terlarang, bantuan, auth, legal, hapus akun, EN | `apps/web/` (19 route) | SELESAI (Playwright; CSP diverifikasi) |
| 8 | Admin web terpisah: RBAC, MFA TOTP wajib server-side, maker-checker, dashboard, KYC, transaksi, sengketa, keuangan, risiko, growth, config, konten, DB & Infra Center | `apps/admin/`, `apps/api/src/modules/admin/` | SELESAI |
| 9 | Auth: OTP telepon/e-mail, Google, Apple, refresh rotation + deteksi reuse, KYC L1–L5 | `modules/auth`, `modules/kyc` | SELESAI · OTP/e-mail **MOCK**, KYC **manual review** |
| 10 | Trip, request, matching, offer | `modules/trips`, `requests`, `matching`, `offers`; `packages/core/src/matching` | SELESAI |
| 11 | Rincian harga transparan 11 baris, engine bea & pajak berversi, FX lock | `packages/core/src/{pricing,customs,fx}`, seed `0100_customs_rules.sql` | SELESAI · tarif = **DRAFT** sampai diverifikasi konsultan |
| 12 | Jendela konfirmasi harga (naik/turun, supplemental checkout, tolak → refund) | `modules/price-confirmation` | SELESAI |
| 13 | SafePay (Xendit abstraction), aturan **DO NOT PURCHASE** sebelum PAYMENT_SECURED, webhook idempoten & fail-closed | `modules/{checkout,payments,webhooks}`, `providers/` | SELESAI · pembayaran **MOCK** (dev) / siap **SANDBOX** Xendit TEST |
| 14 | Rekening settlement: tidak di-hard-code, masked `****0961`, MFA + maker-checker | `modules/admin/settlement`, secret `SETTLEMENT_SECRETS_JSON` | SELESAI |
| 15 | Bukti pembelian, serah terima (meet-up QR/PIN, kurir, mitra logistik), auto-confirm | `modules/{purchase,delivery}` | SELESAI |
| 16 | Notifikasi multi-kanal + siklus e-mail lengkap | `modules/notifications`, template e-mail | SELESAI · kanal **MOCK** (log) |
| 17 | Trust score, fraud engine, limit, barang terlarang | `packages/core/src/{trust-score,fraud,limits,restricted}` | SELESAI |
| 18 | Matriks pembatalan, sengketa + SLA, refund, payout, rekonsiliasi harian + layar rekonsiliasi admin | `modules/{cancellation,disputes,refunds,payouts,reconciliation}`, `admin/reconciliation` | SELESAI |
| 19 | Asuransi/proteksi (abstraksi) | `providers/` insurance | **MOCK** (belum ada mitra) |
| 20 | Chat, rating, referral (Rp25rb/25rb, min Rp500rb, cap Rp250rb/bln, traveler Rp50rb, A/B 15/25/50rb, guardrail), promo | `modules/{chat,ratings,referrals,promotions,credits}` | SELESAI |
| 21 | Config dinamis berversi (maker-checker), backup/DR (RPO/RTO), observability, analytics | `modules/admin/config`, `docs/06-observability.md`, `docs/08-backup-dr.md`, `db-backup.yml` | SELESAI · backup production belum ada (belum ada production) |
| 22 | Keamanan & privasi (UU PDP): enkripsi AES-GCM, HMAC pepper, step-up, rate limit, review keamanan | `docs/09-security.md`, `docs/10-privacy.md`, `docs/security/review-2026-09.md` | SELESAI · 4 temuan Low/Medium terbuka/diterima (§4) |
| 23 | Template legal (S&K, privasi, refund, traveler, barang terlarang, cookie, KYC, marketing, komunitas, pembayaran) | `docs/legal/`, seed `0200_legal_documents` | **TEMPLATE** — wajib review hukum |
| 24 | CI/CD, deployment, env | `.github/workflows/`, `infra/`, `docs/07-deployment.md` | CI SELESAI (hijau) · deploy staging **OWNER** (secret) |
| 25 | Checklist toko, keamanan, launch; skenario tes; load test | `docs/checklists/` | SELESAI (dokumen) · load test lokal saja |
| 26 | Soft launch (tujuan ID; asal JP, SG, KR, MY, AU, US) & growth plan | `docs/marketing/launch-plan.md` | TEMPLATE · iklan berbayar **OWNER** |

## 2. Status integrasi (jujur)

| Integrasi | Sekarang | Untuk staging | Production |
|---|---|---|---|
| Pembayaran Xendit | MOCK | SANDBOX (test key) | belum — butuh PT, kontrak, konfirmasi tertulis penahanan dana, `ALLOW_LIVE_PAYMENTS` |
| E-mail (Resend) | MOCK (log) | LIVE bila `RESEND_API_KEY` + verifikasi domain | belum |
| SMS/WhatsApp OTP (Twilio) | MOCK | MOCK | belum (berbayar) |
| Push (FCM) | MOCK | MOCK | belum |
| Storage (R2/S3) | memori | R2 | belum |
| Kurs (Frankfurter/ECB) | statis | referensi ECB | belum |
| KYC | manual review admin | manual | vendor e-KYC belum dipilih |
| Pemindai malware (ClamAV) | MOCK | MOCK | wajib — API production menolak start tanpa `CLAMAV_HTTP_URL` |
| Asuransi/proteksi | MOCK | MOCK | belum ada mitra |

`GET /v1/health` selalu melaporkan mode sebenarnya; aplikasi & web menampilkan badge SANDBOX.

## 3. Hasil verifikasi

| Suite | Hasil | Di mana |
|---|---|---|
| `packages/core` (engine murni) | 282 lulus | lokal + CI |
| API (unit + integrasi + keamanan + E2E J1–J8) | 549 lulus, 0 gagal (87 file); bundle Worker ±580 KiB gzip | lokal + CI |
| Database (SQL) | 359 lulus, PG 16 & 17 | lokal + CI |
| Admin | 67 unit + 18 Playwright | lokal + CI (unit) |
| Web | 130 Playwright + 6 unit, CSP di 57 halaman | lokal + CI (build) |
| Flutter | analyze bersih, widget/unit test lulus, APK debug & web build | CI |
| Secret scan (guard + gitleaks), audit dependensi, CodeQL | hijau | CI |
| Load test lokal | lihat `checklists/load-test-2026-09.md` | lokal (bukan production) |

## 4. Risiko & keterbatasan terbuka

1. **Legal belum ada:** PT/NIB, PSE Komdigi, opini escrow (PBI 23/6/2021), review template, konsultan kepabeanan & pajak
   (status PKP menentukan boleh tidaknya memungut PPN). Tanpa ini **tidak boleh** menerima uang publik.
2. **Merek "JastipKita" berisiko tinggi** (domain & badan usaha serupa sudah ada) — cek PDKI sebelum kampanye/listing toko.
3. **Web berbagi origin** `antarkitaindonesia.com` (SEC-14): CSP sudah dipasang, token tidak di localStorage, tapi tetap
   disarankan pindah ke subdomain `jastipkita.antarkitaindonesia.com` sebelum publik.
4. **Free tier:** Cloudflare Workers Free punya batas CPU per request; app sudah di-cache per isolate, tapi belum diuji
   di Cloudflare nyata. Bila error 1102 muncul → Workers Paid (±US$5/bulan, ASUMSI harga publik, perlu persetujuan).
5. **Temuan keamanan Low terbuka/diterima:** SEC-15 (nonce OAuth opsional), SEC-18 (polyglot file, perlu domain storage
   terpisah), SEC-19 (tanggal trip publik — keputusan produk) — rincian di `docs/security/review-2026-09.md` (SEC-16, SEC-17,
   SEC-20 sudah diperbaiki 2026-09-28). Pentest independen belum dilakukan.
6. **Tarif bea/pajak & angka config** (biaya kanal bayar, limit, SLA dukungan) adalah **ASUMSI** yang ditandai; rule
   customs berstatus DRAFT sampai diverifikasi.
7. **iOS:** build iOS belum dijalankan (butuh Mac + akun Apple Developer); Android APK debug sudah terbangun di CI.

## 5. Tindakan owner

### 5a. Gratis — untuk menyalakan staging (panduan klik-demi-klik: `docs/07-deployment.md`)

| # | Tindakan | Hasil yang dimasukkan (oleh owner sendiri) ke GitHub → Settings → Environments → `staging` |
|---|---|---|
| 1 | Cek paket GitHub (environment protection) | — (§1.1) |
| 2 | Buat akun **Neon Free**, project `jastipkita-staging` region Singapore, buat role login lewat SQL Editor | `DATABASE_URL_MIGRATOR` (direct), `DATABASE_URL` (pooled) (§2–3) |
| 3 | Buat akun **Cloudflare** + API token Workers + bucket R2 | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; variabel `API_BASE_URL`, `S3_ENDPOINT` (§4, §5.2) |
| 4 | Jalankan `bash scripts/gen-secrets.sh staging` di Mac | `JWT_SECRET`, `DATA_ENCRYPTION_KEYS`, `HMAC_PEPPER` (§5) |
| 5 | Akun **Xendit** mode TEST | `XENDIT_SECRET_KEY` (test), `XENDIT_WEBHOOK_TOKEN` (§6.1) |
| 6 | Login staging: **Resend** (verifikasi domain) atau Google OAuth client | `RESEND_API_KEY` / `GOOGLE_CLIENT_IDS` (§6.2) |
| 7 | PAT fine-grained ke repo `antarkita-landing` (Contents: read & write, 90 hari) + `.nojekyll` | `LANDING_DEPLOY_TOKEN`; variabel `LANDING_ADD_NOJEKYLL=true` bila perlu (§8.1) |

Catatan: R2 di Cloudflare kemungkinan meminta metode pembayaran terdaftar walau pemakaian dalam kuota gratis — cek saat
aktivasi; bila tidak mau, staging tetap bisa jalan dengan storage dinonaktifkan untuk unggahan.

### 5b. Berbiaya / keputusan bisnis (tidak dijalankan tanpa persetujuan)

| Prioritas | Tindakan | Perkiraan biaya |
|---|---|---|
| P0 | PT + NIB (KBLI PMSE), pendaftaran PSE Komdigi | notaris/konsultan — ASUMSI, minta penawaran |
| P0 | Review hukum template + opini escrow + konsultan kepabeanan & pajak | jasa profesional — minta penawaran |
| P0 | Cek & keputusan merek (PDKI) | biaya permohonan merek per kelas — cek tarif PNBP DJKI |
| P0 | Akun bisnis Xendit (KYB atas nama PT) + konfirmasi tertulis penahanan dana | tanpa biaya pendaftaran (fee per transaksi) — verifikasi ke Xendit |
| P0 | Pentest independen | minta penawaran |
| P1 | Google Play Console **organisasi** (+ D-U-N-S) | ±US$25 sekali (ASUMSI) |
| P1 | Apple Developer Program organisasi | US$99/tahun |
| P1 | Infrastruktur production: Workers Paid + Neon berbayar (PITR ≥ 7 hari) | ±US$5 + US$19–30/bulan (ASUMSI, `docs/01-architecture.md` §10) |
| P1 | ClamAV terkelola, SMS/WhatsApp OTP (Twilio) | berbasis pemakaian |
| P2 | Iklan berbayar soft launch | sesuai `docs/marketing/launch-plan.md` |

### 5c. Keputusan produk (tanpa biaya) yang menunggu owner

| Keputusan | Opsi | Rekomendasi Claude (usulan, bukan keputusan) |
|---|---|---|
| Alamat web | tetap `antarkitaindonesia.com/jastipkita` · subdomain `jastipkita.antarkitaindonesia.com` | subdomain sebelum publik (SEC-14) |
| Tanggal trip di halaman publik (SEC-19) | tanggal pasti · rentang minggu untuk pengunjung anonim | rentang minggu untuk anonim, tanggal pasti setelah login |
| Jeda rekening refund/payout baru | tanpa jeda · tahan 24 jam sebelum dipakai | 24 jam (menahan pengambilalihan akun) — belum dibangun; yang ada baru `money.policy.payoutDelayHours` (menunda semua payout, bukan khusus rekening baru) |
| Subsidi biaya kanal bayar (VA) | dibebankan penuh · disubsidi | putuskan setelah tarif resmi Xendit akun bisnis keluar |

Semua gerbang go-live: `docs/checklists/launch-checklist.md` (status seluruh butir = BELUM per tanggal ini).

## 6. Cara melanjutkan pengembangan

- Lokal: `README.md` → Quick start (Docker atau PostgreSQL 16, Node 22, pnpm 10).
- Push dari sesi Claude: bundle git → `Aplikasi Jastip/_sinkron/jastipkita.bundle` → klik ganda
  `push-ke-github.command` (log: `_sinkron/push-log.txt`).
- Setiap perubahan aturan bisnis lewat **config berversi + maker-checker** di admin, bukan ubah kode.

---

**Catatan keterbatasan data:** hasil tes dari run lokal & CI 2026-09-28; biaya pihak ketiga adalah perkiraan dari harga
publik yang diketahui dan ditandai ASUMSI — cek ulang saat pendaftaran; riset regulasi adalah riset desk (diverifikasi
2026-09-27), bukan nasihat hukum/pajak.
