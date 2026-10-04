# Template Perjanjian Pemrosesan Data Pribadi (Data Processing Agreement)

> **TEMPLATE UNTUK REVIEW PROFESIONAL — bukan nasihat hukum dan bukan perjanjian yang siap ditandatangani.** Wajib
> disesuaikan dan disahkan konsultan hukum. Dasar: UU 27/2022 (UU PDP) dan ringkasan PP 33/2026 di
> `docs/research/05-legal-regulatory.md`; kutipan pasal diverifikasi 2026-10-04 (§Sumber). Teks berbahasa Indonesia
> adalah teks utama; Annex A (Inggris) hanya terjemahan kemudahan.

## Panduan pemakaian (untuk tim internal — hapus sebelum dikirim)

1. **Siapa yang perlu DPA:** setiap prosesor di [`ropa.md`](ropa.md) §2 (P-01 Neon … P-13 mitra asuransi). Google/Apple
   sign-in dan kurir diperlakukan sebagai pengendali terpisah (ASUMSI — Legal); Xendit dapat berperan ganda (prosesor
   untuk data checkout; pengendali sendiri untuk kewajiban AML/KYC-nya) — tentukan per jenis data.
2. **Vendor besar** (Cloudflare, Neon, Google/Firebase, Twilio, Resend, GitHub) umumnya hanya menerima DPA standar
   mereka. Dalam hal itu **jangan memaksakan template ini**; gunakan daftar periksa §G untuk analisis kesenjangan, simpan
   salinan DPA standar beserta tanggal & versi, dan catat risiko yang tidak tertutup. URL/versi DPA vendor tidak
   dicantumkan di sini karena belum diverifikasi.
3. **Vendor yang dapat dinegosiasikan** (vendor e-KYC, host pemindai malware, mitra asuransi, Iluma bila kontrak
   terpisah): pakai template ini sebagai posisi awal.
4. Isi Lampiran 1 dari RoPA; Lampiran 2 dari `docs/09-security.md`.

## G. Daftar periksa kesenjangan DPA vendor

| # | Butir wajib (dasar) | Ada di DPA vendor? |
|---|---|---|
| G1 | Pemrosesan hanya atas instruksi tertulis pengendali (UU PDP Pasal 51 ayat (1)) | ☐ |
| G2 | Rincian: cakupan & cara, jenis & tujuan, kategori subjek, jangka waktu, hak & kewajiban, mekanisme pengawasan & audit (PP 33/2026 Pasal 13–16 menurut sumber sekunder — `NEEDS_VERIFICATION`) | ☐ |
| G3 | Kerahasiaan personel | ☐ |
| G4 | Langkah keamanan teknis & organisasi yang setara Lampiran 2 | ☐ |
| G5 | Sub-prosesor hanya dengan persetujuan tertulis/pemberitahuan + hak keberatan; daftar sub-prosesor | ☐ |
| G6 | Notifikasi insiden ke pengendali **≤ 24 jam** sejak diketahui (agar pengendali memenuhi 3×24 jam — Pasal 46) | ☐ |
| G7 | Bantuan pemenuhan hak subjek dalam tenggat yang memungkinkan respons 3×24 jam | ☐ |
| G8 | Lokasi pemrosesan disebut; transfer lintas negara dengan safeguard (Pasal 56) | ☐ |
| G9 | Pengembalian/penghapusan data pada akhir layanan + konfirmasi tertulis | ☐ |
| G10 | Hak audit atau laporan independen (mis. SOC 2 / ISO/IEC 27001) | ☐ |
| G11 | Pemberitahuan permintaan akses dari otoritas | ☐ |

---

# PERJANJIAN PEMROSESAN DATA PRIBADI

Nomor: [●]

Perjanjian ini dibuat pada tanggal [●] oleh dan antara:

1. **[NAMA PT PENGELOLA JASTIPKITA]**, perseroan terbatas yang didirikan berdasarkan hukum Negara Republik Indonesia,
   berkedudukan di [●], NIB [●], dalam hal ini diwakili oleh [nama, jabatan] (**"Pengendali"**); dan
2. **[NAMA PROSESOR]**, [bentuk badan hukum & yurisdiksi], berkedudukan di [●], dalam hal ini diwakili oleh [nama,
   jabatan] (**"Prosesor"**).

Pengendali dan Prosesor masing-masing disebut **"Pihak"** dan bersama-sama **"Para Pihak"**.

**Latar belakang**
A. Para Pihak telah menandatangani [perjanjian layanan/syarat layanan] tanggal [●] (**"Perjanjian Utama"**) yang
   mengharuskan Prosesor memproses Data Pribadi atas nama Pengendali.
B. Para Pihak bermaksud mengatur pemrosesan tersebut sesuai Undang-Undang Nomor 27 Tahun 2022 tentang Pelindungan Data
   Pribadi beserta peraturan pelaksananya (**"Peraturan PDP"**).

## Pasal 1 — Definisi
1.1 Istilah *Data Pribadi*, *Data Pribadi yang bersifat spesifik*, *Subjek Data Pribadi*, *Pengendali Data Pribadi*,
    *Prosesor Data Pribadi*, *Pemrosesan*, dan *Kegagalan Pelindungan Data Pribadi* mempunyai arti sebagaimana dalam
    Peraturan PDP.
1.2 **Instruksi** adalah perintah tertulis Pengendali, termasuk Perjanjian ini, Perjanjian Utama, dan konfigurasi
    layanan yang dilakukan Pengendali.
1.3 **Sub-prosesor** adalah pihak ketiga yang dilibatkan Prosesor untuk memproses Data Pribadi Pengendali.
1.4 **Insiden** adalah setiap Kegagalan Pelindungan Data Pribadi, atau dugaan yang wajar atasnya, yang menyangkut Data
    Pribadi Pengendali.

## Pasal 2 — Ruang lingkup dan instruksi
2.1 Prosesor memproses Data Pribadi **hanya berdasarkan Instruksi** Pengendali dan untuk tujuan dalam Lampiran 1
    (sejalan dengan UU PDP Pasal 51 ayat (1) dan (2)).
2.2 Para Pihak mengakui bahwa pemrosesan oleh Prosesor atas perintah Pengendali termasuk dalam tanggung jawab Pengendali
    (UU PDP Pasal 51 ayat (3)). Pemrosesan oleh Prosesor **di luar** Instruksi menjadi tanggung jawab Prosesor sepenuhnya
    dan merupakan pelanggaran Perjanjian ini. *[LEGAL REVIEW: kalimat kedua adalah klausul kontraktual; cocokkan dengan
    ketentuan PP 33/2026.]*
2.3 Prosesor segera memberi tahu Pengendali bila menurut pendapatnya suatu Instruksi melanggar Peraturan PDP.
2.4 Prosesor tidak boleh menjual, menyewakan, memakai untuk melatih model, profiling, atau tujuannya sendiri, Data
    Pribadi Pengendali.

## Pasal 3 — Rincian pemrosesan
Rincian pemrosesan — cakupan dan cara, jenis dan tujuan, kategori Subjek Data Pribadi dan Data Pribadi (termasuk Data
Pribadi spesifik), jangka waktu, lokasi, dan mekanisme pengawasan — dimuat dalam **Lampiran 1** dan merupakan bagian
tak terpisahkan dari Perjanjian ini.

## Pasal 4 — Kewajiban Prosesor
4.1 **Kerahasiaan.** Hanya personel yang perlu mengetahui yang diberi akses, terikat kewajiban kerahasiaan tertulis dan
    telah mendapat pelatihan pelindungan data.
4.2 **Keamanan.** Menerapkan dan memelihara langkah keamanan teknis dan organisasi sekurang-kurangnya sebagaimana
    **Lampiran 2**, dengan memperhatikan sifat Data Pribadi spesifik.
4.3 **Hak Subjek Data.** Meneruskan setiap permintaan Subjek Data yang diterimanya kepada Pengendali dalam **1 (satu)
    hari kerja** tanpa menanggapinya sendiri, dan membantu Pengendali memenuhinya dalam waktu yang memungkinkan
    Pengendali menanggapi permintaan akses/koreksi dalam 3×24 jam (riset 05 §1: UU PDP Pasal 30 & 32).
4.4 **Bantuan kepatuhan.** Memberikan informasi yang wajar untuk penilaian dampak (UU PDP Pasal 34), catatan aktivitas
    pemrosesan, dan konsultasi dengan lembaga PDP.
4.5 **Catatan.** Menyimpan catatan kategori pemrosesan yang dilakukan atas nama Pengendali.
4.6 **Akurasi & minimisasi.** Tidak menyimpan salinan Data Pribadi melebihi yang diperlukan untuk layanan, termasuk log
    yang memuat isi Data Pribadi.

## Pasal 5 — Sub-prosesor
5.1 Prosesor tidak melibatkan Sub-prosesor tanpa **persetujuan tertulis** Pengendali sebelumnya. Sub-prosesor yang
    disetujui per tanggal Perjanjian tercantum dalam **Lampiran 3**.
5.2 Rencana penambahan/penggantian diberitahukan sekurang-kurangnya **30 hari** sebelumnya (ASUMSI); Pengendali dapat
    berkeberatan atas dasar yang wajar dan, bila tidak tercapai solusi, mengakhiri layanan terkait tanpa denda.
5.3 Prosesor mengikat Sub-prosesor dengan kewajiban yang tidak kurang protektif dari Perjanjian ini dan tetap
    bertanggung jawab penuh atas tindakan Sub-prosesor.

## Pasal 6 — Lokasi pemrosesan dan transfer lintas negara
6.1 Lokasi penyimpanan dan pemrosesan dicantumkan dalam Lampiran 1. Perubahan lokasi atau transfer ke luar wilayah hukum
    Negara Republik Indonesia memerlukan **persetujuan tertulis** Pengendali sebelumnya.
6.2 Untuk setiap transfer ke luar wilayah Indonesia, Para Pihak memastikan bahwa negara penerima memiliki tingkat
    pelindungan yang setara atau lebih tinggi (UU PDP Pasal 56 ayat (2)); bila tidak, transfer hanya dilakukan dengan
    pelindungan yang memadai dan bersifat mengikat — termasuk ketentuan Pasal ini sebagai klausul kontraktual — atau,
    bila keduanya tidak terpenuhi, atas dasar persetujuan Subjek Data yang diperoleh Pengendali (urutan menurut riset
    05 §1; teks UU PDP Pasal 56 ayat (3)–(5) dan PP 33/2026 Pasal 160–166 `NEEDS_VERIFICATION`).
6.3 Prosesor menyediakan informasi yang diperlukan Pengendali untuk penilaian transfer: negara, pusat data, Sub-prosesor,
    hukum setempat yang memungkinkan akses otoritas, dan langkah teknis (mis. enkripsi dengan kunci yang dikuasai
    Pengendali).
6.4 Prosesor memberi tahu Pengendali bila hukum negara penerima mencegah pemenuhan Perjanjian ini.

## Pasal 7 — Kegagalan Pelindungan Data Pribadi (Insiden)
7.1 **Pemberitahuan ke Pengendali.** Prosesor memberi tahu Pengendali **tanpa penundaan dan paling lambat 24 (dua puluh
    empat) jam** sejak Prosesor atau Sub-prosesornya mengetahui Insiden, melalui kontak dalam Lampiran 1 (telepon +
    e-mail), memakai format **Lampiran 4**.
7.2 **Alasan tenggat.** Pengendali wajib menyampaikan pemberitahuan tertulis kepada Subjek Data Pribadi **dan**
    lembaga **paling lambat 3 × 24 jam** (UU PDP Pasal 46 ayat (1)), yang minimal memuat (a) Data Pribadi yang
    terungkap, (b) kapan dan bagaimana terungkap, (c) upaya penanganan dan pemulihan (Pasal 46 ayat (2)); dalam hal
    tertentu juga kepada masyarakat (Pasal 46 ayat (3)). Menurut sumber sekunder, PP 33/2026 Pasal 114–115 menambahkan
    informasi mengenai pejabat PDP (`NEEDS_VERIFICATION`). Titik mulai perhitungan 3×24 jam belum dikutip dari teks
    resmi; Perjanjian ini memakai pendekatan konservatif: **dihitung sejak Insiden diketahui oleh Prosesor**.
7.3 **Isi pemberitahuan Prosesor** (sejauh diketahui, dilengkapi bertahap): uraian Insiden; waktu terjadi & diketahui;
    kategori dan perkiraan jumlah Subjek Data serta catatan; Data Pribadi spesifik yang terdampak; apakah data
    terenkripsi dan apakah kunci ikut terdampak; dampak yang mungkin; tindakan penahanan & pemulihan; kontak penanggung
    jawab.
7.4 **Lini waktu minimum:**

    | Waktu sejak diketahui Prosesor | Kewajiban Prosesor |
    |---|---|
    | ≤ 24 jam | pemberitahuan awal (Lampiran 4 bagian A) |
    | ≤ 48 jam | laporan rinci: cakupan, data, subjek, akar masalah sementara (bagian B) |
    | setiap 24 jam sampai tertangani | pembaruan status |
    | ≤ 10 hari kerja setelah tertangani | laporan akhir & tindakan pencegahan (ASUMSI) |

7.5 Prosesor tidak memberi tahu Subjek Data, otoritas, atau publik mengenai Insiden tanpa persetujuan Pengendali, kecuali
    diwajibkan hukum; dalam hal demikian Prosesor memberi tahu Pengendali terlebih dahulu bila diizinkan hukum.
7.6 Prosesor menyimpan bukti (log, artefak) dan bekerja sama dalam investigasi. Bila Insiden berupa gangguan atau
    kegagalan sistem berdampak serius akibat perbuatan pihak lain, Para Pihak berkoordinasi atas kewajiban pelaporan
    kepada aparat penegak hukum dan Kementerian/Lembaga terkait (PP 71/2019 Pasal 24 ayat (3)).
7.7 Biaya penanganan Insiden yang disebabkan pelanggaran Prosesor ditanggung Prosesor. *[LEGAL REVIEW]*

## Pasal 8 — Audit
8.1 Atas permintaan tertulis, Prosesor menyediakan informasi yang wajar untuk membuktikan kepatuhan, termasuk laporan
    audit independen terkini (mis. SOC 2 Type II, ISO/IEC 27001) dan hasil uji penetrasi ringkas.
8.2 Pengendali (atau auditor yang terikat kerahasiaan) dapat melakukan audit/inspeksi dengan pemberitahuan 30 hari,
    paling banyak 1 kali setahun, kecuali setelah Insiden atau atas permintaan otoritas. *[LEGAL REVIEW]*

## Pasal 9 — Retensi, pengembalian, dan penghapusan
9.1 Prosesor menyimpan Data Pribadi hanya selama jangka waktu dalam Lampiran 1 atau sesuai Instruksi penghapusan
    Pengendali (termasuk permintaan penghapusan per Subjek Data).
9.2 Pada berakhirnya layanan, Prosesor — sesuai pilihan Pengendali — mengembalikan Data Pribadi dalam format umum dan/atau
    menghapusnya dalam **30 hari** (ASUMSI), termasuk dari cadangan dalam siklus rotasi cadangan berikutnya, dan
    menyerahkan **pernyataan tertulis penghapusan**.

## Pasal 10 — Permintaan otoritas
Prosesor segera memberi tahu Pengendali atas permintaan pengungkapan dari otoritas mana pun (kecuali dilarang hukum),
menguji keabsahannya, dan hanya mengungkapkan sebatas yang diwajibkan.

## Pasal 11 — Tanggung jawab
*[LEGAL REVIEW: batas tanggung jawab, ganti rugi, dan hubungannya dengan Perjanjian Utama. Usulan posisi awal: batas
tanggung jawab umum Perjanjian Utama tidak berlaku untuk pelanggaran kewajiban kerahasiaan, keamanan, dan Pasal 7.]*

## Pasal 12 — Jangka waktu dan pengakhiran
Perjanjian ini berlaku sejak ditandatangani sampai seluruh Data Pribadi Pengendali dikembalikan/dihapus sesuai Pasal 9.
Pelanggaran material atas Pasal 4–7 memberi hak kepada Pengendali untuk mengakhiri Perjanjian Utama.

## Pasal 13 — Hukum yang berlaku dan penyelesaian sengketa
Perjanjian ini tunduk pada hukum Negara Republik Indonesia. Sengketa diselesaikan secara musyawarah dalam 30 hari; bila
tidak tercapai, melalui [Pengadilan Negeri ●] / [arbitrase ●]. *[LEGAL REVIEW]*

## Pasal 14 — Lain-lain
14.1 Bila terdapat pertentangan dengan Perjanjian Utama mengenai Data Pribadi, Perjanjian ini yang berlaku.
14.2 Perjanjian ini dibuat dalam Bahasa Indonesia [dan Bahasa Inggris]; bila terdapat perbedaan, versi Bahasa Indonesia
     yang berlaku. *[LEGAL REVIEW: persyaratan bahasa perjanjian dengan pihak asing.]*
14.3 Perubahan hanya sah bila dibuat tertulis dan ditandatangani Para Pihak.

**PENGENDALI** — [nama, jabatan, tanggal, tanda tangan] · **PROSESOR** — [nama, jabatan, tanggal, tanda tangan]

---

## Lampiran 1 — Rincian pemrosesan (isi per prosesor; draf dari RoPA, semua lokasi ASUMSI)

| Prosesor | Tujuan & layanan | Kategori subjek | Kategori data (⚠ spesifik) | Jangka waktu / retensi di prosesor | Lokasi | Kontak insiden |
|---|---|---|---|---|---|---|
| Neon | hosting basis data | semua pengguna, staf | seluruh DB (⚠ identitas KYC & rekening sebagai ciphertext aplikasi) | selama layanan + backup/PITR penyedia | Singapura | [●] |
| Cloudflare (Workers, R2) | runtime API, object storage | semua pengguna | request in-transit, IP, log teredaksi; file (⚠ KYC terenkripsi envelope; staging plaintext sementara) | log: sesuai paket; objek: sesuai instruksi hapus | global / APAC | [●] |
| Xendit | pembayaran, refund, payout | Penitip, Traveler | nama, e-mail, HP, nominal; ⚠ nomor rekening + nama pemilik | sesuai kewajiban penyedia (Legal) | Indonesia | [●] |
| Iluma (bila kontrak terpisah) | validasi nama rekening | Penitip, Traveler | ⚠ kode bank + nomor rekening → nama | [●] | [●] | [●] |
| Vendor e-KYC | verifikasi dokumen & liveness | pemohon KYC | ⚠ foto dokumen, selfie, liveness, nomor identitas | hapus setelah hasil dikirim (posisi awal: ≤ 30 hari) | **utamakan Indonesia** | [●] |
| Resend | e-mail transaksional & OTP | semua pengguna | e-mail, isi e-mail | [●] | AS (ASUMSI) | [●] |
| Twilio | SMS/WhatsApp OTP | pengguna dengan HP | nomor HP, isi OTP | [●] | AS (ASUMSI) | [●] |
| Google (FCM) | push notification | pengguna aplikasi | token perangkat, judul/isi notifikasi (pratinjau chat) | [●] | global (ASUMSI) | [●] |
| Host clamd (bila pihak ketiga) | pemindaian malware | pengunggah file | ⚠ byte file plaintext termasuk KYC | **tanpa penyimpanan** | [●] | [●] |
| GitHub | penyimpanan backup terenkripsi | semua | ciphertext dump DB | 14 hari | AS | [●] |
| Mitra asuransi | proteksi & klaim | Penitip | id transaksi, nilai, deskripsi klaim | [●] | [●] | [●] |

Mekanisme pengawasan: laporan audit tahunan (Pasal 8), tinjauan Lampiran 3 setiap 6 bulan, uji kontak insiden tahunan.

## Lampiran 2 — Langkah keamanan minimum
1. Enkripsi saat transit (TLS 1.2+) dan saat disimpan (enkripsi disk penyedia; untuk data spesifik, Pengendali
   menerapkan enkripsi aplikasi AES-256-GCM — Prosesor tidak memegang kunci aplikasi).
2. Kontrol akses berbasis peran, MFA untuk akses administratif, prinsip *least privilege*, peninjauan akses berkala.
3. Pencatatan & pemantauan akses ke Data Pribadi; log disimpan dan dilindungi dari perubahan.
4. Manajemen kerentanan & patch; uji penetrasi berkala.
5. Pemisahan data antar pelanggan; penghapusan aman.
6. Rencana kelangsungan usaha & pemulihan bencana yang diuji.
7. Prosedur penanganan insiden yang mendukung Pasal 7.
8. Kerahasiaan & pelatihan personel; pemeriksaan latar belakang sesuai hukum setempat.
9. Untuk vendor e-KYC: tidak memakai data biometrik untuk melatih model tanpa persetujuan tertulis; hapus data mentah
   setelah verifikasi sesuai Lampiran 1.

## Lampiran 3 — Sub-prosesor yang disetujui
| Nama | Layanan | Lokasi | Data | Tanggal disetujui |
|---|---|---|---|---|
| [●] | [●] | [●] | [●] | [●] |

## Lampiran 4 — Formulir pemberitahuan Insiden oleh Prosesor
**A. Pemberitahuan awal (≤ 24 jam)** — Nama prosesor · nomor referensi insiden · waktu terjadi (perkiraan) & waktu
diketahui (WIB/UTC) · uraian singkat · sistem/layanan terdampak · kategori data (⚠ spesifik?) · perkiraan jumlah subjek &
catatan · status enkripsi & kunci · tindakan penahanan yang sudah dilakukan · kontak 24/7.
**B. Laporan rinci (≤ 48 jam)** — kronologi · akar masalah sementara · daftar data & subjek (format yang disepakati) ·
risiko bagi subjek · rekomendasi langkah bagi subjek · rencana pemulihan.
**C. Laporan akhir** — akar masalah final · tindakan korektif & pencegahan · bukti penutupan.

---

## Annex A — English convenience translation (key clauses only; the Indonesian text prevails)

- **Instructions (Art. 2):** the Processor processes Personal Data only on the Controller's documented instructions
  (UU PDP Art. 51(1)–(2)); processing on the Controller's instruction is within the Controller's responsibility
  (Art. 51(3)); processing outside instructions is the Processor's sole responsibility and a breach.
- **Sub-processors (Art. 5):** prior written approval; 30 days' notice of changes (assumption) with a right to object;
  flow-down of equivalent obligations; Processor remains liable.
- **International transfers (Art. 6):** no transfer outside Indonesia without prior written approval; the receiving
  country must offer an equivalent or higher level of protection (Art. 56(2)), otherwise adequate binding safeguards or,
  failing both, data-subject consent obtained by the Controller (sequence per internal research; to be verified).
- **Personal data breach (Art. 7):** notify the Controller without undue delay and **no later than 24 hours** after
  becoming aware, so that the Controller can notify data subjects and the authority in writing within **3 × 24 hours**
  (UU PDP Art. 46(1)) with the minimum content of Art. 46(2); detailed report within 48 hours; no external communication
  without the Controller's approval unless required by law.
- **Audit (Art. 8), return/deletion within 30 days with written certification (Art. 9), authority requests (Art. 10),
  Indonesian governing law (Art. 13).**

## Sumber (diverifikasi 2026-10-04)

| Rujukan | Sumber |
|---|---|
| UU 27/2022 Pasal 46 ayat (1)–(3) (teks lengkap) | https://pasal.id/peraturan/uu/uu-no-27-tahun-2022/pasal-46 |
| UU 27/2022 Pasal 51 ayat (1)–(3) | https://pasal.id/peraturan/uu/uu-no-27-tahun-2022/pasal-51 |
| UU 27/2022 Pasal 56 ayat (1)–(2) | https://pasal.id/peraturan/uu/uu-no-27-tahun-2022/pasal-56 |
| UU 27/2022 Pasal 34 | https://pasal.id/peraturan/uu/uu-no-27-tahun-2022/pasal-34 |
| PP 71/2019 Pasal 24 ayat (3) | https://pasal.id/peraturan/pp/pp-no-71-tahun-2019/pasal-24 |
| PP 33/2026 Pasal 13–16 (isi perjanjian pengendali–prosesor), 114–115 (notifikasi), 160–166 (transfer) — sumber sekunder | https://veritask.ai/id/artikel/pengaturan-teknis-pelindungan-data-pribadi-dan-kewajiban-pengendali-serta-prosesor-akhirnya-terbit-lewat-pp-33-2026 |
| PP 33/2026 berlaku 16-01-2027 | https://meridianhukum.com/peraturan/pp-no-33-tahun-2026 |
| Hak akses/koreksi 3×24 jam (Pasal 30, 32), Pasal 56 bertingkat | `docs/research/05-legal-regulatory.md` §1 (diverifikasi 2026-09-27) |

---

**Catatan keterbatasan data:** template disusun tanpa membaca DPA standar masing-masing vendor; isi PP 33/2026 berasal
dari sumber sekunder dan teks UU PDP Pasal 56 ayat (3)–(5) belum dikutip dari sumber primer; titik mulai perhitungan
3×24 jam belum dipastikan (dipakai pendekatan konservatif); seluruh tenggat kontraktual (24/48 jam, 30 hari) dan lokasi
prosesor adalah ASUMSI posisi negosiasi; kutipan pasal berasal dari pasal.id (agregator) dan harus dicocokkan dengan
JDIH resmi.
