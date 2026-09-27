# 10 — Privasi & Kepatuhan UU PDP

> **Bukan nasihat hukum.** Pemetaan teknis terhadap UU 27/2022 (UU PDP) dan PP 33/2026 berdasarkan riset
> `docs/research/05-legal-regulatory.md` (tanggal berlaku PP 33/2026 masih `NEEDS_VERIFICATION`: ±15/16 Januari 2027).
> Wajib ditinjau konsultan hukum sebelum peluncuran. Semua durasi retensi di bawah adalah **ASUMSI** (ditandai
> `is_assumption` di tabel `data_retention_policies`).

## 1. Peran & tata kelola
| Hal | Posisi saat ini | Tindakan | PIC |
|---|---|---|---|
| Pengendali data | PT pemilik JastipKita (belum berdiri/terkonfirmasi) | tetapkan entitas hukum | Owner/Legal |
| Pejabat PDP (DPO) | belum ditunjuk | wajib bila pemrosesan data spesifik skala besar = inti bisnis (KYC biometrik) → tunjuk sebelum KYC nyata | **Owner** |
| Catatan aktivitas pemrosesan (RoPA, ≥ 13 elemen PP 33/2026) | draf di §2 (belum lengkap) | lengkapi bersama Legal | DPO |
| Perjanjian prosesor (DPA) | belum ada | Xendit, Neon, Cloudflare, Resend, Twilio, Google (FCM), GitHub | Legal |

## 2. Aktivitas pemrosesan (draf RoPA)
| Aktivitas | Data | Dasar pemrosesan (usulan) | Lokasi penyimpanan | Retensi (ASUMSI) |
|---|---|---|---|---|
| Akun & login | nama tampilan, e-mail, nomor HP (HMAC + terenkripsi di OTP), perangkat | kontrak | Neon (Singapura) | selama akun aktif; anonimisasi saat hapus akun |
| KYC | nomor & foto KTP/paspor, nama, tgl lahir, selfie/liveness (**biometrik = data spesifik**) | kewajiban hukum (APU-PPT, bila berlaku) + **persetujuan eksplisit** (`consents.type = KYC`) | Neon (terenkripsi AES-GCM), R2 (envelope) | 5 tahun setelah akun ditutup |
| Rekening payout | nomor rekening (terenkripsi + HMAC), nama pemilik | kontrak | Neon | mengikuti catatan keuangan |
| Transaksi, ledger, pembayaran | nilai, status, bukti pembelian, bea cukai | kontrak + kewajiban hukum (pembukuan/pajak) | Neon, R2 | 10 tahun |
| Pengiriman | alamat (terenkripsi), kota | kontrak | Neon | 90 hari setelah transaksi selesai → anonimisasi |
| Chat | pesan, lampiran | kontrak (+ moderasi keamanan) | Neon, R2 | 2 tahun setelah transaksi selesai |
| Trust score & fraud | sinyal perilaku (hash), keputusan risiko | kepentingan sah (pencegahan penipuan) — **keputusan otomatis → DPIA** | Neon | risk/security 12 bulan, trust history selama akun |
| Analitik produk | event tanpa PII (disaring server) | kepentingan sah; pemasaran = persetujuan | Neon | 13 bulan |
| Pemasaran | e-mail/push promosi | **persetujuan** (`consents.type = MARKETING`, terpisah dari T&C) | Neon | sampai persetujuan ditarik |
| Backup | salinan seluruh DB (terenkripsi age) | kepentingan sah (kelangsungan layanan) | GitHub (artifact), R2 opsional | 14 hari (artifact), 35 hari (R2) |

## 3. Hak subjek data (UU PDP Pasal 5–13; tenggat 3×24 jam untuk akses & koreksi)
| Hak | Implementasi | Status | Catatan |
|---|---|---|---|
| Akses / salinan data | `POST /v1/privacy/export` → job `identity.privacy_export` → file JSON terenkripsi, unduh 7 hari (hanya pemilik) | ADA (API) | SLA 72 jam = ASUMSI; pantau `privacy_requests` |
| Koreksi | `PATCH /v1/me` (profil); data KYC → pengajuan KYC baru/penanganan admin | SEBAGIAN | proses koreksi KYC via tiket support perlu SOP |
| Hapus / tarik diri | `POST /v1/privacy/delete-account` → masa tenggang 14 hari → `anonymize_user()`; diblokir bila ada transaksi/sengketa/payout/refund berjalan | ADA (API) | jelaskan pengecualian retensi hukum di kebijakan privasi |
| Hapus via web (Google Play) | `https://antarkitaindonesia.com/jastipkita/akun/hapus/` | BELUM | halaman web harus dibuat tim web (lihat store checklist) |
| Tarik persetujuan | `POST /v1/me/consents {type, granted:false}` (append-only, riwayat utuh) | ADA (API) | tindak lanjut ≤ 3×24 jam (PP 33/2026) |
| Keberatan atas keputusan otomatis | risk HOLD/REVIEW selalu ditinjau manusia; banding dispute sekali | SEBAGIAN | tambahkan jalur keberatan untuk BLOCK di support |

**Backup vs penghapusan:** data yang dihapus masih ada di backup terenkripsi hingga 35 hari. Setelah restore
(`docs/runbooks/db-restore.md`), **jalankan ulang** anonimisasi untuk semua `privacy_requests` penghapusan yang selesai
setelah waktu backup. Sebutkan periode ini di kebijakan privasi.

## 4. Persetujuan (consent)
- Tabel `consents` append-only: `TOS, PRIVACY, KYC, MARKETING, COOKIES, TRAVELER_AGREEMENT, PAYMENT_TERMS` + versi
  dokumen hukum (`legal_documents`, immutable setelah publish). Akun baru wajib `TOS` + `PRIVACY`; `MARKETING` opsional.
- PP 33/2026: persetujuan **terpisah** dari syarat & ketentuan → UI mobile/web wajib checkbox terpisah (tidak dicentang
  default) untuk PRIVACY, KYC (biometrik) dan MARKETING. PIC: tim mobile/web + Legal.

## 5. Retensi (dari `db/scripts/gen-reference-seed.mjs`, semua ASUMSI)
| Data | Retensi | Pemicu | Aksi |
|---|---|---|---|
| identity_records, kyc_documents | 1.825 hari (5 th) | akun ditutup | hapus |
| financial_records (transaksi, pembayaran, refund, payout, ledger, quote, credit) | 3.650 hari (10 th) | dibuat | hapus |
| payment_webhook_events | 1.825 hari | dibuat | hapus |
| audit_logs | 3.650 hari | dibuat | hapus (setelah checkpoint hash disimpan) |
| messages, files.chat | 730 hari | transaksi selesai | anonimisasi / hapus (kecuali ditahan sengketa) |
| deliveries.address | 90 hari | transaksi selesai | anonimisasi |
| trip_verifications.file | 180 hari | trip selesai | hapus |
| analytics_events | 395 hari | dibuat | hapus |
| security_events | 365 hari | dibuat | hapus |
| notifications | 180 hari | dibuat | hapus |
| otp_challenges | 30 hari | dibuat | hapus |
| refresh_tokens | 30 hari | kedaluwarsa | hapus |
| idempotency_keys | 1 hari | kedaluwarsa | hapus |
| outbox_events, jobs | 14 / 30 hari | diproses | hapus |
| backup DB | 14 hari (artifact) / 35 hari (R2) | dibuat | kedaluwarsa otomatis |

Dijalankan oleh job harian `identity.privacy.retention_purge`; tabel append-only/hukum dilaporkan
`SKIPPED_APPEND_ONLY_OR_LEGAL_RETENTION`.

## 6. DPIA (wajib sebelum pemrosesan berisiko tinggi — PP 33/2026 Pasal 120–122)
| # | Pemrosesan | Alasan berisiko tinggi | Status | PIC |
|---|---|---|---|---|
| 1 | KYC biometrik (selfie, liveness) + dokumen identitas | data spesifik skala besar | BELUM | DPO + Legal |
| 2 | Rekening payout & data keuangan pribadi | data spesifik | BELUM | DPO + Finance |
| 3 | Trust score, fraud & risk scoring (keputusan otomatis: HOLD/BLOCK) | profiling & keputusan otomatis | BELUM | DPO + Risk |
| 4 | Ekstraksi produk dari tautan/foto (AI/heuristik) + moderasi chat | teknologi baru, konten pengguna | BELUM | DPO + Product |
| 5 | Transfer lintas negara (§7) | penyedia di luar Indonesia | BELUM | Legal |
Isi minimal tiap DPIA: tujuan & kebutuhan, alur data, risiko terhadap subjek, kontrol (enkripsi, akses `kyc.review`,
audit tampilan, retensi), risiko residual, persetujuan DPO.

## 7. Transfer lintas negara (UU PDP Pasal 56; PP 33/2026: adequacy → safeguard mengikat → persetujuan)
| Prosesor | Data | Lokasi (ASUMSI, verifikasi di DPA) | Catatan |
|---|---|---|---|
| Neon (AWS) | seluruh DB | Singapura (`aws-ap-southeast-1`) | di luar Indonesia |
| Cloudflare Workers | request API dalam proses | global (edge; Smart Placement dekat DB) | tidak menyimpan data kecuali log observability |
| Cloudflare R2 | file (KYC terenkripsi envelope) | location hint Asia-Pacific | jurisdiksi data R2 bisa dibatasi (EU/FedRAMP) — belum untuk ID |
| Xendit | data pembayaran | Indonesia | berlisensi BI |
| Resend | alamat e-mail, isi e-mail | AS (ASUMSI) | belum aktif |
| Twilio | nomor HP, OTP | AS (ASUMSI) | belum aktif |
| Google FCM / Sign-In | token perangkat, ID Google | global/AS | belum aktif |
| GitHub | backup terenkripsi (kunci privat tidak di GitHub) | AS | ciphertext saja |
Tindakan: DPA + klausul kontraktual standar per prosesor; ungkapkan di kebijakan privasi; bila regulator mensyaratkan
lokasi Indonesia untuk data spesifik, evaluasi region Jakarta (AWS `ap-southeast-3`) — Neon belum tentu tersedia di
sana (`NEEDS_VERIFICATION`) → berdampak pada ADR 0003.

## 8. Prosedur kegagalan pelindungan data (≤ 3×24 jam — UU PDP Pasal 46)
1. **Deteksi & catat waktu** (T0 = saat diketahui). Buka insiden (`docs/runbooks/security-incident.md`).
2. **Batasi**: cabut kredensial, rotasi secret, blokir akses, simpan bukti (log, `security_events`, `audit_logs`).
3. **Nilai** (≤ 24 jam): data apa, berapa subjek, data spesifik atau bukan, risiko bagi subjek.
4. **Notifikasi tertulis ≤ 72 jam dari T0** kepada **subjek data** dan **Lembaga PDP**: data yang terungkap, kapan &
   bagaimana, upaya penanganan & pemulihan. Jika mengganggu layanan publik/berdampak serius → umumkan ke masyarakat.
   Draf template dibuat bersama Legal sebelum launch.
5. **Pulihkan & evaluasi**: perbaikan, post-mortem, perbarui DPIA/RoPA.
Pemilik keputusan notifikasi: DPO + Owner. Catatan: struktur "Lembaga" PDP belum sepenuhnya terbentuk — konfirmasi
kanal pelaporan dengan Legal.

## 9. Checklist sebelum KYC nyata dibuka
- [ ] DPO ditunjuk; RoPA lengkap; DPIA #1–#3 disetujui.
- [ ] Kebijakan privasi & persetujuan terpisah dipublikasikan (versi di `legal_documents`).
- [ ] Halaman hapus akun web aktif; alur in-app diuji.
- [ ] DPA prosesor ditandatangani; transfer lintas negara diungkap.
- [ ] Template notifikasi insiden 3×24 jam siap; kontak Legal/DPO on-call.
- [ ] Durasi retensi divalidasi Legal (hapus tanda ASUMSI di `data_retention_policies`).

---

**Catatan keterbatasan data:** analisis hukum berasal dari riset desk (bukan opini hukum); tanggal berlaku PP 33/2026,
struktur Lembaga PDP, lokasi pemrosesan prosesor, dan seluruh durasi retensi adalah **ASUMSI/NEEDS_VERIFICATION**;
kontrol UI (checkbox persetujuan terpisah, halaman hapus akun) belum dapat diverifikasi karena kode klien sedang ditulis.
