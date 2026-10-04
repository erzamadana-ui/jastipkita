# 07 — Panduan Deployment (untuk Owner)

> Tujuan: menyalakan **staging** JastipKita dengan biaya **Rp0** (Neon Free + Cloudflare Workers Free + GitHub).
> Semua pembayaran di staging memakai **Xendit TEST (SANDBOX)** — tidak ada uang sungguhan.
> Production baru dikerjakan setelah checklist `docs/checklists/launch-checklist.md` hijau dan owner menyetujui
> layanan berbayar, pembayaran LIVE, dan submit ke toko aplikasi.

Urutan kerja (±3–4 jam untuk pertama kali):

| # | Langkah | Hasil |
|---|---|---|
| 1 | GitHub: cek paket, buat branch `develop`, environment, variabel | repo siap menerima secret |
| 2 | Neon: buat project Singapore | database kosong |
| 3 | Bootstrap database (sekali) + buat role | skema + role `jk_migrate_staging`, `jk_api_staging`, `jk_backup_staging` |
| 4 | Cloudflare: akun, subdomain workers.dev, token, R2 | tempat API & file |
| 5 | Isi secret & variabel GitHub (nama persis) | pipeline tahu kredensial |
| 6 | Xendit TEST (+ Resend untuk OTP e-mail) | pembayaran sandbox, login bisa diuji |
| 7 | Deploy pertama + smoke test | `/v1/health` = ok, SANDBOX |
| 8 | Web ke antarkita-landing, admin ke Cloudflare Pages; domain API se-situs (§8.3, §9) | situs & admin staging, sesi web bisa diperpanjang |
| 9 | Backup harian terenkripsi | `db-backup.yml` hijau |
| 10 | (Otomatis) build iOS tanpa tanda tangan di runner macOS — `mobile-ios.yml` (§13) | bukti aplikasi iOS ter-compile |

---

## 1. GitHub

### 1.1 Cek paket akun (penting — menentukan fitur)
Repo `erzamadana-ui/jastipkita` bersifat **private**. Per dokumentasi GitHub (verifikasi di *Settings → Billing and plans*):

| Fitur | GitHub Free + repo private | GitHub Pro/Team | Dampak |
|---|---|---|---|
| Menit GitHub Actions | ±2.000 menit/bulan (ASUMSI, cek Billing) | lebih besar | CI ±35–45 menit per push ke `main` (ASUMSI) → ±45 push/bulan. Runner **macOS dihitung 10×** di repo private: satu build iOS ±150–250 menit tagihan (ASUMSI, §13) |
| Environments + environment secrets | tidak tersedia | tersedia | di Free: simpan secret **staging** sebagai *Repository secrets* dengan **nama yang sama** |
| Required reviewers untuk environment | tidak | tidak untuk repo private (Enterprise) | gerbang production diganti: daftar `PRODUCTION_DEPLOYERS` + frasa konfirmasi + keputusan tercatat |
| Branch protection / rulesets | tidak | tersedia | di Free: disiplin PR manual |
| Code scanning (CodeQL) | berbayar (Code Security) | berbayar | `codeql.yml` nonaktif sampai `CODEQL_ENABLED=true`; Semgrep gratis sudah jalan di CI |
| Dependabot alerts | gratis | gratis | aktifkan di *Settings → Code security* |

Rekomendasi: GitHub Pro (±US$4/bulan, ASUMSI) sudah cukup untuk environment + branch protection. **Butuh persetujuan owner.**

### 1.2 Branch
1. Buat branch `develop` dari `main` (Dependabot menargetkan `develop`).
2. Alur kerja: `feat/*` → PR ke `develop` → PR `develop` → `main` (setiap push ke `main` = deploy staging).
3. Jika paket mendukung: *Settings → Branches → Add rule* untuk `main`: wajib PR, wajib status check
   `Detect changes`, `core (typecheck + tests + tokens)`, `db (PostgreSQL 16)`, `db (PostgreSQL 17)`,
   `api (typecheck + tests + OpenAPI + bundles)`, `secret scan (guard + gitleaks)`. (Job yang dilewati karena
   tidak ada perubahan dihitung sukses.)

### 1.3 Environment
*Settings → Environments → New environment*: `staging`, `production`, `mobile-release`.
Untuk `production` (jika tersedia): *Deployment branches* = `main` saja; *Required reviewers* = owner (hanya bila paket mendukung).

### 1.4 Actions
*Settings → Actions → General*: Workflow permissions = **Read repository contents** (default). Jangan izinkan
Actions membuat/menyetujui PR.

---

## 2. Neon (database staging)

1. Daftar di https://console.neon.tech (login GitHub/Google).
2. **Create project**: nama `jastipkita-staging`, Postgres **17**, region **AWS Asia Pacific (Singapore)**
   = `aws-ap-southeast-1`. Database default `neondb`, owner `neondb_owner`.
3. Catat *Project ID* (Settings → General) → nanti variabel `NEON_PROJECT_ID` (opsional).
4. Tombol **Connect** → pilih role `neondb_owner`, database `neondb`:
   - matikan *Connection pooling* → salin string **direct** (host tanpa `-pooler`) → untuk bootstrap di §3.
5. Batas Neon Free (ASUMSI, cek https://neon.com/pricing): PITR 6 jam / 1 GB history, kuota compute bulanan,
   *scale to zero* setelah 5 menit idle. Cron Worker tiap 5 menit membuat compute hampir selalu menyala →
   kuota bisa habis ±hari ke-16–17 (lihat `docs/01-architecture.md` §10 W7). Jika Neon mengirim peringatan kuota,
   ubah `crons` staging di `infra/cloudflare/wrangler.toml` menjadi `"*/15 * * * *"`.

---

## 3. Bootstrap database (sekali saja)

Migrasi pertama **harus** dijalankan oleh owner database (`neondb_owner`) karena migrasi 0016 membuat role
`jk_migrator`, `jk_app`, `jk_readonly`.

> **Masalah yang ditemukan & solusinya:** di PostgreSQL ≥ 16, owner non-superuser (seperti `neondb_owner`) gagal di
> migrasi 0016 dengan `ERROR: must be able to SET ROLE "jk_migrator"`. Solusinya menjalankan migrasi dengan
> `PGOPTIONS="-c createrole_self_grant=set,inherit"`. Workflow deploy **sudah otomatis** memasangnya; CI
> (`scripts/ci/db-provider-parity.sh`) menguji langkah ini di PostgreSQL 16 dan 17. Perbaikan permanen di
> migrasi adalah tugas pemilik skema DB (sudah dilaporkan).

### 3.1 Jalankan migrasi pertama lewat GitHub Actions (tanpa install apa pun)
1. GitHub → *Settings → Secrets and variables → Actions* (environment `staging`, atau repository jika Free):
   secret `DATABASE_URL_MIGRATOR` = string **direct** `neondb_owner` dari §2 langkah 4 (harus berakhiran `?sslmode=require`).
2. *Actions → Deploy staging → Run workflow* (branch `main`).
3. Job **Migrate Neon (staging)** harus hijau dan ringkasan menampilkan `applied 0001_…` s.d. migrasi terakhir.
   (Job API akan dilewati bila secret Cloudflare belum ada — normal.)

Alternatif dari laptop (butuh `psql` 17 dan Git Bash/WSL/macOS/Linux):
```bash
export DATABASE_URL='postgres://neondb_owner:<password>@<endpoint>.ap-southeast-1.aws.neon.tech/neondb?sslmode=require'
PGOPTIONS='-c createrole_self_grant=set,inherit' bash db/scripts/migrate.sh
bash db/scripts/seed.sh
bash db/scripts/migrate.sh --status | tail -3
```

### 3.2 Buat role login (Neon → SQL Editor, sebagai `neondb_owner`)
Buat password dulu (tidak disimpan ke disk): `bash scripts/gen-secrets.sh staging --db-passwords`.
```sql
CREATE ROLE jk_migrate_staging LOGIN PASSWORD '<password-1>' IN ROLE jk_migrator;  -- migrasi & seed (CI)
CREATE ROLE jk_api_staging     LOGIN PASSWORD '<password-2>' IN ROLE jk_app;       -- API runtime (DML saja)
CREATE ROLE jk_backup_staging  LOGIN PASSWORD '<password-3>';                      -- backup (baca saja)
GRANT pg_read_all_data TO jk_backup_staging;
-- Jika baris GRANT di atas ditolak Neon, pakai (lebih luas, tetap tanpa login interaktif):
-- GRANT jk_migrator TO jk_backup_staging;
SELECT rolname FROM pg_roles WHERE rolname LIKE 'jk\_%' ORDER BY 1;   -- cek: 6 role jk_
```
Neon mensyaratkan password role SQL berentropi ≥ 60 bit — password dari `gen-secrets.sh` 192 bit.

### 3.3 Susun connection string (ganti user & password pada string owner)
| Secret | Role | Jenis | Contoh bentuk |
|---|---|---|---|
| `DATABASE_URL_MIGRATOR` | `jk_migrate_staging` | **direct** | `postgres://jk_migrate_staging:<pw>@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require` |
| `DATABASE_URL` | `jk_api_staging` | **pooled** (`-pooler`) | `postgres://jk_api_staging:<pw>@ep-xxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require` |
| `DATABASE_URL_BACKUP` | `jk_backup_staging` | **direct** | `postgres://jk_backup_staging:<pw>@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require` |

Kenapa berbeda: API membuka 1 koneksi per request (pooler PgBouncer, `prepare=false`); migrasi memakai opsi sesi
(`-c role=jk_migrator`) dan backup memakai `pg_dump` — keduanya butuh koneksi langsung.

Setelah itu **ganti** `DATABASE_URL_MIGRATOR` dari string owner ke string `jk_migrate_staging`, jalankan lagi
*Deploy staging*: job migrate harus berkata `no pending migrations`. String `neondb_owner` jangan disimpan di mana pun.

---

## 4. Cloudflare (API + file)

1. Daftar https://dash.cloudflare.com. *Workers & Pages* → pilih subdomain `workers.dev` (mis. `antarkita`) →
   URL API staging menjadi `https://jastipkita-api-staging.<subdomain>.workers.dev`.
2. **Account ID**: halaman *Workers & Pages* (panel kanan) → secret `CLOUDFLARE_ACCOUNT_ID`.
3. **API token**: *My Profile → API Tokens → Create Token* → template **Edit Cloudflare Workers** → *Account
   Resources*: akun Anda → tambah izin **Account › Cloudflare Pages › Edit** (untuk admin) → *Create* → salin
   sekali → secret `CLOUDFLARE_API_TOKEN`. Untuk domain kustom production nanti, batasi *Zone Resources* ke
   zona `antarkitaindonesia.com`.
4. **R2 (penyimpanan file)**: *R2 Object Storage* → aktifkan. Cloudflare dapat meminta metode pembayaran untuk
   mengaktifkan R2 meskipun pemakaian di bawah kuota gratis (verifikasi saat aktivasi) → **perlu persetujuan owner**
   karena ada risiko tagihan bila kuota terlewati.
   - *Create bucket* `jastipkita-staging`, location hint *Asia-Pacific*.
   - *Settings → CORS policy* (unggah langsung dari web/admin; aplikasi mobile tidak butuh CORS):
     ```json
     [{"AllowedOrigins":["https://antarkitaindonesia.com","https://staging.jastipkita-admin.pages.dev","http://localhost:4321","http://localhost:5173"],
       "AllowedMethods":["PUT","GET","HEAD"],"AllowedHeaders":["content-type"],"MaxAgeSeconds":600}]
     ```
   - *Manage R2 API Tokens → Create API token* → **Object Read & Write**, *Specify bucket* `jastipkita-staging`
     → salin *Access Key ID* → secret `S3_ACCESS_KEY_ID`, *Secret Access Key* → secret `S3_SECRET_ACCESS_KEY`.
   - Endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` → variabel `S3_ENDPOINT`.

---

## 5. Daftar secret & variabel (nama persis)

Buat nilai kriptografi: `bash scripts/gen-secrets.sh staging` (hanya dicetak ke layar; tempel satu per satu).

### 5.1 Environment `staging` — Secrets
| Nama | Wajib | Isi |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | ya | token §4.3 |
| `CLOUDFLARE_ACCOUNT_ID` | ya | §4.2 |
| `DATABASE_URL_MIGRATOR` | ya | direct `jk_migrate_staging` |
| `DATABASE_URL` | ya | pooled `jk_api_staging` |
| `JWT_SECRET` | ya | gen-secrets |
| `DATA_ENCRYPTION_KEYS` | ya | gen-secrets (`kid:base64`) |
| `HMAC_PEPPER` | ya | gen-secrets — **jangan pernah diganti setelah ada data** |
| `XENDIT_SECRET_KEY` | ya* | `xnd_development_…` (§6) |
| `XENDIT_WEBHOOK_TOKEN` | ya* | token verifikasi webhook (§6) |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | ya | R2 §4.4 |
| `RESEND_API_KEY` | untuk login e-mail | §6.2 |
| `DATABASE_URL_BACKUP` | untuk backup | direct `jk_backup_staging` |
| `BACKUP_ENCRYPTION_PUBLIC_KEY` | untuk backup | `age1…` (boleh juga sebagai variabel) |
| `LANDING_DEPLOY_TOKEN` | untuk publish web | §8.1 |
| `FCM_SERVICE_ACCOUNT_JSON`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `NEON_API_KEY`, `SETTLEMENT_SECRETS_JSON`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | opsional | — |

\* Tanpa kunci Xendit, set variabel `PAYMENT_PROVIDER=mock` agar deploy tidak ditolak; checkout di staging tidak bisa diselesaikan (rute simulasi hanya ada di development).

### 5.2 Environment `staging` — Variables
| Nama | Wajib | Contoh |
|---|---|---|
| `API_BASE_URL` | ya | awal: `https://jastipkita-api-staging.<subdomain>.workers.dev` (cukup untuk mobile & admin); untuk **login web** wajib domain se-situs `https://jastipkita-api-staging.antarkitaindonesia.com` (§8.3, §9) |
| `S3_ENDPOINT` | ya | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `ADMIN_BASE_URL` | bila admin dipakai | `https://staging.jastipkita-admin.pages.dev` |
| `CORS_ORIGINS` | ya untuk web | `https://antarkitaindonesia.com` (origin tanpa path) — juga daftar origin yang boleh memakai cookie refresh web (§8.3) |
| `EMAIL_PROVIDER`, `EMAIL_FROM` | untuk OTP e-mail | `resend`, `JastipKita Staging <no-reply@antarkitaindonesia.com>` |
| `GOOGLE_CLIENT_IDS`, `APPLE_CLIENT_IDS` | untuk login sosial | ID klien publik (dipisah koma) |
| `PAYMENT_PROVIDER` | opsional | `mock` sementara bila Xendit belum ada |
| `PG_MAJOR` | opsional | `17` |
| `ADMIN_PAGES_PROJECT` | untuk admin | `jastipkita-admin` |
| `LANDING_BRANCH`, `LANDING_PATH`, `LANDING_REPO`, `LANDING_ADD_NOJEKYLL` | opsional | `main`, `jastipkita`, `erzamadana-ui/antarkita-landing`, `true` |
| `PUBLIC_API_BASE_URL`, `PUBLIC_SUPPORT_WHATSAPP`, `PUBLIC_SUPPORT_EMAIL`, `PUBLIC_PLAY_STORE_URL`, `PUBLIC_APP_STORE_URL`, `PUBLIC_ENABLE_GOOGLE_LOGIN`, `PUBLIC_GOOGLE_CLIENT_ID` | opsional | nilai publik untuk build web |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET` | opsional | salinan backup ke R2 |

### 5.3 Repository — Variables (tanpa environment)
| Nama | Isi |
|---|---|
| `STAGING_API_BASE_URL` | sama dengan `API_BASE_URL` staging (dipakai build CI mobile/web) |
| `PRODUCTION_API_BASE_URL` | nanti, untuk rilis mobile production |
| `PRODUCTION_DEPLOYERS` | `erzamadana-ui` (login GitHub yang boleh deploy production, dipisah koma) |
| `CODEQL_ENABLED` | kosong/`false` sampai repo public atau Code Security dibeli |
| `ANDROID_VERSION_CODE_OFFSET`, `IOS_RELEASE_ENABLED`, `IOS_BUILD_NUMBER_OFFSET` | untuk `mobile-release.yml` |
| `IOS_CI_AUTO` | kosong = build iOS otomatis jalan (push `main` yang mengubah app, mingguan); `false` = hanya manual (*Run workflow*) — rem biaya menit macOS (§13) |

### 5.4 Environment `mobile-release` — Secrets
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
(+ iOS nanti: `IOS_DIST_CERT_P12_BASE64`, `IOS_DIST_CERT_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`, `IOS_TEAM_ID`,
`APPSTORE_CONNECT_API_KEY_ID`, `APPSTORE_CONNECT_ISSUER_ID`, `APPSTORE_CONNECT_API_KEY_P8_BASE64`).
Buat upload keystore sekali di laptop: `keytool -genkeypair -v -keystore upload.jks -keyalg RSA -keysize 4096 -validity 10000 -alias upload`,
lalu `base64 -w0 upload.jks` → secret. Simpan `upload.jks` + password di password manager (2 salinan offline).

### 5.5 Environment `production` (nanti)
Nama sama dengan staging + `NEON_API_KEY` (secret), `NEON_PROJECT_ID`, `NEON_PRODUCTION_BRANCH_ID`,
`ALLOW_LIVE_PAYMENTS` (`true`/`false` — **keputusan tertulis owner**), `LIVE_PAYMENTS_DECISION_REF` (nomor/tautan
dokumen keputusan) sebagai variabel. Lihat `infra/env/production.env.example`.

---

## 6. Pihak ketiga (mode uji)

### 6.1 Xendit TEST
1. Daftar https://dashboard.xendit.co → pastikan saklar **Test mode** aktif.
2. *Settings → API Keys → Generate secret key* (izin Money-in write, Money-out write, Read) → `xnd_development_…`
   → secret `XENDIT_SECRET_KEY`. Kunci `xnd_production_…` **dilarang** di staging (CI menolak).
3. *Settings → Webhooks*: salin *verification token* → secret `XENDIT_WEBHOOK_TOKEN`; isi URL webhook
   *Payment Session*/*Payments*/*Refund*/*Payout* = `<API_BASE_URL>/v1/webhooks/payments/xendit`.

### 6.2 Login di staging (wajib salah satu)
Dengan `EMAIL_PROVIDER=log` dan `SMS_PROVIDER=log`, kode OTP **tidak terkirim ke siapa pun** (dan `OTP_DEV_ECHO`
dilarang di staging) → tester tidak bisa login. Pilih:
- **Resend** (gratis dengan kuota harian/bulanan — ASUMSI, cek resend.com/pricing): tambah domain pengirim
  (disarankan subdomain, mis. `send.antarkitaindonesia.com`; tambahkan record SPF/DKIM di DNS domain) → API key
  *Sending access* → secret `RESEND_API_KEY` + variabel `EMAIL_PROVIDER=resend`.
- **Google Sign-In**: buat OAuth client di Google Cloud Console (web/Android/iOS) → variabel `GOOGLE_CLIENT_IDS`.

SMS/WhatsApp (Twilio) berbayar per pesan → **perlu persetujuan owner**.

---

## 7. Deploy pertama & smoke test

1. Pastikan §5 wajib sudah terisi. *Actions → Deploy staging → Run workflow* (branch `main`).
2. Ringkasan run menampilkan tabel kesiapan, migrasi, `integrations`, dan hasil smoke test.
3. Cek manual:
   ```bash
   curl -s https://jastipkita-api-staging.<subdomain>.workers.dev/v1/health | jq
   # harus: "status":"ok", "env":"staging", "database":{"ok":true,"schemaVersion":"<migrasi terakhir>"},
   #        "integrations":{"payments":"SANDBOX" (atau "MOCK"), ...}  — TIDAK PERNAH "LIVE"
   curl -s -o /dev/null -w '%{http_code}\n' https://…/v1/openapi.json   # 200
   ```
4. Setelah itu setiap merge ke `main` yang lulus CI otomatis ter-deploy ke staging.

## 8. Web & admin

### 8.1 Web → `https://antarkitaindonesia.com/jastipkita/`
1. GitHub → *Settings → Developer settings → Fine-grained tokens → Generate*: resource owner `erzamadana-ui`,
   *Only select repositories* = `antarkita-landing`, izin **Contents: Read and write**, kedaluwarsa 90 hari
   (catat tanggal rotasi) → secret `LANDING_DEPLOY_TOKEN`.
2. Di repo `antarkita-landing` → *Settings → Pages*: catat branch sumber (variabel `LANDING_BRANCH` bila bukan `main`).
3. Astro menghasilkan folder `_assets/`; GitHub Pages (Jekyll) mengabaikan folder berawalan `_` → wajib ada file
   `.nojekyll` di root `antarkita-landing`. Jika situs AntarKita **tidak** memakai Jekyll (hanya HTML statis), set
   variabel `LANDING_ADD_NOJEKYLL=true`; workflow akan menambahkannya. Tanpa itu workflow menolak publish (aman).
4. Catatan: GitHub Pages hanya punya satu lingkungan — apa pun yang dipublish langsung **publik**. Konten web tidak
   boleh mengklaim layanan sudah live.

### 8.2 Admin → Cloudflare Pages (tidak diindeks)
1. `npx wrangler@4 pages project create jastipkita-admin --production-branch main` (atau Dashboard → *Workers & Pages →
   Create → Pages → Direct upload*).
2. Variabel `ADMIN_PAGES_PROJECT=jastipkita-admin`; URL staging `https://staging.jastipkita-admin.pages.dev` →
   isi juga variabel `ADMIN_BASE_URL` (agar CORS API mengizinkan admin).
3. Workflow menambahkan `robots.txt` (Disallow) + header `X-Robots-Tag: noindex`.
4. Disarankan: *Zero Trust → Access → Applications → Self-hosted* untuk host admin, kebijakan hanya e-mail staf
   (paket gratis Zero Trust — ASUMSI batas 50 user).

### 8.3 Alamat web & SEC-14 — keputusan Komisaris 2026-10-04
**Keputusan:** web publik tetap di `https://antarkitaindonesia.com/jastipkita` (origin bersama dengan situs AntarKita),
**tanpa subdomain**. Pengganti origin terpisah — dua kontrol yang wajib ada sebelum web dipakai publik:

| Kontrol | Isi | Status |
|---|---|---|
| CSP di **seluruh origin** | Setiap halaman `antarkitaindonesia.com` (termasuk repo `antarkita-landing`, bukan hanya `/jastipkita/`) memuat Content-Security-Policy tanpa `unsafe-inline` untuk skrip. Halaman tanpa CSP = jalan masuk XSS ke origin JastipKita. | `/jastipkita/` sudah ber-CSP (`apps/web`); halaman landing lain **belum diperiksa** — `deploy-staging.yml` melaporkan jumlahnya di ringkasan run + peringatan `SEC-14` |
| Refresh token di **cookie HttpOnly** pada host API | Cookie `jk_rt` (HttpOnly; Secure; SameSite=Strict; Path=/v1/auth; host-only) — token panjang tidak bisa dibaca JavaScript. Hanya aktif bila klien mengirim header `X-JK-Token-Transport: cookie` dan `Origin` termasuk `WEB_BASE_URL`/`CORS_ORIGINS`. | dikerjakan Eng-API 2026-10-04 (`apps/api/src/modules/auth/cookie-transport.ts`) |

Konsekuensi deployment (yang rusak duluan bila diabaikan):
1. **API harus se-situs dengan web.** Cookie `SameSite=Strict` tidak disimpan dan tidak dikirim pada permintaan
   lintas situs. Dengan API di `*.workers.dev`, login web berhasil tetapi **tidak bisa diperpanjang**: pengguna web
   ter-logout setiap kali access token habis (`ACCESS_TOKEN_TTL_SEC` = 900 → ±15 menit). Mobile & admin tidak
   terdampak (refresh lewat body). Solusi: domain kustom API di bawah `antarkitaindonesia.com` (§9) — **staging juga**
   bila web staging ingin diuji login. Ringkasan *Deploy staging* menampilkan baris *Web session (refresh cookie)* dan
   peringatan bila `API_BASE_URL` belum se-situs; *Deploy production* memberi peringatan yang sama.
2. **CSP landing tidak bisa dipasang sebagai header di GitHub Pages.** Pilihan: (a) tag `<meta http-equiv="Content-Security-Policy">`
   di setiap halaman landing (tanpa `frame-ancestors`/`report-to` — tidak didukung lewat meta), atau (b) zona
   `antarkitaindonesia.com` di Cloudflare (proxy) + *Rules → Transform Rules → Modify Response Header* untuk seluruh
   origin: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `frame-ancestors 'none'`, HSTS (jumlah rule
   gratis terbatas — ASUMSI, cek paket). Opsi (b) sekaligus membuka domain kustom API pada poin 1.
3. **Batas kontrol cookie (jujur):** HttpOnly mencegah *pencurian* refresh token, tetapi XSS yang berjalan di origin
   yang sama tetap bisa memanggil `/v1/auth/refresh` (cookie ikut terkirim) dan bertindak atas nama pengguna selama
   tab terbuka. CSP seluruh origin adalah kontrol utama; cookie membatasi dampak setelah tab ditutup.
4. Aplikasi Flutter versi web (`/jastipkita/app/`, dipublikasi terpisah) menyimpan token lewat `flutter_secure_storage`
   (di web = localStorage) pada origin yang sama — jangan dipublikasikan untuk publik sebelum memakai transport cookie
   yang sama (tugas Eng-Mobile).
5. Jalur tetap `/jastipkita`: `astro.config` (`base`), App Links (`assetlinks.json`), AASA, `WEB_BASE_URL` aplikasi
   dan Origin cookie semuanya mengasumsikannya. Workflow memberi peringatan bila variabel `LANDING_PATH` diubah.

## 9. Domain kustom API (wajib untuk login web — staging & production)
- Alasan: cookie refresh web hanya bekerja bila API se-situs dengan `antarkitaindonesia.com` (§8.3 poin 1).
- Butuh zona `antarkitaindonesia.com` dikelola DNS Cloudflare (pindah nameserver — tanpa biaya; lakukan hati-hati
  karena situs & e-mail AntarKita ikut: salin semua record DNS lama, termasuk MX/SPF/DKIM, sebelum mengganti nameserver).
- Gunakan hostname khusus: `jastipkita-api-staging.antarkitaindonesia.com` (staging) dan
  `jastipkita-api.antarkitaindonesia.com` (production) sebagai *Custom Domain* Worker (wrangler.toml / Dashboard →
  Worker → *Settings → Domains & Routes*), lalu ubah variabel `API_BASE_URL` (+ `STAGING_API_BASE_URL` repository dan
  `PUBLIC_API_BASE_URL` web) ke hostname tersebut.
- `api.antarkitaindonesia.com/jastipkita` (rute dengan path) **belum bisa**: API melayani `/v1/*` dan tidak membuang
  prefix path. Perlu perubahan kode di `worker.ts` oleh tim API bila ingin memakai pola ini (web saat ini default ke
  URL tersebut — samakan dengan variabel `PUBLIC_API_BASE_URL`).

## 10. Rollback
| Apa | Cara |
|---|---|
| Kode API (Worker) | Cloudflare Dashboard → Workers → `jastipkita-api-staging` → *Deployments* → *Rollback*; atau `npx wrangler@4 rollback --config infra/cloudflare/wrangler.toml --env staging -y -m "alasan"`. Production: otomatis bila smoke gagal. |
| Database | **Forward-only**: migrasi kompensasi (nomor baru) atau restore (PITR/branch/dump) — `docs/runbooks/db-restore.md`. Jangan edit migrasi yang sudah diterapkan (checksum ditolak). |
| Web | revert commit di `antarkita-landing` (`git revert`), push. |
| Admin | Pages → *Deployments* → pilih deploy sebelumnya → *Rollback*. |
| Secret salah | perbaiki di GitHub → *Run workflow* dengan `force_secrets=true`. |

## 11. Production (ringkas, jangan dijalankan sebelum gerbang lulus)
`deploy-production.yml` hanya manual: pemicu harus ada di `PRODUCTION_DEPLOYERS`, mengetik `DEPLOY PRODUCTION`,
ref harus di `main` dan CI-nya hijau; lalu backup (Neon branch `predeploy-*` atau dump terenkripsi) → migrasi →
deploy → smoke → rollback otomatis Worker jika smoke gagal. Pembayaran LIVE hanya bila variabel
`ALLOW_LIVE_PAYMENTS=true` + `LIVE_PAYMENTS_DECISION_REF` cocok dengan input — keduanya diisi owner setelah kontrak
Xendit, konfirmasi tertulis soal penahanan dana, dan review hukum.

## 12. Troubleshooting
| Gejala | Penyebab | Tindakan |
|---|---|---|
| `Worker config … CHANGE-ME` | variabel wajib belum diisi | isi `API_BASE_URL` / `S3_ENDPOINT` |
| `EMAIL_PROVIDER=resend requires RESEND_API_KEY` | variabel & secret tidak sinkron | tambah secret atau kembalikan `EMAIL_PROVIDER=log` |
| `must be able to SET ROLE "jk_migrator"` | bootstrap tanpa workaround | jalankan via workflow (otomatis) atau pakai `PGOPTIONS` §3.1 |
| `password authentication failed` | user/password/connection string salah | cek §3.3 (pooled vs direct) |
| `/v1/health` → `degraded`, `database.ok=false` | `DATABASE_URL` salah atau compute Neon habis kuota | cek string pooled; cek *Usage* di Neon |
| error 1102 / *exceeded resource limits* | batas CPU Workers Free | `docs/01-architecture.md` §10 W1/W2 → keputusan owner |
| Browser: CORS error | origin tidak terdaftar | `CORS_ORIGINS` (origin tanpa path) / `ADMIN_BASE_URL` |
| Web tampil tanpa CSS | `_assets` diabaikan Jekyll | §8.1 langkah 3 |
| Push ke landing ditolak | token kedaluwarsa/izin kurang | buat ulang token §8.1 |
| CI menghabiskan menit | paket Free | gabung PR sebelum merge ke `main`; cek *Billing → Usage*; menit macOS (×10): variabel `IOS_CI_AUTO=false` (§13) |
| Web: pengguna ter-logout ±15 menit setelah login | API di `*.workers.dev` (lintas situs) → cookie `jk_rt` SameSite=Strict tidak tersimpan | domain kustom API di bawah `antarkitaindonesia.com` (§8.3, §9) |
| Peringatan `SEC-14` di *Deploy staging* | halaman landing di luar `/jastipkita/` tanpa CSP | pasang CSP (meta atau header Cloudflare) — §8.3 poin 2 |
| iOS: `pod install` → *required a higher minimum deployment target* | plugin baru butuh iOS > 15.5 | naikkan `IOS_DEPLOYMENT_TARGET` di `apps/mobile/tool/configure_native.py` (§13.3) |
| iOS di Mac Apple silicon: simulator gagal link (*building for iOS Simulator-arm64*) | `mobile_scanner` 6 (MLKit 7) tanpa slice arm64-simulator | jalankan di iPhone fisik atau simulator Rosetta; permanen: `mobile_scanner` ≥ 7 (§13.3) |

## 13. CI (GitHub Actions) & build iOS

### 13.1 Workflow
| Workflow | Pemicu | Runner | Catatan |
|---|---|---|---|
| `ci.yml` | push/PR `main`, `develop`, manual | Ubuntu | core, db, api, web, admin, mobile (Android APK + web), secret scan, audit. Status check wajib §1.2 |
| `mobile-ios.yml` | push `main` yang mengubah `apps/mobile/**` / `packages/design-tokens/**` / workflow itu sendiri, mingguan (Senin 04.47 WIB), manual | **macOS** | build iOS debug tanpa tanda tangan; **terpisah dari `ci.yml`** agar deploy staging/production tidak menunggu atau terblokir job macOS |
| `mobile-release.yml` | manual | Ubuntu (+ macOS untuk job iOS, nonaktif) | AAB/APK bertanda tangan; IPA hanya bila `IOS_RELEASE_ENABLED=true` + sertifikat Apple |
| `deploy-staging.yml`, `deploy-production.yml`, `db-backup.yml`, `codeql.yml` | lihat §7, §11, `docs/08-backup-dr.md` | Ubuntu | — |

### 13.2 Versi action (runtime Node 24) — diperbarui 2026-10-04
Run CI menampilkan peringatan *deprecation* runtime Node 20 untuk action JavaScript; action berikut dinaikkan ke major
yang berjalan di `node24` (dicek dari `action.yml` tiap tag + catatan rilis resmi). Semua mensyaratkan Actions Runner ≥ 2.327.1 —
otomatis terpenuhi di runner GitHub-hosted.

| Action | Dari → ke | Bukti (catatan rilis) | Dampak ke input kita |
|---|---|---|---|
| `pnpm/action-setup` | v4 → **v5** | v5.0.0 "Updated the action to use Node.js 24"; `action.yml` v4 vs v5 hanya beda `runs.using` | tidak ada — versi pnpm tetap dari `packageManager` (`pnpm@10.28.0`). v6 (dukungan pnpm 11) sengaja **tidak** dipakai |
| `actions/upload-artifact` | v4 → **v7** | v6.0.0 "runs on Node.js 24"; v7.0.0 ESM + input baru `archive` (default `true` = zip seperti dulu). v5 masih `node20` | tidak ada — nama artefak tetap unik per run, `retention-days`/`if-no-files-found`/`compression-level` sama |
| `actions/cache` (+ `/restore`, `/save`) | v4 → **v6** | v5.0.0 "runs on the Node.js 24 runtime"; v6.0.0 migrasi ESM, input identik | tidak ada; paling buruk satu kali *cache miss* fingerprint secret Worker (secret didorong ulang sekali) |
| `actions/setup-go` | v5 → **v7** | v6.0.0 "Upgrade Nodejs runtime from node20 to node 24" + penanganan toolchain; v7.0.0 ESM | tidak ada — kita memakai `go-version: stable`, `cache: false`, tanpa `go.mod` |
| `actions/setup-java` (`mobile-release.yml`) | v4 → **v5** | v5.0.0 Node 24; v4 kini `deprecationMessage` | tidak ada — `distribution`/`java-version` sama |
| `github/codeql-action/{init,analyze}` | v3 → **v4** | CHANGELOG 4.30.7 "[v4+ only] … runs on Node.js v24"; v3 deprecated Desember 2026 (4.31.3) | tidak ada — input `languages`/`build-mode`/`queries`/`config`/`category` tetap |

Tidak diubah: `actions/checkout@v5`, `actions/setup-node@v5` (sudah `node24`), `subosito/flutter-action@v2`
(composite; di dalamnya sudah `actions/cache@v5`). Dependabot (`github-actions`, mingguan) mengusulkan major berikutnya.

### 13.3 Build iOS (`mobile-ios.yml`)
- **Apa yang dibuktikan:** folder `ios/` (dibuat `flutter create` bila belum di-commit) + semua plugin ter-compile
  dengan pengaturan `apps/mobile/tool/configure_native.py`: bundle id `com.antarkitaindonesia.jastipkita`, nama
  *JastipKita*, iOS minimum **15.5**, purpose string kamera/galeri/mikrofon (Indonesia), URL scheme `jastipkita`,
  entitlements Sign in with Apple + Associated Domains (`applinks:`/`webcredentials:antarkitaindonesia.com`, cocok
  dengan `apps/web/well-known/apple-app-site-association`). Langkah terakhir memeriksa `Info.plist` hasil build.
- **Bukan bukti:** penandatanganan, instal di iPhone, upload TestFlight/App Store (butuh Apple Developer Program
  US$99/tahun — keputusan owner, `mobile-release.yml`).
- **Build debug untuk device (arm64) `--no-codesign`, bukan `--simulator`:** `mobile_scanner` 6.x memakai GoogleMLKit
  7.0 yang tidak punya slice arm64-simulator (CHANGELOG 6.0.2) sementara runner macOS = Apple silicon. Alasan yang sama
  membuat simulator di Mac Apple silicon owner gagal link → pakai iPhone fisik/simulator Rosetta, atau (usulan, perlu
  Eng-Mobile) naik ke `mobile_scanner` ≥ 7 (Apple Vision, iOS 13+, tanpa MLKit) lalu turunkan target ke 15.0.
- **iOS 15.5:** minimum tertinggi di antara plugin (`mobile_scanner` 6.0.0: "iOS 15.5.0 is now the minimum");
  Flutter stable sendiri 15.0. Konsekuensi: iPhone yang tertahan di iOS ≤ 15.4 tidak bisa memasang aplikasi.
- **CocoaPods / Swift Package Manager:** SPM aktif default di Flutter stable; plugin tanpa dukungan SPM (MLKit) tetap
  lewat CocoaPods. Workflow menjalankan `pod install` (ulang dengan `--repo-update` bila gagal) hanya bila `ios/Podfile` ada.
- **Biaya:** ±15–25 menit runner per run = ±150–250 menit tagihan di repo private (×10, ASUMSI — ukur di run pertama,
  lihat durasi job). Pemicu otomatis + mingguan bisa menghabiskan sebagian besar kuota ±2.000 menit/bulan paket
  Free → set variabel repository `IOS_CI_AUTO=false` untuk hanya-manual. Concurrency membatalkan run lama di ref yang sama.
- **Membaca hasil:** *Actions → Mobile iOS → run* → ringkasan (versi Flutter/Xcode/CocoaPods, bundle id,
  MinimumOSVersion, ukuran app) + artefak kecil **`mobile-ios-logs`** (7 hari: log `pod install` & `flutter build`,
  `flutter doctor -v`, Podfile/Podfile.lock, Info.plist, entitlements). Tidak ada `.app`/IPA yang diunggah.
- **Saat akun Apple sudah ada (owner):** di App ID `com.antarkitaindonesia.jastipkita` aktifkan *Sign in with Apple* dan
  *Associated Domains*; isi Team ID di AASA (`TEAMID.` → Team ID) dan publikasikan ke
  `https://antarkitaindonesia.com/.well-known/apple-app-site-association` (`apps/web/scripts/deploy-to-landing.sh`);
  buat OAuth client iOS Google → jalankan skrip dengan `GOOGLE_IOS_CLIENT_ID=<id>` (menambah `GIDClientID` + URL
  scheme reversed client id) dan pakai id yang sama sebagai dart-define; commit `apps/mobile/ios` (bersama `android/`
  dan `web/`) sebelum rilis toko pertama.

---

**Catatan keterbatasan data:** batas paket GitHub, Neon, Cloudflare, Resend dan harga GitHub Pro diambil dari
dokumentasi publik yang dapat berubah dan ditandai **ASUMSI** — verifikasi di halaman harga masing-masing saat
setup. Estimasi menit CI belum diukur di runner GitHub. Langkah bootstrap §3 telah diuji pada klaster
PostgreSQL 16 lokal dengan owner non-superuser (bukan pada Neon sungguhan); perilaku `GRANT pg_read_all_data`
di Neon belum diverifikasi. Workflow `mobile-ios.yml` disusun tanpa Mac dan **belum pernah dijalankan** di GitHub
(divalidasi dengan actionlint 1.7.12 + uji skrip pada template Flutter stable); versi action diverifikasi dari
catatan rilis & `action.yml` resmi per 2026-10-04. Perilaku cookie lintas situs (§8.3) mengikuti aturan SameSite
browser umum; uji di Safari, Chrome dan Firefox setelah domain kustom API aktif.
