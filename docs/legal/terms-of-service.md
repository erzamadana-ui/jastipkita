---
title: Syarat & Ketentuan Penggunaan
description: Ketentuan yang mengatur penggunaan platform JastipKita oleh Penitip dan Traveler.
version: "0.1-template"
effectiveDate: "[TANGGAL BERLAKU — diisi saat peluncuran]"
order: 1
---

> **TEMPLATE — wajib direview konsultan hukum sebelum production launch; bukan nasihat hukum.**
>
> Rancangan kerja yang disusun dari riset internal (`docs/research/05-legal-regulatory.md`), model domain (`docs/00-domain-model.md`), dan konfigurasi bisnis default. Semua teks dalam **[KURUNG SIKU]** wajib dilengkapi. Angka biaya, batas, dan tenggat mengikuti konfigurasi saat dokumen ditulis dan dapat berubah melalui versi dokumen baru.

**Versi:** 0.1 (draf) · **Berlaku sejak:** [TANGGAL BERLAKU] · **Terakhir diperbarui:** 27 September 2026

**Penyelenggara:** [NAMA BADAN USAHA — PT/CV, menunggu pendirian] ("**JastipKita**", "**kami**"), berkedudukan di [ALAMAT TERDAFTAR], Nomor Induk Berusaha [NIB], terdaftar sebagai Penyelenggara Sistem Elektronik Lingkup Privat dengan nomor [NOMOR TANDA DAFTAR PSE]. JastipKita adalah merek layanan yang merupakan bagian dari AntarKita Indonesia.

## 1. Definisi

- **Platform**: aplikasi seluler, situs web, dan API JastipKita.
- **Pengguna**: setiap orang yang membuat akun, yaitu Penitip dan/atau Traveler.
- **Penitip**: Pengguna yang meminta Traveler membelikan dan membawakan barang dari luar negeri.
- **Traveler**: Pengguna terverifikasi yang melakukan perjalanan dan menerima permintaan titipan.
- **Titipan**: permintaan pembelian barang oleh Penitip beserta transaksi yang menyertainya.
- **SafePay**: alur pembayaran JastipKita di mana dana Penitip diproses dan ditahan oleh mitra payment gateway berizin sampai syarat pelepasan terpenuhi (lihat [Ketentuan Pembayaran](payment-terms.md)).
- **Rincian Biaya**: tampilan 11 baris biaya yang wajib dilihat Penitip sebelum membayar.
- **Status Transaksi**: status resmi transaksi di Platform (antara lain PAYMENT SECURED, PURCHASE APPROVED, PURCHASED, DELIVERED, COMPLETED).

## 2. Penerimaan ketentuan

1. Dengan membuat akun atau memakai Platform, Anda menyatakan telah membaca, memahami, dan menyetujui Syarat & Ketentuan ini, [Kebijakan Privasi](privacy-policy.md), [Ketentuan Pembayaran](payment-terms.md), [Kebijakan Refund](refund-policy.md), [Kebijakan Barang Terlarang](prohibited-items-policy.md), dan [Pedoman Komunitas](community-guidelines.md).
2. Traveler juga terikat pada [Perjanjian Traveler](traveler-agreement.md).
3. Persetujuan atas pemrosesan data pribadi, data KYC/biometrik, dan pemasaran diberikan **terpisah** dari Syarat & Ketentuan ini.
4. Anda harus berusia minimal 18 tahun atau cakap hukum menurut peraturan perundang-undangan Indonesia. **[LEGAL REVIEW: batas usia & perlakuan pengguna di bawah umur.]**

## 3. Peran para pihak

1. JastipKita adalah **penyelenggara platform** yang mempertemukan Penitip dan Traveler, menyediakan alur pembayaran SafePay melalui mitra, verifikasi pengguna, dan penyelesaian sengketa.
2. **Traveler** adalah pihak yang membeli, membawa, mendeklarasikan, dan menyerahkan barang, serta bertanggung jawab atas kewajiban kepabeanan pada saat kedatangan.
3. JastipKita **bukan** penjual barang, bukan importir, bukan perusahaan jasa pengiriman, bukan bank, dan bukan penerbit uang elektronik.
4. **[LEGAL REVIEW: kualifikasi Traveler sebagai "Pedagang" menurut Permendag 19/2026 dan kewajiban NIB; posisi JastipKita sebagai PPMSE.]**

## 4. Akun, verifikasi, dan keamanan

1. Anda wajib memberikan data yang benar dan terkini, serta menjaga kerahasiaan kode OTP, PIN serah terima, dan perangkat Anda.
2. Tingkat verifikasi (KYC) menentukan fitur dan batas transaksi: Level 1 Terdaftar, Level 2 HP terverifikasi (syarat pembayaran), Level 3 Identitas terverifikasi, Level 4 Traveler terverifikasi, Level 5 Trusted Traveler. Rincian batas ditampilkan di aplikasi.
3. Kami dapat meminta verifikasi ulang, membatasi, menahan, atau menangguhkan akun apabila terdapat indikasi penipuan, pelanggaran hukum, atau risiko bagi pengguna lain. Keputusan tersebut dicatat dan dapat Anda ajukan keberatan melalui kanal bantuan.
4. Satu orang hanya boleh memiliki satu akun kecuali disetujui tertulis oleh kami.

## 5. Alur transaksi

1. Penitip membuat Titipan; Platform memeriksa barang terhadap daftar barang terlarang/terbatas dan menampilkan estimasi biaya.
2. Setelah Penitip dan Traveler sepakat (match), Penitip membayar melalui SafePay. Status menjadi **PAYMENT SECURED** setelah pembayaran terverifikasi.
3. **Traveler hanya boleh membeli barang setelah status PURCHASE APPROVED.** Pembelian sebelum status tersebut sepenuhnya menjadi risiko Traveler.
4. Traveler mengunggah bukti pembelian (struk, foto barang, nama toko, harga aktual, waktu pembelian; nomor seri dan/atau video untuk kategori tertentu).
5. Setelah tiba, Traveler menyelesaikan kewajiban kepabeanan dan menyerahkan barang melalui PIN/QR (bertemu langsung) atau kurir dengan nomor resi.
6. Penitip mengonfirmasi penerimaan. Bila tidak ada konfirmasi atau dispute dalam **48 jam** setelah status DELIVERED, transaksi dikonfirmasi otomatis.
7. Dana diteruskan ke Traveler setelah konfirmasi dan tidak ada dispute terbuka, sesuai [Ketentuan Pembayaran](payment-terms.md).

## 6. Harga, biaya, dan estimasi bea & pajak

1. Seluruh biaya ditampilkan dalam Rincian Biaya sebelum pembayaran: Harga Barang, Traveler Fee, Bea Masuk (estimasi), Pajak Impor (estimasi), JastipKita Protection, Platform Fee, PPN atas layanan (bila berlaku), Biaya Pembayaran, Diskon, JastipKita Credit, dan Total Landed Cost. **Tidak ada biaya yang dipungut di luar Rincian Biaya.**
2. Harga barang dalam mata uang asing dikonversi dengan kurs yang dikunci selama waktu yang ditampilkan (saat ini 30 menit), termasuk markup kurs yang diungkapkan.
3. Bea masuk dan pajak impor adalah **estimasi** berdasarkan aturan yang berlaku saat penawaran dibuat (versi aturan dicatat pada penawaran). Barang titipan diperlakukan sebagai **barang bukan pribadi** menurut PMK 34 Tahun 2025. Nilai final ditetapkan pejabat Bea dan Cukai.
4. Selisih antara estimasi dan tagihan resmi Bea dan Cukai diselesaikan berdasarkan bukti pembayaran resmi yang diunggah Traveler: **[LEGAL/FINANCE REVIEW: mekanisme penagihan kekurangan dan pengembalian kelebihan, batas nominal, dan tenggat.]**

## 7. Konfirmasi perubahan harga

1. Bila harga aktual berbeda dari harga yang telah diamankan melebihi toleransi (saat ini 2% atau maksimal Rp50.000), Traveler wajib mengajukan konfirmasi harga beserta bukti.
2. Penitip memiliki **15 menit** untuk menyetujui, menolak, atau meminta klarifikasi. Tanpa respons hingga batas waktu, konfirmasi dianggap **ditolak**.
3. Penolakan kenaikan harga **bukan kesalahan Penitip**: transaksi dibatalkan dan dana dikembalikan penuh termasuk biaya pembayaran, tanpa penalti Trust Score.
4. Bila disetujui dan dana yang diamankan tidak cukup, Penitip membayar selisihnya sebelum pembelian disetujui.

## 8. Pembatalan, refund, dan dispute

1. Hak membatalkan dan besaran pengembalian dana mengikuti matriks pada [Kebijakan Refund](refund-policy.md).
2. Setelah barang dibeli, Penitip tidak dapat membatalkan sepihak; keluhan diajukan melalui Dispute Center.
3. Dispute dapat dibuka paling lambat **72 jam** setelah status DELIVERED. Para pihak menyampaikan bukti dalam 72 jam; JastipKita menargetkan keputusan dalam 120 jam setelah bukti lengkap; banding dapat diajukan satu kali dalam 72 jam.
4. Keputusan dispute dapat berupa refund penuh, refund sebagian, tanpa refund, retur dan refund, atau penyelesaian lain yang dicatat. Keputusan ini tidak menghapus hak Anda untuk menempuh upaya hukum sesuai Pasal 17.

## 9. Barang terlarang dan terbatas

1. Barang berklasifikasi **PROHIBITED** tidak dapat dititipkan dan pembayaran diblokir.
2. Barang **RESTRICTED**, **DECLARATION_REQUIRED**, atau **PERMIT_REQUIRED** hanya dapat dititipkan setelah Penitip menyetujui peringatan yang ditampilkan; persetujuan tersebut dicatat.
3. Klasifikasi Platform adalah alat bantu. Keputusan akhir atas impor barang ada pada Bea dan Cukai dan instansi terkait. Barang yang ditahan, dimusnahkan, atau direekspor oleh otoritas diselesaikan melalui Dispute Center dengan memperhatikan kesalahan masing-masing pihak.

## 10. Kewajiban dan larangan Pengguna

Pengguna dilarang, antara lain:

1. melakukan atau meminta pembayaran di luar SafePay;
2. meminta atau membantu menyamarkan barang titipan sebagai barang pribadi, memecah barang (*splitting*) untuk memanfaatkan pembebasan, atau memberikan keterangan palsu kepada Bea dan Cukai;
3. menitipkan atau membawa barang terlarang, palsu, curian, atau hasil kejahatan;
4. memakai Platform untuk mengirim uang tunai atau sebagai sarana transfer dana;
5. memberikan ulasan palsu, memanipulasi Trust Score, atau membuat akun ganda;
6. mengakses sistem secara tidak sah atau mengganggu keamanan Platform.

## 11. Trust Score, batas transaksi, dan pengelolaan risiko

1. Trust Score (0–100) dihitung otomatis dari riwayat akun. Penyesuaian manual oleh tim wajib beralasan dan tercatat.
2. Kami menerapkan batas nilai transaksi berdasarkan tingkat verifikasi, Trust Score, dan risiko kategori/negara, serta pemeriksaan risiko otomatis yang dapat menghasilkan keputusan *izinkan*, *tinjau*, *tahan*, atau *blokir*. Anda berhak meminta peninjauan manusia atas keputusan otomatis yang berdampak signifikan (lihat [Kebijakan Privasi](privacy-policy.md)).

## 12. Kekayaan intelektual

Merek, logo, dan perangkat lunak JastipKita dilindungi hukum. Konten yang Anda unggah tetap milik Anda; Anda memberi kami lisensi terbatas untuk memprosesnya sepanjang diperlukan untuk menjalankan layanan, penyelesaian sengketa, dan kepatuhan hukum. **[LEGAL REVIEW: status pendaftaran merek "JastipKita" — lihat docs/research/04-market-and-naming.md.]**

## 13. Batasan tanggung jawab

1. JastipKita bertanggung jawab atas penyelenggaraan Platform sesuai peraturan perundang-undangan, termasuk UU Nomor 8 Tahun 1999 tentang Perlindungan Konsumen. Ketentuan ini **tidak** dimaksudkan untuk mengalihkan tanggung jawab yang menurut hukum tidak dapat dialihkan.
2. Sepanjang diizinkan hukum, JastipKita tidak bertanggung jawab atas: keputusan otoritas kepabeanan/karantina; keterlambatan atau pembatalan perjalanan Traveler; kerugian tidak langsung; atau kerugian akibat transaksi di luar SafePay.
3. **[LEGAL REVIEW: batas nilai tanggung jawab dan kesesuaiannya dengan Pasal 18 UU 8/1999 (klausula baku).]**

## 14. Keadaan kahar

Pihak yang terdampak keadaan kahar (bencana, gangguan penerbangan massal, kebijakan pemerintah, gangguan sistem pembayaran pihak ketiga) dibebaskan dari keterlambatan yang disebabkannya, dengan kewajiban memberi tahu dan memitigasi. Dana yang tertahan diselesaikan sesuai Kebijakan Refund.

## 15. Penangguhan dan pengakhiran

Anda dapat menutup akun kapan saja melalui aplikasi atau halaman [Hapus akun](/jastipkita/hapus-akun/). Kami dapat menangguhkan atau mengakhiri akun yang melanggar ketentuan ini dengan pemberitahuan, kecuali diwajibkan segera oleh hukum atau untuk mencegah kerugian. Kewajiban atas transaksi yang sedang berjalan tetap berlaku sampai selesai.

## 16. Perubahan ketentuan

Perubahan material diberitahukan paling lambat [JUMLAH] hari sebelum berlaku melalui aplikasi dan/atau e-mail. Versi dan tanggal berlaku setiap dokumen dicatat, dan persetujuan Anda disimpan per versi.

## 17. Hukum yang berlaku dan penyelesaian sengketa

1. Ketentuan ini tunduk pada hukum Republik Indonesia.
2. Sengketa diupayakan diselesaikan melalui Dispute Center dan musyawarah. Bila tidak tercapai, Pengguna dapat menempuh penyelesaian melalui Badan Penyelesaian Sengketa Konsumen atau Pengadilan Negeri [DOMISILI PENGADILAN] sesuai peraturan yang berlaku.
3. **[LEGAL REVIEW: klausul pilihan forum/arbitrase dan kanal pengaduan konsumen sesuai Permendag 19/2026.]**

## 18. Bahasa

Ketentuan ini dibuat dalam Bahasa Indonesia. Terjemahan (bila ada) hanya untuk kemudahan; bila terdapat perbedaan, versi Bahasa Indonesia yang berlaku.

## 19. Kontak

- Layanan pelanggan: [NOMOR WHATSAPP CS] · [E-MAIL CS]
- Pengaduan konsumen: [E-MAIL/KANAL PENGADUAN] (target tanggapan: [SLA])
- Alamat surat: [ALAMAT TERDAFTAR]
