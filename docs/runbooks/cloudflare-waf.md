# Runbook — Cloudflare WAF, rate limiting, bot & cache (launch checklist T11)

> Status: **belum dipasang** (belum ada domain kustom API). Aturan di bawah siap tempel untuk zona
> `antarkitaindonesia.com`. Batas paket dikutip dari dokumentasi Cloudflare (diakses 2026-10-04); tandai
> **[BERBAYAR]** = butuh Pro atau lebih tinggi. Aturan WAF hanya berpengaruh pada lalu lintas yang lewat zona — bukan
> `*.workers.dev`.

## 0. Prasyarat

1. **Domain kustom API**: `jastipkita-api.antarkitaindonesia.com` (production) dan
   `jastipkita-api-staging.antarkitaindonesia.com` (staging) sebagai *Custom Domain* Worker (`infra/cloudflare/wrangler.toml`,
   `docs/07-deployment.md` §9). Production sudah `workers_dev = false`; staging masih `workers_dev = true` → URL
   `*.workers.dev` staging **melewati semua aturan di sini**. Matikan setelah domain kustom staging aktif.
2. Dashboard: Cloudflare → zona `antarkitaindonesia.com` → *Security*. Semua ekspresi di bawah dibatasi `http.host`,
   jadi situs landing di zona yang sama tidak terpengaruh.
3. Uji tiap aturan dulu di staging (ganti host), lalu pantau *Security → Events* 24 jam sebelum menyalin ke production.

Kuota paket Free (Cloudflare docs): **5** custom rules (aksi selain *Log*; regex tidak tersedia), **1** rate limiting
rule — field ekspresi hanya *Path* & *Verified Bot*, hitungan per **IP**, periode maks **10 detik**, timeout mitigasi
maks **10 detik**. Pro: 20 custom rules, 2 rate limiting rules (field host/URI/query, periode ≤ 1 menit, timeout ≤ 1 jam).
Business: metode/IP/User-Agent di ekspresi, periode ≤ 10 menit. Sumber: [WAF custom rules](https://developers.cloudflare.com/waf/custom-rules/),
[Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/).

## 1. Rate limiting

Lapisan aplikasi sudah ada (`apps/api/src/middleware/rate-limit.ts`, per isolate) + batas berbasis DB di layanan OTP
(per tujuan/perangkat) — itu yang menegakkan aturan bisnis. Aturan edge ini hanya **meredam banjir** sebelum Worker
(CPU) dan Postgres terbebani. Catatan penting: operator seluler Indonesia memakai **CGNAT** — ratusan pengguna sah bisa
berbagi satu IP. Ambang per IP harus longgar; jangan menurunkannya tanpa melihat *Security Events* nyata.

**Free — satu-satunya aturan (pakai untuk endpoint auth):**

| Field | Nilai |
|---|---|
| Rule name | `api-auth-flood` |
| If incoming requests match (Edit expression) | `(starts_with(http.request.uri.path, "/v1/auth/"))` |
| Characteristics | IP (satu-satunya pilihan di Free) |
| When rate exceeds | **30** requests per **10 seconds** |
| Then | Block, durasi **10 seconds** (maksimum Free); response default 429 |

Path `/v1/auth/*` hanya ada di API (situs landing tidak punya), jadi tanpa field host pun tidak bocor ke situs lain.
Bandingkan: aplikasi membatasi `/v1/auth/otp/request` 30/menit/IP dan `/v1/auth/otp/verify` 60/menit/IP; aturan edge
30 per 10 detik (= 180/menit) hanya menyala pada banjir nyata.

**[BERBAYAR] Pro — dua aturan, jendela 1 menit:**

| Rule | Expression | Rate | Action |
|---|---|---|---|
| `api-otp` | `(http.host eq "jastipkita-api.antarkitaindonesia.com" and http.request.uri.path in {"/v1/auth/otp/request" "/v1/auth/otp/verify"})` | 40 / 1 min per IP | Block 10 min |
| `api-auth` | `(http.host eq "jastipkita-api.antarkitaindonesia.com" and starts_with(http.request.uri.path, "/v1/auth/"))` | 120 / 1 min per IP | Managed Challenge tidak cocok untuk API (klien bukan browser) → Block 10 min |

Business ke atas bisa menambah `http.request.method eq "POST"` dan *counting expression* status 4xx (hitung hanya OTP gagal).

## 2. Custom rules (Free: 5 aturan — urutan sesuai prioritas)

Ganti `API` dengan host production (`jastipkita-api.antarkitaindonesia.com`); buat salinan untuk host staging bila kuota
cukup (atau pakai `http.host in {"…" "…"}`).

**R1 — rute dev & MOCK tidak boleh terjangkau di production** (aplikasi juga menolaknya di luar development; ini lapis kedua) — *Block*:
```
(http.host eq "jastipkita-api.antarkitaindonesia.com" and (starts_with(http.request.uri.path, "/v1/dev/") or http.request.uri.path eq "/v1/webhooks/payments/mock"))
```

**R2 — bentuk webhook pembayaran** — *Block*: hanya `POST` ke `/v1/webhooks/payments/xendit` dengan header
`x-callback-token`. Token tetap diverifikasi constant-time oleh API (salah → 401, tidak disimpan); aturan ini membuang
sampah sebelum menyentuh Worker.
```
(http.host eq "jastipkita-api.antarkitaindonesia.com" and starts_with(http.request.uri.path, "/v1/webhooks/") and (http.request.method ne "POST" or http.request.uri.path ne "/v1/webhooks/payments/xendit" or not any(len(http.request.headers["x-callback-token"][*]) > 0)))
```
*Allowlist IP Xendit:* Xendit **tidak** mempublikasikan IP sumber webhook; dokumentasinya meminta merchant menghubungi CS
untuk daftar IP, dan menekankan verifikasi lewat token `x-callback-token`
([Xendit — Integration security](https://docs.xendit.co/docs/integration-security)). Karena itu andalan kita = token.
Bila daftar IP resmi didapat **tertulis** dari Xendit: buat *Custom list* `xendit_webhook_ips` (Manage Account →
Configurations → Lists; jumlah list di Free = ASUMSI 1, cek) dan tambahkan ke R2:
`… or not ip.src in $xendit_webhook_ips`. Risiko: Xendit mengganti IP tanpa kabar → semua webhook ditolak di edge
(rekonsiliasi `money.reconcile_pending_payments` tetap menarik status tiap 10 menit, tetapi pantau `WEBHOOK_BACKLOG`).

**R3 — hanya permukaan API yang dikenal** — *Block* (API melayani `/v1/*` dan `/health` saja; memotong pemindai `/.env`, `/wp-admin`, …):
```
(http.host eq "jastipkita-api.antarkitaindonesia.com" and not starts_with(http.request.uri.path, "/v1/") and http.request.uri.path ne "/health")
```

**R4 — metode HTTP** — *Block* (CORS API: GET, POST, PUT, PATCH, DELETE, OPTIONS):
```
(http.host eq "jastipkita-api.antarkitaindonesia.com" and not http.request.method in {"GET" "POST" "PUT" "PATCH" "DELETE" "OPTIONS" "HEAD"})
```

**R5 — cadangan** (sengaja kosong): pakai saat insiden untuk memblokir ASN/negara/IP tertentu yang terlihat di
*Security Events*, contoh `(http.host eq "…" and ip.src in {203.0.113.7 198.51.100.0/24})` → Block. Jangan memblokir
negara secara permanen: traveler sengaja berada di luar negeri (JP, SG, KR, MY, AU, US).

Tidak dipakai, dengan alasan: *Managed/JS Challenge* di host API (klien Flutter, admin `fetch`, dan Xendit tidak bisa
menyelesaikan tantangan browser); allowlist IP untuk `/v1/admin/*` (admin bekerja dari jaringan seluler/berubah — kontrol
yang ada: RBAC + MFA TOTP wajib + step-up + maker-checker).

## 3. Bot & pengaturan keamanan zona

- **Bot Fight Mode: JANGAN diaktifkan di zona ini.** Berlaku untuk seluruh zona, *tidak bisa di-skip* dengan custom rule
  atau Page Rules, dan dapat menantang lalu lintas API/aplikasi seluler ([Cloudflare — Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/))
  → webhook Xendit dan aplikasi Flutter bisa terblokir. **[BERBAYAR]** *Super Bot Fight Mode* (Pro+) berjalan di Ruleset
  Engine dan mendukung aturan Skip — pertimbangkan saat ada bukti bot nyata.
- *Browser Integrity Check*: bisa menolak klien non-browser dengan header tidak lazim; bila 403 muncul untuk aplikasi
  (*Security Events* → layanan "Browser Integrity Check"), nonaktifkan untuk host API lewat *Configuration Rules*
  (ASUMSI tersedia di Free — cek).
- *Security Level*: Medium (default) untuk landing; jangan "I'm Under Attack" di host API (memberi tantangan JS).
- SSL/TLS: *Full (strict)*, *Always Use HTTPS*, *Minimum TLS 1.2*, HSTS sudah dikirim API (`max-age=63072000`).

## 4. Cache rules (web statis)

Hanya berlaku bila DNS `antarkitaindonesia.com` diproksikan Cloudflare (awan oranye) di depan GitHub Pages
(`docs/07-deployment.md` §8). Astro menulis aset ber-hash ke `/jastipkita/_assets/` (`apps/web/astro.config.mjs`);
HTML tidak ber-hash. *Caching → Cache Rules* (Free: kuota ASUMSI 10 aturan):

| # | Rule | Expression | Setting |
|---|---|---|---|
| C1 | `web-hashed-assets` | `(http.host eq "antarkitaindonesia.com" and starts_with(http.request.uri.path, "/jastipkita/_assets/"))` | Eligible for cache · Edge TTL: ignore origin, **1 year** · Browser TTL: override, **1 year** (nama file berubah tiap build) |
| C2 | `web-html` | `(http.host eq "antarkitaindonesia.com" and starts_with(http.request.uri.path, "/jastipkita/") and not starts_with(http.request.uri.path, "/jastipkita/_assets/"))` | Eligible for cache · Edge TTL **10 min** · Browser TTL: respect origin (GitHub Pages ±10 min) — rilis terlihat ≤ 10 menit tanpa purge |
| C3 | `api-no-cache` | `(http.host in {"jastipkita-api.antarkitaindonesia.com" "jastipkita-api-staging.antarkitaindonesia.com"})` | **Bypass cache** (respons Worker memang tidak di-cache; aturan ini mencegah salah konfigurasi di masa depan) |

Admin di Cloudflare Pages memakai cache bawaan Pages — tidak perlu aturan; jangan proksikan admin lewat cache rule.
Setelah rilis web yang mendesak (mis. teks legal): *Caching → Configuration → Purge by prefix* `antarkitaindonesia.com/jastipkita/`.

## 5. Verifikasi setelah pemasangan

```bash
API=https://jastipkita-api-staging.antarkitaindonesia.com
curl -s -o /dev/null -w '%{http_code}\n' "$API/v1/health"                        # 200
curl -s -o /dev/null -w '%{http_code}\n' "$API/.env"                             # 403 (R3)
curl -s -o /dev/null -w '%{http_code}\n' -X PROPFIND "$API/v1/health"            # 403 (R4)
curl -s -o /dev/null -w '%{http_code}\n' "$API/v1/webhooks/payments/xendit"      # 403 (R2: GET)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/v1/webhooks/payments/xendit" -H 'content-type: application/json' -d '{}'   # 403 (R2: tanpa token)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/v1/webhooks/payments/xendit" -H 'x-callback-token: salah' -H 'content-type: application/json' -d '{}'  # 401 dari API (lolos edge, ditolak aplikasi)
for i in $(seq 1 40); do curl -s -o /dev/null -w '%{http_code} ' -X POST "$API/v1/auth/otp/verify" -H 'content-type: application/json' -d '{}'; done; echo   # 400… lalu 429 dari Cloudflare
```
Lalu: login OTP dari aplikasi Flutter (data seluler) dan admin web, satu pembayaran Xendit TEST end-to-end (webhook
`200`), dan cek *Security → Events* tidak berisi blokir untuk lalu lintas sah. Catat hasilnya (tanggal, host, siapa) di
`docs/checklists/launch-checklist.md` baris T11.

## 6. Rollback

Setiap aturan bisa dimatikan (toggle) tanpa deploy. Bila pengguna sah terblokir: matikan aturan terkait → lihat
*Security Events* (aturan, IP/ASN, path) → sesuaikan ambang → aktifkan lagi. Aturan tidak menyentuh data aplikasi.

---

**Catatan keterbatasan data:** kuota & fitur per paket dari dokumentasi Cloudflare yang diakses 2026-10-04 (bisa
berubah; yang ditandai ASUMSI tidak disebut eksplisit di halaman yang dicek); ambang rate limit adalah **usulan** untuk
volume peluncuran dan belum diuji terhadap lalu lintas nyata/CGNAT; informasi IP webhook Xendit dari dokumentasi Xendit
(daftar IP hanya via CS). Belum ada aturan yang dipasang di Cloudflare.
