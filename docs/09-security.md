# 09 — Keamanan (Security Architecture & Controls)

> Status: pra-peluncuran, semua integrasi MOCK/SANDBOX. Dokumen ini memetakan kontrol yang **sudah ada di kode**
> (dengan bukti file/test), kontrol **infrastruktur** yang disiapkan pipeline ini, dan **gap** yang harus ditutup
> sebelum production. Checklist per-kontrol (gaya OWASP ASVS): `docs/checklists/security-checklist.md`.
> Insiden: `docs/runbooks/security-incident.md`. Laporan kerentanan: `SECURITY.md`.

## 1. Aset & ancaman utama
| Aset | Mengapa kritis | Ancaman utama |
|---|---|---|
| Dana pembeli (di saldo Xendit) & ledger | uang pihak lain | webhook palsu, manipulasi nominal, pembayaran ganda, refund/payout ke rekening penipu, admin nakal |
| Data KYC (KTP/paspor, selfie, liveness) & rekening | data pribadi spesifik (UU PDP) | kebocoran DB/bucket, akses staf berlebihan, log berisi PII |
| Akun pengguna | pengambilalihan akun = transaksi palsu | brute-force OTP, SIM swap, pencurian refresh token |
| Akun admin & konfigurasi bisnis | bisa mengubah fee/limit/rekening settlement | phishing admin, penyalahgunaan hak, perubahan diam-diam |
| Secret infrastruktur | kunci ke semua aset di atas | commit tak sengaja, log CI, token berumur panjang |

## 2. Kontrol per lapisan

### 2.1 Transport & edge
- TLS di semua hop: Cloudflare edge (HTTPS saja), Neon `sslmode=require` (CI menolak `DATABASE_URL` tanpa itu —
  `scripts/ci/worker-config.ts`), R2/Xendit/Resend via HTTPS.
- Header API (`apps/api/src/app.ts`): HSTS 2 tahun + preload, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  CSP `default-src 'none'; frame-ancestors 'none'`, CORP same-site. CORS: allow-list origin eksak, `credentials: false`.
- Batas body JSON 1 MB; file diunggah langsung ke storage via URL presigned.

### 2.2 Identitas & sesi (ADR 0004)
- Passwordless: OTP disimpan sebagai HMAC, 5 percobaan, kedaluwarsa 5 menit, cooldown & kuota per tujuan/IP berbasis DB
  (tetap berlaku lintas isolate Worker); Google/Apple ID token diverifikasi (issuer, audience, nonce).
- JWT akses HS256 15 menit; refresh token opak 256-bit (SHA-256 di DB), sekali pakai, rotasi, **deteksi reuse**
  mencabut seluruh keluarga sesi + `security_events` HIGH.
- Admin: TOTP wajib + step-up ≤ 15 menit untuk aksi sensitif, anti-replay per time-step, kunci setelah 5 gagal/15 menit.
- Tidak ada cookie → tidak ada permukaan CSRF; token hanya di header `Authorization`.

### 2.3 Otorisasi
- RBAC berbasis permission per route admin (`requirePermission`), peran: SUPER_ADMIN, OPERATIONS, FINANCE,
  FINANCE_SUPER_ADMIN, RISK, SUPPORT, MARKETING, COMPLIANCE.
- Kepemilikan dicek di service (buyer/traveler per transaksi, akses file per tujuan), gerbang level KYC.
- **Maker-checker di database** (CHECK `approved_by <> requested_by`): konfigurasi bisnis, rekening settlement
  (FINANCE_SUPER_ADMIN + MFA segar), override trust, refund besar, pemberian peran istimewa, operasi DB destruktif.

### 2.4 Validasi input & output
- Setiap route didefinisikan dengan zod (`@hono/zod-openapi`); gagal validasi → 422 terstruktur.
- SQL selalu parameterized (tagged template postgres.js; tidak ada `sql.unsafe` di kode runtime).
- Error 5xx tidak membocorkan stack/pesan internal ke klien (hanya `INTERNAL_ERROR` + `requestId`); detail di log.
- Fetch URL dari pengguna (ekstraksi produk) dijaga SSRF guard (skema, port, IP privat/metadata, redirect, ukuran, waktu).

### 2.5 Perlindungan data
- AES-256-GCM dengan AAD per baris/kolom (`<table>.<col>:<id>`), `kid` untuk rotasi kunci; file KYC/TRIP_DOC
  dienkripsi envelope (DEK per file dibungkus KEK), objek plaintext dihapus.
- Pencarian/dedupe memakai HMAC-SHA256 dengan pepper (bukan SHA polos) → dump DB tidak bisa di-brute-force untuk
  nomor HP/rekening.
- Output ter-mask (`****0961`); rekening settlement hanya di secret store (`SETTLEMENT_SECRETS_JSON`).
- Logger JSON dengan redaksi kunci sensitif (password, token, otp, pin, nik, rekening, email, phone, alamat, …).
- Enkripsi at-rest penyedia: Neon & R2 mengenkripsi disk (klaim penyedia — verifikasi di dokumen keamanan mereka).

### 2.6 Integritas finansial
- Ledger double-entry, seimbang per mata uang saat COMMIT, append-only (trigger + grant), koreksi hanya dengan jurnal balik.
- Status transaksi hanya lewat state machine (DB + core); `audit_logs` hash-chain (SHA-256) + `verify_audit_chain()`.
- Webhook Xendit: token dibandingkan waktu-konstan (hash dulu), request tak terverifikasi **tidak disimpan**, dedup
  `webhook-id`, lalu verifikasi ulang ke Xendit (GET) — nominal & mata uang harus cocok; selisih → HOLD + review risiko.
- Idempotency-Key wajib untuk mutasi finansial; kunci idempotensi sendiri ke provider (`pay:`, `refund:`, `payout:`).
- Pembayaran LIVE mustahil tanpa `XENDIT_ENV=live` + `ALLOW_LIVE_PAYMENTS=true` + keputusan tercatat
  (`deploy-production.yml`); CI menolak kunci production di staging dan kunci development di live.

### 2.7 Database
- Role least-privilege: API `jk_app` (DML saja; tabel append-only hanya INSERT; tanpa DDL/TRUNCATE), migrasi
  `jk_migrator`, BI `jk_readonly` (per kolom, tanpa PII). Diuji di CI (`db/tests/100_grants.sql`,
  `scripts/ci/db-provider-parity.sh`).
- String koneksi terpisah per role & environment; owner (`neondb_owner`) tidak dipakai setelah bootstrap.

### 2.8 Unggahan file
- URL presigned 15 menit menandatangani `content-type` **dan** `content-length`; `complete`: cek ukuran → magic bytes
  vs tipe deklarasi → SHA-256 → pemindaian malware (**fail-closed**: scanner tidak tersedia → 503) → enkripsi (KYC).
- Akses unduh diperiksa per tujuan file; dokumen KYC hanya permission `kyc.review`, setiap tampilan diaudit.
- **Catatan staging:** pemindai malware = MOCK (ClamAV tidak bisa jalan di Worker) → wajib clamd sungguhan sebelum production.

### 2.9 Secret management
- Tidak ada secret di repo, aplikasi mobile, bundle web/admin. Nilai hanya di GitHub Environment secrets →
  `wrangler secret bulk` ke Worker; file sementara `0600` dihapus di akhir job; fingerprint HMAC untuk melewati
  push yang tidak berubah (tanpa membuka nilai).
- `scripts/gen-secrets.sh` mencetak nilai baru tanpa menulis ke disk. Aturan rotasi: `HMAC_PEPPER` tidak boleh
  berubah setelah ada data; `DATA_ENCRYPTION_KEYS` rotasi dengan menambah kunci aktif di depan.
- Kunci privat backup (age) tidak pernah masuk GitHub.

### 2.10 Supply chain & CI/CD
- `pnpm install --frozen-lockfile`; Dependabot (npm, actions, pub); OSV-Scanner + `pnpm audit` (laporan);
  Semgrep (SAST gratis); CodeQL siap tetapi nonaktif untuk repo private tanpa lisensi (`codeql.yml`).
- Pemindaian secret: `scripts/ci/secret-grep.sh` (file terlarang, pola kunci nyata) + gitleaks riwayat penuh (blokir).
- Workflow: `permissions: contents: read` default, izin tambahan per job; `persist-credentials: false`;
  concurrency group; deploy staging hanya dari `main` setelah CI sukses; production manual + gerbang (§ADR 0005).
- Action dipin ke **major version** (sesuai permintaan); rekomendasi lanjutan: pin ke commit SHA untuk action
  pihak ketiga (`pnpm/action-setup`, `subosito/flutter-action`) — Dependabot tetap bisa memperbarui SHA.

### 2.11 Permukaan admin & klien
- Admin SPA statis, `noindex` + header keamanan dari workflow; disarankan Cloudflare Access (Zero Trust) di depan
  host admin selain MFA aplikasi.
- Mobile: tidak ada secret di binary; simpan token di secure storage (Keychain/Keystore) — tanggung jawab tim mobile;
  tidak ada SDK pelacakan iklan (App Tracking Transparency tidak diperlukan).
- Web statis tanpa form yang mengirim data sensitif ke pihak ketiga.

## 3. Gap & tindakan (diurutkan menurut risiko)
| # | Gap | Risiko | Tindakan | PIC | Kapan |
|---|---|---|---|---|---|
| 1 | Pemindai malware MOCK | file berbahaya ke staf/pengguna | deploy clamd + shim HTTP; `MALWARE_SCAN_PROVIDER=clamav-http` | Eng + Owner (biaya) | sebelum beta publik |
| 2 | Batas CPU Workers Free (W1/W2) | request/unggahan gagal → pengguna mencoba jalur di luar aplikasi | cache app per isolate; putuskan Workers Paid | Tim API + **Owner** | sebelum beta tertutup |
| 3 | Rate limit in-memory per isolate | serangan terdistribusi | aturan WAF Cloudflare (butuh zona di Cloudflare) + limit DB yang sudah ada | Eng | saat domain kustom |
| 4 | Checkpoint audit chain ke WORM belum ada | penulisan ulang total oleh superuser tak terdeteksi | ekspor harian `(last_id,last_hash)` ke R2 Object Lock | Eng | sebelum production |
| 5 | Validasi nama rekening (Iluma) belum tersambung | payout/refund ke rekening salah | aktivasi Iluma/penny-drop (biaya) | Finance + **Owner** | sebelum LIVE |
| 6 | Pentest independen belum ada | celah logika bisnis | pentest API + mobile oleh pihak ketiga | **Owner** | sebelum launch publik |
| 7 | CodeQL tidak jalan (repo private) | SAST lebih lemah | andalkan Semgrep; beli Code Security atau buka repo | Owner | opsional |
| 8 | Branch protection/required reviewers tergantung paket | perubahan tanpa review ke `main`/production | GitHub Pro/Team | **Owner** | sebelum tim > 1 orang |
| 9 | Action pihak ketiga dipin major, bukan SHA | action disusupi | pin SHA | Eng | 1 bulan |
| 10 | DPIA biometrik/KYC belum ada | ketidakpatuhan PDP | lihat `docs/10-privacy.md` | DPO/Legal | sebelum KYC nyata |
| 11 | Mode maintenance API tidak ada | migrasi/insiden = error mentah | `MAINTENANCE_MODE` 503 | Tim API | 1 bulan |
| 12 | Sertifikat pinning mobile tidak direncanakan | MITM di perangkat ter-root | evaluasi setelah beta (trade-off rotasi sertifikat) | Tim mobile | backlog |

---

**Catatan keterbatasan data:** status kontrol dibaca dari kode & test di repo per 2026-09-27 (bukan hasil pentest);
klaim enkripsi at-rest penyedia belum diverifikasi dari dokumen kepatuhan mereka; ketersediaan fitur GitHub/Cloudflare
tergantung paket akun dan dapat berubah.
