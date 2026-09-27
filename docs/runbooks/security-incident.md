# Runbook — Insiden Keamanan

> Termasuk: kebocoran secret/kredensial, akses tidak sah (akun pengguna/admin), kebocoran data pribadi, penipuan
> terorganisasi, kompromi pipeline CI/CD, unggahan malware. Kewajiban UU PDP: notifikasi tertulis ke subjek data **dan**
> Lembaga PDP ≤ **3×24 jam** sejak diketahui (lihat `docs/10-privacy.md` §8).

## 0. Peran
| Peran | Siapa (isi sebelum launch) | Tugas |
|---|---|---|
| Incident Commander (IC) | Owner / delegasi | memimpin, memutuskan, komunikasi eksternal |
| Tech lead | Eng on-call | penahanan & pemulihan teknis |
| DPO | (belum ditunjuk) | penilaian data pribadi & notifikasi PDP |
| Finance | FINANCE_SUPER_ADMIN | dampak dana, hold payout |
| Legal | konsultan | kewajiban hukum, bahasa notifikasi |
Catat semua tindakan dengan waktu (UTC + WIB) di satu dokumen insiden. Jangan menghapus log/bukti.

## 1. Tingkat keparahan
| Level | Contoh | Target respons |
|---|---|---|
| SEV1 | secret production bocor, akses admin tidak sah, data KYC terekspos, dana dialihkan | mulai ≤ 15 menit, 24/7 |
| SEV2 | secret staging bocor, akun pengguna diambil alih (sedikit), serangan brute-force berlanjut | ≤ 1 jam |
| SEV3 | temuan kerentanan tanpa bukti eksploitasi, laporan `SECURITY.md` | ≤ 1 hari kerja |

## 2. Deteksi (sinyal yang sudah ada)
`security_events` (HIGH: `REFRESH_TOKEN_REUSE`, `MALWARE_UPLOAD`, `KYC_DUPLICATE_IDENTITY`, `SIGNUP_BLOCKED`, `MFA_FAILED`
berulang), `payment.amount_mismatch`, `ALERT reconciliation.mismatch`, gitleaks/secret-guard gagal di CI, lonjakan 401/429/5xx
di Workers Observability, laporan pengguna/peneliti, `/v1/admin/audit-logs/verify` gagal (audit chain rusak).

## 3. Penahanan (lakukan sesuai jenis)
**Secret bocor (repo, log, chat, laptop hilang):**
1. Anggap bocor = sudah dipakai. **Rotasi dulu, investigasi kemudian.**
2. Urutan rotasi & tempat:
   | Secret | Rotasi | Efek samping |
   |---|---|---|
   | `CLOUDFLARE_API_TOKEN` | Cloudflare → API Tokens → Roll/Delete | deploy memakai token baru |
   | Password role Neon (`DATABASE_URL*`) | Neon SQL: `ALTER ROLE jk_api_x PASSWORD '…'` (baru dari `gen-secrets.sh --db-passwords`) | perbarui secret → deploy `force_secrets=true` |
   | `XENDIT_SECRET_KEY` / `XENDIT_WEBHOOK_TOKEN` | Dashboard Xendit → hapus & buat kunci/token baru | webhook lama ditolak sampai secret diganti |
   | `JWT_SECRET` | nilai baru | semua access token tidak berlaku (pengguna refresh/login ulang) |
   | `DATA_ENCRYPTION_KEYS` | **tambahkan** kunci baru di depan (`kidBaru:…,kidLama:…`), jangan hapus lama | re-enkripsi data lama = pekerjaan terpisah |
   | `HMAC_PEPPER` | **jangan** diganti tanpa rencana migrasi (semua lookup rusak) | eskalasi ke Tim API |
   | `S3_*` (R2), `RESEND_API_KEY`, `TWILIO_*`, `FCM_*` | buat token baru, cabut lama | — |
   | `LANDING_DEPLOY_TOKEN`, keystore Android | cabut PAT; keystore upload bocor → minta reset upload key ke Google Play | — |
3. Bila secret pernah ter-commit: rotasi tetap wajib (riwayat Git sudah tersalin); baru kemudian bersihkan riwayat bila perlu.

**Akun admin dicurigai:** `POST /v1/admin/users/{id}/suspend` + `force-logout`, cabut peran (`DELETE /v1/admin/users/{id}/roles/{roleCode}`), reset MFA, periksa `audit_logs`
aktor tersebut (perubahan config, settlement, refund, role). Tahan payout yang disetujui akun itu.

**Pengambilalihan akun pengguna:** `POST /v1/admin/users/{id}/force-logout` (cabut semua sesi) lalu `…/suspend`,
tahan payout/transaksi berjalan, verifikasi ulang identitas.

**Serangan otomatis (OTP/login/brute force):** limit DB sudah aktif; tambah aturan WAF/rate limit Cloudflare (butuh zona),
blokir sementara ASN/IP; pertimbangkan menonaktifkan kanal OTP yang diserang.

**Malware terunggah:** file sudah ditolak & dihapus bila pemindai aktif; bila pemindai MOCK (staging) — cari file terkait,
karantina, beri tahu staf yang mungkin membuka.

**Pipeline CI/CD dikompromikan:** nonaktifkan workflow (Settings → Actions → Disable), cabut semua secret environment,
periksa commit/PR/run terbaru, rotasi semua secret.

## 4. Penilaian (≤ 24 jam)
Data apa (KYC? rekening? kontak?), berapa subjek, periode, apakah terenkripsi (kolom `*_enc` + kunci aman = risiko lebih
rendah), apakah dana terdampak. Kueri bukti: `security_events`, `audit_logs` (verifikasi chain), log Workers, log Neon.

## 5. Notifikasi (≤ 3×24 jam dari T0 bila data pribadi terdampak)
- Subjek data (e-mail/in-app) + Lembaga PDP: data yang terungkap, kapan & bagaimana, upaya penanganan & pemulihan,
  langkah yang disarankan ke pengguna (mis. waspada phishing), kontak.
- Mitra: Xendit (bila terkait pembayaran), penyedia cloud terkait.
- Publik: bila dampak luas/serius (keputusan IC + Legal).
Template disiapkan Legal sebelum launch (launch checklist L10).

## 6. Pemulihan & pelajaran
Perbaikan akar masalah, deploy, verifikasi (audit chain OK, rekonsiliasi 0 selisih), buka kembali akses bertahap.
Post-mortem tanpa menyalahkan ≤ 5 hari kerja; tindak lanjut masuk `docs/09-security.md` §3 (gap).

---

**Catatan keterbatasan data:** peran IC/DPO/on-call belum diisi; alert otomatis untuk sinyal di §2 belum dikonfigurasi
(hanya tercatat di DB/log); struktur Lembaga PDP dan kanal pelaporannya masih `NEEDS_VERIFICATION`.
