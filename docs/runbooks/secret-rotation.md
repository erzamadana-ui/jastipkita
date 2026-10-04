# Runbook — Rotasi Secret & Escrow Offline (launch checklist T8)

> Untuk: rotasi terjadwal, rotasi darurat (secret bocor → `docs/runbooks/security-incident.md` §3 dulu: **rotasi dulu,
> investigasi kemudian**), dan pembuatan secret production pertama kali. Semua perilaku aplikasi di bawah diverifikasi
> dari kode (`apps/api/src/env.ts`, `lib/crypto.ts`, `services/session.ts`, `middleware/auth.ts`) per 2026-10-04.
> Langkah di dashboard pihak ketiga ditulis dari dokumentasi publik — cek ulang tampilan saat menjalankan.

## 1. Prinsip

1. **Satu set per lingkungan.** `bash scripts/gen-secrets.sh production --db-passwords` menghasilkan nilai baru; nilai
   staging **tidak pernah** dipakai ulang di production (T8). Jangan tempel secret di chat, tiket, e-mail, catatan
   (termasuk vault Obsidian) atau log — cukup catat *bahwa* secret X dirotasi, kapan, oleh siapa.
2. **Sumber kebenaran:** GitHub → Settings → Environments → `staging` / `production` → secrets. Workflow deploy
   meneruskannya ke Worker (`wrangler secret bulk`): production **setiap** deploy; staging bila sidik secret berubah atau
   *Run workflow* dengan `force_secrets=true`. Secret di Worker berlaku begitu di-push (tanpa masa tenggang).
3. **Urutan aman umum:** buat kunci baru di penyedia → simpan di GitHub Environment → deploy → verifikasi (smoke
   `GET /v1/health`, alur terkait) → **baru** cabut kunci lama di penyedia → catat.
4. Dua orang untuk production bila memungkinkan (satu menjalankan, satu memeriksa). Rotasi dicatat di dokumen operasi
   (tanggal UTC+WIB, secret, alasan, pelaksana, verifikasi) — bukan nilainya.

## 2. Inventaris

| Secret | Disimpan di | Dampak saat dirotasi | Siklus usulan (bukan keputusan) |
|---|---|---|---|
| `JWT_SECRET` | GitHub Env → Worker | access token (≤ 15 mnt) ditolak → klien refresh otomatis; sesi tetap (§3) | 12 bulan / saat bocor |
| `DATA_ENCRYPTION_KEYS` | GitHub Env → Worker + **escrow offline** | tidak ada bila kunci lama dipertahankan (§5) | 12 bulan / saat bocor |
| `HMAC_PEPPER` | GitHub Env → Worker + **escrow offline** | **merusak** lookup & kode aktif — jangan dirotasi (§7) | tidak pernah |
| `XENDIT_SECRET_KEY`, `XENDIT_WEBHOOK_TOKEN` | Dashboard Xendit → GitHub Env | webhook ditolak di antara ganti token & deploy (§4) | 12 bulan / saat bocor / staf keluar |
| `S3_ACCESS_KEY_ID/SECRET` (R2 aplikasi), `BACKUP_S3_*` | Cloudflare R2 → GitHub Env | unggah/unduh file gagal sampai deploy (§8) | 12 bulan |
| `RESEND_API_KEY`, `TWILIO_*`, `FCM_SERVICE_ACCOUNT_JSON` | penyedia → GitHub Env | e-mail/OTP/push gagal di jendela ganti (§6) | 12 bulan |
| `DATABASE_URL*` (role `jk_api_*`, `jk_migrate_*`, `jk_backup_*`), `NEON_API_KEY` | Neon → GitHub Env | koneksi ditolak sampai deploy (§9) | 6–12 bulan / staf keluar |
| `CLOUDFLARE_API_TOKEN`, `LANDING_DEPLOY_TOKEN` (GitHub PAT) | Cloudflare / GitHub → GitHub Env | deploy gagal sampai diganti (§10) | PAT 90 hari (kedaluwarsa otomatis) |
| `SETTLEMENT_SECRETS_JSON` | GitHub Env → Worker | ikuti maker-checker rekening settlement (`docs/api/admin.md` §4) | saat rekening berubah |
| Kunci privat backup `age` (`BACKUP_ENCRYPTION_PUBLIC_KEY` = publiknya) | **offline saja** (§11) | backup lama tetap butuh kunci lama | saat bocor / pemegang berganti |

## 3. JWT_SECRET

Perilaku (kode): access token HS256 ditandatangani dengan **satu** `JWT_SECRET` (`services/session.ts`) dan diverifikasi
dengan secret yang sama (`middleware/auth.ts`) — tidak ada daftar kunci ganda, jadi tidak ada masa tenggang. Refresh token
**opaque** (disimpan sebagai SHA-256 di `refresh_tokens`, tidak terkait `JWT_SECRET`), dan status MFA admin
(`mfa_verified_at`) ikut tersalin saat rotasi refresh token.

Akibatnya **rotasi biasa = bukan logout**: semua access token aktif langsung 401, klien (admin web: `authFetch` →
`refresh()`; aplikasi & web: alur refresh) memanggil `POST /v1/auth/refresh` dan mendapat access token baru.

1. `openssl rand -base64 48` → secret `JWT_SECRET` di GitHub Environment.
2. Deploy (production: *DEPLOY PRODUCTION*; staging: `force_secrets=true`).
3. Verifikasi: login admin → buka halaman apa pun setelah deploy (harus jalan tanpa login ulang); log `http.request`
   status 401 melonjak sebentar lalu normal.

**Bila tujuannya memutus semua sesi** (refresh token ikut dicurigai bocor, mis. dump DB + secret bocor) — setelah deploy,
cabut semua refresh token aktif (semua pengguna & admin login ulang; reuse detection tetap bekerja):
```sql
-- revoke-all-sessions (jalankan sebagai jk_migrate_* / owner; catat jumlah baris)
UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'ADMIN'
 WHERE revoked_at IS NULL AND expires_at > now();
```
Catat di audit: `SELECT jk_audit('ADMIN', '<uuid admin>', 'security.sessions_revoked_all', 'system', 'refresh_tokens', NULL, '{"reason":"…"}', '{}');`

## 4. Xendit secret key & webhook token

`XENDIT_SECRET_KEY` (panggilan API ke Xendit) dan `XENDIT_WEBHOOK_TOKEN` (header `x-callback-token`, dibandingkan
constant-time; salah → 401, tidak disimpan, log `webhook.invalid_token`). Aplikasi hanya menerima **satu** token webhook.

1. Dashboard Xendit (mode yang sesuai TEST/LIVE) → *Settings → API keys*: buat secret key baru (izin minimum yang
   dipakai: Money-in write, refunds, payouts sesuai fitur aktif). Simpan ke GitHub Env `XENDIT_SECRET_KEY`.
2. *Settings → Webhooks*: buat/regenerate *verification token* → `XENDIT_WEBHOOK_TOKEN`.
3. Deploy **segera** setelah langkah 2: di antara regenerasi token dan deploy, webhook Xendit ditolak 401. Xendit
   mengirim ulang webhook yang gagal (perilaku retry — cek dokumentasi Xendit untuk durasinya); selain itu
   `money.reconcile_pending_payments` (10 mnt) menanyakan status pembayaran pending ke Xendit, jadi pembayaran tidak hilang.
4. Verifikasi: Dashboard Xendit → *Webhooks → Test* (atau pembayaran TEST) → `200`; alert `WEBHOOK_INVALID_TOKEN_BURST`
   (`infra/monitoring/alerts.yaml`) tidak menyala setelah deploy.
5. Cabut secret key lama di Dashboard.

## 5. DATA_ENCRYPTION_KEYS (rotasi kid)

Format `kid1:base64(32 byte),kid2:…`. Kode (`lib/crypto.ts`): entri **pertama** = kunci aktif untuk semua enkripsi baru;
semua entri bisa mendekripsi. Setiap blob menyimpan `kid`-nya sendiri (`0x01 | len | kid | iv | ct‖tag`), jadi baris
lama tetap terbaca selama kid-nya masih ada di daftar. `kid` ≤ 32 karakter, kunci harus tepat 32 byte (start gagal bila tidak).

**Rotasi terjadwal (tanpa downtime):**
1. Kunci baru: `echo "pro$(date -u +%Y%m):$(openssl rand -base64 32)"`.
2. **Prepend**: `DATA_ENCRYPTION_KEYS=proYYYYMM:BARU,proLAMA:LAMA` (kunci lama tetap di belakang). Deploy.
3. **Escrow** nilai lengkap yang baru (§12) sebelum dianggap selesai.
4. Inventaris — baris per kid (jalankan berkala; aman, hanya membaca header blob):
```sql
-- kid-inventory: rows per encryption key id for every API-encrypted column
WITH blobs(col, b) AS (
            SELECT 'deliveries.address_enc', address_enc FROM deliveries
  UNION ALL SELECT 'identity_records.id_number_enc', id_number_enc FROM identity_records
  UNION ALL SELECT 'identity_records.full_name_enc', full_name_enc FROM identity_records
  UNION ALL SELECT 'identity_records.dob_enc', dob_enc FROM identity_records
  UNION ALL SELECT 'mfa_factors.secret_enc', secret_enc FROM mfa_factors
  UNION ALL SELECT 'otp_challenges.destination_enc', destination_enc FROM otp_challenges
  UNION ALL SELECT 'payout_accounts.account_number_enc', account_number_enc FROM payout_accounts
  UNION ALL SELECT 'refund_destinations.account_number_enc', account_number_enc FROM refund_destinations
  UNION ALL SELECT 'refund_destinations.holder_name_enc', holder_name_enc FROM refund_destinations
)
SELECT col,
       CASE WHEN get_byte(b, 0) = 1 THEN convert_from(substring(b FROM 3 FOR get_byte(b, 1)), 'UTF8') ELSE '?unknown-format' END AS kid,
       count(*) AS rows
  FROM blobs WHERE b IS NOT NULL GROUP BY 1, 2 ORDER BY 2, 1;
```
(Diuji otomatis di `apps/api/src/modules/infra/monitoring.test.ts`. Kolom `*_enc` baru → tambahkan ke query ini.)

**Kunci lama boleh dihapus dari daftar hanya bila:** inventaris = 0 baris untuk kid itu **dan** tidak ada file di storage
yang DEK-nya dibungkus kid itu **dan** semua backup yang berisi data kid itu sudah lewat retensi (dump harian 14 hari
artifact / 35 hari R2 — §3 `docs/08-backup-dr.md`). Sampai saat itu kunci lama tetap di daftar **dan** di escrow.

**Re-enkripsi (diperlukan bila kunci lama BOCOR):** belum ada skrip — sengaja. Yang harus disentuh: 9 kolom di atas
(dekripsi dengan kid lama, enkripsi ulang dengan AAD yang sama `"<tabel>.<kolom>:<id>"`, perbarui `enc_key_id`) **dan**
setiap objek file terenkripsi di storage (DEK terbungkus disimpan **di dalam objek**, `modules/files/envelope.ts`:
GET → unwrap → wrap → PUT). Beberapa tabel punya guard update; `otp_challenges` cukup dibiarkan kedaluwarsa (TTL menit).
Itu pekerjaan engineering terpisah (job idempoten per batch + tes), bukan skrip kecil. Sementara itu, bila kunci bocor:
prepend kunci baru (data baru aman), perlakukan sebagai insiden data pribadi (`security-incident.md`, UU PDP 3×24 jam)
dan jadwalkan job re-enkripsi.

## 6. Resend, Twilio, FCM

| Secret | Buat baru | Cabut lama | Verifikasi |
|---|---|---|---|
| `RESEND_API_KEY` | resend.com → API Keys → Create (permission *Sending access*, domain pengirim saja) | hapus key lama setelah deploy | login OTP e-mail di staging; log `otp.delivery_failed` = 0 |
| `TWILIO_AUTH_TOKEN` (+ `TWILIO_ACCOUNT_SID`) | Twilio Console → Account → API keys & tokens → *secondary auth token* → promote | token lama otomatis tidak berlaku saat promote | OTP SMS/WhatsApp (saat sudah LIVE) |
| `FCM_SERVICE_ACCOUNT_JSON` | Google Cloud Console → IAM → Service Accounts → Keys → Add key (JSON) | hapus key lama | push uji ke perangkat internal |

Selama jendela ganti, OTP/e-mail/push bisa gagal → kerjakan di jam sepi; alert `OTP_DELIVERY_FAILED` /
`NOTIFICATION_FAILURE_RATE` menangkap kegagalan berkepanjangan.

## 7. HMAC_PEPPER — jangan dirotasi setelah ada data

`hashIdentifier(kind, value) = HMAC-SHA256(HMAC_PEPPER, kind:value)` dipakai untuk (kode, per 2026-10-04):

| Pemakaian | Bila pepper diganti |
|---|---|
| hash e-mail/telepon tujuan OTP, daftar `email_suppressions` | e-mail yang sudah berhenti langganan / bounce **dikirimi lagi** (masalah kepatuhan) |
| `identity_records.id_number_hash` (UNIQUE: satu identitas → satu akun) | **satu KTP/paspor bisa membuka akun kedua** (kontrol fraud/KYC jebol) |
| `payout_accounts` / `refund_destinations.account_number_hash` | rekening yang sama di banyak akun tidak terdeteksi |
| kode pemulihan MFA admin (`mfa_recovery_codes`) | semua kode pemulihan admin **tidak berlaku** |
| PIN & QR serah terima (`deliveries.pin_hash`, `qr_token_hash`) | serah terima yang sedang berjalan **gagal diverifikasi** |
| kode OTP aktif, sidik perangkat, `ip_hash` di security events/audit | OTP aktif gagal; korelasi perangkat/IP historis terputus |

Sebagian hash bisa dihitung ulang dari plaintext terenkripsi (ID, rekening), tetapi kode MFA, PIN, QR, IP, sidik
perangkat dan e-mail yang di-suppress **tidak punya plaintext** — tidak bisa dipulihkan. Karena itu: buat sekali per
lingkungan, escrow (§12), jangan pernah diganti. Bila pepper bocor: risiko nyata hanya bila **dump DB juga** bocor
(nomor telepon/rekening berentropi rendah bisa di-brute-force) → perlakukan sebagai insiden data pribadi; rotasi butuh
proyek migrasi dua-pepper (verifikasi dengan pepper lama sampai kedaluwarsa, hitung ulang dari plaintext yang ada) — bukan
tindakan runbook.

## 8. R2 / S3 keys

- Aplikasi (`S3_ACCESS_KEY_ID/SECRET`): Cloudflare → R2 → *Manage API tokens* → token baru **Object Read & Write**,
  dibatasi ke bucket aplikasi saja (tanpa izin admin bucket → tidak bisa mencabut *bucket lock* checkpoint audit,
  `docs/08-backup-dr.md` §9). Simpan → deploy → uji unggah+unduh file (KYC/bukti beli) di staging → hapus token lama.
- Backup (`BACKUP_S3_*`): token terpisah, hanya bucket backup. Ganti → jalankan *DB backup* manual → cek objek baru.

## 9. Neon roles & NEON_API_KEY

Password role login (`jk_api_*`, `jk_migrate_*`, `jk_backup_*`):
1. `bash scripts/gen-secrets.sh production --db-passwords` (hanya ambil baris role yang dirotasi).
2. Neon SQL Editor (sebagai owner): `ALTER ROLE jk_api_production PASSWORD '<baru>';` — koneksi baru dengan password
   lama langsung ditolak; koneksi yang sudah terbuka tetap hidup sampai ditutup.
3. Perbarui `DATABASE_URL` (pooled) / `DATABASE_URL_MIGRATOR` / `DATABASE_URL_BACKUP` di GitHub Env → deploy segera
   (jendela error = waktu antara langkah 2 dan deploy selesai; untuk `jk_api_*` kerjakan saat sepi).
4. `NEON_API_KEY`: Neon → Account settings → API keys → create → simpan → deploy → revoke lama.

## 10. GitHub PAT & Cloudflare API token

- `LANDING_DEPLOY_TOKEN` (PAT fine-grained, repo `antarkita-landing`, Contents read/write, **kedaluwarsa 90 hari**):
  GitHub → Settings → Developer settings → Fine-grained tokens → *Regenerate* → secret baru. Pasang pengingat kalender
  7 hari sebelum kedaluwarsa (deploy web gagal saat PAT habis).
- `CLOUDFLARE_API_TOKEN`: Cloudflare → My Profile → API Tokens → *Roll* (template *Edit Cloudflare Workers*, batasi ke
  akun + zona yang dipakai) → secret baru → jalankan deploy staging → hapus token lama.
- Akun manusia: 2FA wajib di GitHub, Cloudflare, Neon, Xendit, Resend, Google Cloud; cabut akses staf yang keluar di
  hari yang sama dan rotasi secret yang pernah mereka lihat.

## 11. Kunci backup `age`

Pasangan kunci dibuat offline (`docs/08-backup-dr.md` §3). Rotasi (bocor / pemegang berganti):
1. `age-keygen -o jastipkita-backup-YYYYMM.agekey` di laptop tepercaya; publik `age1…` → `BACKUP_ENCRYPTION_PUBLIC_KEY`.
2. Backup **baru** memakai kunci baru. Kunci **lama tetap disimpan** sampai backup terakhir yang dienkripsi dengannya
   lewat retensi (≥ 35 hari) — kalau dihapus lebih cepat, backup itu tidak bisa dibuka.
3. Restore test berikutnya (`db/scripts/restore-test.sh --dump`, `checklists/restore-test-*.md`) wajib memakai backup
   yang dienkripsi kunci baru.

## 12. Escrow offline (wajib untuk `DATA_ENCRYPTION_KEYS`, `HMAC_PEPPER`, kunci privat `age`)

Kehilangan salah satunya = data terenkripsi / lookup / backup **tidak bisa dipulihkan**. GitHub/Cloudflare tidak
menampilkan ulang nilai secret, jadi escrow adalah satu-satunya salinan yang bisa dibaca.

1. Siapkan dua media: (a) entri di password manager owner (vault terpisah "JastipKita production keys", 2FA), (b) USB
   terenkripsi (VeraCrypt / APFS terenkripsi) atau cetakan kertas dalam amplop bersegel, disimpan di **lokasi fisik
   berbeda** (brankas owner + DPO/notaris).
2. Isi tiap salinan: nama lingkungan, tanggal UTC, `DATA_ENCRYPTION_KEYS` lengkap (semua kid yang masih dipakai),
   `HMAC_PEPPER`, kunci privat `age` (isi file `.agekey`), sidik SHA-256 masing-masing untuk verifikasi tanpa membuka:
   `printf '%s' "$VALUE" | shasum -a 256`.
3. Buat di laptop tepercaya, offline bila mungkin; jangan lewat clipboard sinkron/cloud notes; bersihkan scrollback
   terminal; tidak ada salinan di chat, e-mail, tiket, vault catatan (Obsidian) atau repo.
4. Uji tiap kuartal: dua orang membuka salinan (b), cocokkan SHA-256 dengan salinan (a), segel ulang, catat tanggal &
   saksi. Restore test bulanan memakai kunci `age` dari escrow (bukti escrow berfungsi).
5. Setiap rotasi §5/§11 → perbarui **kedua** salinan di hari yang sama.

## 13. Checklist T8 — secret production pertama kali

- [ ] `bash scripts/gen-secrets.sh production --db-passwords` di laptop tepercaya — nilai baru, bukan staging
- [ ] Role Neon production dibuat dengan password baru (`docs/07-deployment.md` §3), `DATABASE_URL*` di Env `production`
- [ ] Xendit **LIVE** key + webhook token baru (hanya setelah keputusan owner + `ALLOW_LIVE_PAYMENTS`), terpisah dari TEST
- [ ] Token R2 aplikasi & backup baru (bucket production), bucket lock checkpoint audit terpasang (`08-backup-dr.md` §9)
- [ ] `RESEND_API_KEY`, `TWILIO_*`, `FCM_SERVICE_ACCOUNT_JSON` production (bila kanal LIVE)
- [ ] Pasangan kunci `age` production baru; publiknya di `BACKUP_ENCRYPTION_PUBLIC_KEY`
- [ ] Escrow offline 2 salinan (§12) berisi `DATA_ENCRYPTION_KEYS`, `HMAC_PEPPER`, kunci privat `age`; diuji 2 orang
- [ ] Tidak ada secret production yang sama dengan staging (bandingkan SHA-256, bukan nilainya)
- [ ] Catatan rotasi pertama dibuat (tanggal, siapa, apa — tanpa nilai)

---

**Catatan keterbatasan data:** perilaku aplikasi diverifikasi dari kode per 2026-10-04 (satu `JWT_SECRET` tanpa masa
tenggang; refresh token SHA-256 opaque; kunci enkripsi pertama aktif, lainnya decrypt-only; pemakaian `HMAC_PEPPER` dari
pemanggil `hashIdentifier`). Menu dashboard Xendit/Resend/Twilio/Google/Cloudflare/Neon dari dokumentasi publik dan bisa
berubah. Siklus rotasi adalah **usulan**, bukan keputusan owner. Belum ada skrip re-enkripsi (lihat §5).
