---
title: Kebijakan Pembatalan & Refund
description: Kapan titipan bisa dibatalkan, berapa dana yang kembali di setiap tahap, dan bagaimana hasil dispute diselesaikan.
version: "0.1-draft"
effectiveDate: "[TANGGAL BERLAKU — diisi saat peluncuran]"
order: 4
---

> **TEMPLATE — wajib direview konsultan hukum sebelum production launch; bukan nasihat hukum.**
>
> Matriks di bawah **mencerminkan persis** `cancellation.matrix` di `packages/core/src/config/business-config.defaults.json` (versi konfigurasi 1) dan status dispute di `docs/00-domain-model.md` §6. Bila konfigurasi diubah dari Admin, dokumen ini wajib diperbarui dengan versi baru.

**Versi:** 0.1 (draf) · **Berlaku sejak:** [TANGGAL BERLAKU] · **Penyelenggara:** [NAMA BADAN USAHA — PT/CV, menunggu pendirian]

## 1. Prinsip

1. Dana Penitip ditahan SafePay sampai transaksi selesai, sehingga pengembalian dana (refund) dihitung **per baris Rincian Biaya**.
2. Pihak yang tidak bersalah tidak menanggung biaya. Contoh: Penitip yang menolak kenaikan harga menerima refund penuh termasuk biaya pembayaran.
3. Pajak dan bea yang **belum** dibayarkan ke negara dikembalikan sesuai matriks. Bea & pajak yang **sudah** dibayar Traveler kepada Bea Cukai tidak dapat ditarik kembali dan diperhitungkan dalam penyelesaian.
4. Setelah barang dibeli, Penitip tidak dapat membatalkan sepihak; gunakan **Dispute Center**.

## 2. Matriks pembatalan

Persentase = bagian dari baris yang dikembalikan kepada Penitip. "Penalti" = pengurangan Trust Score pihak yang membatalkan.

| Tahap | Pembatal | Boleh? | Dana dikembalikan ke penitip | Kompensasi traveler | Penalti Trust Score | Catatan |
|---|---|---|---|---|---|---|
| Sebelum match | Siapa pun | Ya | Belum ada dana yang dibayar | — | — | — |
| Setelah match, belum bayar | Penitip | Ya | Belum ada dana yang dibayar | — | 1 | — |
| Setelah match, belum bayar | Traveler | Ya | Belum ada dana yang dibayar | — | 2 | — |
| Pembayaran aman (PAYMENT SECURED / konfirmasi harga) | Penitip (tolak kenaikan harga) | Ya | 100% semua baris | — | — | Penitip menolak kenaikan harga — bukan kesalahan penitip |
| Pembayaran aman (PAYMENT SECURED / konfirmasi harga) | Penitip | Ya | 100%: Barang, Fee traveler, Bea, Pajak impor, Protection, Platform fee, PPN layanan; tidak dikembalikan: Biaya pembayaran | — | 2 | — |
| Pembayaran aman (PAYMENT SECURED / konfirmasi harga) | Traveler | Ya | 100% semua baris | — | 5 | — |
| Pembayaran aman (PAYMENT SECURED / konfirmasi harga) | Sistem | Ya | 100% semua baris | — | — | Konfirmasi harga kedaluwarsa / pembatalan sistem |
| Pembayaran aman (PAYMENT SECURED / konfirmasi harga) | Admin JastipKita | Ya | 100% semua baris | — | — | Wajib persetujuan admin |
| Pembelian disetujui, barang belum dibeli | Penitip | Ya | 100%: Barang, Bea, Pajak impor, Protection; Fee traveler 90%, Platform fee 50%, PPN layanan 50%; tidak dikembalikan: Biaya pembayaran | 10% fee traveler (min. Rp10.000) | 3 | — |
| Pembelian disetujui, barang belum dibeli | Traveler | Ya | 100% semua baris | — | 8 | — |
| Pembelian disetujui, barang belum dibeli | Sistem | Ya | 100% semua baris | — | — | — |
| Pembelian disetujui, barang belum dibeli | Admin JastipKita | Ya | 100% semua baris | — | — | Wajib persetujuan admin |
| Barang sudah dibeli | Penitip | Tidak | — | — | — | Barang sudah dibeli; gunakan Dispute Center |
| Barang sudah dibeli | Traveler | Ya | 100% semua baris | — | 15 | Wajib persetujuan admin; barang tetap tanggung jawab Traveler |
| Barang sudah dibeli | Admin JastipKita | Ya | 100% semua baris | — | — | Wajib persetujuan admin |
| Dalam perjalanan | Penitip | Tidak | — | — | — | Barang dalam perjalanan; gunakan Dispute Center |
| Dalam perjalanan | Admin JastipKita | Ya | 100% semua baris | — | — | Wajib persetujuan admin |
| Sudah tiba / proses serah terima | Penitip | Tidak | — | — | — | Barang sudah tiba; gunakan Dispute Center |
| Sudah tiba / proses serah terima | Admin JastipKita | Ya | 100%: Barang, Protection, Platform fee, PPN layanan; tidak dikembalikan: Fee traveler, Bea, Pajak impor, Biaya pembayaran | 100% fee traveler | — | Wajib persetujuan admin |

Penjelasan tahap: *Setelah match, belum bayar* mencakup status MATCHED dan AWAITING_PAYMENT; *Pembayaran aman* mencakup PAYMENT_SECURED dan PRICE_CHANGE_PENDING; *Pembelian disetujui* = PURCHASE_APPROVED; *Sudah tiba* mencakup ARRIVED, CUSTOMS_PROCESS, READY_FOR_HANDOVER, OUT_FOR_DELIVERY, dan DELIVERED.

## 3. Promo dan JastipKita Credit saat refund

1. Nilai yang dikembalikan tidak melebihi uang yang benar-benar Anda bayarkan.
2. Bila sebagian biaya tidak dikembalikan, potongan promo/credit dipakai terlebih dahulu untuk menutup bagian yang ditahan; sisa JastipKita Credit dikembalikan ke saldo Credit Anda (dengan tanggal kedaluwarsa semula), dan sisa diskon promo dibatalkan.

## 4. Dispute

1. **Jenis**: barang tidak diterima, barang salah, barang rusak, barang palsu, sengketa harga, sengketa serah terima, lainnya.
2. **Tenggat**: dibuka paling lambat 72 jam setelah status DELIVERED; bukti dari kedua pihak dalam 72 jam; target keputusan 120 jam setelah bukti lengkap; banding satu kali dalam 72 jam setelah keputusan.
3. **Hasil yang mungkin**:

| Hasil | Arti |
|---|---|
| REFUND_FULL | Seluruh dana yang dibayar Penitip dikembalikan (dikurangi bea/pajak yang sudah dibayar ke negara bila barang tertahan karena kesalahan Penitip — **[LEGAL REVIEW]**). |
| REFUND_PARTIAL | Sebagian dana dikembalikan per baris; sisanya diteruskan kepada Traveler. |
| RETURN_AND_REFUND | Barang dikembalikan kepada Traveler sesuai instruksi, lalu refund diproses. |
| NO_REFUND | Klaim tidak terbukti; dana diteruskan kepada Traveler. |
| OTHER | Penyelesaian lain yang disepakati dan dicatat. |

4. Selama dispute terbuka, payout Traveler untuk transaksi tersebut ditahan.

## 5. Proses dan waktu refund

1. Refund dikirim ke metode pembayaran asal melalui mitra payment gateway, atau melalui transfer bank bila metode asal tidak mendukung refund.
2. Refund di atas batas persetujuan otomatis (saat ini Rp10.000.000) memerlukan persetujuan dua petugas keuangan (maker-checker).
3. Waktu dana diterima bergantung pada bank/penyedia metode pembayaran: **[FINANCE: SLA per kanal setelah kontrak mitra]**.
4. Refund yang gagal diproses ulang otomatis hingga 3 kali, lalu ditangani tim secara manual.

## 6. Kontak

[E-MAIL CS] · [NOMOR WHATSAPP CS] · Dispute Center di aplikasi.
