---
title: Ketentuan Pembayaran (SafePay)
description: Cara kerja SafePay, peran mitra payment gateway berizin, biaya, penguncian kurs, penggantian bea & pajak, chargeback, dan payout Traveler.
version: "0.1-draft"
effectiveDate: "[TANGGAL BERLAKU — diisi saat peluncuran]"
order: 6
---

> **TEMPLATE — wajib direview konsultan hukum sebelum production launch; bukan nasihat hukum.**
>
> Mengacu pada `docs/04-payments-ledger.md`, `docs/research/02-xendit-integration.md`, dan konfigurasi `pricing.*` / `fx.lock` / `money.policy`. **Status integrasi pembayaran: SANDBOX** — belum ada transaksi uang sungguhan. Biaya metode pembayaran adalah **asumsi** sampai kontrak mitra ditandatangani. Kelayakan pola "dana ditahan sampai barang diterima" wajib dikonfirmasi tertulis oleh mitra pembayaran dan ditinjau konsultan hukum (PBI 23/6/PBI/2021) sebelum peluncuran.

**Versi:** 0.1 (draf) · **Berlaku sejak:** [TANGGAL BERLAKU] · **Penyelenggara:** [NAMA BADAN USAHA — PT/CV, menunggu pendirian]

## 1. Apa itu SafePay

1. **SafePay** adalah nama alur pembayaran di JastipKita: pembayaran Penitip **diproses dan ditahan oleh mitra payment gateway yang berizin Bank Indonesia** — [NAMA MITRA PAYMENT GATEWAY & NOMOR IZIN] — dan baru dilepaskan kepada Traveler setelah syarat pelepasan terpenuhi.
2. **JastipKita bukan bank, bukan penyedia jasa pembayaran, dan bukan penerbit uang elektronik/dompet digital.** Dana tidak melewati rekening bank JastipKita maupun rekening pribadi siapa pun. JastipKita mencatat hak masing-masing pihak atas dana tersebut dalam buku besar per transaksi (double-entry, append-only).
3. JastipKita Credit adalah potongan harga tertutup (closed-loop) yang tidak dapat diisi ulang, dicairkan, atau dipindahkan.

## 2. Alur dana

1. **Pembayaran** — Penitip membayar Total Landed Cost melalui metode yang tersedia. Status menjadi **PAYMENT SECURED** setelah pemberitahuan pembayaran diverifikasi (tanda tangan, nominal, dan mata uang cocok).
2. **Penahanan** — dana dicatat terpisah per komponen: dana barang, cadangan bea & pajak, dan biaya layanan.
3. **Pembelian** — Traveler hanya boleh membeli setelah **PURCHASE APPROVED**.
4. **Pelepasan** — setelah Penitip mengonfirmasi penerimaan (atau otomatis 48 jam setelah DELIVERED tanpa dispute), sistem menjadwalkan payout kepada Traveler (penggantian harga barang + fee + penggantian bea & pajak yang dibayar) dan membukukan pendapatan JastipKita.
5. **Refund** — bila transaksi dibatalkan atau dispute diputuskan, dana dikembalikan sesuai [Kebijakan Refund](refund-policy.md).

## 3. Biaya

Semua biaya tampil pada Rincian Biaya sebelum membayar.

| Biaya | Besaran saat ini | Catatan |
|---|---|---|
| Traveler Fee | ditentukan Traveler; min. Rp25.000, maks. 30% harga barang | hak Traveler |
| JastipKita Protection | 1,5% harga barang (min. Rp5.000, maks. Rp300.000) | [LEGAL REVIEW: cakupan perlindungan & apakah produk asuransi terlibat] |
| Platform Fee | 5% harga barang (min. Rp10.000, maks. Rp750.000) | pendapatan JastipKita |
| PPN atas layanan | 12% × DPP 11/12 atas Protection + Platform Fee | hanya bila JastipKita telah menjadi PKP [TAX REVIEW] |
| Biaya pembayaran | Virtual Account Rp4.500; QRIS 0,7%; e-wallet 1,5%; kartu 2,9% + Rp2.000 | **asumsi** sampai kontrak mitra; dapat dibulatkan agar menutup biaya gateway |
| Bea masuk & pajak impor | estimasi sesuai PMK 34/2025 | dibayarkan Traveler kepada negara |
| Nilai barang minimum | Rp100.000 per titipan | — |

Diskon promo tidak pernah mengurangi pajak atau bea.

## 4. Kurs

1. Harga dalam mata uang asing dikonversi dengan kurs acuan penyedia data kurs ditambah markup kurs yang diungkapkan (umumnya 1,5%; KRW 2%).
2. Kurs **dikunci 30 menit** saat checkout. Bila waktu habis sebelum pembayaran, kurs diperbarui dan Rincian Biaya dihitung ulang.
3. Estimasi bea & pajak memakai kurs acuan; Bea Cukai memakai kurs pajak (KMK) pada minggu kedatangan, sehingga tagihan resmi dapat berbeda.

## 5. Bea & pajak impor

1. Estimasi bea masuk dan pajak impor disimpan sebagai **cadangan bea & pajak** dan digunakan untuk mengganti pembayaran resmi Traveler kepada Bea Cukai berdasarkan bukti pembayaran yang diunggah.
2. JastipKita **bukan pemungut** bea masuk atau pajak impor. Penyelesaian selisih antara estimasi dan tagihan resmi: **[LEGAL/FINANCE REVIEW]**.

## 6. Perubahan harga dan pembayaran tambahan

Bila Penitip menyetujui kenaikan harga yang melebihi dana yang diamankan, Penitip membayar tambahan melalui SafePay sebelum pembelian disetujui. Selisih kecil dalam toleransi dapat ditanggung JastipKita dan dicatat sebagai promosi.

## 7. Chargeback dan pembayaran yang bermasalah

1. Bila Penitip mengajukan sanggahan/chargeback kepada penerbit kartu atas transaksi yang sedang berjalan atau sudah selesai, JastipKita dapat menahan payout terkait, menyampaikan bukti transaksi kepada mitra pembayaran, dan menangguhkan akun sampai sanggahan selesai.
2. Kami menganjurkan Penitip memakai **Dispute Center** terlebih dahulu — lebih cepat dan tidak dikenai biaya chargeback.
3. Chargeback yang terbukti tidak beritikad baik dapat dibebankan biaya yang dikenakan mitra pembayaran kepada kami (saat ini sekitar USD 25 per kasus **[asumsi, sesuai daftar harga mitra]**).
4. Dana yang masuk setelah invoice kedaluwarsa atau setelah transaksi dibatalkan dikembalikan otomatis.

## 8. Payout Traveler

1. Payout dikirim ke rekening/e-wallet atas nama Traveler yang tervalidasi; nomor rekening hanya ditampilkan tersamar.
2. Payout dapat ditahan bila ada dispute terbuka, indikasi risiko, atau permintaan otoritas; alasan penahanan dicatat.
3. Biaya transfer payout saat ini ditanggung JastipKita; nilai payout minimum Rp10.000.
4. Payout yang gagal dicoba ulang otomatis hingga 3 kali sebelum ditangani tim.

## 9. Keamanan pembayaran

Jangan pernah membayar di luar SafePay atau mentransfer ke rekening pribadi Traveler. Transaksi di luar Platform tidak dilindungi dan tidak dapat diajukan dispute.

## 10. Kontak

[E-MAIL CS] · [NOMOR WHATSAPP CS]
