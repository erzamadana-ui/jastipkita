# 02 — Integrasi Xendit untuk Marketplace ber-escrow (SafePay)

> Status: riset dokumentasi publik Xendit, diverifikasi **2026-09-27**. Belum dikonfirmasi oleh account manager Xendit maupun konsultan hukum.
> Item yang tidak terkonfirmasi ditandai **`NEEDS_VERIFICATION`**. Integrasi wajib diberi label **SANDBOX** sampai kontrak & go-live disetujui (CONVENTIONS.md "Kejujuran integrasi").

## Ringkasan
- **API penerimaan pembayaran yang direkomendasikan: Payment Sessions** (`POST /sessions`, `mode: PAYMENT_LINK`) — penerus resmi Invoices/Payment Links legacy (`POST /v2/invoices`). Untuk integrasi native per-channel gunakan **Payment Requests v3** (`POST /v3/payment_requests`, header `api-version: 2024-11-11`).
- **Webhook** diverifikasi dengan header **`x-callback-token`** (token statis per akun dari Dashboard), bukan HMAC. Deduplikasi dengan header **`webhook-id`**. Retry **6×** (15m, 45m, 2j, 3j, 6j, 12j). Urutan **tidak dijamin**.
- **Refund tidak didukung Virtual Account, AstraPay, Alfamart/Indomaret**; e-wallet punya jendela refund pendek (OVO 14 hari). Karena dana jastip bisa tertahan berminggu-minggu, **refund harus bisa jatuh ke payout ke rekening pembeli**.
- **Menahan dana** dilakukan di saldo akun Xendit (master/OWNED sub-account) — Xendit Indonesia berlisensi BI (PJP Kategori 1 & 3). JastipKita **tidak boleh** menampung dana di rekening bank sendiri. Kelayakan pola "hold s.d. barang diterima" wajib dikonfirmasi tertulis ke Xendit + legal review.

---

## 1. Memilih API penerimaan pembayaran

| API | Endpoint | Status 2026 | Kapan dipakai |
|---|---|---|---|
| Invoices / Payment Links (legacy) | `POST /v2/invoices`, `GET /v2/invoices/{id}` | **Legacy** — dokumen migrasi resmi menyebut "(legacy) Payment Links/Invoice"; tidak ada tanggal sunset yang dipublikasikan | Jangan dipakai untuk integrasi baru |
| **Payment Sessions** | `POST /sessions`, `GET /sessions/{payment_session_id}`, cancel session | Pengganti Invoices ("Payment Link (New)") | **Checkout MVP**: hosted page (`PAYMENT_LINK`) atau embedded (`COMPONENTS`) |
| Payment Requests v3 | `POST /v3/payment_requests`, `GET …/{id}`, cancel; header `api-version: 2024-11-11` | Current | Checkout native (tampilkan nomor VA/QR sendiri), tokenisasi kartu |

Pemetaan status Invoice → Session: `PENDING→ACTIVE`, `PAID/SETTLED→COMPLETED`, `EXPIRED→EXPIRED`, baru: `CANCELED` ([migrate-to-payment-session](https://docs.xendit.co/docs/migrate-to-payment-session.md)).

### 1.1 Payment Sessions — field penting ([create-session](https://docs.xendit.co/apidocs/create-session.md))
- Wajib: `reference_id` (1–64), `session_type` (`PAY`|`SAVE`|`SUBSCRIPTION`), `mode` (`PAYMENT_LINK`|`COMPONENTS`), `amount`, `currency` (IDR…), `country` (ID…).
- Opsional: `customer`/`customer_id`, `capture_method` (`AUTOMATIC`|`MANUAL`), `allowed_payment_channels`, `expires_at` (**default 30 menit**), `success_return_url`, `cancel_return_url`, `items`, `metadata` (≤ 50 key), `channel_properties`, `allow_save_payment_method`.
- Header opsional: `for-user-id` (sub-account xenPlatform), `with-split-rule`.
- Respons: `payment_session_id`, `payment_link_url`, `status` (`ACTIVE|COMPLETED|EXPIRED|CANCELED`), `payment_request_id`, `payment_id`.
- Error: `API_VALIDATION_ERROR`, `INVALID_AMOUNT`, `INVALID_PAYMENT_CHANNEL`, `DUPLICATE_ERROR` (409), `INVALID_API_KEY` (401), dll.

### 1.2 Payment Requests v3 ([create-payment-request](https://docs.xendit.co/apidocs/create-payment-request.md))
- `type`: `PAY`, `PAY_AND_SAVE`, `REUSABLE_PAYMENT_CODE`, `VERIFY_PAYMENT_METHOD`; `request_amount`; `channel_code` (mis. `QRIS`, `BCA_VIRTUAL_ACCOUNT`, `CARDS`); `capture_method`; `channel_properties`.
- Status: `ACCEPTING_PAYMENTS`, `REQUIRES_ACTION`, `AUTHORIZED`, `CANCELED`, `EXPIRED`, `SUCCEEDED`, `FAILED`. `actions[]` berisi `PRESENT_TO_CUSTOMER`/`REDIRECT_CUSTOMER`/`API_POST_REQUEST` dengan descriptor `QR_STRING`, `WEB_URL`, `VIRTUAL_ACCOUNT_NUMBER`.

### 1.3 Batas channel yang memengaruhi desain
| Channel | Batas nominal | Settlement | Sumber |
|---|---|---|---|
| QRIS (`QRIS`) | **Rp1 – Rp10.000.000** per transaksi; expiry 48 jam | T+1 hari kerja | [qris.md](https://docs.xendit.co/docs/qris.md) |
| BCA VA (`BCA_VIRTUAL_ACCOUNT`) | Rp10.000 – Rp50.000.000, fixed amount | T+1 hari kerja | [bca-virtual-account.md](https://docs.xendit.co/docs/bca-virtual-account.md) |
→ Item mewah > Rp10 juta tidak bisa QRIS; engine harus memfilter `allowed_payment_channels` berdasarkan total.

## 2. Autentikasi, idempotensi, rate limit, mode uji
- **Auth:** HTTP Basic — *secret API key sebagai username, password kosong* (`base64("<key>:")`). Kunci uji berawalan `xnd_development_`, live `xnd_production_` ([arsip API reference](https://archive.developers.xendit.co/)). Kunci punya permission (mis. **MONEY-OUT** untuk payout — [create-payout-v3](https://docs.xendit.co/apidocs/create-payout-v3.md)). Rekomendasi: **kunci terpisah** untuk money-in, money-out, dan read-only report.
- **Idempotensi:**
  - Payouts v2: header **`Idempotency-key`** **wajib** (1–100 karakter) ([create-payout](https://docs.xendit.co/apidocs/create-payout.md)).
  - Payouts v3: `idempotency-key` opsional; key + body sama → mengembalikan objek pertama; konflik → 409.
  - API legacy: header idempotency untuk POST/PATCH, maks. 100 karakter, kedaluwarsa 24 jam (arsip; nama persis versi legacy `X-IDEMPOTENCY-KEY` — `NEEDS_VERIFICATION`).
  - Payment Sessions / Payment Requests v3: header idempotensi **tidak tercantum** di spesifikasi yang dibaca → andalkan `reference_id` unik (409 `DUPLICATE_ERROR`) + tabel `idempotency_keys` internal (`NEEDS_VERIFICATION`).
- **Rate limit** (arsip): test 60 RPM/endpoint, live 6.000 RPM/endpoint, 18.000 RPM per IP; kelebihan → 429 `RATE_LIMIT_EXCEEDED`.
- **Simulasi (test mode):**
  - `POST /v3/payment_requests/{payment_request_id}/simulate` body `{ "amount": <n> }`, header `api-version: 2024-11-11`, hasil async via webhook ([simulate-payment-test-mode](https://docs.xendit.co/apidocs/simulate-payment-test-mode.md)).
  - VA legacy: `POST https://api.xendit.co/callback_virtual_accounts/{external_id}/simulate_payment` body `{ "amount": … }` ([Help Center](https://help.xendit.co/hc/en-us/articles/360038118371-How-can-I-simulate-the-fixed-Virtual-Account-payment-in-test-mode)); format path (`external_id=` prefix) `NEEDS_VERIFICATION`.
  - Skenario kartu & error: [cards-simulate-card-scenarios](https://docs.xendit.co/docs/cards-simulate-card-scenarios.md), [simulate-error-scenarios](https://docs.xendit.co/docs/simulate-error-scenarios.md); xenPlatform: [testing-xenplatform-features](https://docs.xendit.co/docs/testing-xenplatform-features.md). Simulasi payout di test mode: `NEEDS_VERIFICATION`.

## 3. Webhook
| Aspek | Ketentuan | Sumber |
|---|---|---|
| Verifikasi | Header **`x-callback-token`** = token webhook per akun (Dashboard → Webhook settings). Tidak ada HMAC/signature yang terdokumentasi | [handling-webhooks](https://docs.xendit.co/docs/handling-webhooks.md), [integration-security](https://docs.xendit.co/docs/integration-security), [Help Center](https://help.xendit.co/hc/en-us/articles/360038072991-How-to-validate-if-the-webhook-is-sent-from-Xendit) |
| Dedup | Header **`webhook-id`** unik per webhook; juga `payment_id`/`capture_id` | [arsip](https://archive.developers.xendit.co/), handling-webhooks |
| Sukses | Respons HTTP **2xx** secepatnya (timeout tidak dipublikasikan — `NEEDS_VERIFICATION`) | [webhook-behavior](https://docs.xendit.co/apidocs/webhook-behavior.md) |
| Retry | Hingga **6 retry**: +15 m, +45 m, +2 j, +3 j, +6 j, +12 j; resend manual di Dashboard (batch ≤ 500) | webhook-behavior |
| Urutan | **Tidak dijamin** ("jumbled sequence") → state machine harus idempoten & monoton | handling-webhooks |
| IP allowlist | Daftar IP diminta ke CS | integration-security |
| Routing xenPlatform | Webhook sub-account dikirim ke `MASTER_ACCOUNT` atau `SUB_ACCOUNT` (pilih saat pembuatan) | [accepting-payments-for-sub-accounts](https://docs.xendit.co/docs/accepting-payments-for-sub-accounts.md) |

**Event & field penting**
- Payment Session: `payment_session.completed`, `payment_session.expired`; payload `{ event, business_id, created, data: { payment_session_id, status, payment_id, payment_request_id, reference_id, amount, currency, … } }` ([webhook session](https://docs.xendit.co/apidocs/webhook-notification-sent-defined-webhook-url-updates-payment-session.md)).
- Payments API: `payment.capture` (dana terkumpul), `payment.authorization`, `payment.expiry`, `payment.failure`, `payment_request.expiry` ([payments-api-webhooks](https://docs.xendit.co/docs/payments-api-webhooks.md)).
- Refund: `refund.succeeded`, `refund.failed`.
- Payout v3: `v3_payout.succeeded|failed|reversed|rejected|pending_compliance` ([integration-payouts](https://docs.xendit.co/docs/integration-payouts)). Payout **v2**: nama event `NEEDS_VERIFICATION` (umumnya `payout.succeeded/failed/reversed`).
- Lain: split payment status, report, account/KYC sub-account.

**Aturan internal:** webhook hanya *pemicu*; sebelum transisi `AWAITING_PAYMENT → PAYMENT_SECURED`, server **GET** ulang resource (`GET /sessions/{id}` atau payment request) dan cocokkan `status`, `amount`, `currency`, `reference_id` (domain model §4).

## 4. Refund
- `POST /refunds` ([spec](https://docs.xendit.co/apidocs/refund-payment-request.md)): wajib `payment_request_id`, `reason` ∈ {`FRAUDULENT`, `DUPLICATE`, `REQUESTED_BY_CUSTOMER`, `CANCELLATION`, `OTHERS`}; opsional `reference_id`, `amount` (partial, ≤ sisa capture), `currency`, `metadata`; header `for-user-id`.
- Status: `PENDING`, `SUCCEEDED`, `FAILED`, `CANCELLED`; ada `refund_fee_amount`.
- Error penting: `REFUND_NOT_SUPPORTED`, `PARTIAL_REFUND_NOT_SUPPORTED`, `PARTIAL_REFUND_COUNTS_EXCEEDED`, `REFUND_AMOUNT_EXCEEDED`, `INSUFFICIENT_BALANCE`, `INELIGIBLE_TRANSACTION_STATUS`, `CHANNEL_UNAVAILABLE`.

| Channel (ID) | Full | Partial | Jendela | Catatan |
|---|---|---|---|---|
| Semua VA (BCA, BNI, BRI, BSI, Mandiri, Permata, CIMB, …) | ✗ | ✗ | — | **refund via payout** |
| QRIS | ✓ | ✗ / ✓ | 30 hari / 7 hari | **Konflik** antara halaman daftar channel dan halaman QRIS → `NEEDS_VERIFICATION` |
| OVO | ✓ | ✓ | 14 hari | |
| ShopeePay | ✓ | ✓ | 365 hari | |
| GoPay | ✓ | ✓ | 45 hari | |
| DANA | ✓ | ✓ | 30 hari | |
| LinkAja | ✓ | ✗ | 30 hari | |
| Kartu | ✓ | ✓ | 365 hari | |
| AstraPay, Alfamart, Indomaret | ✗ | ✗ | — | refund via payout |
| BRI Direct Debit | ✓ | ✗ | 120 hari | |
| Kredivo/Indodana/Atome | ✓ | ✓ | 14–30 hari | |
Sumber: [available-payment-channels](https://docs.xendit.co/docs/available-payment-channels.md), [qris.md](https://docs.xendit.co/docs/qris.md).

**Implikasi:** simpan `refund_method ∈ {PROVIDER_REFUND, PAYOUT_TO_BUYER}` per refund; pilih otomatis berdasarkan channel, sisa jendela, dan partial/full. Refund via payout butuh rekening pembeli tervalidasi (nama) + biaya payout (siapa menanggung → matrix pembatalan). Refund memotong **saldo akun penerima** (`INSUFFICIENT_BALANCE`) → jangan transfer semua dana keluar sebelum transaksi final.

## 5. xenPlatform
| Aspek | Ketentuan | Sumber |
|---|---|---|
| Struktur | Master account (xenPlatform aktif) + sub-account | [xenplatform-overview](https://docs.xendit.co/docs/xenplatform-overview.md) |
| OWNED | Dibuat dengan nama bisnis + email; **master mengendalikan & bertanggung jawab**; tidak bisa membuat API key sendiri | [Help Center](https://help.xendit.co/hc/en-us/articles/4408655256589-How-Do-I-Create-A-Sub-Account-on-XenPlatform), accepting-payments-for-sub-accounts |
| MANAGED | Mitra mengunggah dokumen (verifikasi 3–5 hari kerja), punya dashboard sendiri, **mengendalikan dananya sendiri** | Help Center |
| Migrasi tipe | **Tidak bisa** OWNED ↔ MANAGED | Help Center |
| `for-user-id` | Header untuk membuat transaksi/payout/refund atas nama sub-account dengan API key master | [sub-accounts](https://docs.xendit.co/docs/sub-accounts.md) |
| Split rule | `POST /split_rules` (routes flat/percent → `destination_account_id`; IDR didukung); dipakai via header `with-split-rule`; dieksekusi **saat settlement** dari (total − fee); split 100% gagal | [split-payments](https://docs.xendit.co/docs/split-payments.md), [create-split-rule](https://docs.xendit.co/apidocs/create-split-rule.md) |
| Transfer | `POST /transfers` {`reference`, `amount`, `source_user_id`, `destination_user_id`}; hanya API key master; master↔sub, sub↔sub; instan; satu mata uang; ≤ saldo tersedia; **cross-border tidak didukung untuk merchant Indonesia**; `GET` by reference | [transfer-balances](https://docs.xendit.co/docs/transfer-balances.md) |
| Biaya | Per sub-account aktif bulanan + biaya transfer/split (contoh di dokumen ambigu) — tarif tidak dipublikasikan | [xenplatform-fees](https://docs.xendit.co/docs/xenplatform-fees.md) → `NEEDS_VERIFICATION` |

**Catatan split rule:** split dieksekusi saat settlement → **tidak cocok untuk escrow** (dana traveler akan terbagi sebelum barang diterima). Platform fee sebaiknya diambil saat **release** (transfer/payout dikurangi fee), bukan split otomatis.

## 6. Payout (pembayaran ke traveler / refund ke pembeli)
- **Payouts v2 (domestik):** `POST /v2/payouts`; header **`Idempotency-key` wajib**, `for-user-id` opsional; body `reference_id`, `channel_code` (kode bank/e-wallet tujuan), `channel_properties { account_holder_name, account_number, account_type? }`, `amount`, `currency`, `description`, `receipt_notification`, `metadata`. Status: `ACCEPTED → REQUESTED → SUCCEEDED | FAILED | CANCELLED | REVERSED`. Failure: `INSUFFICIENT_BALANCE`, `INVALID_DESTINATION`, `REJECTED_BY_CHANNEL`, `TEMPORARY_TRANSFER_ERROR`, `TRANSFER_ERROR`, `UNKNOWN_BANK_NETWORK_ERROR`, `DESTINATION_MAXIMUM_LIMIT` ([create-payout](https://docs.xendit.co/apidocs/create-payout.md)).
- **Payouts v3:** `POST /v3/payouts`, `api-version: 2025-09-01`, berorientasi lintas negara (recipient, `source_of_fund`, `purpose_code`, quote FX) — **tidak diperlukan** untuk payout IDR domestik.
- **Cakupan Indonesia:** BI-FAST (±15 menit, ≤ Rp250 juta/transaksi), RTGS (±2 jam, cut-off 14:00 WIB); bank utama (BCA, BRI, BNI, Mandiri, Permata, CIMB, Maybank) & e-wallet (OVO, DANA, GoPay) ([payout-coverage-indonesia](https://docs.xendit.co/docs/payout-coverage-indonesia.md)).
- **Validasi rekening (name inquiry):** "Bank Account Validation (Name Validator)" disediakan lewat **Iluma** (Xendit Data Services); aktivasi via help@xendit.co / help@iluma.ai; biaya bulanan; kompatibel dengan disbursement API ([Help Center, 2023-01-03](https://help.xendit.co/hc/en-us/articles/14143546600857-Does-the-Bank-Account-Validation-Service-Compatible-to-be-Used-for-Disbursement-via-API)). Endpoint & harga `NEEDS_VERIFICATION` ([docs.iluma.ai](https://docs.iluma.ai/)). Alternatif murah: penny-drop Rp1 + cocokkan nama (lebih lambat, perlu biaya payout).

## 7. Rekonsiliasi
- `GET /transactions` — filter `types`, `statuses`, `channel_categories`, `reference_id`, `product_id`, `created[gte]`, `updated[gte]`, `limit`, `after_id`; field `fee.xendit_fee`, `fee.value_added_tax`, `fee.third_party_withholding_tax`, `settlement_status`, `estimated_settlement_time`, `cashflow` (`MONEY_IN|MONEY_OUT`); header `for-user-id` ([list-transactions](https://docs.xendit.co/apidocs/list-transactions.md)).
- `POST /reports` — `type` ∈ {`BALANCE_HISTORY`, `TRANSACTIONS`, `UPCOMING_TRANSACTIONS`, `DETAILED_TRANSACTIONS`}, `filter.from/to` (< 92 hari), CSV, async + webhook report, lalu `GET /reports/{id}` ([generate-report](https://docs.xendit.co/apidocs/generate-report.md)).
- `GET /balance` untuk saldo master/sub-account.
- Job harian: tarik `GET /transactions?updated[gte]=<last_cursor>` → cocokkan ke `ledger` (`PROVIDER_CASH`, `PAYMENT_FEE`, `TAX_PAYABLE` untuk PPN atas fee) → tandai selisih.

## 8. Biaya Indonesia (halaman harga publik, **belum termasuk pajak**; dipotong saat settlement)
Sumber: [xendit.co/en-id/pricing](https://www.xendit.co/en-id/pricing/) (diakses 2026-09-27; halaman dinamis — tarif final sesuai kontrak).

| Metode | Fee metode | + Xendit Processing fee |
|---|---|---|
| VA (BCA/BNI/BRI/BSI/CIMB/Mandiri/Muamalat/Neo/Permata/Sampoerna) | Rp9.000 | Rp4.000 |
| QRIS | 0,70% (**termasuk PPN**) | Rp4.000 |
| OVO | 3,00–5,50% | Rp4.000 |
| DANA | 3,00–3,50% | Rp4.000 |
| ShopeePay | 2,50–3,60% | Rp4.000 |
| GoPay | 3,00–5,00% | Rp4.000 |
| AstraPay | 2,00% | Rp4.000 |
| Kartu Visa/MC/JCB | 2,90% + Rp2.000 | Rp4.000 |
| AMEX | 3,90% + Rp2.000 | Rp4.000 |
| Cicilan kartu 3/6/12 bln | 5,00–10,00% + Rp2.000 | Rp4.000 |
| Alfamart / Indomaret | Rp9.000 | Rp4.000 |
| Akulaku / Kredivo | 2,00% / 2,30% | Rp4.000 |
| Payout bank/e-wallet | 1,00% (min. Rp2.500) | Rp4.000 — **`NEEDS_VERIFICATION`** (struktur tidak lazim untuk disbursement domestik; konfirmasi ke Xendit) |
| Chargeback | USD 25 | — |
| xenPlatform | tidak dipublikasikan | `NEEDS_VERIFICATION` |

Contoh checkout Rp5.000.000 (asumsi PPN 11% efektif atas fee yang belum termasuk pajak): VA = (9.000 + 4.000) × 1,11 = **Rp14.430**; QRIS = 35.000 + 4.000 × 1,11 = **Rp39.440**; kartu = (145.000 + 2.000 + 4.000) × 1,11 = **Rp167.610**. → VA termurah untuk tiket besar, tetapi **tidak bisa refund** (lihat §4).

## 9. Batas regulasi
> Bukan nasihat hukum. Wajib legal review sebelum go-live.

1. **Kerangka BI:** PBI 23/6/PBI/2021 tentang Penyedia Jasa Pembayaran membagi aktivitas PJP: penyediaan informasi sumber dana, *payment initiation/acquiring*, **penatausahaan sumber dana**, dan remitansi; lisensi Kategori 1 (semua), 2, 3. Pihak yang **menerima dan menatausahakan dana untuk kepentingan pembayaran pihak lain** memerlukan izin kecuali memenuhi pengecualian ([BI](https://www.bi.go.id/id/publikasi/peraturan/Pages/PBI_230621.aspx)). Amandemen pasca-2021 belum dicek → `NEEDS_VERIFICATION`.
2. **Lisensi Xendit (grup):** PT Sinar Digital Terdepan — *Payment Gateway License (Category 1)* BI; PT Syaftraco — *Funds Transfer Services Provider License (Category 3)* BI; entitas lain OJK ([Xendit Licenses](https://www.xendit.co/en/company/xendit-licenses/)). Nomor izin tidak dicantumkan → minta salinan.
3. **Yang boleh (dengan konfirmasi Xendit):** dana pembeli masuk ke saldo Xendit (master/OWNED sub-account milik JastipKita), ditahan secara **akuntansi** (ledger `PRODUCT_FUND`, `TRAVELER_EARNING`, `CUSTOMS_RESERVE`) sampai `BUYER_CONFIRMED`, lalu dibayarkan ke traveler lewat payout/transfer. Dana tidak pernah melewati rekening bank JastipKita.
4. **Yang memerlukan izin BI (hindari):** menampung dana pembeli di rekening bank JastipKita lalu meneruskan; menyediakan saldo/dompet yang bisa di-*top-up*, ditarik tunai, atau ditransfer antar-pengguna (uang elektronik / penatausahaan sumber dana); jasa kirim uang/titip uang tunai (remitansi).
5. **Perlu legal review:**
   - Apakah menahan dana hingga barang diterima (bisa > 30 hari) sesuai T&C Xendit & ketentuan settlement BI, serta apakah perlu **rekening penampungan/escrow bank** atau trustee.
   - Branding "SafePay"/"dana aman" — hindari klaim yang menyiratkan JastipKita adalah bank/PJP.
   - **JastipKita Credit** (referral/promo): harus *closed-loop*, tidak dapat diuangkan/ditransfer; jika tidak, berpotensi uang elektronik.
   - Status JastipKita sebagai **PPMSE** dengan escrow: PMK 37/2025 & PER-15/2025 menjadikan marketplace yang memakai escrow dan melewati ambang (nilai transaksi > Rp600 juta/12 bln atau > Rp50 juta/bln; traffic > 12.000/12 bln atau > 1.000/bln) dapat **ditunjuk pemungut PPh 22 0,5%** atas omzet pedagang ([Ortax](https://ortax.org/apa-saja-kriteria-marketplace-menjadi-pemungut-pph-pasal-22), [DJP](https://www.pajak.go.id/en/node/120146)). Apakah traveler = "pedagang" (penghasilan jasa titip) → review pajak.
   - Kelayakan bisnis jastip lintas negara menurut daftar bisnis terlarang/berisiko tinggi Xendit → konfirmasi KYB (`NEEDS_VERIFICATION`).

## 10. Arsitektur yang direkomendasikan

**Pilihan akun (MVP): Opsi A** — satu **OWNED sub-account "JK-ESCROW"** (atau master) menampung semua dana pembeli; traveler **bukan** sub-account Xendit (KYC traveler oleh JastipKita, level 4); payout langsung ke rekening traveler tervalidasi. Alasan: onboarding traveler ringan, tanpa biaya per sub-account aktif, satu saldo untuk refund. Pertimbangkan **Opsi C** (OWNED sub-account per traveler) saat skala naik untuk segregasi dana; **Opsi B** (MANAGED per traveler) tidak realistis untuk traveler kasual.

| Fungsi | Endpoint Xendit | Endpoint JastipKita | Catatan |
|---|---|---|---|
| Buat checkout | `POST /sessions` (`session_type: PAY`, `mode: PAYMENT_LINK`, `reference_id = JK-YYMMDD-XXXXXX[-n]`, `amount = TOTAL`, `currency: IDR`, `country: ID`, `allowed_payment_channels` difilter nominal, `expires_at = min(quote TTL, FX-lock TTL)`, `metadata {transactionId, quoteId}`), header `for-user-id: <escrow>` | `POST /v1/transactions/{id}/checkout` (Idempotency-Key) | Simpan `payment_session_id` |
| Terima webhook | — | `POST /v1/webhooks/xendit` | Cek `x-callback-token` (constant-time) → dedup `webhook-id` → `GET /sessions/{id}` (atau `GET /v3/payment_requests/{id}`) → cocokkan amount/currency/reference → `transitionTransaction(PAYMENT_SECURED)` + ledger, satu DB transaction |
| Hold | (tidak ada panggilan) | ledger internal | Dana tetap di saldo escrow; laporan saldo harian |
| Release ke traveler | `POST /v2/payouts` (`for-user-id: <escrow>`, `Idempotency-key: PO-…`) — atau `POST /transfers` escrow → sub-account traveler (Opsi C) | job `payout.release` setelah `BUYER_CONFIRMED` | Potong platform fee di sini (bukan split rule) |
| Refund | `POST /refunds` (`payment_request_id`, `amount` untuk parsial, `reason`) bila channel & jendela mendukung; selain itu `POST /v2/payouts` ke rekening pembeli | `POST /v1/admin/refunds` (RBAC `finance.refund.write`) | Nomor `RFD-…` sebagai `reference_id` |
| Payout | `POST /v2/payouts`, `GET /v2/payouts/{id}`, webhook payout | worker `payouts` | Validasi nama rekening sebelum payout pertama |
| Rekonsiliasi | `GET /transactions`, `POST /reports` + webhook report, `GET /balance` | job `recon.daily` | Cocokkan fee & PPN atas fee ke `PAYMENT_FEE`/`TAX_PAYABLE` |

**Variabel lingkungan (nama saja):**
```
PAYMENT_PROVIDER            # mock | xendit
XENDIT_ENV                  # test | live (UI admin menampilkan badge SANDBOX bila test)
XENDIT_API_BASE_URL         # https://api.xendit.co
XENDIT_SECRET_KEY           # money-in (sessions, payment requests, refunds)
XENDIT_PAYOUT_SECRET_KEY    # kunci terpisah dengan permission MONEY-OUT
XENDIT_REPORT_SECRET_KEY    # kunci read-only untuk transactions/reports/balance
XENDIT_WEBHOOK_TOKEN        # nilai x-callback-token dari Dashboard
XENDIT_WEBHOOK_IP_ALLOWLIST # opsional, dari CS Xendit
XENDIT_ESCROW_ACCOUNT_ID    # for-user-id OWNED sub-account escrow (kosong = master)
XENDIT_PAYMENT_REQUESTS_API_VERSION  # 2024-11-11
XENDIT_SESSION_TTL_SECONDS
XENDIT_SUCCESS_RETURN_URL
XENDIT_CANCEL_RETURN_URL
ILUMA_API_KEY               # validasi nama rekening (NEEDS_VERIFICATION)
```

## Daftar `NEEDS_VERIFICATION`
Nama header idempotensi untuk Sessions/Payment Requests v3; format path simulasi VA legacy; simulasi payout test mode; timeout webhook; nama event webhook payout v2; dukungan & jendela refund QRIS (konflik 30 vs 7 hari, partial ✗ vs ✓); biaya payout (1% + Rp4.000?) dan biaya xenPlatform; endpoint & biaya Iluma name validator; kelayakan hold dana panjang & jenis bisnis jastip di Xendit; amandemen PBI 23/6/PBI/2021.

## Sumber (diverifikasi 2026-09-27)
https://docs.xendit.co/llms.txt · https://docs.xendit.co/docs/migrate-to-payment-session.md · https://docs.xendit.co/docs/how-payment-sessions-work.md · https://docs.xendit.co/apidocs/create-session.md · https://docs.xendit.co/apidocs/webhook-notification-sent-defined-webhook-url-updates-payment-session.md · https://docs.xendit.co/apidocs/create-payment-request.md · https://docs.xendit.co/apidocs/simulate-payment-test-mode.md · https://docs.xendit.co/docs/payments-api-webhooks.md · https://docs.xendit.co/docs/handling-webhooks.md · https://docs.xendit.co/apidocs/webhook-behavior.md · https://docs.xendit.co/docs/integration-security · https://help.xendit.co/hc/en-us/articles/360038072991-How-to-validate-if-the-webhook-is-sent-from-Xendit · https://archive.developers.xendit.co/ · https://docs.xendit.co/apidocs/refund-payment-request.md · https://docs.xendit.co/docs/refund-payment-request.md · https://docs.xendit.co/docs/available-payment-channels.md · https://docs.xendit.co/docs/qris.md · https://docs.xendit.co/docs/bca-virtual-account.md · https://docs.xendit.co/docs/xenplatform-overview.md · https://docs.xendit.co/docs/sub-accounts.md · https://docs.xendit.co/docs/accepting-payments-for-sub-accounts.md · https://help.xendit.co/hc/en-us/articles/4408655256589-How-Do-I-Create-A-Sub-Account-on-XenPlatform · https://docs.xendit.co/docs/split-payments.md · https://docs.xendit.co/docs/transfer-balances.md · https://docs.xendit.co/docs/xenplatform-fees.md · https://docs.xendit.co/apidocs/create-payout.md · https://docs.xendit.co/apidocs/create-payout-v3.md · https://docs.xendit.co/docs/integration-payouts · https://docs.xendit.co/docs/payout-coverage-indonesia.md · https://help.xendit.co/hc/en-us/articles/14143546600857-Does-the-Bank-Account-Validation-Service-Compatible-to-be-Used-for-Disbursement-via-API · https://help.xendit.co/hc/en-us/articles/360038118371-How-can-I-simulate-the-fixed-Virtual-Account-payment-in-test-mode · https://docs.xendit.co/apidocs/list-transactions.md · https://docs.xendit.co/apidocs/generate-report.md · https://www.xendit.co/en-id/pricing/ · https://www.xendit.co/en/company/xendit-licenses/ · https://www.bi.go.id/id/publikasi/peraturan/Pages/PBI_230621.aspx · https://ortax.org/apa-saja-kriteria-marketplace-menjadi-pemungut-pph-pasal-22 · https://www.pajak.go.id/en/node/120146
