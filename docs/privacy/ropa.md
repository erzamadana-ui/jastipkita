# Catatan Aktivitas Pemrosesan Data Pribadi (RoPA) — JastipKita

> **TEMPLATE UNTUK REVIEW PROFESIONAL — bukan nasihat hukum.** Disusun dari kode & konfigurasi repo per 2026-10-04
> (`db/migrations/*.sql`, `apps/api/src/modules/*`, `db/scripts/gen-reference-seed.mjs`) dan `docs/10-privacy.md`.
> Wajib ditinjau dan disahkan **Pejabat Pelindungan Data Pribadi (DPO)** dan konsultan hukum sebelum pemrosesan data
> nyata. Semua integrasi masih **MOCK/SANDBOX** (`docs/STATUS.md` §2); belum ada data subjek nyata yang diproses.
> Label **ASUMSI** = belum diverifikasi; **NEEDS_VERIFICATION** = harus dicek ke sumber primer/penyedia.

| Atribut | Isi |
|---|---|
| Versi | 0.1 (draf) · 2026-10-04 |
| Pengendali Data Pribadi | **[NAMA PT — belum berdiri]** (`docs/STATUS.md` §4.1), [ALAMAT], [NIB] |
| DPO | **[BELUM DITUNJUK]** — wajib bila kegiatan inti = pemrosesan data spesifik skala besar (UU 27/2022 Pasal 53 ayat (1) huruf c) |
| Pemilik dokumen | DPO; kontributor: Tim API, Finance, Ops, Legal |
| Siklus tinjauan | setiap perubahan prosesor, skema DB, atau tujuan baru; minimal 12 bulan (ASUMSI) |
| Dokumen terkait | `docs/10-privacy.md`, [`dpia-kyc-payout.md`](dpia-kyc-payout.md), [`dpa-template.md`](dpa-template.md), `docs/legal/privacy-policy.md`, `docs/09-security.md` |

## 1. Dasar penyusunan

- **Dasar pemrosesan** mengacu UU 27/2022 Pasal 20 ayat (2): (a) persetujuan eksplisit, (b) perjanjian, (c) kewajiban
  hukum, (d) kepentingan vital, (e) tugas kepentingan umum, (f) kepentingan yang sah (teks diverifikasi, lihat §9).
  Kolom "dasar" di bawah adalah **usulan** dan wajib dikonfirmasi Legal.
- **Data spesifik** (UU 27/2022 Pasal 4 ayat (2)) di JastipKita: **data biometrik** (selfie/liveness KYC) dan **data
  keuangan pribadi** (rekening payout & rekening tujuan refund). Juga **data anak** bila pengguna < 18 tahun lolos —
  lihat temuan usia minimum di DPIA (R-14).
- **Elemen RoPA:** PP 33/2026 menurut riset (`docs/research/05-legal-regulatory.md` §1) mensyaratkan catatan aktivitas
  pemrosesan minimal 13 elemen (Pasal 74). Daftar resmi 13 elemen **belum berhasil dikutip dari teks primer**
  (`NEEDS_VERIFICATION`); kolom di bawah memakai elemen umum (tujuan, dasar, subjek, kategori data, sumber, penerima,
  transfer, retensi, keamanan, lokasi) dan harus dipetakan ulang setelah teks PP diperoleh dari JDIH.

## 2. Prosesor & penerima

Status per 2026-10-04. Lokasi = **ASUMSI** sampai dikonfirmasi di DPA/dokumen penyedia.

| Kode | Pihak | Peran (usulan) | Data yang diterima | Lokasi (ASUMSI) | Status integrasi | Bukti di kode |
|---|---|---|---|---|---|---|
| P-01 | Neon (di atas AWS) | prosesor | seluruh basis data (kolom PII terenkripsi/HMAC, sisanya plaintext) | Singapura `aws-ap-southeast-1` | staging belum menyala | `docs/07-deployment.md`, ADR 0003 |
| P-02 | Cloudflare Workers | prosesor | seluruh request/response API saat transit, IP klien (`CF-Connecting-IP`), log JSON (kunci PII diredaksi) | global (edge) | staging belum menyala | `apps/api/src/worker.ts`, `lib/logger.ts` |
| P-03 | Cloudflare R2 | prosesor | objek file: KYC & TRIP_DOC & EXPORT (envelope AES-256-GCM), struk, foto produk, bukti dispute, lampiran chat, avatar (**plaintext** untuk non-KYC); objek *staging* KYC plaintext sementara | location hint Asia-Pasifik | belum (dev: memori) | `providers/storage/s3.ts`, `modules/files/*` |
| P-04 | Xendit (PT Sinar Digital Terdepan / PT Syaftraco — lisensi BI per riset 02 §9) | prosesor (ASUMSI; sebagian peran bisa pengendali sendiri atas data KYC/AML-nya — Legal) | nama, e-mail, nomor HP pembeli, nominal, `reference_id`; nomor rekening + nama pemilik untuk payout traveler & refund-via-payout | Indonesia | MOCK (dev) / siap SANDBOX | `providers/payment/xendit.ts` (customer, `channel_properties`) |
| P-05 | Iluma (Xendit Data Services) — validasi nama rekening | prosesor | kode bank + nomor rekening → nama pemilik | NEEDS_VERIFICATION | **belum tersambung** (adapter mengembalikan `NAME_VALIDATION_UNAVAILABLE`) | `xendit.ts` `validateBankAccount` |
| P-06 | Resend | prosesor | alamat e-mail, isi e-mail transaksional (nama tampilan, produk, nominal), kode OTP e-mail | AS (ASUMSI) | MOCK (log) | `providers/email/resend.ts` |
| P-07 | Twilio | prosesor | nomor HP, isi SMS/WhatsApp (OTP) | AS (ASUMSI) | MOCK | `providers/sms/twilio.ts` |
| P-08 | Google Firebase Cloud Messaging | prosesor | token push perangkat, judul/isi notifikasi (termasuk nama pengirim + pratinjau chat ≤ 120 karakter, versi termask bila pesan FLAGGED) | global/AS (ASUMSI) | MOCK | `providers/push/fcm.ts`, `notifications/handlers.ts` |
| P-09 | Google Sign-In, Sign in with Apple | **pengendali terpisah** (ASUMSI — Legal): pengguna memilih login; API hanya memverifikasi ID token via JWKS, tidak mengirim data ke Google/Apple | (data mengalir dari Google/Apple ke JastipKita: subjek, e-mail, status verifikasi) | AS | siap, belum aktif | `modules/auth/oauth.ts` |
| P-10 | Vendor e-KYC | prosesor | foto dokumen, selfie, rekaman liveness (dikirim sebagai *file key*; mekanisme akses vendor ke objek belum dirancang) | **TBD** | **belum dipilih** — `KYC_PROVIDER=manual` (review admin) | `providers/kyc/index.ts`, `providers/types.ts` |
| P-11 | Pemindai malware (clamd + shim HTTP) | prosesor bila dihosting pihak ketiga; sistem internal bila dihosting sendiri | **byte file plaintext**, termasuk gambar KYC sebelum dienkripsi, + storage key | **TBD** (wajib di production) | MOCK | `providers/malware/clamav-http.ts`, `env.ts` (SEC-08) |
| P-12 | GitHub (Actions artifact) | prosesor | dump DB harian terenkripsi `age` (kunci privat tidak di GitHub) | AS | workflow siap | `.github/workflows/db-backup.yml`, `docs/08-backup-dr.md` |
| P-13 | Mitra asuransi/proteksi | TBD | id transaksi, nilai pertanggungan, deskripsi klaim (teks bebas, dapat memuat data pribadi) | TBD | MOCK, belum ada mitra | `providers/insurance/index.ts` |
| P-14 | Kurir / mitra logistik (dipilih traveler) | penerima / pengendali terpisah (ASUMSI) | alamat & kontak penerima yang diberikan traveler di luar sistem | Indonesia | tidak terintegrasi | `modules/delivery/service.ts` (hanya nama kurir + resi disimpan) |
| R-01 | Pengguna lawan transaksi | penerima | nama depan + inisial, level KYC, Trust Score, rating, pesan chat, data serah terima | — | — | `docs/legal/privacy-policy.md` §4 |
| R-02 | Instansi berwenang | penerima | sesuai permintaan sah | Indonesia | prosedur belum ada | — |

Tidak ada penerima untuk kurs FX (Frankfurter/ECB) dan ekstraksi produk (`HeuristicExtractionProvider` mengambil URL
merchant tanpa data pribadi) — `providers/fx/*`, `providers/extraction/heuristic.ts`.

## 3. Register aktivitas pemrosesan

Format setiap entri: tujuan · dasar (usulan) · subjek · kategori data (⚠ = data spesifik) · sumber · tempat simpan
(bukti) · penerima · transfer lintas negara · retensi (lihat §4 untuk status eksekusi) · keamanan · catatan.

### PA-01 Registrasi, autentikasi & sesi
| Elemen | Isi |
|---|---|
| Tujuan | membuat akun, login tanpa password (OTP e-mail/HP, Google, Apple), mempertahankan sesi, mencegah pengambilalihan akun |
| Dasar | perjanjian (Pasal 20(2)b); keamanan akun = kepentingan sah (f) |
| Subjek | Penitip, Traveler, staf admin |
| Data | e-mail, nomor HP (E.164), nama tampilan, locale, negara, foto profil; subjek penyedia login; HMAC tujuan OTP & kode OTP; hash refresh token, `ip_hash`, user-agent; perangkat (`fingerprint_hash` HMAC, token push, versi app/OS) |
| Sumber | pengguna; Google/Apple (ID token) |
| Tempat | `users`, `auth_identities`, `otp_challenges`, `refresh_tokens`, `devices`, `user_devices` (`0003_identity_access.sql`) |
| Penerima | P-01, P-02, P-06 (OTP e-mail), P-07 (OTP SMS/WA), P-09 |
| Transfer | Singapura (Neon); AS (Resend/Twilio, ASUMSI) |
| Retensi | akun aktif; anonimisasi saat hapus akun (`anonymize_user()`); `otp_challenges` 30 hari (efektif ±24 jam, lihat §4); `refresh_tokens` 30 hari setelah kedaluwarsa; **`devices` tanpa kebijakan** |
| Keamanan | OTP HMAC, 5 percobaan, TTL 5 menit, kuota per tujuan/IP di DB; refresh token sekali pakai + deteksi reuse; JWT 15 menit; kolom kontak disembunyikan dari `jk_readonly` (`jk_sensitive_columns`) |
| Catatan | baris `devices` (token push) tidak dihapus saat anonimisasi — hanya tautan `user_devices` (gap G-05) |

### PA-02 Persetujuan & dokumen hukum
| Elemen | Isi |
|---|---|
| Tujuan | bukti persetujuan TOS, PRIVACY, KYC, MARKETING, COOKIES, TRAVELER_AGREEMENT, PAYMENT_TERMS beserta versi dokumen |
| Dasar | kewajiban hukum (c) — pembuktian persetujuan |
| Subjek | semua pengguna |
| Data | jenis & versi persetujuan, granted/withdrawn, sumber, `ip_hash`, user-agent, waktu |
| Tempat | `consents` (append-only), `legal_documents` |
| Penerima | P-01 |
| Retensi | **tanpa kebijakan**; tabel append-only, tidak ikut anonimisasi (merujuk UUID) — ASUMSI: disimpan selama dapat menjadi bukti |
| Keamanan | append-only trigger; persetujuan KYC terpisah wajib sebelum `submitKyc` (`modules/kyc/service.ts`) |

### PA-03 Verifikasi identitas (KYC level 3) — ⚠ data spesifik
| Elemen | Isi |
|---|---|
| Tujuan | memverifikasi identitas Traveler/pengguna yang membutuhkan limit lebih tinggi; mencegah satu identitas banyak akun |
| Dasar | **persetujuan eksplisit terpisah** (`consents.type = KYC`); kewajiban hukum APU-PPT **hanya bila berlaku** (NEEDS_VERIFICATION) |
| Subjek | pengguna yang mengajukan KYC (WNI dengan KTP; WNA/WNI dengan paspor) |
| Data | jenis & nomor KTP/paspor, nama lengkap, tanggal lahir, kewarganegaraan; foto dokumen depan/belakang; ⚠ **selfie & 1–5 rekaman liveness (biometrik)**; skor liveness/face-match, alasan keputusan |
| Sumber | pengguna; vendor KYC (skor) — belum ada |
| Tempat | `kyc_submissions`, `kyc_documents`, `identity_records` (`*_enc` AES-256-GCM + `id_number_hash` HMAC), `files` purpose KYC di R2 (envelope) |
| Penerima | P-01, P-03, P-11 (plaintext saat pemindaian), P-10 (TBD); staf dengan `kyc.review` (OPERATIONS, RISK, COMPLIANCE, SUPER_ADMIN) |
| Transfer | Singapura (Neon), APAC (R2), vendor KYC TBD |
| Retensi | 1.825 hari setelah akun ditutup (`identity_records`, `kyc_documents` — ASUMSI); **dokumen pengajuan yang ditolak tetap tersimpan sampai akun ditutup + 5 tahun** (G-03) |
| Keamanan | lihat DPIA: enkripsi kolom & envelope, HMAC dedupe, akses hanya `kyc.review` + sesi admin ber-MFA, setiap tampilan diaudit (`kyc.document_viewed`, `kyc.submission_viewed`), pemilik pun tidak dapat mengunduh konten KYC |
| Catatan | DPIA wajib (Pasal 34 ayat (2) huruf b) — [`dpia-kyc-payout.md`](dpia-kyc-payout.md) |

### PA-04 Rekening payout Traveler — ⚠ data spesifik
| Elemen | Isi |
|---|---|
| Tujuan | membayar penghasilan traveler ke rekening atas nama yang benar; syarat level 4 |
| Dasar | perjanjian (b); pencegahan penipuan = kepentingan sah (f) |
| Subjek | Traveler |
| Data | ⚠ kode bank, nomor rekening (`account_number_enc` + HMAC), mask `****1234`, nama pemilik (plaintext, disembunyikan dari `jk_readonly`), status verifikasi |
| Sumber | traveler; hasil *name inquiry* (P-05, belum aktif) |
| Tempat | `payout_accounts` (`0006_kyc.sql`) |
| Penerima | P-01, P-04 (saat disbursement), P-05 (TBD); staf `kyc.review` melihat mask saja |
| Transfer | Singapura (Neon) |
| Retensi | selama akun; saat anonimisasi ciphertext & nama dihapus, hash + mask dipertahankan (riwayat payout & deteksi fraud) — **tanpa entri kebijakan retensi tersendiri** |
| Keamanan | step-up OTP `SENSITIVE_ACTION` (`PAYOUT_ACCOUNT_ADD`, `PAYOUT_ACCOUNT_SET_DEFAULT`), pencocokan nama dengan identitas KYC, `NAME_MISMATCH`/`PENDING` untuk review manual, hanya rekening `VERIFIED` yang dibayar; jeda payout rekening baru `money.policy.newPayoutAccountCooldownHours` (default 24 jam, migrasi `0120`, ditambahkan 2026-10-04) |

### PA-05 Trip & verifikasi dokumen perjalanan
| Elemen | Isi |
|---|---|
| Tujuan | publikasi trip, verifikasi bahwa traveler benar bepergian (level 4) |
| Dasar | perjanjian (b); kepentingan sah (f) untuk verifikasi |
| Subjek | Traveler |
| Data | negara/kota asal-tujuan, tanggal berangkat/tiba, kapasitas, catatan; e-tiket/boarding pass (TRIP_DOC, terenkripsi envelope) |
| Tempat | `trips`, `trip_verifications`, `files` TRIP_DOC |
| Penerima | P-01, P-03; publik: nama depan + inisial, kota, tanggal (SEC-19 ACCEPTED — risiko keamanan fisik) |
| Retensi | `trip_verifications.file` 180 hari setelah trip selesai (dijalankan); data trip mengikuti catatan transaksi |
| Keamanan | TRIP_DOC wajib terenkripsi (CHECK DB), akses staf diaudit (`trips.document_viewed`) |

### PA-06 Request, penawaran & pencocokan
| Elemen | Isi |
|---|---|
| Tujuan | membuat permintaan titipan, menerima penawaran, mencocokkan request–trip |
| Dasar | perjanjian (b) |
| Subjek | Penitip, Traveler |
| Data | nama/URL produk, merchant, catatan bebas, foto produk, pesan penawaran |
| Tempat | `requests`, `request_images`, `offers` |
| Penerima | P-01, P-03; pihak lawan |
| Retensi | mengikuti `financial_records` bila menjadi transaksi; teks bebas (`requests.notes`, `offers.message`) dihapus saat anonimisasi (SEC-09) |

### PA-07 Transaksi, SafePay, ledger & kepabeanan
| Elemen | Isi |
|---|---|
| Tujuan | menjalankan transaksi, menahan & melepas dana secara ledger, rincian harga, estimasi bea & pajak, bukti pembelian, rekonsiliasi |
| Dasar | perjanjian (b); kewajiban hukum pembukuan/pajak (c) |
| Subjek | Penitip, Traveler |
| Data | nominal, status, quote & FX lock, pembayaran (kanal, `provider_ref`), webhook mentah, jurnal ledger per pemilik, struk/foto/video/nomor seri pembelian, deklarasi & bukti bayar bea, item rekonsiliasi |
| Sumber | pengguna; Xendit (webhook, GET status) |
| Tempat | `transactions`, `quotes`, `quote_lines`, `payments`, `payment_webhook_events`, `ledger_*`, `purchase_proofs`, `customs_declarations`, `reconciliation_runs/items` |
| Penerima | P-01, P-03, P-04 (nama, e-mail, HP pembeli saat checkout) |
| Transfer | Singapura (Neon) |
| Retensi | `financial_records` 3.650 hari; `payment_webhook_events` 1.825 hari — **keduanya tidak dieksekusi job** (§4); file struk/foto **tanpa kebijakan** |
| Keamanan | ledger append-only & seimbang, FSM di DB, audit hash-chain, idempotensi, webhook diverifikasi ulang ke penyedia (SEC-03) |

### PA-08 Refund & rekening tujuan refund — ⚠ data spesifik
| Elemen | Isi |
|---|---|
| Tujuan | mengembalikan dana; untuk kanal yang tidak mendukung refund (VA, ritel) dana dikirim ke rekening pembeli |
| Dasar | perjanjian (b); kewajiban hukum perlindungan konsumen (c) — UU 8/1999 Pasal 7 huruf g (lihat §9) |
| Subjek | Penitip |
| Data | nominal, alasan, status; ⚠ kode bank, nomor rekening & nama pemilik (`*_enc`), HMAC, mask, hasil pencocokan nama, catatan review FINANCE |
| Tempat | `refunds`, `refund_events`, `refund_destinations` (`0040_money.sql`, `0090_qa_security_followups.sql`) |
| Penerima | P-01, P-04, P-05 (TBD); FINANCE melihat mask |
| Retensi | `refunds` = `financial_records`; `refund_destinations` **tanpa kebijakan** — ciphertext dihapus saat anonimisasi (SEC-09) |
| Keamanan | step-up OTP `REFUND_DESTINATION_SET` terikat id refund; nama ≠ identitas KYC → `PENDING_REVIEW` + review maker-checker; notifikasi `refund.destination_updated` |

### PA-09 Payout Traveler
| Elemen | Isi |
|---|---|
| Tujuan | membayar penghasilan & kompensasi traveler |
| Dasar | perjanjian (b); kewajiban hukum pembukuan (c) |
| Data | nominal, status, alasan hold, rekening tujuan (referensi `payout_account_id`) |
| Tempat | `payouts` |
| Penerima | P-01, P-04 (nomor rekening + nama pemilik didekripsi server-side saat disbursement) |
| Retensi | `financial_records` 3.650 hari (tidak dieksekusi job) |
| Keamanan | guard `PAYOUT_CLEAR` (risiko, tidak ada dispute terbuka, rekening VERIFIED); hold/release maker-checker |

### PA-10 Serah terima & pengiriman
| Elemen | Isi |
|---|---|
| Tujuan | mengatur meet-up/kurir, membuktikan serah terima |
| Dasar | perjanjian (b) |
| Data | alamat (terenkripsi, `address_enc`), kota (kasar), titik meet-up, jadwal, nama kurir & resi, hash PIN/QR, bukti foto |
| Tempat | `deliveries`, `files` DELIVERY_PROOF |
| Penerima | P-01, P-03; pihak lawan; P-14 di luar sistem |
| Retensi | `deliveries.address` 90 hari setelah transaksi selesai → anonimisasi (dijalankan); bukti foto **tanpa kebijakan** |
| Keamanan | alamat AES-GCM; PIN 6 digit sekali pakai, maks. 5 percobaan |

### PA-11 Chat & moderasi
| Elemen | Isi |
|---|---|
| Tujuan | komunikasi pihak transaksi; moderasi keselamatan (kontak di luar platform, penipuan) |
| Dasar | perjanjian (b); moderasi = kepentingan sah (f) |
| Data | isi pesan, lampiran, status moderasi, teks termask |
| Tempat | `conversations`, `messages`, `files` CHAT |
| Penerima | P-01, P-03, P-08 (pratinjau push); staf `chat.moderate` hanya dengan dispute/tiket terbuka, alasan wajib, diaudit (`chat.conversation_viewed`) |
| Retensi | `messages` 730 hari setelah transaksi selesai → anonimisasi; `files.chat` 730 hari → hapus; pesan yang menjadi bukti dispute ditahan (keduanya dijalankan) |

### PA-12 Sengketa (dispute)
| Elemen | Isi |
|---|---|
| Tujuan | menyelesaikan sengketa & mengeksekusi akibat dana |
| Dasar | perjanjian (b); kewajiban hukum perlindungan konsumen (c) |
| Data | tipe, deskripsi, bukti (foto, video, struk, bukti kirim, rujukan pesan), resolusi & nominal, catatan agen, banding |
| Tempat | `disputes`, `dispute_events`, `dispute_evidence`, `files` EVIDENCE |
| Penerima | P-01, P-03; pihak lawan (bukti); OPERATIONS (`disputes.manage`) |
| Retensi | **tanpa kebijakan tersendiri** (ASUMSI: ikut `financial_records`) |

### PA-13 Layanan pelanggan & pengaduan
| Elemen | Isi |
|---|---|
| Tujuan | menjawab pertanyaan, menangani keluhan & pengaduan konsumen (kategori `COMPLAINT`, default prioritas HIGH — migrasi `0130_consumer_complaints.sql`, ditambahkan 2026-10-04) |
| Dasar | perjanjian (b); kewajiban hukum (c) — Permendag 19/2026 Pasal 10, 12, 13 (diverifikasi, §9) |
| Data | kategori, subjek, isi pesan & lampiran, prioritas, SLA, catatan internal agen |
| Tempat | `support_tickets`, `ticket_messages` (`body` disembunyikan dari `jk_readonly`) |
| Penerima | P-01, P-03; SUPPORT/OPERATIONS (`support.tickets.manage`) |
| Retensi | **tanpa kebijakan**; saat anonimisasi isi diganti `[dihapus atas permintaan pengguna]` |
| Catatan | SOP: `docs/sop/customer-service.md` |

### PA-14 Trust Score, rating, fraud & risiko — keputusan otomatis
| Elemen | Isi |
|---|---|
| Tujuan | mencegah penipuan, menetapkan limit, menahan payout berisiko |
| Dasar | kepentingan sah (f) — **DPIA tersendiri wajib** (Pasal 34 ayat (2) huruf a & d; `docs/10-privacy.md` §6 #3) |
| Data | skor 0–100 & komponennya, riwayat, override (alasan), penilaian risiko (sinyal hash: identitas/rekening/perangkat bersama), review risiko, rating & komentar |
| Tempat | `trust_scores`, `trust_score_history`, `trust_score_overrides`, `risk_assessments`, `risk_reviews`, `ratings`, `user_rating_summaries` |
| Penerima | P-01; RISK; pihak lawan melihat skor & rating |
| Retensi | **tanpa kebijakan** (docs/10-privacy menyebut 12 bulan untuk risk — belum ada entri `data_retention_policies`) |
| Catatan | HOLD/REVIEW selalu ditinjau manusia; jalur keberatan untuk BLOCK belum ada (docs/10-privacy §3) |

### PA-15 Notifikasi multi-kanal
| Elemen | Isi |
|---|---|
| Tujuan | pemberitahuan status transaksi, keamanan, OTP; pemasaran hanya dengan persetujuan |
| Dasar | perjanjian (b); pemasaran = persetujuan (a) |
| Data | isi notifikasi, status pengiriman per kanal, preferensi, HMAC e-mail yang di-suppress |
| Tempat | `notifications`, `notification_deliveries`, `notification_preferences`, `email_suppressions` |
| Penerima | P-06, P-07, P-08 |
| Transfer | AS (ASUMSI) |
| Retensi | `notifications` 180 hari (dijalankan); `email_suppressions` (HMAC) **tanpa batas** — mencegah penyalahgunaan pendaftaran ulang (disebut di kebijakan privasi §6) |

### PA-16 Referral, kredit & promosi
| Elemen | Isi |
|---|---|
| Tujuan | program referral, JastipKita Credit (closed-loop), promo |
| Dasar | perjanjian (b); deteksi penyalahgunaan = kepentingan sah (f) |
| Data | kode referral, relasi perujuk–dirujuk, saldo kredit, penebusan promo |
| Tempat | `referrals`, `credit_entries`, `promotions`, `promotion_redemptions` |
| Retensi | `credit_entries` = `financial_records`; kredit sisa hangus saat anonimisasi |

### PA-17 Analitik produk
| Elemen | Isi |
|---|---|
| Tujuan | memahami funnel & kualitas produk |
| Dasar | kepentingan sah (f) untuk event non-PII; persetujuan (a) bila untuk pemasaran (docs/10-privacy §2) |
| Data | nama event (allowlist), properti tanpa PII (disaring `modules/analytics/sanitize.ts`), `user_id`/`anonymous_id`, platform, versi |
| Tempat | `analytics_events`, `experiment_assignments` |
| Retensi | 395 hari (dijalankan); dihapus saat anonimisasi |

### PA-18 Keamanan, audit & log operasional
| Elemen | Isi |
|---|---|
| Tujuan | investigasi keamanan, jejak audit tindakan staf & sistem, observability |
| Dasar | kepentingan sah (f); kewajiban hukum PSE (c) — PP 71/2019 Pasal 24 ayat (1)–(2) (diverifikasi, §9) |
| Data | `security_events` (tipe, `ip_hash`, user-agent, meta), `audit_logs` (aktor, before/after **tanpa PII mentah**), log JSON Workers (PII diredaksi) |
| Tempat | `security_events`, `audit_logs` (append-only, hash-chain), Workers Logs |
| Retensi | `security_events` 365 hari & `audit_logs` 3.650 hari — **tidak dieksekusi job** (SKIPPED); retensi log Workers mengikuti paket Cloudflare (NEEDS_VERIFICATION) |

### PA-19 Pemenuhan hak subjek data
| Elemen | Isi |
|---|---|
| Tujuan | akses/salinan, penghapusan, penarikan persetujuan, koreksi |
| Dasar | kewajiban hukum (c) — UU 27/2022 Pasal 5–13 |
| Data | jenis & status permintaan, tenggat, file ekspor JSON terenkripsi (identitas KYC termask, tanpa gambar KYC) |
| Tempat | `privacy_requests`, `files` EXPORT (`modules/privacy/*`) |
| Retensi | file ekspor 7 hari (dijalankan); `privacy_requests` **tanpa kebijakan** |
| Catatan | hapus akun: masa tenggang 14 hari → `anonymize_user()`; diblokir selama ada transaksi/sengketa/payout/refund berjalan |

### PA-20 Administrasi staf (akun admin)
| Elemen | Isi |
|---|---|
| Tujuan | RBAC, MFA, maker-checker, akuntabilitas staf |
| Dasar | perjanjian kerja/kepentingan sah (f) |
| Subjek | staf & kontraktor dengan peran admin |
| Data | peran, pemberi/pencabut, faktor TOTP (terenkripsi), kode pemulihan (hash), permintaan peran & reset MFA, jejak audit |
| Tempat | `user_roles`, `admin_role_requests`, `mfa_factors`, `mfa_recovery_codes`, `admin_mfa_reset_requests` |
| Retensi | selama peran aktif; jejak audit mengikuti `audit_logs` |

### PA-21 Backup & pemulihan bencana
| Elemen | Isi |
|---|---|
| Tujuan | kelangsungan layanan |
| Dasar | kepentingan sah (f) |
| Data | salinan seluruh DB (terenkripsi `age`) |
| Tempat | GitHub artifact (P-12), R2 opsional (P-03) |
| Retensi | 14 hari (artifact) / 35 hari (R2 lifecycle) — `docs/08-backup-dr.md` |
| Catatan | setelah restore, anonimisasi ulang untuk penghapusan yang selesai setelah waktu backup (`docs/10-privacy.md` §3) |

## 4. Retensi: kebijakan vs eksekusi di kode

Sumber kebijakan: `db/scripts/gen-reference-seed.mjs` → `data_retention_policies` (semua `is_assumption = true`).
Eksekusi: job harian `identity.privacy.retention_purge` (`apps/api/src/modules/privacy/retention.ts`) dan job per jam
`identity.auth.purge_otp_idempotency`.

| Entitas | Kebijakan (ASUMSI) | Pemicu → aksi | Status eksekusi di kode |
|---|---|---|---|
| `identity_records` | 1.825 hari | akun ditutup → hapus | **dijalankan** (`purge_after` diisi oleh `anonymize_user()`) |
| `kyc_documents` | 1.825 hari | akun ditutup → hapus objek + `PURGED` | **dijalankan**, tetapi hanya setelah anonimisasi; pengajuan ditolak tidak dibersihkan |
| `financial_records` | 3.650 hari | dibuat → hapus | **tidak dijalankan** — `SKIPPED_APPEND_ONLY_OR_LEGAL_RETENTION` |
| `payment_webhook_events` | 1.825 hari | dibuat → hapus | **tidak dijalankan** (SKIPPED) |
| `audit_logs` | 3.650 hari | dibuat → hapus | **tidak dijalankan** (SKIPPED; purge baru aman setelah checkpoint WORM — `0140_audit_checkpoints.sql` masuk 2026-10-04, bucket Object Lock production belum ada) |
| `security_events` | 365 hari | dibuat → hapus | **tidak dijalankan** (SKIPPED) → data tersimpan tanpa batas |
| `messages` | 730 hari | transaksi selesai → anonimisasi | dijalankan (kecuali bukti dispute) |
| `files.chat` | 730 hari | transaksi selesai → hapus objek | dijalankan (kecuali bukti dispute) |
| `deliveries.address` | 90 hari | transaksi selesai → anonimisasi | dijalankan |
| `trip_verifications.file` | 180 hari | trip selesai → hapus objek | dijalankan |
| `analytics_events` | 395 hari | dibuat → hapus | dijalankan |
| `notifications` | 180 hari | dibuat → hapus | dijalankan |
| `otp_challenges` | 30 hari | dibuat → hapus | dijalankan; job per jam juga menghapus yang kedaluwarsa > 24 jam → **efektif ±1 hari** (lebih ketat dari kebijakan) |
| `refresh_tokens` | 30 hari | kedaluwarsa → hapus | dijalankan |
| `idempotency_keys`, `outbox_events`, `jobs` | 1 / 14 / 30 hari | teknis | dijalankan |
| File dengan `retention_until` (EXPORT 7 hari, file pengguna teranonimkan) & unggahan terbengkalai (> 1 hari setelah URL kedaluwarsa) | — | hapus objek | dijalankan |
| **Tanpa kebijakan:** `devices`, `consents`, `kyc_submissions`, `payout_accounts`, `refund_destinations`, `support_tickets`/`ticket_messages`, `disputes`/`dispute_evidence`, file RECEIPT/PRODUCT_PHOTO/DELIVERY_PROOF/EVIDENCE, `risk_assessments`/`risk_reviews`/`trust_score_history`, `ratings`, `privacy_requests`, `email_suppressions` | — | — | tidak ada pembersihan otomatis (G-02) |

## 5. Transfer lintas negara

- UU 27/2022 Pasal 56 ayat (2): pengendali wajib memastikan negara penerima memiliki tingkat pelindungan setara atau
  lebih tinggi (teks diverifikasi). Ayat berikutnya (pelindungan memadai & mengikat, lalu persetujuan subjek) diambil
  dari ringkasan riset 05 §1 — teks ayat (3)–(5) belum dikutip dari sumber primer (`NEEDS_VERIFICATION`).
- PP 33/2026 Pasal 160–166 (menurut sumber sekunder Veritask) mengatur pemetaan siklus transfer, penilaian tingkat
  pelindungan, persetujuan bila tidak memadai, dan pengungkapan — `NEEDS_VERIFICATION` terhadap teks resmi.
- Transfer yang sudah pasti dari desain: seluruh DB ke **Singapura** (Neon), objek ke R2 **APAC**, e-mail/SMS/push ke
  penyedia **AS** (ASUMSI). Vendor KYC belum dipilih — **prioritaskan pemrosesan di Indonesia** untuk biometrik.
- Tindakan: penilaian transfer per prosesor (Lampiran 1 DPA), klausul transfer di DPA (`dpa-template.md` Pasal 6),
  pengungkapan di kebijakan privasi §5, evaluasi region Jakarta (`docs/10-privacy.md` §7).

## 6. Langkah keamanan lintas aktivitas (ringkas)

AES-256-GCM dengan AAD per baris/kolom + `kid` (`apps/api/src/lib/crypto.ts`); envelope per file (`modules/files/envelope.ts`);
HMAC-SHA256 ber-pepper untuk lookup/dedupe; mask `****1234` di semua respons; role DB least-privilege (`jk_app`,
`jk_readonly` tanpa kolom PII); RBAC admin + sesi MFA ≤ 12 jam + step-up ≤ 15 menit; maker-checker di DB; audit
hash-chain; redaksi log; TLS; pemindaian malware fail-closed. Rincian & bukti: `docs/09-security.md` §2,
`docs/security/review-2026-09.md`, DPIA §8.

## 7. Gap & tindakan

| # | Gap | Dampak | Tindakan (usulan, bukan keputusan) | PIC |
|---|---|---|---|---|
| G-01 | DPO, pengendali (PT) dan dasar hukum APU-PPT belum ditetapkan | RoPA tidak dapat disahkan | tunjuk DPO; Legal konfirmasi dasar KYC | Owner + Legal |
| G-02 | Banyak entitas tanpa kebijakan retensi; 4 kebijakan tidak dieksekusi (SKIPPED) | penyimpanan melebihi tujuan (prinsip pembatasan) | Legal tetapkan durasi; Tim API tambahkan entri & mekanisme (untuk append-only: partisi/arsip terenkripsi) | DPO + Tim API |
| G-03 | Dokumen KYC pengajuan **ditolak/kedaluwarsa** disimpan sampai akun ditutup + 5 tahun | minimisasi biometrik | kebijakan purge pengajuan ditolak (mis. 30–90 hari, ASUMSI) | DPO + Tim API |
| G-04 | Objek staging KYC plaintext di R2 sampai `complete`; unggahan terbengkalai bertahan ±1–2 hari | eksposur biometrik tak terenkripsi | lifecycle rule R2 pada prefix staging (≤ 24 jam) + verifikasi | DevOps |
| G-05 | Baris `devices` (token push) tidak dihapus saat anonimisasi | data perangkat tanpa dasar | hapus/kosongkan token saat tautan terakhir dicabut | Tim API |
| G-06 | DPA belum ada untuk semua prosesor (P-01…P-13) | Pasal 51 & transfer tanpa safeguard | gunakan `dpa-template.md` / DPA standar vendor + gap check | Legal |
| G-07 | Vendor KYC, host pemindai malware, mitra asuransi belum dipilih | RoPA tidak lengkap | isi saat pemilihan; perbarui RoPA & DPIA | Owner + DPO |
| G-08 | Peta resmi 13 elemen PP 33/2026 Pasal 74 belum diverifikasi | format bisa tidak sesuai | ambil teks dari JDIH, petakan ulang kolom | Legal |
| G-09 | Retensi log Cloudflare Workers belum diketahui | kebijakan privasi tidak akurat | cek paket & set retensi | DevOps |

## 8. Pengesahan

| Peran | Nama | Tanda tangan | Tanggal |
|---|---|---|---|
| DPO | [ ] | [ ] | [ ] |
| Legal | [ ] | [ ] | [ ] |
| Owner / Direksi Pengendali | [ ] | [ ] | [ ] |

## 9. Dasar hukum & sumber

| Rujukan | Isi yang dipakai | Sumber · tanggal akses |
|---|---|---|
| UU 27/2022 Pasal 4 ayat (2) | kategori data spesifik (biometrik, keuangan pribadi, anak) | https://pasal.id/peraturan/uu/uu-no-27-tahun-2022 · 2026-10-04 |
| UU 27/2022 Pasal 20 | 6 dasar pemrosesan | https://pasal.id/peraturan/uu/uu-no-27-tahun-2022/pasal-20 · 2026-10-04 |
| UU 27/2022 Pasal 34 | kewajiban penilaian dampak; 7 kriteria risiko tinggi | https://pasal.id/peraturan/uu/uu-no-27-tahun-2022/pasal-34 · 2026-10-04 |
| UU 27/2022 Pasal 51 ayat (1)–(3) | prosesor bertindak atas perintah pengendali; tanggung jawab pengendali | https://pasal.id/peraturan/uu/uu-no-27-tahun-2022/pasal-51 · 2026-10-04 |
| UU 27/2022 Pasal 53 ayat (1) | kewajiban menunjuk pejabat PDP | https://pasal.id/peraturan/uu/uu-no-27-tahun-2022/pasal-53 · 2026-10-04 |
| UU 27/2022 Pasal 56 ayat (1)–(2) | transfer lintas negara | https://pasal.id/peraturan/uu/uu-no-27-tahun-2022/pasal-56 · 2026-10-04 |
| PP 33/2026 (tanggal) | ditetapkan 16-07-2026, berlaku 16-01-2027 (riset 05 menyebut "15 atau 16" → kini dua sumber menyebut 16) | https://meridianhukum.com/peraturan/pp-no-33-tahun-2026 · 2026-10-04; judul Hukumonline Pro "Berlaku Mulai 16 Januari 2027" — tetap verifikasi ke JDIH |
| PP 33/2026 Pasal 74, 120–122, 160–166 | RoPA 13 elemen, DPIA, transfer | riset 05 (2026-09-27); Veritask (sekunder) · 2026-10-04 — `NEEDS_VERIFICATION` |
| PP 71/2019 Pasal 24 ayat (1)–(3) | kewajiban pengamanan sistem elektronik & pelaporan gangguan serius | https://pasal.id/peraturan/pp/pp-no-71-tahun-2019/pasal-24 · 2026-10-04 |
| Permendag 19/2026 Pasal 10, 12, 13 | layanan pengaduan | https://pasal.id/peraturan/permen/permendag-no-19-tahun-2026 · 2026-10-04 |
| UU 8/1999 Pasal 7 | kewajiban pelaku usaha (kompensasi/penggantian) | https://pasal.id/peraturan/uu/uu-no-8-tahun-1999/pasal-7 · 2026-10-04 |

---

**Catatan keterbatasan data:** register disusun dari pembacaan kode, migrasi, dan konfigurasi per 2026-10-04, bukan
dari data produksi (belum ada); seluruh durasi retensi berstatus ASUMSI (`is_assumption = true`); lokasi pemrosesan
prosesor, peran Google/Apple/Xendit/kurir sebagai pengendali atau prosesor, dan daftar resmi 13 elemen PP 33/2026
belum diverifikasi; vendor KYC, host pemindai malware, dan mitra asuransi belum ada sehingga entri terkait tidak
lengkap; kutipan pasal berasal dari pasal.id (agregator, bukan JDIH resmi) dan harus dicocokkan dengan teks resmi.
