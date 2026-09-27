# Security Checklist (pemetaan gaya OWASP ASVS)

Pemetaan per **bab ASVS 4.0.3** (V1–V14; ASVS 5.0 menata ulang nomor, jadi acuan di sini per topik bab, bukan nomor
requirement). Level sasaran: **ASVS L2** untuk API & admin (aplikasi yang memproses uang dan data pribadi spesifik).
Status: **ADA** (dengan bukti) · **SEBAGIAN** · **BELUM** · **N/A** (tidak relevan).
PIC: Eng-API, Eng-Mobile, Eng-Web, DevOps, Owner, DPO, Legal, Finance.

| Bab ASVS | Kontrol | Status | Bukti / catatan | PIC | Tindakan berikut |
|---|---|---|---|---|---|
| V1 Arsitektur | Model ancaman & batas kepercayaan terdokumentasi | SEBAGIAN | `docs/09-security.md` §1, `docs/01-architecture.md`, review internal `docs/security/review-2026-09.md` | DevOps | threat model per fitur (checkout, KYC, payout) sebelum beta publik |
| V1 | Komponen pihak ketiga di balik interface + MOCK | ADA | `apps/api/src/providers/*` | Eng-API | — |
| V1 | Pemisahan environment & kredensial | ADA | GitHub Environments, role DB per env, `infra/env/*.env.example` | DevOps | pastikan paket GitHub mendukung environment (07 §1.1) |
| V2 Autentikasi | Tanpa password; OTP HMAC, 5 percobaan, 5 menit, cooldown & kuota DB | ADA | `modules/auth`, `otp.test.ts` | Eng-API | — |
| V2 | Verifikasi ID token Google/Apple (iss, aud, exp, email_verified, nonce bila dikirim) | SEBAGIAN | `modules/auth/oauth.ts`, `oauth-session-mfa.test.ts` | Eng-API/Eng-Mobile | isi `GOOGLE_CLIENT_IDS`/`APPLE_CLIENT_IDS`; wajibkan nonce (SEC-15) |
| V2 | MFA untuk admin (TOTP, anti-replay, lockout, recovery code HMAC) — **ditegakkan server**: setiap `/v1/admin/*` & akses file staf butuh sesi terverifikasi MFA ≤ 12 j (SEC-01) | ADA | `oauth-session-mfa.test.ts`, `test/security/admin-session-mfa.test.ts`, migrasi 0080 | Eng-API | tutup jendela trust-on-first-use pendaftaran TOTP (SEC-13, OPEN); enrolment di hari grant |
| V2 | Perlindungan SIM swap / ATO untuk aksi bernilai tinggi | SEBAGIAN | KYC level, risk scoring, pencocokan nama rekening payout | Eng-API/Risk | step-up OTP + notifikasi saat set/ganti rekening payout & **tujuan refund** (SEC-12, wajib sebelum Iluma aktif) |
| V3 Sesi | Token akses pendek (15 menit), refresh rotasi + reuse detection | ADA | `services/session.ts`, `docs/api/identity.md` §3 | Eng-API | — |
| V3 | Logout & pencabutan sesi per perangkat (access token mati seketika; perangkat berhenti menerima push akun itu) | ADA | `DELETE /auth/sessions/{id}`, `DELETE /me/devices/{id}`, `test/security/session-device.test.ts` (SEC-07) | Eng-API | — |
| V3 | Penyimpanan token aman di klien | BELUM | belum ada kode mobile | Eng-Mobile | Keychain/Keystore (flutter_secure_storage), jangan di SharedPreferences |
| V4 Akses | RBAC per route admin + sesi MFA + MFA segar untuk aksi sensitif | ADA | `middleware/auth.ts`; `test/security/admin-rbac-matrix.test.ts` (141 operasi: anonim / non-admin / tanpa permission / kurang satu permission → ditolak) | Eng-API | review matriks peran sebelum launch (SUPER_ADMIN sangat luas); cabut sesi saat revoke role (SEC-16) |
| V4 | Cek kepemilikan objek (IDOR) di service, peran buyer vs traveler per aksi | ADA | `test/security/idor-matrix.test.ts` (65 kasus rute ber-path-id + matriks peran; PIN serah terima hanya pembeli) | Eng-API | tambahkan rute baru ke matriks |
| V4 | Maker-checker (config, settlement, trust, refund, role, DB ops) | ADA | CHECK di migrasi 0005/0009/0011/0014/0060, `db/tests/050_maker_checker.sql` | Eng-API | tunjuk ≥ 2 admin berperan berbeda (Owner) |
| V5 Validasi | Validasi skema semua request (zod/OpenAPI) | ADA | `app.ts` defaultHook, `docs/api/openapi.json` | Eng-API | — |
| V5 | SQL injection: query parameterized | ADA | tagged template postgres.js; tidak ada `sql.unsafe` runtime | Eng-API | Semgrep di CI |
| V5 | SSRF pada fetch URL pengguna | SEBAGIAN | `providers/extraction/ssrf.ts` — resolusi DNS fail-closed, IPv6 IPv4-translated/NAT64/Teredo diblok (SEC-05), `test/security/ssrf.test.ts`; alamat belum di-pin (rebinding) | Eng-API | egress proxy bila pindah dari Workers |
| V5 | XSS | SEBAGIAN | API JSON + CSP `none`; Admin SPA CSP ketat (tanpa inline); web escape konsisten tetapi **tanpa CSP dan berbagi origin** `antarkitaindonesia.com` dengan aplikasi lain (SEC-14) | Eng-Web/DevOps | subdomain khusus + CSP untuk web |
| V5 | CSRF | N/A | tanpa cookie, token di header, CORS `credentials:false` | — | tetap tanpa cookie auth |
| V6 Kriptografi | AES-256-GCM + AAD, `kid` rotasi, HMAC pepper | ADA | `lib/crypto.ts`, `docs/03-database.md` §7.2 | Eng-API | prosedur rotasi KEK tertulis (runbook) |
| V6 | Manajemen kunci: generate & simpan di secret store | ADA | `scripts/gen-secrets.sh`, Worker secrets | DevOps/Owner | salinan escrow offline `DATA_ENCRYPTION_KEYS` production (Owner+DPO) |
| V7 Log & error | Log JSON terstruktur dengan redaksi PII | ADA | `lib/logger.ts` (redaksi per nama key); pesan error DB `JK*` masih diteruskan ke klien (SEC-20) | Eng-API | petakan pesan `JK*` |
| V7 | Error tanpa bocor stack ke klien | ADA | `middleware/request.ts` | Eng-API | — |
| V7 | Audit trail tahan-rusak (hash chain) | SEBAGIAN | `audit_logs`, `verify_audit_chain()`, `db/tests/040_audit_chain.sql` | DevOps | checkpoint harian ke WORM (R2 Object Lock) |
| V7 | Pemantauan & alert keamanan | BELUM | Workers Observability aktif, belum ada alert | DevOps/Owner | alert: lonjakan 5xx, `REFRESH_TOKEN_REUSE`, `MALWARE_UPLOAD`, `payment.amount_mismatch`, `payment.webhook_not_confirmed_by_provider`, `MFA_RECOVERY_CODE_USED`, `ADMIN_PII_REVEALED` |
| V8 Data | Minimisasi & retensi | SEBAGIAN | `data_retention_policies` (ASUMSI), job `retention_purge` | DPO | validasi durasi oleh Legal (`docs/10-privacy.md`) |
| V8 | Data sensitif tidak dikirim ke klien (hash/enc/mask) | ADA | `test/security/data-exposure.test.ts` (sweep semua GET admin + baca pengguna) | Eng-API | — |
| V8 | Anonimisasi lengkap saat hapus akun | ADA | `anonymize_user()` (migrasi 0080) juga menghapus ciphertext tujuan refund & pesan offer (SEC-09); `db/tests/090_anonymize.sql`, `130_security_review.sql` | Eng-API/DPO | periksa setiap tabel baru berisi PII |
| V8 | Data di perangkat mobile | BELUM | belum ada kode | Eng-Mobile | jangan cache dokumen KYC; hapus cache saat logout |
| V9 Komunikasi | TLS di semua koneksi, HSTS | ADA | `app.ts`, `sslmode=require` dicek CI | DevOps | domain kustom: HSTS preload hanya setelah semua subdomain HTTPS |
| V10 Kode berbahaya | Dependensi terkunci & dipindai | ADA | frozen lockfile, Dependabot, OSV, `pnpm audit --prod` = 0 temuan (2026-09-28); wrangler dipin eksak di job deploy (SEC-11) | DevOps | wrangler sebagai devDependency terkunci; pin SHA action |
| V10 | Secret tidak di repo | ADA | `scripts/ci/secret-grep.sh`, gitleaks | DevOps | aktifkan secret scanning GitHub bila paket mendukung |
| V11 Logika bisnis | State machine tunggal, golden rule DO NOT PURCHASE | ADA | `packages/core/src/state-machine`, `db/tests/010_transitions.sql` | Eng-API | — |
| V11 | Anti-fraud (risk score, limit, referral guard, batas promo ditegakkan ulang saat checkout) | ADA | `packages/core/src/fraud`, `packages/core/src/limits`, `referrals/guardrail.ts`, `checkout/service.ts` `revalidatePromotions` (SEC-02), `test/security/money-abuse.test.ts` | Risk | kalibrasi ambang setelah 90 hari data |
| V11 | Idempotensi mutasi finansial (klaim retry atomik) & race uang | ADA | `middleware/idempotency.ts` (SEC-04), `db/tests/080_idempotency.sql`, `test/security/idempotency-race.test.ts`, `money-abuse.test.ts` (checkout paralel, replay webhook, refund vs konfirmasi) | Eng-API | — |
| V12 File | Tipe via magic bytes, ukuran, checksum, presigned terbatas | ADA | `modules/files/policy.ts`, `files.test.ts` | Eng-API | — |
| V12 | Pemindaian malware | SEBAGIAN | adapter clamav-http siap; staging MOCK | DevOps/Owner | layanan clamd sebelum production |
| V13 API | Autentikasi & otorisasi setiap endpoint, OpenAPI | ADA | `docs/api/openapi.json` | Eng-API | CI gagal bila OpenAPI basi |
| V13 | Rate limiting | SEBAGIAN | in-memory per isolate + limit DB untuk OTP/login/pembayaran; IP klien dari `CF-Connecting-IP` / XFF paling kanan (SEC-06, `client-ip.test.ts`) | DevOps | aturan WAF Cloudflare; origin Node hanya dari IP Cloudflare |
| V13 | Verifikasi webhook (token waktu-konstan + konfirmasi GET penyedia, fail-closed) | ADA | `providers/payment/xendit.ts`, `payments/service.ts` (SEC-03), `webhooks.test.ts`, `test/security/webhook-authenticity.test.ts` | Eng-API | minta daftar IP Xendit (allow-list opsional) |
| V14 Konfigurasi | Header keamanan, CORS allow-list, body limit | ADA | `app.ts` | Eng-API | — |
| V14 | Guard konfigurasi produksi (mock/log dilarang untuk pembayaran, e-mail, SMS, KYC, pemindai malware; LIVE butuh izin) | ADA | `env.ts` (SEC-08), `test/security/config-guard.test.ts`, `scripts/ci/worker-config.ts`, `deploy-production.yml` | DevOps | — |
| V14 | Build & deploy dapat direproduksi, least privilege CI | ADA | workflows `permissions:` per job, concurrency | DevOps | pin SHA action pihak ketiga |

## Sebelum production (gerbang keamanan)
- [x] Review keamanan internal pra-peluncuran — `docs/security/review-2026-09.md` (1 High, 7 Medium, 3 Low FIXED). PIC: Eng-API.
- [ ] Temuan OPEN review 2026-09: SEC-12 (tujuan refund — sebelum Iluma aktif), SEC-13 (TOFU TOTP admin), SEC-14 (origin & CSP web). PIC: Eng-API / DevOps.
- [ ] Pentest independen (API, admin, mobile) — laporan & perbaikan high/critical. PIC: Owner.
- [ ] Pemindai malware nyata aktif; unggah file uji EICAR ditolak. PIC: DevOps.
- [ ] Semua akun admin ber-MFA; ≥ 2 orang untuk maker-checker; akses admin via Cloudflare Access. PIC: Owner.
- [ ] Alert keamanan terpasang & on-call jelas. PIC: DevOps/Owner.
- [ ] Rotasi semua secret staging → nilai production baru (tidak ada reuse). PIC: DevOps.
- [ ] Checkpoint audit chain WORM berjalan. PIC: DevOps.
- [ ] Restore test berhasil ≤ 4 jam. PIC: DevOps.

---

**Catatan keterbatasan data:** status dinilai dari pembacaan kode dan test di repo per 2026-09-28 (diperbarui oleh review `docs/security/review-2026-09.md`), bukan dari audit
eksternal; pemetaan ASVS bersifat per bab (bukan verifikasi tiap requirement); kontrol klien mobile/admin belum dapat
dinilai karena kodenya sedang ditulis.
