# JastipKita — Engineering Conventions

Satu sumber kebenaran untuk semua kontributor (manusia & agen). Baca sebelum menulis kode.

## Bahasa
- Kode, nama tabel/kolom, API, komentar teknis: **Inggris**.
- Teks UI, email, notifikasi, dokumen bisnis/legal: **Indonesia** (default) + Inggris (l10n `id`, `en`).

## Brand tokens (jangan hard-code warna di luar token)
| Token | Hex | Pakai |
|---|---|---|
| navy-900 (primary) | `#0B1E4A` | brand, app bar, CTA sekunder, teks judul light mode |
| navy-950 | `#070B19` | background dark mode (near-black navy) |
| navy-800 | `#12295F` | surface elevated dark |
| cobalt-500 (secondary) | `#1E5BFF` | CTA utama, link, fokus, aksen |
| cobalt-400 | `#4D7DFF` | CTA di dark mode |
| emerald-600 (success) | `#059669` | sukses, PAYMENT SECURED |
| orange-500 (warning) | `#F97316` | peringatan, price change |
| red-600 (error) | `#DC2626` | error, DO NOT PURCHASE, prohibited |
| offwhite-50 (bg light) | `#F7F8FB` | background light mode |
| ink-900 | `#0F172A` | teks utama light |
| slate-500 | `#64748B` | teks sekunder |

Font: **Poppins** (OFL) — 400/500/600/700. Angka uang pakai `font-feature-settings: "tnum"`.
Tagline: **"Titip Mudah, Aman, Terpercaya."**

## Uang & angka
- Semua nominal disimpan sebagai **integer minor unit** (`bigint`) + `currency` ISO-4217. IDR minor unit = 0 desimal (Rp1 = 1). USD = sen (x100). JPY/KRW = 0 desimal.
- Tabel `currencies.minor_units` menentukan skala. Jangan pakai float untuk uang. Konversi FX memakai rate `numeric(20,10)` dan pembulatan **half-up** di minor unit tujuan.
- Persentase disimpan sebagai **basis points** (`bps`, 1% = 100 bps) atau `numeric(9,6)` rate — konsisten per tabel (lihat skema).

## Waktu
- DB: `timestamptz`, simpan UTC. API: ISO-8601 dengan `Z`. UI: tampilkan WIB (Asia/Jakarta) default, ikut locale perangkat.

## ID & nomor
- Primary key: `uuid` (`gen_random_uuid()`).
- Nomor transaksi manusiawi: `JK-YYMMDD-XXXXXX` (base32 Crockford 6 char). Nomor dispute `DSP-…`, refund `RFD-…`, tiket `TKT-…`.

## Arsitektur (wajib)
```
Mobile / Web / Admin  →  HTTPS API (apps/api, Hono)  →  service  →  repository  →  PostgreSQL
                                        └── packages/core (engine murni, tanpa I/O)
```
- Klien **tidak pernah** mengakses database langsung.
- `packages/core`: fungsi murni + tipe (pricing, customs/tax, FX, state machine, matching, trust, fraud, limits, restricted items, cancellation, referral, promo). Tanpa I/O, tanpa dependensi runtime. 100% unit-tested.
- `apps/api/src/modules/<module>/{routes.ts,service.ts,repository.ts,schemas.ts}`.
- Provider eksternal selalu di balik interface di `apps/api/src/providers/<kind>/` (payment, email, push, sms, storage, fx, kyc, insurance, ai-extraction, db-admin). Implementasi `mock` wajib ada untuk dev/test.
- Status transaksi **hanya** berubah melalui state machine (`packages/core/src/state-machine`) + fungsi repository `transitionTransaction()` yang menulis `transaction_events` dalam satu DB transaction.

## API
- Base path `/v1`. JSON camelCase. Error format:
  `{ "error": { "code": "PAYMENT_NOT_SECURED", "message": "…", "details": {…}, "requestId": "…" } }`
- Auth: `Authorization: Bearer <access JWT>` (15 menit) + refresh token rotasi (30 hari, reuse-detection).
- Mutasi finansial wajib header `Idempotency-Key` (UUID) — disimpan di tabel `idempotency_keys`.
- Pagination: `?limit=&cursor=` → `{ data: [], nextCursor }`.
- Admin endpoint di `/v1/admin/*`, dicek permission RBAC (`finance.settlement.request_change` + `finance.settlement.approve_change` (maker-checker), dst).

## Keamanan
- Tidak ada secret/API key di repo, klien mobile, atau web bundle. Hanya `.env.example` berisi nama variabel.
- Rekening settlement **tidak pernah** dikirim ke klien kecuali dalam bentuk mask `****0961`.
- Data KYC: file terenkripsi (AES-256-GCM envelope) di object storage; DB hanya menyimpan referensi + hash.
- Semua perubahan finansial/config/trust score/role → `audit_logs` (append-only, hash chain).

## Git
- Conventional Commits (`feat(api): …`, `fix(mobile): …`).
- Branch: `main` (protected) ← `develop` ← `feat/*`.

## Kejujuran integrasi
- Integrasi yang masih sandbox/mock **harus** diberi label jelas di kode, UI admin (badge "SANDBOX"), dan dokumen. Jangan mengklaim live.
