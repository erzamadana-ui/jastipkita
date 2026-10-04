# SOP Operasional Keuangan Harian — Refund, Payout & Rekonsiliasi

> **TEMPLATE UNTUK REVIEW PROFESIONAL — bukan nasihat akuntansi/pajak/hukum.** Mengikuti kode per 2026-10-04:
> `apps/api/src/modules/admin/finance/*`, `apps/api/src/modules/admin/reconciliation/service.ts`,
> `apps/api/src/modules/{refunds,payouts,reconciliation}/service.ts`, `docs/04-payments-ledger.md`, `docs/api/admin.md`.
> Semua pembayaran masih **MOCK/SANDBOX**; jadwal harian, SLA internal, dan checklist tutup buku adalah **ASUMSI** yang
> harus disahkan Finance Lead dan ditinjau akuntan/konsultan pajak.

| Atribut | Isi |
|---|---|
| Versi | 0.1 (draf) · 2026-10-04 |
| Pemilik proses | Finance Lead [belum ditunjuk] |
| Pelaksana | `FINANCE` (maker), `FINANCE_SUPER_ADMIN` (checker untuk rekening settlement & config); `SUPER_ADMIN` hanya darurat |
| Prasyarat | ≥ 2 akun finance aktif ber-MFA dengan orang berbeda (launch checklist B3) — tanpa itu maker-checker tidak dapat berjalan |
| Terkait | `docs/runbooks/payment-incident.md` · [`dispute-resolution.md`](dispute-resolution.md) · [`incident-communication.md`](incident-communication.md) |

## 1. Prinsip yang tidak boleh dilanggar

1. **Uang hanya bergerak lewat alur sistem** (refund, payout, dispute, cancel). Tidak ada transfer manual dari dashboard
   Xendit atau rekening bank tanpa pencatatan admin; tidak ada UPDATE manual ke tabel ledger (append-only, trigger menolak).
2. **Maker ≠ checker.** Sistem menolak approver = peminta (`MAKER_CHECKER_VIOLATION`); jangan meminjam akun.
3. **Setiap aksi tulis butuh step-up MFA ≤ 15 menit** dan, untuk aksi uang, `Idempotency-Key` (UI admin mengirimkannya).
   Mengulang permintaan yang sama tidak menggandakan uang.
4. Dana pembeli berada di saldo penyedia pembayaran berlisensi BI, bukan di rekening JastipKita (PBI 23/6/PBI/2021 menurut
   `docs/research/02-xendit-integration.md` §9).
5. Data rekening hanya terlihat ter-mask (`****1234`); jangan meminta pengguna mengirim nomor rekening lewat chat/e-mail.

## 2. Jadwal harian (WIB, ASUMSI)

| Jam | Kegiatan | Layar / endpoint |
|---|---|---|
| 08.30 | Cek alert semalam: `ALERT reconciliation.mismatch`, `payment.amount_mismatch`, refund FAILED berulang | Admin → System alerts; log Workers |
| 09.00 | **Rekonsiliasi** run hari sebelumnya (§5) | `GET /v1/admin/reconciliation/runs` |
| 09.30 | **Antrean approval refund** (§3) | `GET /v1/admin/refunds` (default `PENDING_APPROVAL`) |
| 10.30 | **Review rekening tujuan refund** (§4) | `GET /v1/admin/refund-destinations` (default `PENDING_REVIEW`) |
| 11.00 | **Payout** ON_HOLD / FAILED / tertahan jeda rekening baru (§6) | `GET /v1/admin/payouts?status=ON_HOLD,FAILED` |
| 13.30 | Putaran kedua refund & payout (sebelum cut-off RTGS 14.00 WIB — riset 02 §6; BI-FAST ±15 menit) | idem |
| 16.30 | Ringkasan harian ke Finance Lead (§9) | — |

Job sistem yang mendasari: `money.process_refunds` (2 menit), `money.process_payouts` (5 menit),
`money.reconcile_pending_payments` (10 menit), `money.daily_reconciliation` (24 jam, periode = hari WIB lengkap
sebelumnya) — `apps/api/src/jobs/money.ts`. Di Cloudflare Workers cron efektif tiap 5 menit.

## 3. Antrean approval refund

Refund dibuat per pembayaran; nominal ≤ `money.policy.refundAutoApproveMaxIdr` (default **Rp10.000.000, ASUMSI**) langsung
`APPROVED` oleh sistem, di atasnya `PENDING_APPROVAL` (domain §15.6).

**Checklist sebelum menyetujui** (`POST /v1/admin/refunds/{id}/approve`, `refunds.approve`, MFA, Idempotency-Key, maker-checker):
1. `canApprove = true` (Anda bukan peminta).
2. Alasan (`reason_code`: pembatalan, `DISPUTE_RESOLUTION`, `ADMIN`, …) sesuai keputusan tercatat (dispute `DSP-…`/tiket).
3. Nominal ≤ dana yang dapat direfund (trigger DB `jk_check_refund_total` menolak kelebihan — tetap cek wajar).
4. Status transaksi masuk akal (mis. `REFUND_PENDING`); tidak ada refund lain untuk tujuan yang sama.
5. Tidak ada review risiko terbuka yang mengindikasikan penipuan oleh pembeli.
6. Metode: `PROVIDER_REFUND` (QRIS, e-wallet, kartu) atau `PAYOUT_TO_BUYER` (VA, gerai ritel) — yang kedua menunggu
   rekening pembeli (§4).

**Menolak:** `POST …/reject` `{reason}` — alokasi dibalik; bila tidak ada hal lain terbuka, respons memberi
`transactionFollowUp: REVIEW_REQUIRED` → buat tiket ke OPERATIONS untuk menuntaskan status transaksi.

**SLA internal (ASUMSI):** keputusan ≤ 1 hari kerja; pembeli diberi kabar status refund ≤ 1×24 jam (runbook pembayaran §4).

**Refund FAILED:** sistem mencoba ulang maks. 3× (`refundMaxSystemRetries`); kanal tidak mendukung refund otomatis
beralih ke `PAYOUT_TO_BUYER` tanpa menghabiskan jatah retry. `INSUFFICIENT_BALANCE` = **P1** (runbook pembayaran §4).

## 4. Review rekening tujuan refund (SEC-12)

Rekening yang nama pemiliknya **berbeda** dari nama identitas KYC pembeli masuk `PENDING_REVIEW` dan tidak pernah dibayar
sebelum direview.

**Prosedur** (`POST /v1/admin/refund-destinations/{id}/review` `{decision, note}`, `refunds.approve`, MFA, maker-checker, reviewer ≠ pembeli):
1. Lihat mask, bank, `nameMatch`, nominal, nomor transaksi.
2. Hubungi pembeli **lewat tiket in-app / kanal terverifikasi**, bukan lewat kontak yang dikirim di pesan baru.
3. Kebijakan (ASUMSI, disahkan Legal): refund hanya ke rekening atas nama pembeli. Pengecualian (rekening pasangan/orang
   tua) hanya dengan bukti hubungan + pernyataan tertulis pembeli di tiket; catat di `note`.
4. Tanda bahaya → **REJECT** + teruskan ke RISK: rekening baru diganti berulang, nama tidak berhubungan, perangkat/IP baru
   bersamaan, notifikasi `refund.destination_updated` dilaporkan "bukan saya" oleh pembeli.
5. APPROVE → status `VALID`, refund diproses otomatis. REJECT → pembeli diminta mengisi ulang (`refund.destination_required`).

> **BLOKER sebelum LIVE (launch checklist T10):** validasi nama rekening (Iluma) belum tersambung. Di mode Xendit
> (SANDBOX/LIVE) `validateBankAccount` selalu mengembalikan `NAME_VALIDATION_UNAVAILABLE`, sehingga pembeli menerima
> `BANK_ACCOUNT_VALIDATION_UNAVAILABLE` dan **refund ke rekening untuk kanal VA/ritel tidak dapat diselesaikan sama
> sekali**. Tidak ada jalur admin untuk mengisi rekening atas nama pembeli, dan transfer di luar sistem dilarang (§1).
> Keputusan Owner/Finance diperlukan: aktifkan Iluma/penny-drop, atau batasi kanal pembayaran ke yang mendukung refund
> sampai validasi tersedia.

## 5. Layar rekonsiliasi

### 5.1 Apa yang dibandingkan (baca sebelum memakai)
`runDailyReconciliation` (`apps/api/src/modules/reconciliation/service.ts`) membandingkan, untuk pembayaran yang
`secured_at` dalam periode, **nominal di tabel `payments` internal** dengan debit `PROVIDER_CASH` jurnal capture-nya
(`capture:<paymentId>`), plus jurnal capture yang pembayarannya tidak berstatus SECURED.

- Nama kolom `providerSecuredIdr` / `provider_amount_idr` = nominal yang **dicatat sistem kita** dari webhook + verifikasi
  ulang ke penyedia, **bukan** laporan/saldo Xendit. Rekonsiliasi ini membuktikan konsistensi *pembayaran ↔ ledger*,
  tidak membuktikan *ledger ↔ uang di Xendit*.
- **Refund dan payout tidak direkonsiliasi oleh job.** Keduanya harus dicocokkan manual ke laporan Xendit (§8).

### 5.2 Membaca run — `GET /v1/admin/reconciliation/runs?status=` (`finance.reports.read`)
| Status run | Arti | Tindakan |
|---|---|---|
| `MATCHED` | semua pembayaran periode punya jurnal capture dengan nominal sama | catat di ringkasan harian |
| `COMPLETED_WITH_DIFFS` | ada item terbuka; log `ALERT reconciliation.mismatch` | §5.3 hari yang sama |
| `RUNNING` lama / `FAILED` | job gagal | eskalasi Tim API; jalankan manual setelah diperbaiki |

Kolom: `payments`, `mismatches`, `internalCapturedIdr`, `providerSecuredIdr`, `openItems`, `resolvedItems`, `manual`
(run manual), `sandbox` (bukan LIVE — angka tidak boleh dipakai untuk laporan keuangan).

### 5.3 Item selisih — `GET /v1/admin/reconciliation/runs/{id}/items` (default yang terbuka)
`diffIdr` = nominal pembayaran − capture ledger.

| Status item | Kemungkinan penyebab | Tindakan |
|---|---|---|
| `MISSING_INTERNAL` | pembayaran SECURED tanpa jurnal capture | **P1 — bug**: eskalasi Tim API segera; jangan selesaikan item sebelum jurnal dibuat lewat jalur aplikasi |
| `MISMATCH` | nominal jurnal ≠ nominal pembayaran (pembayaran tambahan, salah hitung) | bandingkan ke dashboard Xendit (reference `JK-…`); ikuti runbook pembayaran §2 |
| `MISSING_PROVIDER` | jurnal capture ada tetapi pembayaran tidak SECURED (mis. dibatalkan setelah dicatat) | cek status pembayaran di Xendit; bila dana tidak pernah masuk → koreksi lewat alur resmi (Tim API) |

**Menyelesaikan item:** `POST /v1/admin/reconciliation/items/{id}/resolve` `{note ≥ 10 karakter}` — butuh
`finance.reports.read` + `payouts.manage` + MFA. **Tidak menggerakkan uang**; hanya mencatat penyelesai, waktu, catatan
(audit `reconciliation.item_resolved`). Catatan wajib memuat: penyebab, bukti (ID Xendit/journal/tiket), tindakan korektif
yang sudah dilakukan lewat alur resmi. Item yang sudah RESOLVED → 409 `RECONCILIATION_ITEM_NOT_OPEN`.
Aturan: **dilarang** me-resolve item hanya untuk "menghijaukan" layar.

### 5.4 Run manual
`POST /v1/admin/reconciliation/runs` `{periodStart, periodEnd, reason}` — periode ≤ 31 hari, tidak melewati waktu
sekarang, MFA + Idempotency-Key; audit `reconciliation.manual_run`. Dipakai: setelah perbaikan bug, setelah insiden,
dan saat tutup buku bulanan (§8). Run harian berikutnya harus kembali 0 selisih.

## 6. Payout traveler

### 6.1 Siklus & guard
Payout dijadwalkan saat transaksi selesai (penghasilan) atau pembatalan (kompensasi) ke rekening utama traveler.
Processor memeriksa `PAYOUT_CLEAR`: keputusan risiko (flag hold transaksi, review HOLD/BLOCK terbuka), **tidak ada dispute
terbuka** (dispute `RESOLVED` yang belum `CLOSED` dianggap terbuka), rekening `VERIFIED`. Rekening belum terverifikasi →
tetap `SCHEDULED`. Gagal disbursement → retry dengan backoff (15 menit × 2ⁿ) maks. 3×, lalu `ON_HOLD`
(`REPEATED_FAILURE: …`).

### 6.2 Jeda rekening payout baru — `money.policy.newPayoutAccountCooldownHours` (default 24 jam)
Ditambahkan 2026-10-04 (migrasi `0120_payout_account_cooldown.sql`, keputusan CEO dicatat di catatan config).
- Payout baru dikirim setelah **`greatest(created_at, verified_at, default_since) + jeda`** rekening tujuan. Jadi
  menambah, memverifikasi (termasuk override admin), atau menjadikan rekening utama **memulai ulang** jeda.
- Saat rekening utama diganti, payout yang belum dikirim (`SCHEDULED/ON_HOLD/FAILED`) dipindah ke rekening baru dan ikut
  menunggu. Aturan dicek saat penjadwalan **dan** saat diproses, sehingga perubahan config berlaku untuk semua payout tertunda.
- Layar payout menampilkan `cooldownUntil` untuk payout yang masih dalam jeda. **Jangan** mencoba "mempercepat" dengan
  hold/release — release tidak melewati jeda.
- Mengubah nilai (0–720 jam) = versi config baru `money.policy` lewat maker-checker. Jeda **tidak** berlaku untuk rekening
  tujuan refund pembeli (§4).
- Berbeda dari `payoutDelayHours` (default 0) yang menunda **semua** payout.

### 6.3 Aksi admin (`payouts.manage`)
| Aksi | Endpoint | Kontrol | Kapan |
|---|---|---|---|
| Tahan | `POST /v1/admin/payouts/{id}/hold` `{reason}` | MFA + Idempotency-Key; `held_by` dicatat; event `payout.on_hold` | indikasi fraud, permintaan RISK, rekening dicurigai, dispute belum dibuka tapi dilaporkan |
| Lepas | `POST …/release` | MFA + Idempotency-Key + **maker-checker: pelepas ≠ penahan** (API + DB CHECK); 422 `RISK_REVIEW_OPEN` bila review risiko transaksi terbuka; peringatan `DISPUTE_NOT_CLOSED` | penyebab hold sudah selesai & terdokumentasi |
| Coba ulang | `POST …/retry` | MFA + Idempotency-Key; FAILED → SCHEDULED, attempts direset | setelah traveler memperbarui rekening / gangguan bank selesai |

Hold otomatis `DISPUTE_OPEN` dilepas sistem setelah dispute `CLOSED` dan tidak ada review risiko terbuka — tidak perlu
tindakan manual.

### 6.4 Override verifikasi rekening payout — kontrol 4-mata prosedural
`POST /v1/admin/kyc/payout-accounts/{id}/verification-override` (`kyc.review`, MFA) **tidak memiliki maker-checker di
kode** — satu admin dapat mengubah rekening `NAME_MISMATCH`/`PENDING` menjadi `VERIFIED` (hanya dilarang untuk rekening
sendiri). Sampai maker-checker dibangun (DPIA A-02), wajib:
1. Peminta (OPERATIONS/RISK) menulis alasan + bukti (dokumen kepemilikan rekening) di tiket.
2. Orang kedua dari FINANCE meninjau dan menulis persetujuan di tiket **sebelum** override dijalankan.
3. Override memulai jeda 24 jam (§6.2) — beri tahu traveler.
4. Review mingguan audit `kyc.payout_account_override` oleh Finance Lead.

> **Masalah diketahui (perlu Tim API):** di mode Xendit, `addPayoutAccount` (`apps/api/src/modules/kyc/service.ts`)
> memperlakukan jawaban `valid:false, reason: NAME_VALIDATION_UNAVAILABLE` sebagai rekening tidak ditemukan dan menolak
> **setiap** rekening dengan `BANK_ACCOUNT_INVALID` ("Nomor rekening tidak ditemukan di bank tujuan"). Alur refund sudah
> membedakan alasan itu, alur rekening payout belum. Akibatnya di staging Xendit traveler tidak dapat menambah rekening
> dan tidak dapat mencapai level 4. CS jangan menyarankan pengguna mencoba nomor lain.

## 7. Ringkasan wewenang

| Aksi | FINANCE | FINANCE_SUPER_ADMIN | OPERATIONS | SUPER_ADMIN |
|---|---|---|---|---|
| Approve/reject refund, review rekening tujuan refund | ✓ | ✓ | — | ✓ |
| Ajukan refund admin | ✓ (`refunds.request`, butuh juga `transactions.override` untuk endpoint transaksi) | ✓ | ✓ | ✓ |
| Hold/release/retry payout, resolve item & run manual rekonsiliasi | ✓ | ✓ | — | ✓ |
| Override verifikasi rekening payout | — | — | ✓ (`kyc.review`) | ✓ |
| Ajukan perubahan rekening settlement | ✓ | ✓ | — | ✓ |
| Setujui perubahan rekening settlement & config | — | ✓ | — | — (settlement) |

## 8. Checklist tutup buku bulanan (ASUMSI — disahkan akuntan)

| # | Hari | Langkah | Bukti |
|---|---|---|---|
| 1 | H+1 | Semua run harian bulan lalu `MATCHED` atau item terbuka sudah RESOLVED dengan catatan | daftar run |
| 2 | H+1 | Run manual satu bulan penuh (≤ 31 hari) → harus 0 selisih | ID run |
| 3 | H+2 | Unduh laporan transaksi & saldo dari dashboard Xendit (mode LIVE) untuk bulan itu; cocokkan: total money-in vs `PROVIDER_CASH` debit capture; refund & payout sukses vs jurnal `REFUND_PAID`/`PAYOUT_PAID`; biaya vs `PAYMENT_FEE`; saldo akhir Xendit vs saldo `PROVIDER_CASH` | lembar kerja ditandatangani |
| 4 | H+2 | Dana ditahan (escrow) per bucket (`PRODUCT_FUND`, `CUSTOMS_RESERVE`, `TRAVELER_EARNING`, `CLEARING`) hanya milik transaksi yang belum final | kueri read-only |
| 5 | H+2 | Umur refund terbuka (`PENDING_APPROVAL`, menunggu rekening, FAILED > 3 hari) & payout `ON_HOLD` > 7 hari — masing-masing punya PIC & rencana | daftar umur |
| 6 | H+3 | Pendapatan platform (`PLATFORM_REVENUE`), proteksi, promo (`PROMOTION_CREDIT`), kredit hangus | ringkasan |
| 7 | H+3 | `TAX_PAYABLE` (PPN atas fee) **hanya bila JastipKita PKP**; bila belum PKP, `pricing.service_tax.enabled` harus `false` (launch checklist L8) | memo pajak |
| 8 | H+3 | Integritas: `GET /v1/admin/audit-logs/verify` OK; checkpoint audit harian tersedia (migrasi `0140`, bila sudah aktif) | hasil verifikasi |
| 9 | H+3 | Tinjau audit perubahan sensitif bulan itu: config (`config.*`), rekening settlement, override rekening payout, refund admin (`GET /v1/admin/audit-logs?action=finance.*` dan aksi terkait) | catatan tinjauan |
| 10 | H+5 | Paket tutup buku ditandatangani maker (FINANCE) + checker (FINANCE_SUPER_ADMIN), diarsip | paket |

Catatan: tidak ada endpoint ekspor ledger/neraca saldo di admin; langkah 4–6 memakai kueri read-only (role `jk_readonly`,
tanpa kolom PII) — ASUMSI bahwa kolom yang diperlukan tersedia untuk role itu; verifikasi dengan Tim API.

## 9. Ringkasan harian (templat)

```
Tanggal: {YYYY-MM-DD} · Mode: {SANDBOX/LIVE}
Rekonsiliasi run {id}: {MATCHED/…} · item terbuka {n} (Rp{total diff})
Refund: disetujui {n} (Rp…) · ditolak {n} · menunggu rekening {n} · FAILED {n}
Rekening tujuan refund: approve {n} · reject {n} · tertunda {n}
Payout: dibayar {n} (Rp…) · ON_HOLD {n} (alasan) · dalam jeda rekening baru {n} · FAILED {n}
Eskalasi/insiden: {…}
```

## 10. Eskalasi

| Kondisi | Level | Ke |
|---|---|---|
| `INSUFFICIENT_BALANCE`, `MISSING_INTERNAL`, payout ke rekening tak dikenal, dana dobel keluar | P1 | Finance Lead + Owner + on-call (runbook pembayaran) segera |
| Item rekonsiliasi terbuka > 2 hari kerja; refund > 3 hari tanpa progres | P2 | Finance Lead |
| Pola penggantian rekening mencurigakan | — | RISK + `docs/runbooks/security-incident.md` |

## 11. KPI

| KPI | Target awal (ASUMSI) |
|---|---|
| Waktu siklus refund (diminta → SUCCEEDED) | median ≤ 2 hari kerja |
| % refund yang butuh rekening tujuan; waktu review `PENDING_REVIEW` | dipantau; review ≤ 1 hari kerja |
| Payout tepat waktu (≤ 1 hari kerja setelah jeda/hold selesai) | ≥ 95 % |
| Umur hold payout | 0 > 7 hari tanpa PIC |
| Item rekonsiliasi terbuka (jumlah, Rp) | 0 > 2 hari kerja |

---

**Catatan keterbatasan data:** prosedur disusun dari kode dan dokumen per 2026-10-04 dengan provider MOCK; perilaku Xendit
(cut-off, kode error, laporan) dari dokumentasi publik (riset 02, 2026-09-27) dan belum diuji dengan akun nyata; jeda
rekening payout baru (0120) dan checkpoint audit (0140) ditambahkan engineer lain pada hari yang sama — kodenya dibaca,
tesnya tidak dijalankan penyusun; ambang Rp10 juta, jadwal, SLA, kebijakan rekening atas nama pembeli, dan checklist
tutup buku adalah ASUMSI yang memerlukan pengesahan Finance Lead dan akuntan.
