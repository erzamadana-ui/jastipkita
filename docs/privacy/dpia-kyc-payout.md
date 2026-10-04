# DPIA — Verifikasi Identitas (KYC) & Rekening Payout/Refund

> **TEMPLATE UNTUK REVIEW PROFESIONAL — bukan nasihat hukum.** Penilaian dampak pelindungan data pribadi (UU 27/2022
> Pasal 34) untuk DPIA #1 dan #2 di `docs/10-privacy.md` §6. Disusun dari kode per 2026-10-04; semua integrasi masih
> **MOCK/SANDBOX** dan KYC berjalan sebagai **review manual admin** (`KYC_PROVIDER=manual`). Penilaian risiko di bawah
> adalah usulan penyusun dan **harus** ditinjau, diubah bila perlu, dan disetujui DPO sebelum KYC nyata dibuka.

| Atribut | Isi |
|---|---|
| Versi / tanggal | 0.1 (draf) · 2026-10-04 |
| Pengendali | **[NAMA PT — belum berdiri]** |
| Penyusun | Tim compliance & operasi (draf teknis) |
| Peninjau wajib | DPO **[belum ditunjuk]**, Legal, Finance, Eng lead |
| Status | **DRAF — belum disetujui**; KYC nyata **tidak boleh** dibuka sebelum §11 ditandatangani (`docs/10-privacy.md` §9) |
| Terkait | [`ropa.md`](ropa.md) PA-03, PA-04, PA-08 · `docs/09-security.md` · `docs/security/review-2026-09.md` |

## 1. Ringkasan untuk pengambil keputusan

1. **Mengapa DPIA wajib:** pemrosesan data spesifik (biometrik selfie/liveness; data keuangan pribadi) — UU 27/2022
   Pasal 34 ayat (2) huruf b; juga huruf e (pencocokan identitas untuk mencegah duplikasi) dan huruf f (teknologi
   liveness). Teks pasal diverifikasi 2026-10-04 (§12).
2. **Kontrol teknis yang sudah ada kuat** untuk kebocoran basis data (enkripsi kolom AES-256-GCM + HMAC ber-pepper),
   akses staf (MFA wajib server-side, audit setiap tampilan), dan pengalihan dana pasca-pengambilalihan akun (step-up OTP,
   pencocokan nama, review maker-checker).
3. **Yang akan rusak duluan bila KYC dibuka hari ini** (urut tingkat risiko residual):
   - **R-06 Pemalsuan identitas** — review manual tidak dapat memastikan keaslian KTP/paspor atau mendeteksi deepfake;
     tidak ada pencocokan ke data kependudukan. Residual **Tinggi** sampai vendor e-KYC aktif.
   - **R-04 Pengalihan dana pasca-ATO** — validasi nama rekening (Iluma) belum tersambung: di mode Xendit adapter selalu
     mengembalikan `NAME_VALIDATION_UNAVAILABLE`, sehingga rekening tidak bisa terverifikasi otomatis dan beban berpindah ke
     override admin **tanpa maker-checker**. Jeda rekening payout baru (`money.policy.newPayoutAccountCooldownHours`,
     default 24 jam, migrasi `0120`) baru masuk ke working tree 2026-10-04 dan **hanya berlaku untuk rekening payout
     traveler**, tidak untuk rekening tujuan refund pembeli.
   - **R-07 Retensi berlebih** — dokumen KYC pengajuan yang ditolak tidak pernah dibersihkan selama akun aktif.
   - **R-14 Usia minimum** — kode menerima KYC usia ≥ 17 tahun (`MIN_AGE_YEARS = 17`, `modules/kyc/service.ts`) sedangkan
     kebijakan privasi menyatakan layanan untuk ≥ 18 tahun → potensi pemrosesan **data anak** (data spesifik).
4. **Rekomendasi (usulan, bukan keputusan):** setujui dengan syarat — tindakan A-01…A-08 (§9) selesai sebelum KYC nyata
   dan payout LIVE.

## 2. Ruang lingkup

| Dalam lingkup | Di luar lingkup (DPIA terpisah) |
|---|---|
| **A. KYC L3:** nomor & foto KTP/paspor, nama, tanggal lahir, kewarganegaraan, selfie, 1–5 rekaman liveness, skor & keputusan | Trust score/fraud/risk scoring (DPIA #3) |
| **B. Rekening payout traveler:** kode bank, nomor rekening, nama pemilik, status verifikasi, override admin | Ekstraksi produk & moderasi chat (DPIA #4) |
| **C. Rekening tujuan refund pembeli** (kanal VA/ritel yang tidak mendukung refund) | Transfer lintas negara umum (DPIA #5 — disinggung di R-08) |

Volume: pra-peluncuran, 0 subjek nyata. Proyeksi volume = ASUMSI, diisi dari rencana soft launch (`docs/marketing/launch-plan.md`).

## 3. Deskripsi pemrosesan & alur data (dari kode)

### 3.A KYC
| # | Langkah | Implementasi | Data pribadi yang tersentuh |
|---|---|---|---|
| 1 | Persetujuan KYC terpisah | `consents.type = KYC`; `submitKyc` menolak tanpa itu (`CONSENT_REQUIRED`) | versi persetujuan, `ip_hash` |
| 2 | Unggah dokumen | URL presigned 15 menit (tipe & ukuran ditandatangani) ke **objek staging plaintext** di R2 (`modules/files/service.ts`) | gambar KTP/paspor, selfie, liveness |
| 3 | `complete` | cek ukuran → magic bytes → SHA-256 → **pemindaian malware** (byte plaintext dikirim ke clamd; fail-closed) → **envelope AES-256-GCM** (DEK per file dibungkus KEK, AAD `files.object:<id>`, `modules/files/envelope.ts`) → objek staging dihapus | idem |
| 4 | Pengajuan | normalisasi nomor; validasi usia ≥ 17 (ASUMSI); HMAC `kyc_id` untuk dedupe (satu identitas = satu akun); nomor, nama, tgl lahir dienkripsi AES-GCM dengan AAD per kolom `identity_records.<kolom>:<id>` | nomor identitas, nama, tgl lahir |
| 5 | Verifikasi | provider `manual` → status IN_REVIEW untuk antrean admin; provider otomatis (belum ada) → setuju bila skor liveness & face-match ≥ 0,8 | skor, alasan |
| 6 | Review admin | `GET /v1/admin/kyc/submissions/{id}`: identitas ter-mask (`••••••••1234`, `Siti R.`), flag duplikat; konten file di-stream & didekripsi hanya untuk `kyc.review`; audit `kyc.submission_viewed` & `kyc.document_viewed`; approve/reject butuh step-up MFA ≤ 15 menit; reviewer ≠ pemohon | semua di atas |
| 7 | Hasil | level 3 dihitung ulang; event `kyc.approved/rejected` | status |
| 8 | Akses subjek | pemilik **tidak** dapat mengunduh konten KYC (membatasi dampak sesi dicuri); ekspor data berisi identitas dengan nomor ter-mask, tanpa gambar (`modules/privacy/export.ts`) | — |
| 9 | Retensi | saat akun dianonimkan: `purge_after` = sekarang + 1.825 hari (ASUMSI) → job harian menghapus objek & baris (`modules/privacy/retention.ts`) | — |

### 3.B Rekening payout traveler
| # | Langkah | Implementasi |
|---|---|---|
| 1 | Tambah rekening | wajib KYC ≥ L3; HMAC `bank_account` untuk dedupe; **step-up OTP `SENSITIVE_ACTION`** (`PAYOUT_ACCOUNT_ADD`, 10 menit, sekali pakai, terikat aksi + target) **sebelum** inquiry bank (endpoint bukan oracle nama) |
| 2 | Sinyal risiko | rekening yang sama di akun lain → `assessRisk('PAYOUT')`; BLOCK → ditolak (`PAYOUT_ACCOUNT_BLOCKED`) |
| 3 | Inquiry nama | `validateBankAccount` — **di mode Xendit selalu `valid:false, NAME_VALIDATION_UNAVAILABLE`** (Iluma belum tersambung, `providers/payment/xendit.ts`) |
| 4 | Pencocokan nama | nama bank vs nama identitas KYC (toleran singkatan); beda → `NAME_MISMATCH` (review manual); tanpa identitas terverifikasi → `PENDING` (SEC-17) |
| 5 | Simpan | nomor AES-GCM (AAD `payout_accounts.account_number:<id>`), mask `****1234`; respons hanya mask |
| 6 | Override admin | `POST /v1/admin/kyc/payout-accounts/{id}/verification-override` — `kyc.review` + MFA ≤ 15 menit; **satu admin** (hanya larangan memverifikasi rekening sendiri; tidak ada maker-checker) |
| 7 | Ganti rekening utama | step-up OTP `PAYOUT_ACCOUNT_SET_DEFAULT`; hanya rekening VERIFIED |
| 8 | Disbursement | nomor didekripsi server-side → Xendit payout; guard `PAYOUT_CLEAR` (risiko, tidak ada dispute terbuka, rekening VERIFIED) |
| 9 | Jeda rekening baru | `money.policy.newPayoutAccountCooldownHours` (default 24, rentang 0–720): payout baru dikirim setelah `greatest(created_at, verified_at, default_since) + jeda` — dihitung saat penjadwalan **dan** saat diproses; ganti rekening utama memindahkan payout tertunda ke rekening baru dan ikut menunggu (`modules/payouts/service.ts` `payoutAccountReadyAt`, `repointPendingPayouts`; migrasi `0120_payout_account_cooldown.sql`; tes `payouts/cooldown.test.ts`). Ditambahkan 2026-10-04 oleh engineer lain — belum dijalankan ulang oleh penyusun |

### 3.C Rekening tujuan refund
`setRefundDestination` (`modules/refunds/service.ts`): hanya untuk refund metode `PAYOUT_TO_BUYER`; step-up OTP
`REFUND_DESTINATION_SET` terikat id refund → validasi rekening → nama bank vs identitas KYC (bila ≥ L3): beda →
`PENDING_REVIEW` (tidak pernah dibayar sebelum FINANCE menyetujui di `/v1/admin/refund-destinations`, reviewer ≠
pembeli, MFA + maker-checker) → notifikasi kritis `refund.destination_updated` + security event. Nomor & nama pemilik
terenkripsi AES-GCM; saat anonimisasi ciphertext dihapus, hash + mask dipertahankan (SEC-09).

## 4. Kebutuhan & proporsionalitas

| Pertanyaan | Jawaban & dasar | Penilaian |
|---|---|---|
| Tujuan sah & spesifik? | mencegah penipuan dua sisi (traveler kabur dengan dana, akun ganda), menetapkan limit (`limits.transaction.byKycLevel`), memastikan payout ke pemilik sah | Ya |
| Dasar pemrosesan | KYC: persetujuan eksplisit terpisah (Pasal 20(2)a) + kewajiban hukum APU-PPT **bila berlaku** (NEEDS_VERIFICATION — JastipKita bukan PJP; Legal); rekening: perjanjian (b) | perlu konfirmasi Legal |
| Perlu biometrik? | selfie/liveness mengikat dokumen ke orang yang mengajukan; alternatif tanpa biometrik (hanya nomor KTP) tidak mencegah pemakaian KTP orang lain | Proporsional **bila** dibatasi pada traveler/limit tinggi — saat ini KYC hanya diminta untuk L3+ |
| Minimisasi field | hanya nomor, nama, tgl lahir, kewarganegaraan; tidak ada alamat KTP, agama, status kawin yang disimpan sebagai field | Baik (catatan: **gambar KTP tetap memuat seluruh field KTP**) |
| Minimisasi penyimpanan | gambar disimpan selama akun + 5 tahun (ASUMSI); pengajuan ditolak tidak dibersihkan | **Kurang** — lihat A-04; opsi: hapus gambar setelah keputusan dan simpan hanya hasil + hash (butuh keputusan Legal tentang kebutuhan bukti) |
| Pembatasan akses | `kyc.review` dimiliki 4 peran (OPERATIONS, RISK, COMPLIANCE, SUPER_ADMIN) | Cukup luas — pertimbangkan peran reviewer KYC khusus |
| Transparansi | kebijakan privasi & persetujuan KYC (`docs/legal/kyc-consent.md`) masih TEMPLATE | perlu review hukum |
| Hak subjek | akses (ekspor, nomor ter-mask), koreksi via pengajuan ulang/tiket, hapus (14 hari tenggang → anonimisasi, KYC ditahan retensi) | Sebagian — jalur koreksi KYC perlu SOP (`docs/sop/customer-service.md` §5) |
| Alternatif dipertimbangkan | (a) vendor e-KYC dengan pencocokan Dukcapil di Indonesia; (b) review manual (sekarang); (c) tanpa KYC untuk traveler bernilai kecil | (a) disarankan sebelum skala; (c) sudah sebagian lewat limit per level |

## 5. Konsultasi

| Pihak | Status |
|---|---|
| DPO | belum ditunjuk |
| Legal (APU-PPT, persetujuan, retensi) | belum — permintaan penawaran dijadwalkan (`docs/STATUS.md` §5) |
| Finance (rekening, Iluma) | belum |
| Perwakilan pengguna (uji persepsi alur KYC) | belum — ASUMSI: lakukan saat beta tertutup |
| Vendor e-KYC | belum dipilih |

## 6. Metodologi penilaian risiko (ASUMSI — metode internal)

Kemungkinan (K) dan Dampak (D) skala 1–5; Skor = K × D.
K: 1 sangat jarang · 2 jarang · 3 mungkin · 4 sering · 5 hampir pasti (dalam 12 bulan setelah launch).
D (terhadap subjek): 1 tidak berarti · 2 terbatas · 3 signifikan (kerugian finansial kecil, tekanan) · 4 serius (kerugian
finansial besar, penyalahgunaan identitas) · 5 sangat serius/tidak dapat dipulihkan (biometrik bocor, pencurian identitas massal).
Kategori: 1–4 **Rendah** · 5–9 **Sedang** · 10–16 **Tinggi** · 20–25 **Kritis**.

## 7. Register risiko

| ID | Risiko terhadap subjek | K×D inheren | Kontrol yang sudah ada (bukti) | K×D residual | Tindakan tambahan |
|---|---|---|---|---|---|
| R-01 | Kebocoran basis data (dump, backup, kredensial Neon) membuka identitas & rekening | 3×5 = **15** | kolom `*_enc` AES-256-GCM + AAD + `kid` (`lib/crypto.ts`); HMAC ber-pepper, bukan SHA polos; `jk_readonly` tanpa kolom PII (`jk_sensitive_columns`); backup dienkripsi `age`, kunci privat di luar GitHub; TLS `sslmode=require` | 2×4 = **8** Sedang | escrow kunci offline (T8 launch checklist); pantau akses Neon; uji restore tidak membocorkan kunci |
| R-02 | Akses tidak sah ke objek KYC di R2 | 2×5 = **10** | envelope per file, objek KYC tidak dapat diunduh langsung (di-stream API); kredensial R2 hanya di secret store | 2×4 = **8** Sedang | **objek staging plaintext** hidup sampai `complete` dan, bila scan gagal/unggahan ditinggalkan, sampai dibersihkan job (> 1 hari setelah URL kedaluwarsa) → lifecycle rule R2 prefix staging ≤ 24 jam (A-05); domain storage terpisah (SEC-18) |
| R-03 | Staf melihat/menyalin KYC tanpa keperluan (insider) | 3×4 = **12** | izin `kyc.review`; sesi admin wajib MFA ≤ 12 jam (SEC-01), step-up ≤ 15 menit untuk keputusan; setiap tampilan diaudit di `audit_logs` hash-chain; identitas ter-mask; tidak boleh review diri sendiri | 2×4 = **8** Sedang | peran reviewer khusus; review bulanan log `kyc.document_viewed` vs antrean; alert volume tampilan; checkpoint audit ke penyimpanan WORM (SEC-R4 — migrasi `0140_audit_checkpoints.sql` masuk 2026-10-04, bucket Object Lock production belum ada) |
| R-04 | Pengambilalihan akun → rekening payout/refund diganti → dana dialihkan | 4×4 = **16** | step-up OTP `SENSITIVE_ACTION` ke kontak terverifikasi (SEC-12); pencocokan nama vs KYC → `NAME_MISMATCH`/`PENDING_REVIEW`; review FINANCE maker-checker untuk tujuan refund; notifikasi kritis; hanya rekening VERIFIED dibayar; refresh token reuse detection | 3×4 = **12** Tinggi | **Iluma/penny-drop** (T10) — tanpa itu verifikasi bergantung override manual; **maker-checker untuk override rekening** (A-02); jeda 24 jam rekening payout baru sudah ada di kode (verifikasi A-03) tetapi **tidak** mencakup rekening tujuan refund; SIM-swap tetap melewati OTP SMS |
| R-05 | Akun admin dibajak → akses PII massal | 2×5 = **10** | MFA TOTP ditegakkan API (SEC-01); enrol TOTP hanya dari login OTP segar ≤ 15 menit, reset maker-checker (SEC-13); pencabutan peran mencabut sesi (SEC-16); RBAC least privilege diuji 141 operasi | 2×4 = **8** Sedang | Cloudflare Access di depan admin; alert `MFA_FAILED`, `ADMIN_PII_REVEALED`; pentest (T3) |
| R-06 | Identitas palsu/dicuri, deepfake liveness → traveler penipu terverifikasi | 4×4 = **16** | review manual; dedupe HMAC nomor identitas (`KYC_DUPLICATE_IDENTITY` HIGH + risk assessment); limit traveler baru `newTravelerMaxIdr` Rp5 juta; dana ditahan sampai serah terima (SafePay) | 4×3 = **12** Tinggi | vendor e-KYC dengan pencocokan sumber resmi (A-01); pelatihan reviewer; checklist review dokumen |
| R-07 | Penyimpanan melebihi tujuan (gambar KYC ditolak, `security_events` SKIPPED, 5 tahun ASUMSI) | 4×3 = **12** | purge setelah anonimisasi; `anonymize_user()` menghapus ciphertext rekening (SEC-09) | 4×3 = **12** Tinggi | kebijakan purge pengajuan ditolak/kedaluwarsa (A-04); Legal validasi 5 tahun; mekanisme untuk entitas SKIPPED |
| R-08 | Transfer lintas negara tanpa safeguard (Neon Singapura, R2 APAC, vendor KYC TBD) | 5×3 = **15** | data spesifik terenkripsi di level aplikasi sebelum keluar Worker (penyedia storage hanya melihat ciphertext untuk KYC final) | 5×2 = **10** Tinggi | DPA + klausul transfer (`dpa-template.md` Pasal 6); vendor KYC dengan pemrosesan di Indonesia; pengungkapan di kebijakan privasi |
| R-09 | `HMAC_PEPPER` bocor → NIK (16 digit, berstruktur, entropi rendah) dapat di-brute-force dari `id_number_hash` | 2×4 = **8** | pepper hanya di secret store; tidak boleh dirotasi sembarangan (`docs/09-security.md` §2.9) | 2×4 = **8** Sedang | prosedur insiden khusus pepper; pertimbangkan HSM/KMS saat skala |
| R-10 | Kehilangan kunci `DATA_ENCRYPTION_KEYS` → identitas/rekening tak terbaca (ketersediaan) | 2×3 = **6** | rotasi dengan menambah kunci di depan; `kid` per blob | 1×3 = **3** Rendah | salinan escrow offline Owner + DPO (T8) |
| R-11 | PII bocor lewat log, error, notifikasi, analitik | 3×3 = **9** | redaksi kunci sensitif di logger; error 5xx generik (SEC-20); analitik membuang kunci & nilai mirip PII; respons hanya mask (diuji `data-exposure.test.ts`) | 2×2 = **4** Rendah | tinjau berkala template e-mail/push |
| R-12 | Pemindai malware (sidecar) menerima KYC plaintext | 3×4 = **12** | kontrak HTTP minimal (body + storage key); fail-closed | 2×4 = **8** Sedang | host di lingkungan yang dikendalikan, TLS, tanpa penyimpanan/log body; bila pihak ketiga → DPA (A-06) |
| R-13 | Keputusan otomatis menolak KYC tanpa jalur keberatan (saat vendor aktif) | 3×3 = **9** | saat ini manual; FSM mewajibkan alasan penolakan | 2×3 = **6** Sedang | jalur peninjauan manusia via tiket untuk penolakan otomatis (SOP CS); sebut di kebijakan privasi §3.1 |
| R-14 | Pengguna < 18 tahun lolos KYC (kode ≥ 17) → pemrosesan data anak tanpa dasar yang tepat | 3×4 = **12** | validasi tanggal lahir di server | 3×4 = **12** Tinggi | Legal tetapkan usia minimum; samakan `MIN_AGE_YEARS` dengan kebijakan (A-07) |
| R-15 | Data rekening salah orang (salah ketik/nama mirip) → dana ke pihak ketiga | 3×3 = **9** | pencocokan nama toleran; review manual untuk mismatch | 3×3 = **9** Sedang | Iluma (A-01/T10); konfirmasi nama ke pengguna sebelum simpan |

## 8. Katalog kontrol yang sudah diterapkan (bukti)

| Kontrol | Lokasi kode / bukti uji |
|---|---|
| AES-256-GCM, AAD per baris/kolom, `kid` untuk rotasi | `apps/api/src/lib/crypto.ts` (`CryptoService.encrypt/decrypt`) |
| Envelope per file (DEK acak dibungkus KEK, AAD `files.object:<id>`), staging plaintext dihapus | `apps/api/src/modules/files/envelope.ts`, `modules/files/service.ts`; CHECK DB `purpose NOT IN ('KYC','TRIP_DOC') OR encrypted` (`0003_identity_access.sql`) |
| HMAC-SHA256 ber-pepper untuk dedupe identitas & rekening | `CryptoService.hashIdentifier` (`kyc_id`, `bank_account`) |
| Mask `****1234` / `••••••••1234` di semua respons | `modules/kyc/service.ts`, `modules/refunds/service.ts`, admin KYC; `test/security/data-exposure.test.ts` |
| Step-up OTP `SENSITIVE_ACTION` (10 menit, sekali pakai, terikat aksi + target) | `modules/auth/service.ts` (`SENSITIVE_OTP_TTL_SEC: 600` di `auth/common.ts`); `test/security/step-up-mfa-enrollment.test.ts` |
| Maker-checker: review tujuan refund, approval refund > Rp10 juta (ASUMSI), release payout | `docs/api/admin.md` §1–2; CHECK DB `payouts_hold_release_maker_checker` |
| MFA admin wajib server-side (sesi ≤ 12 jam, step-up ≤ 15 menit) | `middleware/auth.ts`; `test/security/admin-session-mfa.test.ts` (SEC-01) |
| Audit setiap tampilan KYC, hash-chain | `modules/files/service.ts` (`kyc.document_viewed`), `audit_logs` + `verify_audit_chain()` |
| Retensi & anonimisasi | `modules/privacy/retention.ts`, `anonymize_user()` (`0014`, diperbarui `0080` untuk SEC-09) |
| Pemindaian malware fail-closed; production menolak boot tanpa clamd | `modules/files/service.ts`, `env.ts` (SEC-08) |
| Role DB least-privilege | `db/tests/100_grants.sql` |
| Temuan review keamanan terkait | SEC-01, SEC-09, SEC-12, SEC-13, SEC-16, SEC-17 **FIXED**; SEC-18 ACCEPTED; SEC-R4 OPEN (`docs/security/review-2026-09.md`) |

## 9. Rencana tindakan (usulan, bukan keputusan GM/Owner)

| # | Tindakan | Menurunkan | Prioritas | PIC | Syarat sebelum |
|---|---|---|---|---|---|
| A-01 | Pilih & integrasikan vendor e-KYC (utamakan pemrosesan di Indonesia) + aktifkan Iluma/penny-drop | R-06, R-04, R-15, R-08 | P0 | Owner + Tim API | KYC nyata / payout LIVE |
| A-02 | Maker-checker untuk `verification-override` rekening payout (atau SOP 4-mata wajib sampai dibangun — `docs/sop/refund-payout-operations.md` §6) | R-04 | P0 | Tim API / Finance | payout LIVE |
| A-03 | Uji jeda 24 jam rekening payout baru (0120) end-to-end termasuk override admin & ganti rekening utama; putuskan apakah jeda serupa diperlukan untuk rekening tujuan refund | R-04 | P0 | QA + Owner | payout LIVE |
| A-04 | Kebijakan purge dokumen KYC pengajuan ditolak/kedaluwarsa + validasi durasi 5 tahun | R-07 | P0 | DPO + Legal + Tim API | KYC nyata |
| A-05 | Lifecycle rule R2 untuk prefix staging (≤ 24 jam) | R-02 | P0 | DevOps | KYC nyata |
| A-06 | Host clamd di lingkungan terkendali tanpa log body; DPA bila pihak ketiga | R-12 | P0 | DevOps | production |
| A-07 | Tetapkan usia minimum dan samakan kode & kebijakan | R-14 | P0 | Legal + Tim API | KYC nyata |
| A-08 | DPA + penilaian transfer untuk Neon, Cloudflare, vendor KYC, Xendit | R-08 | P0 | Legal | KYC nyata |
| A-09 | Peran reviewer KYC khusus; review bulanan log akses | R-03 | P1 | Owner + DPO | publik luas |
| A-10 | Cloudflare Access di depan admin; alert keamanan | R-05 | P1 | DevOps | publik luas |

## 10. Risiko residual & kesimpulan

- Residual **saat ini** (tanpa A-01…A-08): 5 risiko **Tinggi** (R-04, R-06, R-07, R-08, R-14), tidak ada Kritis.
- Residual **target** setelah A-01…A-08 (perkiraan penyusun): seluruhnya ≤ Sedang, kecuali R-04 yang tetap Sedang–Tinggi
  karena SIM-swap/phishing OTP di luar kendali platform.
- Bila risiko residual Tinggi tetap diterima, keputusan harus tertulis oleh Owner dengan alasan. Konsultasi dengan
  lembaga PDP sebelum pemrosesan berisiko tinggi residual tinggi perlu dicek di PP 33/2026 Pasal 120–122
  (`NEEDS_VERIFICATION`; lembaga PDP belum terbentuk per 16-09-2026 — §12).

## 11. Persetujuan DPO

| Keputusan DPO | ☐ Disetujui ☐ Disetujui dengan syarat (sebutkan) ☐ Ditolak |
|---|---|
| Syarat / catatan | [ ] |
| Risiko residual yang diterima | [daftar ID] — diterima oleh Owner: [nama, tanggal] |
| Tanggal tinjauan berikutnya | [≤ 12 bulan atau saat vendor KYC/Iluma aktif, perubahan skema, insiden] |

| Peran | Nama | Tanda tangan | Tanggal |
|---|---|---|---|
| DPO | [ ] | [ ] | [ ] |
| Legal | [ ] | [ ] | [ ] |
| Eng lead (pemilik kontrol teknis) | [ ] | [ ] | [ ] |
| Finance (pemilik proses rekening) | [ ] | [ ] | [ ] |
| Owner (penerima risiko residual) | [ ] | [ ] | [ ] |

## 12. Dasar hukum & sumber

| Rujukan | Isi | Sumber · tanggal akses |
|---|---|---|
| UU 27/2022 Pasal 34 | kewajiban DPIA; 7 kriteria risiko tinggi (huruf a–g) | https://pasal.id/peraturan/uu/uu-no-27-tahun-2022/pasal-34 · 2026-10-04 |
| UU 27/2022 Pasal 4 ayat (2) | data spesifik: biometrik, keuangan pribadi, anak | https://pasal.id/peraturan/uu/uu-no-27-tahun-2022 · 2026-10-04 |
| UU 27/2022 Pasal 20 ayat (2) | dasar pemrosesan | https://pasal.id/peraturan/uu/uu-no-27-tahun-2022/pasal-20 · 2026-10-04 |
| UU 27/2022 Pasal 53 ayat (1) huruf c | kewajiban pejabat PDP | https://pasal.id/peraturan/uu/uu-no-27-tahun-2022/pasal-53 · 2026-10-04 |
| PP 33/2026 Pasal 120–122 | isi & dokumentasi DPIA | riset 05 (2026-09-27); Veritask (sekunder) · 2026-10-04 — `NEEDS_VERIFICATION` |
| Status lembaga PDP | belum terbentuk | CNBC Indonesia 16-09-2026, https://www.cnbcindonesia.com/tech/20260916115609-37-768328/lembaga-perlindungan-data-belum-ada-di-ri-padahal-aturannya-sudah-ada · 2026-10-04 |
| PBI 23/6/PBI/2021 | JastipKita tidak menatausahakan dana; dana di PJP berlisensi | `docs/research/02-xendit-integration.md` §9 (2026-09-27) |

---

**Catatan keterbatasan data:** penilaian berasal dari pembacaan kode dan tes per 2026-10-04 dengan provider MOCK/manual,
tanpa data subjek nyata, tanpa pentest, dan tanpa vendor KYC/Iluma; skor K×D adalah perkiraan penyusun dengan metode
internal (ASUMSI) dan harus dikalibrasi DPO; jeda 24 jam rekening payout baru (0120) dan checkpoint audit (0140)
masuk ke working tree pada hari yang sama oleh engineer lain — kodenya dibaca, tesnya tidak dijalankan penyusun;
durasi retensi ASUMSI; ketentuan PP 33/2026 dikutip dari sumber sekunder; kutipan UU dari pasal.id
(agregator) perlu dicocokkan dengan JDIH resmi.
