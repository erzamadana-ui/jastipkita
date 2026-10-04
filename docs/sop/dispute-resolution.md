# SOP Penyelesaian Sengketa (Dispute)

> **TEMPLATE UNTUK REVIEW PROFESIONAL — bukan nasihat hukum.** Mengikuti FSM sengketa `docs/00-domain-model.md` §6 &
> §15.3, akibat dana `docs/api/admin.md` §3, config `dispute.sla`, dan kode per 2026-10-04
> (`apps/api/src/modules/disputes/*`, `apps/api/src/modules/admin/disputes/*`, `packages/core/src/dispute/index.ts`).
> Pedoman keputusan di §6 adalah **usulan** dan harus disahkan Owner + Legal bersama kebijakan refund (`docs/legal/refund-policy.md`).

| Atribut | Isi |
|---|---|
| Versi | 0.1 (draf) · 2026-10-04 |
| Pemilik proses | Ops Manager [belum ditunjuk] |
| Pelaksana | peran `OPERATIONS` (`disputes.manage`); persetujuan refund besar: `FINANCE`/`FINANCE_SUPER_ADMIN` (`refunds.approve`); fraud: `RISK` |
| Terkait | `docs/runbooks/dispute-sla-breach.md` · [`customer-service.md`](customer-service.md) · [`refund-payout-operations.md`](refund-payout-operations.md) |

## 1. Dasar

- UU 8/1999 Pasal 7 huruf f–g: pelaku usaha memberi kompensasi/ganti rugi bila barang/jasa tidak sesuai perjanjian;
  Pasal 45: konsumen dapat menempuh lembaga penyelesaian sengketa atau pengadilan — keputusan internal JastipKita **tidak**
  menghapus hak itu (teks diverifikasi, §Sumber).
- Permendag 19/2026 Pasal 11 (ringkasan, teks belum dikutip verbatim): penyelesaian sengketa mengutamakan musyawarah;
  bila gagal, menurut mekanisme peraturan. Pasal 10 ayat (1) mewajibkan mekanisme penyelesaian sengketa bagi Pedagang
  pada model lokapasar (teks diverifikasi).
- Domain: dana tetap ditahan SafePay selama sengketa; payout traveler ditahan (`PAYOUT_CLEAR`: tidak ada dispute terbuka).

## 2. Waktu & SLA — config `dispute.sla` (ASUMSI operasional)

| Parameter | Default | Efek di kode |
|---|---|---|
| `openWindowHoursAfterDelivery` | 72 jam | dispute dapat dibuka dari status `PURCHASED` s.d. `DELIVERED`; sebelum `DELIVERED` tanpa batas waktu; setelah `DELIVERED` hanya ≤ 72 jam (`canOpenDispute`) |
| `evidenceHours` | 72 jam | `evidence_due_at = dibuka + 72 jam`; job memindahkan ke `UNDER_REVIEW` setelah lewat |
| `reviewHours` | 120 jam | `sla_due_at = evidence_due_at + 120 jam` (keputusan ≤ 8 hari sejak dibuka); breach → `dispute.sla_breached` |
| `appealWindowHours` | 72 jam | banding sekali ≤ 72 jam setelah `RESOLVED`; setelah itu job menutup (`CLOSED`) |

Job `engagement.dispute_sla` berjalan tiap 5 menit (`apps/api/src/jobs/engagement.ts`).

> **TEMUAN — jendela efektif hanya 48 jam.** `delivery.autoConfirmHours = 48` lebih pendek dari
> `openWindowHoursAfterDelivery = 72`. Job `money.auto_confirm` mengubah `DELIVERED → BUYER_CONFIRMED → COMPLETED` setelah
> 48 jam bila tidak ada dispute, dan `BUYER_CONFIRMED` bukan status yang dapat disengketakan. Konfirmasi manual oleh
> pembeli juga menutup jendela seketika. Jadi FAQ "paling lambat 72 jam" (`db/scripts/gen-reference-seed.mjs`) tidak
> pernah tercapai. Validasi config tidak memeriksa hubungan kedua nilai (`packages/core/src/config/index.ts`).
> **Keputusan Owner diperlukan** (usulan, bukan keputusan): samakan — `autoConfirmHours ≥ openWindowHoursAfterDelivery`
> atau sebaliknya — lewat versi config maker-checker, lalu perbarui FAQ & S&K. Sampai diputuskan, agen wajib
> memberi tahu pembeli batas **48 jam** (makro M-06 di SOP CS).

## 3. Status & siapa melakukan apa (FSM §15.3)

| Dari → Ke | Pemicu | Endpoint / job |
|---|---|---|
| — → `OPEN` → `EVIDENCE_COLLECTION` | pembeli/traveler membuka; jendela bukti langsung dimulai; transaksi → `DISPUTED` | `POST /v1/transactions/{id}/disputes` `{type, description, requestedResolution?}` |
| `EVIDENCE_COLLECTION` → `UNDER_REVIEW` | jendela bukti habis (SYSTEM) atau agen menutup lebih awal | job; `POST /v1/admin/disputes/{id}/review` (`closeEvidenceWindow:true` bila jendela masih terbuka, kalau tidak 422 `EVIDENCE_WINDOW_OPEN`) |
| `UNDER_REVIEW` → `EVIDENCE_COLLECTION` | butuh bukti tambahan | `POST …/request-evidence` `{note ≥ 5, dueHours 1–240, default 48}` |
| `UNDER_REVIEW` → `RESOLVED` | keputusan + nominal tercatat; eksekusi dana bila transaksi masih `DISPUTED` | `POST …/resolve` (**MFA ≤ 15 menit + Idempotency-Key**) |
| `RESOLVED` → `APPEALED` → `UNDER_REVIEW` | banding sekali dalam 72 jam; SLA review dimulai ulang | `POST /v1/disputes/{id}/appeal`; agen `review` |
| `RESOLVED` → `CLOSED` | jendela banding habis (SYSTEM) atau agen | job; `POST …/close` |
| `OPEN`/`EVIDENCE_COLLECTION` → `CLOSED` | ditarik pembuka | `POST /v1/disputes/{id}/withdraw` |

Tipe: `ITEM_NOT_RECEIVED, WRONG_ITEM, DAMAGED_ITEM, COUNTERFEIT, PRICE_DISPUTE, DELIVERY_DISPUTE, OTHER`.
Jenis bukti: `PHOTO, VIDEO, RECEIPT, CHAT, TRACKING, DELIVERY_PROOF, OTHER` (file harus milik pengunggah & bagian dari transaksi).

## 4. Prosedur langkah demi langkah

| # | Langkah | Rincian | Batas |
|---|---|---|---|
| 1 | Pantau antrean | `GET /v1/admin/disputes?sla=BREACHED` lalu `DUE_SOON`, lalu `assignee=none` | tiap awal shift |
| 2 | Ambil kasus | `POST …/assign` (default diri sendiri; penerima wajib punya `disputes.manage`). **Konflik kepentingan:** jangan menangani kasus yang melibatkan akun Anda/kenalan (tidak diblokir kode — wajib prosedural) | ≤ 4 jam kerja sejak dibuka (ASUMSI) |
| 3 | Kirim M-D1 ke kedua pihak | jelaskan jenis bukti & tenggat `evidence_due_at` (notifikasi sistem sudah terkirim; pesan agen memperjelas) | segera |
| 4 | Kumpulkan bukti | detail `GET …/{id}`: bukti, timeline, escrow ditahan, `transaction.refundableIdr`, status sebelum sengketa, `allowedActions`; baca chat transaksi dengan dasar dispute + alasan (diaudit) | sampai `evidence_due_at` |
| 5 | Minta bukti tambahan (opsional) | `request-evidence` dengan catatan spesifik & `dueHours`; hindari berulang (memperpanjang dana tertahan) | maks. 2× (ASUMSI) |
| 6 | Mulai review | `review` (atau otomatis oleh job) | — |
| 7 | Cek risiko | bila ada indikasi penipuan/barang palsu/akun ganda → buka/teruskan ke RISK; transaksi > Rp10 juta (ASUMSI) wajib tinjauan RISK (runbook §3) | sebelum memutus |
| 8 | Putuskan | pedoman §6; tulis `note` yang dapat dipahami pihak luar (alasan + bukti yang dipakai) | ≤ `sla_due_at` |
| 9 | Eksekusi | `resolve` (§5). Refund di atas `money.policy.refundAutoApproveMaxIdr` (Rp10 juta, ASUMSI) masuk `PENDING_APPROVAL` → FINANCE (approver ≠ peminta) | FINANCE ≤ 1 hari kerja (ASUMSI) |
| 10 | Komunikasikan | M-D3…M-D5 ke kedua pihak, sebut hak banding & tenggat | ≤ 2 jam setelah resolve |
| 11 | Tutup | otomatis setelah jendela banding; payout traveler baru bisa berjalan setelah `CLOSED` (processor memperlakukan `RESOLVED` sebagai masih terbuka) | 72 jam |
| 12 | Pasca-kasus | catat akar masalah; trust score diperbarui oleh job trust; pola traveler bermasalah → RISK | ≤ 1 hari kerja |

## 5. Resolusi & akibat dana (`docs/api/admin.md` §3, `modules/admin/disputes/service.ts`)

| Resolusi | Syarat input | Eksekusi bila transaksi masih `DISPUTED` | Akhir transaksi |
|---|---|---|---|
| `REFUND_FULL` | — | refund **semua dana yang masih ditahan** = min(escrow PRODUCT_FUND + CUSTOMS_RESERVE + CLEARING, sisa pembayaran yang dapat direfund); `NOTHING_TO_REFUND` bila 0 | `REFUND_PENDING` → `REFUNDED` |
| `RETURN_AND_REFUND` | — | sama dengan REFUND_FULL (pengembalian barang fisik **tidak dilacak sistem** — atur & catat di `note`) | `REFUNDED` |
| `REFUND_PARTIAL` | `amountIdr` > 0 **dan < dana ditahan** (kalau tidak 422 `PARTIAL_AMOUNT_TOO_LARGE`) | refund `amountIdr`; sisa dirilis ke traveler | `REFUND_PENDING` → `COMPLETED` + payout |
| `NO_REFUND`, `OTHER` | bila dispute dibuka **sebelum** `DELIVERED`: wajib `releaseBeforeDelivery:true` (kalau tidak 422 `PRE_DELIVERY_RELEASE_CONFIRMATION_REQUIRED`) | `DISPUTED → BUYER_CONFIRMED` → dana dirilis + payout | `COMPLETED` |

- Kunci idempotensi refund `dispute:{id}:v{versi}` — mengulang `resolve` tidak membuat refund ganda.
- Metode refund dipilih dari kanal pembayaran: e-wallet/QRIS/kartu → refund ke kanal; **VA/gerai ritel → transfer ke
  rekening pembeli** yang harus diisi pembeli (step-up OTP) dan, bila nama berbeda dengan KYC, direview FINANCE.
- Event `dispute.resolved` membawa `appealDeadline` dan status eksekusi (`REFUND_REQUESTED`, `BUYER_CONFIRMED`,
  `ALREADY_EXECUTED`, `MANUAL_FOLLOW_UP`).

## 6. Pedoman keputusan (usulan — wajib disahkan)

| Tipe | Bukti kunci | Arah umum |
|---|---|---|
| `ITEM_NOT_RECEIVED` | status & bukti serah terima (PIN/QR = bukti kuat), resi + tracking, chat | tanpa bukti serah terima yang sah → `REFUND_FULL`; ada konfirmasi PIN/QR → `NO_REFUND` kecuali ada bukti kuat lain |
| `WRONG_ITEM` | bukti pembelian traveler (struk, foto, merchant), foto barang diterima, deskripsi request | tidak sesuai request → `RETURN_AND_REFUND` / `REFUND_FULL`; perbedaan kecil yang disetujui di chat → `NO_REFUND`/parsial |
| `DAMAGED_ITEM` | foto/video unboxing segera setelah terima, kemasan, foto saat beli | kerusakan dalam penguasaan traveler → parsial/penuh sesuai tingkat; klaim proteksi saat mitra tersedia (MOCK) |
| `COUNTERFEIT` | struk merchant resmi, serial/video bila kategori mewajibkan, penilaian pihak ketiga | wajib RISK; bukti pembelian lemah → `REFUND_FULL` + tinjau akun traveler |
| `PRICE_DISPUTE` | rincian harga & versi aturan pada quote, riwayat konfirmasi harga | biaya di luar breakdown tidak sah (domain §10) → refund selisih (parsial) |
| `DELIVERY_DISPUTE` | metode, jadwal, chat, bukti kurir | sesuai kesalahan pihak; keterlambatan wajar tanpa kerugian → `NO_REFUND` |
| Bea masuk final ≠ estimasi | bukti bayar DJBC di `customs_declarations` | selisih diproses sesuai S&K — **bukan** kesalahan traveler bila dibayar sah |

Prinsip: keputusan berdasarkan bukti dalam sistem; keraguan wajar yang disebabkan pihak yang menguasai barang
(traveler) menjadi beban pihak itu; tidak ada penalti bagi pembeli yang menolak kenaikan harga (domain §5).

## 7. Maker-checker, MFA & kontrol

| Kontrol | Ditegakkan kode | Prosedural (wajib walau tidak diblokir) |
|---|---|---|
| Sesi admin ber-MFA ≤ 12 jam; `resolve` butuh step-up ≤ 15 menit + Idempotency-Key | ya | — |
| Refund > Rp10 juta (ASUMSI) → `PENDING_APPROVAL`, approver ≠ peminta | ya (API + DB) | — |
| Rilis payout yang ditahan manual: pelepas ≠ penahan | ya (DB CHECK) | — |
| `NO_REFUND`/`OTHER` yang merilis dana **sebelum** barang diterima | konfirmasi eksplisit saja | **4-mata:** agen kedua (OPERATIONS/Ops Manager) menyetujui di catatan internal sebelum `resolve` |
| `NO_REFUND` bernilai > Rp10 juta (ASUMSI) | tidak | 4-mata seperti di atas |
| Konflik kepentingan agen | tidak | §4 langkah 2 |
| Jejak | `audit_logs` hash-chain (`disputes.resolved`, `disputes.review_started`, `chat.conversation_viewed`) | — |

## 8. Banding

1. Pihak yang tidak puas mengajukan banding **sekali** ≤ 72 jam (`APPEAL_WINDOW_CLOSED`, `APPEAL_ALREADY_USED`).
2. Banding ditinjau **agen berbeda** dari pemutus awal (prosedural, ASUMSI); SLA review dimulai ulang (`reviewHours`).
3. Re-resolusi saat transaksi sudah tidak `DISPUTED`: arah sama → `ALREADY_EXECUTED`; arah berbeda → `MANUAL_FOLLOW_UP`
   → buat tiket keuangan: refund admin (`POST /v1/admin/transactions/{id}/refund`, maker-checker bila di atas ambang) atau
   koreksi lewat alur resmi. **Uang yang sudah keluar tidak dibalik diam-diam.** Bila payout traveler sudah dibayar,
   pemulihan dana dari traveler adalah proses penagihan di luar sistem (Legal).

## 9. Kasus khusus

- **Ditarik pembuka:** barang sudah `DELIVERED` + pembeli menarik → `BUYER_CONFIRMED` otomatis; kasus lain → transaksi
  tetap `DISPUTED` dengan `transactionFollowUp: ADMIN_REQUIRED` → agen menuntaskan lewat endpoint transaksi admin
  (batal/refund atau konfirmasi). Tidak ada transisi `DISPUTED → status sebelumnya`.
- **Tutup tanpa resolusi:** `close` pada `OPEN/EVIDENCE_COLLECTION` hanya bila barang sudah `DELIVERED`; selain itu 422
  `RESOLUTION_REQUIRED`.
- **SLA breach:** ikuti `docs/runbooks/dispute-sla-breach.md` (ambil alih, hubungi pihak, putuskan ≤ 24 jam).
- **Gangguan layanan** saat jendela bukti/banding berjalan: timer tetap berjalan → lihat
  [`incident-communication.md`](incident-communication.md) §6.3 (keputusan perpanjangan per kasus dengan `request-evidence`).

## 10. Templat komunikasi agen

**M-D1 — Dispute diterima (ke kedua pihak)**
> Dispute **{DSP-…}** untuk transaksi {JK-…} sedang kami tangani. Dana tetap ditahan SafePay selama proses berlangsung.
> Silakan unggah bukti (foto, video, struk, resi, atau rujuk chat di aplikasi) paling lambat **{evidence_due_at WIB}**.
> Kami menargetkan keputusan paling lambat **{sla_due_at WIB}**.

**M-D2 — Permintaan bukti tambahan**
> Untuk memutus dispute {DSP-…} dengan adil, kami memerlukan: {daftar spesifik}. Mohon unggah paling lambat {tenggat}.
> Bila tidak ada tambahan, kami akan memutus berdasarkan bukti yang tersedia.

**M-D3 — Keputusan refund (penuh/parsial)**
> Keputusan dispute {DSP-…}: **{Refund penuh / Refund sebagian Rp…}**. Alasan: {ringkas}. {Refund ke metode pembayaran
> asal / Mohon isi rekening tujuan di halaman refund}. {Parsial: Sisa dana diteruskan ke traveler.} Kamu dapat mengajukan
> banding satu kali paling lambat **{appealDeadline WIB}**.

**M-D4 — Keputusan tanpa refund**
> Keputusan dispute {DSP-…}: **tanpa refund**. Alasan: {ringkas, bukti yang dipakai}. Dana akan diteruskan ke traveler
> setelah masa banding berakhir pada **{appealDeadline WIB}**. Banding dapat diajukan satu kali sebelum batas itu.

**M-D5 — Hak lanjutan (sertakan pada setiap keputusan)**
> Bila tidak setuju dengan hasil akhir, kamu tetap berhak menyampaikan pengaduan kepada Ditjen Perlindungan Konsumen dan
> Tertib Niaga, Kementerian Perdagangan (WhatsApp 0853-1111-1010, pengaduan.konsumen@kemendag.go.id) atau BPSK, atau
> menempuh jalur pengadilan.

**M-D6 — Banding diterima / hasil banding**
> Banding untuk {DSP-…} kami terima dan akan ditinjau oleh petugas berbeda paling lambat {sla_due_at}. / Hasil banding:
> {tetap / berubah menjadi …}. Keputusan banding bersifat final di JastipKita.

**M-D7 — Dispute ditutup**
> Dispute {DSP-…} telah ditutup. {Ringkasan eksekusi: refund {RFD-…} berstatus … / dana diteruskan ke traveler}.

## 11. KPI

| KPI | Sumber | Target awal (ASUMSI, runbook §5) |
|---|---|---|
| Jumlah sengketa per 100 transaksi selesai | `disputes` vs `transactions` | dipantau (pemicu level 5 traveler: < 3 %) |
| % breach SLA | `disputes.sla_breached_at` | < 5 % |
| Median waktu ke keputusan | `resolved_at − created_at` | < 72 jam |
| % keputusan dibanding; % banding yang mengubah hasil | `appealed_at`, resolusi | dipantau |
| Nilai refund dari sengketa (Rp) | refunds `reason_code = DISPUTE_RESOLUTION` | dipantau |
| Kasus `MANUAL_FOLLOW_UP` terbuka | audit `disputes.resolved` meta | 0 > 5 hari kerja |

## Sumber (diverifikasi 2026-10-04)

| Rujukan | Sumber |
|---|---|
| UU 8/1999 Pasal 7, 45 | https://pasal.id/peraturan/uu/uu-no-8-tahun-1999/pasal-7 · https://pasal.id/peraturan/uu/uu-no-8-tahun-1999/pasal-45 |
| Permendag 19/2026 Pasal 10 (teks), Pasal 11 (ringkasan) | https://pasal.id/peraturan/permen/permendag-no-19-tahun-2026 |
| Kontak Ditjen PKTN | https://www.kemendag.go.id/berita/siaran-pers/komitmen-lindungi-konsumen-kemendag-terima-1911-layanan-konsumen-sepanjang-semester-i-2026 (15-07-2026); `docs/api/engagement.md` §8.1 |

---

**Catatan keterbatasan data:** durasi `dispute.sla`, ambang refund Rp10 juta, batas waktu prosedural, dan target KPI
adalah ASUMSI operasional pra-peluncuran; pedoman keputusan §6 adalah usulan penyusun, bukan kebijakan yang disahkan;
temuan jendela efektif 48 jam berasal dari pembacaan kode (`delivery/service.ts`, `packages/core/src/dispute/index.ts`) dan
belum diuji end-to-end; pengembalian barang fisik dan penagihan balik ke traveler tidak didukung sistem; Pasal 11
Permendag 19/2026 hanya tersedia dalam ringkasan.
