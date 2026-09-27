# 04 — Lanskap Pasar Jastip & Pengecekan Nama "JastipKita"

> Riset desk (web publik) diverifikasi **2026-09-27**. Tidak ada pendaftaran domain/merek/akun yang dilakukan. Data pasar bersifat indikatif (banyak sumber sekunder/blog) — jangan dipakai sebagai angka ukuran pasar.

## Ringkasan
- Pasar jastip Indonesia didominasi **operator individu di Instagram/TikTok/WhatsApp**; platform P2P ber-escrow masih sedikit. Pesaing langsung yang paling mirip konsep JastipKita: **"Jastip" oleh Biissa** (jastip.biissa.com) — escrow, traveler terverifikasi, 50+ negara, rilis dana 24 jam setelah konfirmasi.
- Fee traveler lazim **5–15% dari harga barang** atau flat per item (Rp15.000–Rp80.000 tergantung kategori); jastip impor bisa 10–20%. Model "proxy + kirim kargo" memakai tarif per berat (contoh: Rp29.000/100 g dari Jepang).
- Risiko kepercayaan tinggi: kasus penipuan jastip ratusan juta rupiah (2025) → escrow + verifikasi adalah diferensiasi yang valid.
- **Nama "JastipKita": risiko TINGGI.** Domain `.com`, `.id`, `.co.id` sudah terdaftar pihak lain; ≥ 8 akun Instagram, 1 akun TikTok aktif, 1 Facebook page, 1 Linktree, dan satu badan usaha **"CV JASTIP KITA INDONESIA"** memakai nama ini. Nama juga sangat deskriptif (sulit didaftarkan sebagai merek kata). Pengecekan PDKI tidak dapat dilakukan otomatis → `NEEDS_VERIFICATION`.

## 1. Lanskap jastip Indonesia

### 1.1 Pelaku & platform
| Pemain | Model | Status/temuan | Sumber |
|---|---|---|---|
| Operator IG/TikTok/WA ("open jastip") | Traveler/reseller mengumumkan trip, terima DP/transfer langsung | Dominan; pembayaran ke rekening pribadi (tanpa escrow) = red flag penipuan | [Founderplus, 02-09-2026](https://founderplus.id/blog/jastip-scam-red-flags-bisnis-trust-based-founder/) |
| **Jastip by Biissa** | P2P: pilih listing traveler aktif → bayar via escrow → traveler beli & kirim → konfirmasi → dana rilis 24 jam | "funds locked safely until confirmed delivery", perlindungan 30 hari, 50+ negara (JP, KR, US, UK, AU, SG, …); klaim jastiper "Rp5–15 jt/trip" | [jastip.biissa.com](https://jastip.biissa.com/) |
| Bistip | P2P "peer to peer courier" traveler ↔ pencari barang (sejak 2011 menurut Tirto) | Situs masih dapat diakses; aktivitas 2026 tidak terkonfirmasi | [bistip.com](https://www.bistip.com/u/), [Tirto 2019](https://tirto.id/4-aplikasi-situs-web-jastip-barang-dari-dalam-dan-luar-negeri-ejL4) |
| Titip Beliin (PT Titipbeliin Global Internasional) | Proxy shopping + gudang luar negeri + kepabeanan + kirim (bukan hand-carry P2P) | Play Store: 10.000+ unduhan, rating 4,0 (145 ulasan), update 13-04-2026; keluhan crash | [Google Play](https://play.google.com/store/apps/details?id=com.titipbeliin.apps&hl=en_US) |
| Layanan jastip Jepang spesialis (mis. JJ Jastip Jepang) | Proxy + kirim udara | Fee 5% (min ¥400) + ongkir Rp29.000/100 g + ¥500 biaya bank; kurs BCA | [jjjastipjepang.com](https://jjjastipjepang.com/pages/kalkulator) |
| Aplikasi "Jastip" kecil di Play Store | Mayoritas domestik (makanan/lokal) | Contoh: Radjago Jastip, Jastiper, Jastip Nur | hasil pencarian Google Play |

### 1.2 Fee traveler yang lazim
| Model | Kisaran | Sumber |
|---|---|---|
| Persentase harga barang | **5–15%** per item (umum); impor **10–20%** | [SAPX (upd. 12-05-2026)](https://www.sapx.id/blog/cara-menentukan-biaya-jastip-yang-menguntungkan/), [harga.web.id](https://harga.web.id/info-tarif-dan-tips-sukses-raup-untung-dari-bisnis-jasa-titip.info) |
| Flat per item | Makanan Rp7.000–20.000; mainan Rp20.000–25.000; fashion Rp25.000–35.000; emas Rp40.000–50.000; elektronik Rp60.000–80.000; contoh K-pop merch Rp50.000/item | harga.web.id; [Ducking, 21-08-2025](https://www.ducking.id/artikel/fee-jastip-adalah) |
| Per berat (proxy + kargo) | contoh Jepang Rp29.000/100 g (≈ Rp290.000/kg) | JJ Jastip Jepang |
| Pembanding global | Grabr: reward traveler "10–20% of the item's total cost", minimum USD 5 | [Grabr Help](https://help.grabr.io/hc/en-us/articles/115004005714-Can-you-explain-all-the-fees-I-m-seeing) |
Implikasi: default `TRAVELER_FEE` di kisaran 10% (min. flat per kategori) kompetitif; ingat beban bea+pajak jastip ±27,6% nilai barang (dokumen 01) sering **tidak** dihitung operator informal → transparansi landed cost adalah diferensiasi sekaligus membuat harga JastipKita tampak lebih mahal.

### 1.3 Kategori & rute umum
Kategori yang sering disebut: kosmetik/skincare (KR, JP), makanan/camilan, fashion & sepatu, merchandise K-pop, koleksi/TCG, elektronik ([Ducking](https://www.ducking.id/artikel/fee-jastip-adalah); [Flip, 24-10-2023](https://flip.id/en/blog/jastip-luar-negeri)). Rute prioritas JastipKita (JP, SG, KR, MY, AU, US) sejalan dengan cakupan Biissa. Artikel Traveloka "10 Negara Favorit untuk Jastip" tidak dapat diakses (HTTP 405) → daftar negara favorit `NEEDS_VERIFICATION`.
Catatan: artikel Flip (2023) masih memakai rezim lama (BM 7,5%, PPh 2%, dst.) — contoh betapa informasi publik tentang pajak jastip sering usang.

### 1.4 Kepercayaan & penipuan
- 2025: dua pelaku menipu 60 korban ±Rp200 juta; kasus jastip elektronik ±Rp200 juta; utas viral jastip sepatu "ratusan juta rupiah" ([Founderplus](https://founderplus.id/blog/jastip-scam-red-flags-bisnis-trust-based-founder/)).
- Komdigi mencatat 528.415 aduan penipuan jual-beli online 2017–2024; GASA 2025: 35% orang dewasa Indonesia mengalami penipuan dalam 12 bulan, 62% terkait belanja online (dikutip Founderplus — sekunder).
- Red flag yang dikutip: transfer hanya ke rekening pribadi (tanpa escrow), akun baru/berganti nama, kolom komentar dimatikan, harga jauh di bawah pasar.

## 2. Pembanding global (P2P traveler delivery)
| Platform | Model & perlindungan | Status | Sumber |
|---|---|---|---|
| **Grabr** | Shopper membayar saat menerima penawaran traveler; **dana ditahan Grabr dan baru dibayarkan ke traveler setelah shopper mengonfirmasi penerimaan**; money-back guarantee; pembayaran offline dilarang | Masih beroperasi (±100.000 pengguna aktif 2024 per FT, dikutip sekunder) | [Grabr Help – charging](https://help.grabr.io/hc/en-us/articles/360023658254-When-am-I-charged-for-my-order), [expandedramblings](https://expandedramblings.com/index.php/grabr-facts-and-statistics/) |
| **PiggyBee** | Crowd-shipping P2P (Eropa), salah satu pionir | "one of the few still around" (2021); status 2026 tidak terverifikasi | [ShareTraveler, 03-07-2021](https://sharetraveler.com/pandemic-crushed-crowdsourced-shipping-companies/) |
| **Airmule** | Kurir P2P internasional (fokus impor ke Tiongkok) | Ditutup ("RIP Airmule", pos LinkedIn ±2024); disebut berisiko hukum impor | [LinkedIn](https://www.linkedin.com/posts/cameronrcraig_rip-airmule-the-most-audacious-peer-to-activity-7262560484367761408-SPmO), ShareTraveler |
| **Airfrov** (SG) | P2P buyer–traveller; fee dinegosiasikan dengan traveler; perlindungan "case-by-case, limited" (menurut pesaing) | Masih ada (2025); pernah didanai East Ventures USD 500K | [Buy&Ship SG 2025](https://www.buyandship.com.sg/blog/buyandship-vs-airfrov-korean-proxy-services-singapore/), [East Ventures](https://east.vc/news/press-release/airfrov-500-thousand-funding) |
| "Wonder" | — | Tidak ditemukan sumber yang dapat diverifikasi | — |
Pelajaran: 59% perusahaan crowd-shipping tutup selama pandemi (76 → 31; ShareTraveler 2021); risiko utama = **ketergantungan pada perjalanan** dan **kepatuhan impor**. Pola perlindungan yang konsisten: dana ditahan platform → rilis setelah konfirmasi → garansi uang kembali → larangan transaksi di luar platform.

## 3. Pengecekan nama "JastipKita"
| Kanal | Temuan (2026-09-27) | Sumber |
|---|---|---|
| Domain `.com` | **Terdaftar** pihak lain; tidak merespons (connect timeout) | [whois.com](https://www.whois.com/whois/jastipkita.com) |
| Domain `.id` | **Terdaftar** pihak lain (ditawarkan "make an offer" via Sedo); DNS tidak resolve | [whois.com](https://www.whois.com/whois/jastipkita.id) |
| Domain `.co.id` | **Terdaftar** pihak lain; DNS tidak resolve | [whois.com](https://www.whois.com/whois/jastipkita.co.id) |
| Instagram | `@jastipkita.eropa`, `@jastipkita_eu`, `@jastipkita123`, `@jastipkita.id_` ("JastipKita.id"), `@jastipkita.official`, `@jastipkita_indonesia` (**"CV JASTIP KITA INDONESIA"**), `@jastipkita_id`, `@jastip.kitaa` (Bandung) | hasil pencarian web |
| TikTok | `@jastipkita_indonesia` — aktif (unggahan Okt 2025, rute ke Ambon, "kloter") | hasil pencarian web |
| Facebook | Page "JastipKita" (Jakarta Timur); page "Jastip Kita" | hasil pencarian web |
| Linktree | `linktr.ee/jastipkita` — jastip Malaysia↔Indonesia, member sejak Sep 2022 | [linktr.ee/jastipkita](https://linktr.ee/jastipkita) |
| Google Play / App Store | Tidak ditemukan aplikasi bernama "JastipKita" pada pencarian | hasil pencarian web (tidak konklusif) |
| PDKI (DJKI) | Pencarian otomatis diblokir (HTTP 403) → **cek manual** di pdki-indonesia.dgip.go.id kelas 9, 35, 36, 39, 42 | `NEEDS_VERIFICATION` |

**Penilaian risiko: TINGGI**
1. **Konflik penggunaan terdahulu:** badan usaha "CV JASTIP KITA INDONESIA" dan beberapa akun aktif dengan layanan yang sama (jastip) → risiko kebingungan konsumen, sengketa merek bila salah satu pihak telah mendaftarkan merek, dan risiko reputasi (ulasan/penipuan akun lain diasosiasikan ke JastipKita).
2. **Distingtif rendah:** "jastip" adalah istilah generik layanan; "kita" kata umum. Merek yang hanya menerangkan jasa lazim ditolak/lemah (UU 20/2016 — analisis hukum `NEEDS_VERIFICATION`).
3. **Domain tidak tersedia** untuk `.com/.id/.co.id` → perlu varian (mis. `jastipkita.app`) atau pembelian.
**Rekomendasi (untuk keputusan manajemen, bukan tindakan otomatis):** (a) lakukan pencarian PDKI resmi & konsultasi konsultan KI terdaftar; (b) pertimbangkan nama/merek utama yang lebih distingtif dengan "JastipKita" sebagai deskriptor, atau merek kombinasi logo+kata; (c) amankan handle sosial alternatif yang konsisten; (d) jangan meluncurkan kampanye berbayar sebelum status merek jelas.

## `NEEDS_VERIFICATION`
Status PDKI untuk "JastipKita"/"Jastip Kita"; aktivitas Bistip & PiggyBee 2026; daftar negara jastip favorit; data ukuran pasar (tidak ada sumber kredibel ditemukan); analisis distingtif merek.

## Sumber (diverifikasi 2026-09-27)
https://jastip.biissa.com/ · https://www.bistip.com/u/ · https://tirto.id/4-aplikasi-situs-web-jastip-barang-dari-dalam-dan-luar-negeri-ejL4 · https://play.google.com/store/apps/details?id=com.titipbeliin.apps&hl=en_US · https://jjjastipjepang.com/pages/kalkulator · https://www.sapx.id/blog/cara-menentukan-biaya-jastip-yang-menguntungkan/ · https://harga.web.id/info-tarif-dan-tips-sukses-raup-untung-dari-bisnis-jasa-titip.info · https://www.ducking.id/artikel/fee-jastip-adalah · https://flip.id/en/blog/jastip-luar-negeri · https://founderplus.id/blog/jastip-scam-red-flags-bisnis-trust-based-founder/ · https://help.grabr.io/hc/en-us/articles/115004005714-Can-you-explain-all-the-fees-I-m-seeing · https://help.grabr.io/hc/en-us/articles/360023658254-When-am-I-charged-for-my-order · https://expandedramblings.com/index.php/grabr-facts-and-statistics/ · https://sharetraveler.com/pandemic-crushed-crowdsourced-shipping-companies/ · https://www.linkedin.com/posts/cameronrcraig_rip-airmule-the-most-audacious-peer-to-activity-7262560484367761408-SPmO · https://www.buyandship.com.sg/blog/buyandship-vs-airfrov-korean-proxy-services-singapore/ · https://east.vc/news/press-release/airfrov-500-thousand-funding · https://www.whois.com/whois/jastipkita.com · https://www.whois.com/whois/jastipkita.id · https://www.whois.com/whois/jastipkita.co.id · https://linktr.ee/jastipkita · https://www.instagram.com/jastipkita_indonesia/ · https://www.tiktok.com/@jastipkita_indonesia · https://www.facebook.com/p/JastipKita-100068106078812/
