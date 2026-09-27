# JastipKita — Domain Model (single source of truth)

Dokumen ini mengikat skema DB (`db/migrations`), engine (`packages/core`), API (`apps/api`), dan klien. Jika ada konflik, **dokumen ini menang** — perbarui dokumen dulu sebelum mengubah kode.

## 1. Aktor
- **Penitip (Buyer)** — membuat request titipan, membayar via SafePay, menerima barang.
- **Traveler (Mitra)** — membuat trip, menerima request, membeli barang, membawa, menyerahkan.
- Satu akun bisa berpindah mode `BUYER` ↔ `TRAVELER` (`users.active_mode`). Mode traveler butuh KYC level ≥ 3 untuk menerima transaksi, level 4 untuk publish trip terverifikasi.
- **Admin** — RBAC: `SUPER_ADMIN`, `OPERATIONS`, `FINANCE`, `FINANCE_SUPER_ADMIN`, `RISK`, `SUPPORT`, `MARKETING`, `COMPLIANCE`.
- **System** — job/worker/webhook.

## 2. Level akun (KYC)
| Level | Kode | Syarat |
|---|---|---|
| 1 | REGISTERED | akun dibuat (Google/Apple/email/phone) |
| 2 | PHONE_VERIFIED | OTP nomor HP sukses |
| 3 | IDENTITY_VERIFIED | KTP/paspor + selfie + liveness disetujui |
| 4 | TRAVELER_VERIFIED | level 3 + rekening payout terverifikasi + ≥1 trip terverifikasi dokumen perjalanan |
| 5 | TRUSTED_TRAVELER | level 4 + ≥10 transaksi COMPLETED + Trust Score ≥ 80 + dispute rate < 3% (dievaluasi otomatis, dapat dicabut) |

Registrasi terpisah dari KYC: user level 1 bisa browsing & membuat draft request, tapi checkout butuh level 2.

## 3. Status Trip
`DRAFT → VERIFICATION_PENDING → VERIFIED → ACTIVE → FULL → TRAVELING → COMPLETED`, plus `CANCELLED` (dari status mana pun sebelum COMPLETED, dengan aturan).
- `ACTIVE` ↔ `FULL` bolak-balik berdasarkan sisa kapasitas.
- Trip tanpa dokumen perjalanan boleh `ACTIVE` hanya jika config `trips.allow_unverified_active=true` (default **false**).

## 4. Status Transaksi (state machine — satu-satunya cara mengubah status)
Status: `REQUEST_CREATED, MATCHED, AWAITING_PAYMENT, PAYMENT_SECURED, PRICE_CHANGE_PENDING, PURCHASE_APPROVED, PURCHASED, TRAVELING, ARRIVED, CUSTOMS_PROCESS, READY_FOR_HANDOVER, OUT_FOR_DELIVERY, DELIVERED, BUYER_CONFIRMED, COMPLETED, CANCELLED, DISPUTED, REFUND_PENDING, REFUNDED`.
Terminal: `COMPLETED, CANCELLED, REFUNDED`.

| Dari | Ke | Aktor | Guard |
|---|---|---|---|
| REQUEST_CREATED | MATCHED | BUYER, TRAVELER | offer diterima kedua pihak; trip ACTIVE; kapasitas cukup; limit lolos; item tidak PROHIBITED |
| REQUEST_CREATED | CANCELLED | BUYER, SYSTEM, ADMIN | — |
| MATCHED | AWAITING_PAYMENT | BUYER | quote ACTIVE + FX lock ACTIVE; KYC buyer ≥ 2; restricted-item warning sudah di-acknowledge |
| MATCHED | CANCELLED | BUYER, TRAVELER, SYSTEM, ADMIN | cancellation matrix stage `AFTER_MATCH` |
| AWAITING_PAYMENT | PAYMENT_SECURED | SYSTEM | webhook payment terverifikasi (signature + amount + currency cocok) |
| AWAITING_PAYMENT | MATCHED | SYSTEM | invoice kedaluwarsa / quote expired (perlu re-quote) |
| AWAITING_PAYMENT | CANCELLED | BUYER, SYSTEM, ADMIN | belum ada dana masuk |
| PAYMENT_SECURED | PURCHASE_APPROVED | TRAVELER, SYSTEM | traveler konfirmasi harga aktual ≤ harga ter-secure (toleransi config) |
| PAYMENT_SECURED | PRICE_CHANGE_PENDING | TRAVELER | harga aktual berbeda di luar toleransi → price confirmation dibuat |
| PAYMENT_SECURED | REFUND_PENDING | BUYER, TRAVELER, SYSTEM, ADMIN | pembatalan setelah bayar (matrix `AFTER_PAYMENT`) |
| PRICE_CHANGE_PENDING | PURCHASE_APPROVED | BUYER | approve & dana ter-secure mencukupi |
| PRICE_CHANGE_PENDING | AWAITING_PAYMENT | BUYER | approve tapi butuh pembayaran tambahan (SUPPLEMENTAL) |
| PRICE_CHANGE_PENDING | PAYMENT_SECURED | TRAVELER | traveler merevisi harga kembali dalam toleransi (setelah clarification) |
| PRICE_CHANGE_PENDING | REFUND_PENDING | BUYER, TRAVELER, SYSTEM | buyer reject (cause `PRICE_CHANGE_REJECTED`, tanpa penalti), window habis tanpa respon (default: expired = reject), atau traveler membatalkan |
| PURCHASE_APPROVED | PURCHASED | TRAVELER | purchase proof lengkap (receipt, foto, merchant, harga, waktu; serial/video jika kategori mewajibkan); harga ≤ approved |
| PURCHASE_APPROVED | REFUND_PENDING | BUYER, TRAVELER, SYSTEM, ADMIN | matrix `BEFORE_PURCHASE` |
| PURCHASED | TRAVELING | TRAVELER, SYSTEM | trip TRAVELING |
| PURCHASED | ARRIVED | TRAVELER | (jika trip sudah sampai) |
| PURCHASED | REFUND_PENDING | ADMIN | matrix `AFTER_PURCHASE` (barang tetap tanggung jawab traveler) |
| TRAVELING | ARRIVED | TRAVELER, SYSTEM | — |
| ARRIVED | CUSTOMS_PROCESS | TRAVELER | — |
| ARRIVED | READY_FOR_HANDOVER | TRAVELER | — |
| CUSTOMS_PROCESS | READY_FOR_HANDOVER | TRAVELER | bukti bea masuk (jika dibayar) diunggah |
| READY_FOR_HANDOVER | OUT_FOR_DELIVERY | TRAVELER | delivery method COURIER / PARTNER_LOGISTICS + nomor resi |
| READY_FOR_HANDOVER | DELIVERED | TRAVELER | MEETUP: PIN/QR buyer valid |
| OUT_FOR_DELIVERY | DELIVERED | TRAVELER, SYSTEM | bukti kirim / tracking delivered |
| DELIVERED | BUYER_CONFIRMED | BUYER, SYSTEM | buyer konfirmasi, atau auto-confirm setelah `delivery.auto_confirm_hours` tanpa dispute |
| BUYER_CONFIRMED | COMPLETED | SYSTEM | payout traveler dijadwalkan, ledger final |
| {PURCHASED, TRAVELING, ARRIVED, CUSTOMS_PROCESS, READY_FOR_HANDOVER, OUT_FOR_DELIVERY, DELIVERED} | DISPUTED | BUYER, TRAVELER, ADMIN | dispute dibuka dalam window |
| {TRAVELING, ARRIVED, CUSTOMS_PROCESS, READY_FOR_HANDOVER, OUT_FOR_DELIVERY} | REFUND_PENDING | ADMIN | override admin dengan approval (matrix `DURING_TRAVEL`/`AFTER_ARRIVAL`, `requiresAdminApproval`) |
| DISPUTED | REFUND_PENDING | ADMIN, SYSTEM | resolusi refund |
| DISPUTED | BUYER_CONFIRMED | ADMIN, SYSTEM | resolusi tanpa refund / partial yang sudah diselesaikan |
| REFUND_PENDING | REFUNDED | SYSTEM | refund provider sukses (full) |
| REFUND_PENDING | COMPLETED | SYSTEM | partial refund sukses dan sisa dana dibayarkan |

Setiap transisi menulis `transaction_events` (append-only) + `audit_logs` + `outbox_events` (untuk notifikasi) dalam **satu** DB transaction dengan optimistic lock (`transactions.version`).

**Aturan emas:** Traveler hanya boleh membeli jika status `PURCHASE_APPROVED` (yang mensyaratkan `PAYMENT_SECURED`). UI traveler menampilkan banner merah **DO NOT PURCHASE** untuk semua status sebelum `PURCHASE_APPROVED`.

## 5. Price Confirmation
`PENDING → APPROVED | REJECTED | CLARIFICATION_REQUESTED | EXPIRED`; `CLARIFICATION_REQUESTED → PENDING` (traveler menjawab, window di-reset). Window default 900 detik (config `price_confirmation.windowSeconds`). Tabel transisi lengkap di §15.2.
Buyer yang menolak kenaikan harga **tidak dianggap salah**: pembatalan memakai cause `PRICE_CHANGE_REJECTED` (refund penuh termasuk payment fee, tanpa penalti Trust Score).

## 6. Dispute
`OPEN → EVIDENCE_COLLECTION → UNDER_REVIEW → RESOLVED → (APPEALED → UNDER_REVIEW → RESOLVED) → CLOSED`.
Tipe: `ITEM_NOT_RECEIVED, WRONG_ITEM, DAMAGED_ITEM, COUNTERFEIT, PRICE_DISPUTE, DELIVERY_DISPUTE, OTHER`.
Resolusi: `REFUND_FULL, REFUND_PARTIAL, NO_REFUND, RETURN_AND_REFUND, OTHER`.

## 7. Klasifikasi barang terbatas
`ALLOWED, RESTRICTED, DECLARATION_REQUIRED, PERMIT_REQUIRED, PROHIBITED`. PROHIBITED memblokir checkout. Lainnya wajib acknowledgement sebelum payment.

## 8. Cancellation stage
`BEFORE_MATCH, AFTER_MATCH, AFTER_PAYMENT, BEFORE_PURCHASE, AFTER_PURCHASE, DURING_TRAVEL, AFTER_ARRIVAL`.

## 9. Bucket dana (ledger)
`PRODUCT_FUND, TRAVELER_EARNING, CUSTOMS_RESERVE, PLATFORM_REVENUE, TAX_PAYABLE, PAYMENT_FEE, REFUND, PROMOTION_CREDIT, CLEARING` (+ akun eksternal `PROVIDER_CASH` untuk sisi provider).
Ledger double-entry, immutable, per journal debit = kredit.

## 10. Baris harga (price breakdown) — urutan tampilan
1. `ITEM_PRICE` — Harga Barang (qty × unit, dikonversi IDR dengan FX lock)
2. `TRAVELER_FEE` — Traveler Fee
3. `CUSTOMS_DUTY` — Bea Masuk (estimasi)
4. `IMPORT_TAX` — Pajak Impor (PPN impor + PPh 22 impor; estimasi)
5. `PROTECTION_FEE` — JastipKita Protection
6. `PLATFORM_FEE` — Platform Fee
7. `SERVICE_TAX` — Pajak atas layanan platform (PPN atas platform & protection fee, jika berlaku)
8. `PAYMENT_FEE` — Biaya Pembayaran (per channel, jika dibebankan ke buyer)
9. `DISCOUNT` — Diskon promo (negatif)
10. `REFERRAL_CREDIT` — JastipKita Credit (negatif)
11. `TOTAL` — Total Landed Cost

Setiap baris membawa `bucket` tujuan dana, `isEstimate`, dan `ruleRef` (id rule/config versi). **Tidak ada biaya yang tidak tampil di breakdown.**

## 11. Delivery
Method: `MEETUP` (PIN 6 digit sekali pakai atau QR token, maks 5 percobaan), `COURIER`, `PARTNER_LOGISTICS`.
Konfirmasi tercatat: waktu, transaction id, method, `confirmed_via` (`PIN, QR, BUYER_APP, AUTO, ADMIN`), bukti.

## 12. Trust Score (0–100)
Komponen default (bobot configurable `trust.weights`): KYC level, transaksi selesai, nilai transaksi, umur akun, pembatalan (negatif), dispute (negatif), on-time delivery, trip terverifikasi, fraud signal (negatif), riwayat pembayaran, rating. Override admin wajib alasan + approval + audit.

## 13. Risk decision
`ALLOW, REVIEW, HOLD, BLOCK` berdasarkan skor 0–100 & threshold `risk.thresholds` (default review ≥ 40, hold ≥ 70, block ≥ 90).

## 14. Nomor & format
Transaksi `JK-YYMMDD-XXXXXX`, dispute `DSP-YYMMDD-XXXXXX`, refund `RFD-…`, tiket `TKT-…`, payout `PO-…`.

## 15. State machine sekunder (sumber kebenaran untuk `packages/core` dan seed DB)
Format tabel sama dengan §4. Guard selain aktor dicek di service layer / engine.

### 15.1 Trip
| Dari | Ke | Aktor | Guard |
|---|---|---|---|
| DRAFT | VERIFICATION_PENDING | TRAVELER | dokumen perjalanan diunggah |
| DRAFT | ACTIVE | TRAVELER, SYSTEM | `UNVERIFIED_ACTIVE`: hanya jika `trips.allowUnverifiedActive=true` |
| VERIFICATION_PENDING | VERIFIED | ADMIN, SYSTEM | dokumen disetujui |
| VERIFICATION_PENDING | DRAFT | TRAVELER, ADMIN, SYSTEM | dokumen ditolak / ditarik |
| VERIFICATION_PENDING | ACTIVE | TRAVELER, SYSTEM | `UNVERIFIED_ACTIVE` |
| VERIFIED | ACTIVE | TRAVELER, SYSTEM | `HAS_CAPACITY`; publish |
| ACTIVE | FULL | TRAVELER, SYSTEM | kapasitas habis / traveler berhenti menerima |
| FULL | ACTIVE | TRAVELER, SYSTEM | `HAS_CAPACITY` |
| ACTIVE | TRAVELING | TRAVELER, SYSTEM | berangkat |
| FULL | TRAVELING | TRAVELER, SYSTEM | berangkat |
| TRAVELING | COMPLETED | TRAVELER, SYSTEM | semua serah terima selesai |
| {DRAFT, VERIFICATION_PENDING, VERIFIED, ACTIVE, FULL, TRAVELING} | CANCELLED | TRAVELER, SYSTEM, ADMIN | transaksi terbuka ditangani cancellation matrix |

### 15.2 Price Confirmation
| Dari | Ke | Aktor | Guard |
|---|---|---|---|
| PENDING | APPROVED | BUYER | `WINDOW_OPEN` |
| PENDING | REJECTED | BUYER | `WINDOW_OPEN` |
| PENDING | CLARIFICATION_REQUESTED | BUYER | `WINDOW_OPEN` |
| PENDING | EXPIRED | SYSTEM | `WINDOW_EXPIRED` |
| CLARIFICATION_REQUESTED | PENDING | TRAVELER | traveler menjawab; window di-reset |
| CLARIFICATION_REQUESTED | REJECTED | BUYER | buyer menolak tanpa menunggu jawaban |
| CLARIFICATION_REQUESTED | EXPIRED | SYSTEM | `WINDOW_EXPIRED` |

### 15.3 Dispute
| Dari | Ke | Aktor | Guard |
|---|---|---|---|
| OPEN | EVIDENCE_COLLECTION | ADMIN, SYSTEM | kasus diterima, window bukti dimulai |
| OPEN | UNDER_REVIEW | ADMIN | bukti sudah lengkap |
| EVIDENCE_COLLECTION | UNDER_REVIEW | ADMIN, SYSTEM | `EVIDENCE_DONE` |
| UNDER_REVIEW | EVIDENCE_COLLECTION | ADMIN | butuh bukti tambahan |
| UNDER_REVIEW | RESOLVED | ADMIN | `RESOLUTION`: tipe + nominal resolusi tercatat |
| RESOLVED | APPEALED | BUYER, TRAVELER | `APPEAL`: dalam `dispute.sla.appealWindowHours`, sekali |
| APPEALED | UNDER_REVIEW | ADMIN, SYSTEM | banding ditinjau |
| RESOLVED | CLOSED | ADMIN, SYSTEM | window banding habis / resolusi dieksekusi |
| OPEN | CLOSED | BUYER, TRAVELER, ADMIN | ditarik pembuka / tidak valid |
| EVIDENCE_COLLECTION | CLOSED | BUYER, TRAVELER, ADMIN | ditarik pembuka |

### 15.4 KYC submission
| Dari | Ke | Aktor | Guard |
|---|---|---|---|
| PENDING | IN_REVIEW | SYSTEM, ADMIN | diambil untuk review |
| PENDING | EXPIRED | SYSTEM | pengajuan ditinggalkan |
| IN_REVIEW | APPROVED | ADMIN, SYSTEM | `KYC_CHECKS`: liveness lolos, dokumen cocok, tidak duplikat |
| IN_REVIEW | REJECTED | ADMIN, SYSTEM | alasan wajib |
| APPROVED | EXPIRED | SYSTEM | dokumen identitas kedaluwarsa |

### 15.5 Payment
| Dari | Ke | Aktor | Guard |
|---|---|---|---|
| PENDING | SECURED | SYSTEM | webhook terverifikasi, nominal & mata uang cocok |
| PENDING | EXPIRED | SYSTEM | invoice kedaluwarsa |
| PENDING | FAILED | SYSTEM | provider gagal |
| EXPIRED | SECURED | SYSTEM | dana terlambat tetap dicatat → otomatis refund bila transaksi sudah batal |
| FAILED | SECURED | SYSTEM | idem |
| SECURED | PARTIALLY_REFUNDED | SYSTEM | refund parsial sukses |
| SECURED | REFUNDED | SYSTEM | refund penuh sukses |
| PARTIALLY_REFUNDED | REFUNDED | SYSTEM | sisa di-refund |

### 15.6 Refund
| Dari | Ke | Aktor | Guard |
|---|---|---|---|
| REQUESTED | PENDING_APPROVAL | SYSTEM | nominal di atas batas auto-approve |
| REQUESTED | APPROVED | ADMIN, SYSTEM | `AMOUNT_OK` (≤ dana tertangkap) |
| REQUESTED | REJECTED | ADMIN | alasan wajib |
| REQUESTED | CANCELLED | ADMIN, SYSTEM | — |
| PENDING_APPROVAL | APPROVED | ADMIN | maker-checker: approver ≠ requester |
| PENDING_APPROVAL | REJECTED | ADMIN | alasan wajib |
| PENDING_APPROVAL | CANCELLED | ADMIN, SYSTEM | — |
| APPROVED | PROCESSING | SYSTEM | dikirim ke provider (refund kanal, atau disbursement bila kanal tidak mendukung refund) |
| APPROVED | CANCELLED | ADMIN | — |
| PROCESSING | SUCCEEDED | SYSTEM | provider sukses |
| PROCESSING | FAILED | SYSTEM | provider gagal |
| FAILED | PROCESSING | SYSTEM, ADMIN | `RETRY_BUDGET` (SYSTEM maks 3x; ADMIN bebas) |
| FAILED | CANCELLED | ADMIN | — |

### 15.7 Payout (traveler)
| Dari | Ke | Aktor | Guard |
|---|---|---|---|
| SCHEDULED | PROCESSING | SYSTEM, ADMIN | `PAYOUT_CLEAR`: risk ALLOW/REVIEW, tidak ada dispute terbuka, rekening terverifikasi |
| SCHEDULED | ON_HOLD | SYSTEM, ADMIN | alasan hold wajib |
| SCHEDULED | CANCELLED | ADMIN | — |
| ON_HOLD | SCHEDULED | ADMIN | `HOLD_RELEASE`: approver tercatat |
| ON_HOLD | CANCELLED | ADMIN | — |
| PROCESSING | PAID | SYSTEM | disbursement sukses |
| PROCESSING | FAILED | SYSTEM | disbursement gagal |
| FAILED | SCHEDULED | SYSTEM, ADMIN | retry setelah perbaikan |
| FAILED | ON_HOLD | SYSTEM, ADMIN | gagal berulang |
| FAILED | CANCELLED | ADMIN | — |

### 15.8 Quote & FX lock
Quote: `ACTIVE → ACCEPTED | EXPIRED | SUPERSEDED`, `ACCEPTED → SUPERSEDED` (SYSTEM). FX lock: `ACTIVE → CONSUMED | EXPIRED` (SYSTEM).

## 16. Aturan data rule (customs & restricted items)
- `effective_from` dan `effective_until` adalah **tanggal inklusif** (hari terakhir berlaku). Rule berlaku pada tanggal `d` jika `effective_from ≤ d ≤ effective_until` (atau `effective_until` NULL).
- Status rule: `DRAFT, PENDING_APPROVAL, ACTIVE, RETIRED`. Engine hanya memakai `ACTIVE`.
- `restricted_items.airline_dg` = boolean (barang berbahaya penerbangan / IATA DG).
- Hanya rule `ACTIVE` yang boleh dipakai checkout; rule `DRAFT` ditandai `NEEDS_VERIFICATION` di Admin.
