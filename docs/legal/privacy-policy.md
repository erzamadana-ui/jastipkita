---
title: Kebijakan Privasi
description: Bagaimana JastipKita mengumpulkan, memakai, membagikan, menyimpan, dan melindungi data pribadi sesuai UU 27/2022 tentang Pelindungan Data Pribadi.
version: "0.1-template"
effectiveDate: "[TANGGAL BERLAKU — diisi saat peluncuran]"
order: 2
---

> **TEMPLATE — wajib direview konsultan hukum sebelum production launch; bukan nasihat hukum.**
>
> Disusun berdasarkan UU Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi (UU PDP) dan ringkasan PP 33/2026 dalam `docs/research/05-legal-regulatory.md`, serta arsitektur data aktual (`docs/03-database.md`, `docs/api/identity.md`). Durasi retensi berasal dari tabel `data_retention_policies` yang **seluruhnya masih asumsi**. Lengkapi semua **[KURUNG SIKU]**, lakukan DPIA untuk pemrosesan KYC/biometrik, dan verifikasi daftar prosesor sebelum publikasi.

**Versi:** 0.1 (draf) · **Berlaku sejak:** [TANGGAL BERLAKU] · **Terakhir diperbarui:** 27 September 2026

## 1. Siapa kami

Pengendali Data Pribadi: **[NAMA BADAN USAHA — PT/CV, menunggu pendirian]** ("JastipKita", "kami"), [ALAMAT TERDAFTAR], NIB [NIB]. JastipKita adalah merek layanan yang merupakan bagian dari AntarKita Indonesia.

Pejabat Pelindungan Data Pribadi (DPO): **[NAMA/JABATAN DPO]** — [E-MAIL DPO] · [ALAMAT SURAT].

Kebijakan ini berlaku untuk aplikasi JastipKita, situs `antarkitaindonesia.com/jastipkita`, dan API kami.

## 2. Data yang kami proses

| Kategori | Contoh | Sumber |
|---|---|---|
| Identitas & kontak | nama, e-mail, nomor HP, foto profil, bahasa | Anda |
| Akun & autentikasi | ID akun, riwayat login, sesi, perangkat terdaftar, status verifikasi | Anda, sistem |
| **Data KYC — data pribadi spesifik** | jenis & nomor KTP/paspor, nama sesuai dokumen, foto dokumen, **selfie dan data liveness (data biometrik)** | Anda, penyedia verifikasi |
| **Data keuangan pribadi — data spesifik** | rekening payout Traveler (ditampilkan hanya dalam bentuk tersamar, mis. `****0961`), status pembayaran, refund, payout | Anda, mitra payment gateway |
| Transaksi | titipan, barang, harga, rincian biaya, bukti pembelian (struk, foto, nomor seri/video), konfirmasi harga, bukti bea cukai | Anda, pihak lawan transaksi |
| Perjalanan (Traveler) | rute, tanggal, kapasitas, dokumen perjalanan (tiket/boarding pass, data sensitif disamarkan) | Traveler |
| Serah terima | kota, alamat pengiriman, nomor resi, bukti serah terima | Anda, kurir |
| Komunikasi | chat antar pengguna, tiket bantuan, bukti dispute | Anda |
| Reputasi & risiko | Trust Score, rating, sinyal penipuan, keputusan risiko | sistem |
| Perangkat & log | alamat IP, jenis perangkat & sistem operasi, versi aplikasi, token notifikasi, log keamanan | sistem |
| Preferensi | persetujuan (versi & waktu), preferensi pemasaran, tema, bahasa | Anda |

Kami **tidak** menyimpan nomor kartu pembayaran; data kartu diproses langsung oleh mitra payment gateway berizin.

## 3. Tujuan dan dasar pemrosesan

Dasar pemrosesan mengacu pada Pasal 20 ayat (2) UU PDP.

| Tujuan | Dasar pemrosesan |
|---|---|
| Membuat dan mengelola akun, autentikasi OTP | pemenuhan perjanjian |
| Mempertemukan Penitip dan Traveler, menjalankan transaksi, SafePay, serah terima | pemenuhan perjanjian |
| Verifikasi identitas (KYC) termasuk pencocokan wajah & liveness | **persetujuan eksplisit terpisah** ([Persetujuan KYC](kyc-consent.md)) dan kewajiban hukum [LEGAL REVIEW: APU-PPT bila berlaku] |
| Menghitung estimasi bea & pajak, memeriksa barang terlarang | pemenuhan perjanjian; kepentingan yang sah |
| Pencegahan penipuan, keamanan akun, Trust Score, batas transaksi | kepentingan yang sah; kewajiban hukum |
| Penyelesaian dispute, refund, dan payout | pemenuhan perjanjian; kewajiban hukum |
| Pembukuan dan perpajakan | kewajiban hukum |
| Layanan pelanggan dan pengaduan | pemenuhan perjanjian; kewajiban hukum (perlindungan konsumen) |
| Pemberitahuan layanan (status transaksi, keamanan) | pemenuhan perjanjian |
| Pemasaran dan promosi | **persetujuan terpisah** ([Persetujuan Pemasaran](marketing-consent.md)), dapat ditarik kapan saja |
| Analitik produk (bila kelak diaktifkan) | persetujuan (lihat [Kebijakan Cookie](cookie-policy.md)) |

### 3.1 Keputusan otomatis

Trust Score, penilaian risiko transaksi (izinkan/tinjau/tahan/blokir), dan pemeriksaan liveness dijalankan secara otomatis. Anda berhak **mengajukan keberatan** dan meminta peninjauan oleh manusia atas keputusan yang semata-mata otomatis dan berdampak signifikan bagi Anda, melalui kanal pada Bagian 9.

## 4. Kepada siapa data dibagikan

Kami hanya membagikan data seperlunya:

| Penerima | Data | Tujuan |
|---|---|---|
| Pengguna lawan transaksi | nama depan + inisial, level verifikasi, Trust Score, rating; data serah terima yang diperlukan | menjalankan transaksi (data identitas KYC **tidak** dibagikan) |
| Mitra payment gateway berizin Bank Indonesia — [NAMA MITRA] | data pembayaran, jumlah, rekening payout | memproses pembayaran, refund, payout |
| Penyedia verifikasi identitas — [NAMA VENDOR KYC] | foto dokumen, selfie, data liveness | verifikasi KYC |
| Penyedia infrastruktur — [PENYEDIA CLOUD/HOSTING, DATABASE, OBJECT STORAGE] | data yang disimpan di sistem | hosting & penyimpanan terenkripsi |
| Penyedia komunikasi — [E-MAIL, SMS/WHATSAPP, PUSH NOTIFICATION] | kontak & isi pesan layanan | mengirim OTP & notifikasi |
| Penyedia ekstraksi produk berbasis AI (bila dipakai) — [NAMA] | tautan/foto produk | membaca detail produk (ditandai sebagai hasil AI) |
| Instansi berwenang | data sesuai permintaan sah | kewajiban hukum |

Semua prosesor terikat perjanjian pemrosesan data. **Kami tidak menjual data pribadi Anda.**

## 5. Transfer data ke luar negeri

Sebagian penyedia layanan dapat menyimpan atau memproses data di luar wilayah Indonesia ([LOKASI SERVER UTAMA & NEGARA PROSESOR]). Transfer dilakukan sesuai Pasal 56 UU PDP: ke negara dengan tingkat pelindungan setara atau lebih tinggi; atau dengan pelindungan yang memadai dan mengikat (mis. klausul kontrak standar); atau dengan persetujuan Anda. **[LEGAL REVIEW: pilih region Indonesia bila memungkinkan; dokumentasikan penilaian transfer sesuai PP 33/2026.]**

## 6. Berapa lama data disimpan

Data disimpan selama akun aktif dan setelahnya hanya selama diperlukan untuk tujuan atau kewajiban hukum. Durasi di bawah adalah **asumsi internal** yang sedang ditinjau:

| Data | Retensi | Setelahnya |
|---|---|---|
| Catatan keuangan (transaksi, pembayaran, refund, payout, buku besar) | 10 tahun sejak dibuat (kewajiban pembukuan) | dihapus |
| Identitas & dokumen KYC | 5 tahun setelah akun ditutup (praktik APU-PPT) | dihapus |
| Log audit | 10 tahun | dihapus setelah checkpoint integritas |
| Bukti rekonsiliasi pembayaran (webhook) | 5 tahun | dihapus |
| Pesan chat | 2 tahun setelah transaksi selesai (pesan yang menjadi bukti dispute ditahan) | dianonimkan |
| Alamat pengiriman | 90 hari setelah transaksi selesai | dianonimkan |
| Dokumen perjalanan Traveler | 180 hari setelah trip selesai | dihapus |
| Log keamanan | 12 bulan | dihapus |
| Notifikasi | 180 hari | dihapus |
| Data analitik (bila diaktifkan) | 13 bulan | dihapus |
| Kode OTP & sesi kedaluwarsa | 30 hari | dihapus |

Saat akun dihapus, profil dianonimkan setelah masa tenggang 14 hari; e-mail disimpan hanya dalam bentuk hash untuk mencegah penyalahgunaan pendaftaran ulang.

## 7. Keamanan

Kami menerapkan langkah teknis dan organisasi yang wajar, antara lain: enkripsi saat transit (TLS); file KYC disimpan terenkripsi (envelope AES-256-GCM) di object storage dengan basis data hanya menyimpan referensi dan hash; rekening payout ditampilkan tersamar; kontrol akses berbasis peran dengan persetujuan berlapis (maker-checker) untuk tindakan keuangan; log audit append-only berantai hash; dan pembatasan percobaan OTP/PIN. Tidak ada sistem yang sepenuhnya bebas risiko.

## 8. Hak Anda

Sesuai Pasal 5–13 UU PDP, Anda berhak:

1. memperoleh informasi tentang pemrosesan data Anda;
2. **mengakses** dan memperoleh salinan data Anda;
3. **memperbaiki** data yang tidak akurat;
4. **menghapus** data dan mengakhiri pemrosesan (lihat [Hapus akun](/jastipkita/hapus-akun/));
5. **menarik persetujuan** yang pernah diberikan (penarikan tidak memengaruhi pemrosesan sebelumnya dan dapat membatasi fitur, mis. transaksi yang memerlukan KYC);
6. **mengajukan keberatan** atas keputusan yang semata-mata otomatis;
7. **menunda atau membatasi** pemrosesan secara proporsional;
8. memperoleh dan/atau memindahkan data dalam format yang umum dipakai;
9. menggugat dan menerima ganti rugi atas pelanggaran pemrosesan data sesuai peraturan.

## 9. Cara menggunakan hak Anda

- Di aplikasi: **Profil → Keamanan & privasi** (unduh data, hapus akun, kelola persetujuan).
- Di web: [halaman Akun](/jastipkita/akun/) setelah masuk.
- E-mail DPO: [E-MAIL DPO] — dari e-mail/nomor HP terdaftar; kami dapat meminta verifikasi identitas.

Kami menanggapi permintaan akses dan perbaikan paling lambat **3 × 24 jam** sejak permintaan lengkap diterima (Pasal 30 & 32 UU PDP), dan permintaan lain dalam tenggat yang diatur peraturan. Permintaan dapat ditolak bila bertentangan dengan kewajiban hukum (mis. retensi catatan keuangan), dengan alasan tertulis.

## 10. Pemberitahuan kegagalan pelindungan data

Bila terjadi kegagalan pelindungan data pribadi, kami memberi tahu Anda dan lembaga penyelenggara pelindungan data pribadi secara tertulis paling lambat **3 × 24 jam** (Pasal 46 UU PDP), memuat data yang terdampak, waktu dan cara terjadinya, serta upaya penanganan dan pemulihan.

## 11. Anak

Layanan ditujukan bagi pengguna berusia 18 tahun ke atas atau yang cakap hukum. Kami tidak dengan sengaja memproses data anak; bila kami mengetahuinya, akun akan ditangguhkan dan data dihapus sesuai ketentuan. **[LEGAL REVIEW]**

## 12. Cookie dan penyimpanan lokal

Situs hanya memakai penyimpanan yang benar-benar diperlukan; tidak ada pelacak pihak ketiga yang terpasang. Detail di [Kebijakan Cookie](cookie-policy.md).

## 13. Perubahan kebijakan

Perubahan material diberitahukan melalui aplikasi/e-mail sebelum berlaku. Bila perubahan memerlukan persetujuan baru, kami akan memintanya secara terpisah.

## 14. Kontak

DPO: [E-MAIL DPO] · Layanan pelanggan: [NOMOR WHATSAPP CS] · Alamat: [ALAMAT TERDAFTAR]
