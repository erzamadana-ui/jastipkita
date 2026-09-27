---
title: Kebijakan Barang Terlarang & Terbatas
description: Barang yang tidak boleh dititipkan, barang yang dibatasi, dan barang yang wajib dideklarasikan atau memerlukan izin, beserta dasar aturannya.
version: "0.1-template"
effectiveDate: "[TANGGAL BERLAKU — diisi saat peluncuran]"
order: 5
---

> **TEMPLATE — wajib direview konsultan hukum sebelum production launch; bukan nasihat hukum.**
>
> Tabel pada Bagian 3 dihasilkan dari `db/seeds/0101_restricted_items.sql` (aturan diverifikasi 2026-09-27 oleh tim riset; **belum ditinjau ahli kepabeanan/konsultan hukum**). Aturan berstatus DRAFT belum diterapkan otomatis di checkout. Daftar ini dapat berubah; versi aturan yang dipakai pada setiap titipan dicatat di transaksi.

**Versi:** 0.1 (draf) · **Berlaku sejak:** [TANGGAL BERLAKU] · **Penyelenggara:** [NAMA BADAN USAHA — PT/CV, menunggu pendirian]

## 1. Prinsip

1. **Barang titipan bukan barang pribadi Traveler.** Menurut Direktorat Jenderal Bea dan Cukai (pernyataan 2 Mei 2024) dan PMK 34 Tahun 2025, barang jastip tidak dikecualikan dari ketentuan larangan dan/atau pembatasan impor (lartas) dan dikenai bea & pajak atas nilai penuh.
2. JastipKita memeriksa setiap titipan terhadap daftar di bawah **sebelum** estimasi harga dan pembayaran. Klasifikasi paling berat yang berlaku: **PROHIBITED › PERMIT_REQUIRED › RESTRICTED › DECLARATION_REQUIRED › ALLOWED**.
3. Melampaui batas jumlah atau nilai pada suatu aturan membuat barang diperlakukan sebagai **PROHIBITED**.
4. Pemeriksaan otomatis adalah alat bantu. **Keputusan akhir ada pada Bea dan Cukai, Badan Karantina Indonesia, BPOM, dan instansi terkait.** Pengguna tetap wajib memastikan barangnya sesuai aturan.
5. JastipKita tidak akan pernah memberi "tips lolos bea cukai", menyarankan barang dipecah (*splitting*), atau menyamarkan titipan sebagai barang pribadi.

## 2. Arti klasifikasi

| Klasifikasi | Arti | Tindakan di aplikasi |
|---|---|---|
| **PROHIBITED** | Dilarang dititipkan melalui JastipKita (dilarang hukum, kebijakan platform, atau aturan penerbangan) | Checkout diblokir |
| **PERMIT_REQUIRED** | Membutuhkan izin/rekomendasi instansi (mis. BPOM, Polri, Karantina, Komdigi) | Persetujuan risiko wajib; bukti izin dapat diminta |
| **RESTRICTED** | Boleh dengan batas jumlah/kondisi tertentu (mis. BPOM, bagasi) | Persetujuan risiko wajib sebelum membayar |
| **DECLARATION_REQUIRED** | Wajib dideklarasikan/didaftarkan (mis. registrasi IMEI) | Persetujuan wajib; Traveler wajib deklarasi |
| **ALLOWED** | Tidak ada aturan khusus yang cocok | Tetap wajib deklarasi sebagai barang bukan pribadi |

## 3. Daftar aturan

### 3.1 Dilarang (PROHIBITED) — checkout diblokir

| Kode | Cakupan | Ketentuan | Batas | Dasar |
|---|---|---|---|---|
| `RI_ID_NARCOTICS_PSYCHOTROPICS` | kata kunci: narkotika, narkoba, ganja, marijuana, marihuana, cannabis, cbd, cbd oil … | Narkotika, psikotropika, produk ganja/CBD/THC, dan obat yang mengandung kodein/amfetamin dilarang dibawa masuk ke Indonesia. Sanksi pidana berat. | — | UU 35/2009 tentang Narkotika; UU 5/1997 tentang Psikotropika; Per BPOM 28/2023 (narkotika tidak diizinkan; psikotropika hanya WNA dengan resep maks. 90 hari). |
| `RI_ID_ALCOHOL_CATEGORY` | kategori Minuman Beralkohol | Minuman beralkohol tidak dapat dititipkan. Pembebasan cukai 1 liter hanya untuk konsumsi pribadi orang dewasa; kelebihan dimusnahkan Bea Cukai. Maskapai: >24% ABV maks. 5 L, >70% ABV dilarang. | DG penerbangan | PMK 82/2024 (pembebasan cukai penumpang: MMEA 1 liter/orang dewasa); PMK 34/2025 Pasal 13 (kelebihan dimusnahkan); kebijakan platform (barang kena cukai non-pribadi). |
| `RI_ID_TOBACCO_VAPE_CATEGORY` | kategori Rokok, Cerutu & Vape | Rokok, cerutu, tembakau, dan rokok elektrik/liquid tidak dapat dititipkan. Pembebasan cukai (mis. 200 batang sigaret, 30 ml liquid sistem terbuka) hanya untuk konsumsi pribadi. Vape wajib di kabin, tidak boleh di bagasi. | DG penerbangan | PMK 82/2024 (batas BKC penumpang); PMK 34/2025 Pasal 13; IATA DGR 67 Tabel 2.3.A (e-cigarettes). |
| `RI_ID_WEAPONS_CATEGORY` | kategori Senjata & Replika | Senjata api, airsoft/air gun, replika senjata, dan amunisi tidak dapat dititipkan. Impor memerlukan izin Polri. | DG penerbangan | UU Darurat 12/1951; Perpol 1/2022 (perizinan senjata api & peralatan yang digolongkan senjata api); IATA DGR (amunisi = barang berbahaya). |
| `RI_ID_FIREARMS_KEYWORD` | kata kunci: senjata api, firearm, handgun, senapan angin, airsoft, airsoft gun, airgun, gas blowback … | Senjata api, airsoft/air gun, replika senjata, dan amunisi tidak dapat dititipkan. | DG penerbangan | UU Darurat 12/1951; Perpol 1/2022; IATA DGR. |
| `RI_ID_SELF_DEFENSE_DEVICES` | kata kunci: pepper spray, semprotan merica, bear spray, stun gun, taser, setrum kejut, alat kejut listrik, tongkat listrik | Semprotan merica, stun gun/taser, dan alat pelumpuh lain dilarang di kabin maupun bagasi pesawat. | DG penerbangan | IATA passenger guidance (disabling devices forbidden in carry-on and checked baggage); kebijakan platform. |
| `RI_ID_PORNOGRAPHY` | kata kunci: pornografi, pornography, porn, hentai, film dewasa, adult video, majalah dewasa, adult magazine … | Barang bermuatan pornografi dilarang diimpor ke Indonesia. | — | UU 44/2008 tentang Pornografi Pasal 4 ayat (1) (dikutip akun resmi Bravo Bea Cukai; diverifikasi via hasil pencarian). |
| `RI_ID_SEX_TOYS` | kata kunci: sex toy, sex toys, alat bantu seks, dildo, fleshlight, onahole, masturbator | Alat bantu seks termasuk barang yang lazim ditegah Bea Cukai (UU Pornografi) dan tidak dapat dititipkan. | — | UU 44/2008 Pasal 4 ayat (1); penindakan BC Kualanamu 2020 (sex toys paling dominan) — diverifikasi via hasil pencarian. |
| `RI_ID_CASH_CATEGORY` | kategori Uang Tunai & Surat Berharga | JastipKita tidak melayani titipan uang tunai, valas, cek, atau surat berharga (bukan layanan transfer dana). Traveler wajib melapor ke Bea Cukai bila membawa uang/instrumen pembayaran senilai >= Rp100 juta; uang kertas asing >= Rp1 miliar hanya boleh dibawa badan berizin BI. | — | PMK 157/PMK.04/2017 jo PMK 100/2018 (deklarasi >= Rp100 juta; sanksi 10% maks. Rp300 juta); PBI 20/2/PBI/2018 (UKA >= Rp1 miliar); kebijakan platform. |
| `RI_ID_LIVE_ANIMALS` | kata kunci: hewan hidup, live animal, kitten, puppy, anak kucing, anak anjing, ikan hias hidup, live fish … | Hewan hidup tidak dapat dititipkan (wajib karantina, sertifikat kesehatan, dan izin maskapai). | — | UU 21/2019 tentang Karantina Hewan, Ikan, dan Tumbuhan; kebijakan platform. |
| `RI_ID_USED_CLOTHING_HS` | seluruh rute | Pakaian bekas dan barang bekas sejenis dilarang diimpor ke Indonesia. | — | Permendag 47/2025 tentang Barang yang Dilarang untuk Diimpor Pasal 2 (kantong bekas, karung bekas, pakaian bekas); mencabut Permendag 18/2021 jo 40/2022; berlaku 01-01-2026. |
| `RI_ID_USED_CLOTHING_KEYWORD` | kata kunci: pakaian bekas, baju bekas, used clothing, second hand clothing, secondhand clothing, karung bekas, kantong bekas, bal pakaian bekas | Pakaian bekas, kantong bekas, dan karung bekas dilarang diimpor ke Indonesia. | — | Permendag 47/2025 Pasal 2. |
| `RI_ID_USED_APPAREL` | kategori Pakaian; kata kunci: preloved, bekas, second hand, secondhand, used, thrift, thrifting, worn | Pakaian bekas/preloved dilarang diimpor ke Indonesia. Hanya pakaian baru yang dapat dititipkan. | — | Permendag 47/2025 Pasal 2 (pakaian bekas). |
| `RI_ID_COUNTERFEIT` | kata kunci: barang palsu, counterfeit, kw super, barang kw, tas kw, sepatu kw, jam kw, super copy … | Barang palsu/tiruan merek tidak dapat dititipkan dan dapat disita. | — | UU 20/2016 tentang Merek dan Indikasi Geografis; kebijakan platform (URL sumber belum diverifikasi). |
| `RI_ID_SIGNAL_JAMMER` | kata kunci: jammer, signal jammer, gps jammer, pengacak sinyal | Pengacak sinyal (jammer) tidak dapat dititipkan. | — | Kebijakan platform; dasar hukum spesifik (UU 36/1999 tentang Telekomunikasi — larangan gangguan) NEEDS_VERIFICATION. |
| `RI_ID_LARGE_LITHIUM` | kata kunci: power station, portable power station, hoverboard, electric scooter, skuter listrik, otopet listrik, sepeda listrik, e bike … | Power station portabel, hoverboard, skuter/sepeda listrik umumnya memakai baterai >160 Wh yang dilarang di pesawat penumpang. | DG penerbangan | IATA DGR 67th ed. Tabel 2.3.A (>160 Wh terlarang); FAA PackSafe. |
| `RI_ID_FLAMMABLES_EXPLOSIVES` | kata kunci: spray paint, cat semprot, pilox, pilok, lighter fluid, gas butana, butane, gas korek … | Bahan mudah terbakar, gas, bahan bakar, dan kembang api/bahan peledak dilarang di pesawat penumpang. | DG penerbangan | IATA DGR 67th ed. Tabel 2.3.A (lighter fuel & refills forbidden); IATA passenger guidance. |

### 3.2 Butuh izin (PERMIT_REQUIRED)

| Kode | Cakupan | Ketentuan | Batas | Dasar |
|---|---|---|---|---|
| `RI_ID_MEDICINE_PRESCRIPTION` | kata kunci: obat resep, prescription drug, prescription medicine, ozempic, wegovy, semaglutide, mounjaro, zepbound … | Obat keras/resep (termasuk injeksi GLP-1 seperti Ozempic/Mounjaro, antibiotik, isotretinoin, tretinoin, botox/filler) memerlukan resep dokter dan izin BPOM. Titip beli untuk orang lain berisiko disita. | — | Per BPOM 28/2023 (obat sesuai resep maks. 90 hari pengobatan; penggunaan pribadi); kebijakan platform. |
| `RI_ID_BLADES_SWORDS` | kata kunci: katana, samurai sword, wakizashi, tanto, pedang, belati, dagger, bayonet … | Senjata tajam (pedang/katana/belati) tidak boleh dimasukkan tanpa hak. Hanya replika tumpul/mainan atau barang yang jelas untuk keperluan sah yang dapat diproses setelah review admin. | — | UU Darurat 12/1951 Pasal 2 (senjata penikam/penusuk; pengecualian untuk pertanian, rumah tangga, pekerjaan sah, pusaka/barang kuno). |
| `RI_ID_WILDLIFE_CITES` | kata kunci: gading, ivory, kulit ular, python leather, snakeskin, kulit buaya, crocodile leather, alligator leather … | Produk dari satwa/tumbuhan dilindungi atau CITES (gading, kulit buaya/ular/biawak, penyu, karang) wajib dokumen CITES dari negara asal dan izin Indonesia. Tanpa dokumen, barang disita. | — | UU 5/1990 jo UU 32/2024 tentang Konservasi Sumber Daya Alam Hayati dan Ekosistemnya; CITES. |
| `RI_ID_ANIMAL_PRODUCTS_CATEGORY` | kategori Hewan & Produk Hewan | Hewan dan produk hewan wajib dilaporkan ke karantina (All Indonesia) dan disertai sertifikat kesehatan dari negara asal; tanpa dokumen dapat ditolak atau dimusnahkan. | — | UU 21/2019; Badan Karantina Indonesia (berita 06-04-2026). |
| `RI_ID_ANIMAL_PRODUCTS_KEYWORD` | kata kunci: daging, meat, wagyu, beef jerky, dendeng, sosis, sausage, ham … | Daging, olahan daging, telur mentah, susu segar, dan sarang burung walet adalah media pembawa karantina; wajib dokumen karantina negara asal. | — | UU 21/2019; Badan Karantina Indonesia (berita 06-04-2026). |
| `RI_ID_PLANTS_SEEDS_CATEGORY` | kategori Tanaman & Benih | Tanaman, benih, bibit, buah & sayur segar wajib sertifikat fitosanitari negara asal dan dilaporkan ke karantina; tanpa dokumen dapat dimusnahkan. | — | UU 21/2019 tentang Karantina Hewan, Ikan, dan Tumbuhan; Badan Karantina Indonesia. |
| `RI_ID_PLANTS_KEYWORD` | kata kunci: benih, bibit, seeds, biji tanaman, umbi, tanaman hidup, live plant, bonsai … | Nama barang mengindikasikan tanaman/benih/buah segar yang diawasi karantina. | — | UU 21/2019; Badan Karantina Indonesia. |
| `RI_ID_DRONES` | kata kunci: drone, dji mini, dji mavic, dji air, dji avata, dji neo, dji flip, quadcopter … | Drone wajib dideklarasikan, memerlukan sertifikasi perangkat (SDPPI) dan registrasi/izin operasi Kemenhub. Baterai cadangan hanya di kabin. | DG penerbangan | Permenkominfo 16/2018 (sertifikasi alat/perangkat telekomunikasi); PM Perhubungan 37/2020 (pengoperasian pesawat udara tanpa awak); IATA DGR (baterai). Sumber sekunder: drone.co.id (2022). |
| `RI_ID_RADIO_DEVICES` | kata kunci: walkie talkie, handy talky, radio ht, transceiver, ham radio, baofeng, starlink, radio pemancar | Perangkat pemancar radio (HT/walkie talkie, transceiver, terminal satelit) wajib bersertifikat SDPPI sebelum digunakan/diedarkan di Indonesia. | — | Permenkominfo 16/2018 tentang Ketentuan Operasional Sertifikasi Alat dan/atau Perangkat Telekomunikasi. |

### 3.3 Terbatas (RESTRICTED)

| Kode | Cakupan | Ketentuan | Batas | Dasar |
|---|---|---|---|---|
| `RI_ID_MEDICINE_CATEGORY` | kategori Obat | Obat hanya untuk penggunaan pribadi: maks. 30 pcs per jenis (tablet/kapsul) atau 3 pcs per jenis (cair/aerosol) tanpa resep. Barang titipan dianggap bukan barang pribadi traveler dan dapat ditahan Bea Cukai/BPOM. | maks. 30 | Per BPOM 28/2023 (mengubah Per BPOM 27/2022) — batas barang bawaan pribadi; DJBC 02-05-2024: barang jastip tidak dikecualikan dari lartas. |
| `RI_ID_SUPPLEMENTS_CATEGORY` | kategori Suplemen & Vitamin | Suplemen & obat tradisional: maks. 5 pcs per jenis per penumpang untuk penggunaan pribadi. Jumlah komersial memerlukan izin edar BPOM. | maks. 5 | Per BPOM 28/2023 — batas barang bawaan pribadi (5 pcs/jenis). |
| `RI_ID_COSMETICS_CATEGORY` | kategori Kosmetik & Skincare | Kosmetik & skincare: maks. 20 pcs per penumpang untuk penggunaan pribadi (total semua jenis per traveler per kedatangan). Jumlah komersial memerlukan notifikasi BPOM. | maks. 20 | Per BPOM 28/2023 — batas barang bawaan pribadi (20 pcs); DJBC 02-05-2024 (jastip tidak dikecualikan dari lartas). |
| `RI_ID_PERFUME_CATEGORY` | kategori Parfum | Parfum termasuk kosmetik (maks. 20 pcs per penumpang). Aturan maskapai: toiletries maks. 0,5 L per wadah dan total 2 L/2 kg per orang; di kabin maks. 100 ml per wadah. | maks. 20, DG penerbangan | Per BPOM 28/2023; IATA DGR 67 Tabel 2.3.A (medicinal/toilet articles). |
| `RI_ID_FOOD_CATEGORY` | kategori Makanan & Camilan | Pangan olahan untuk penggunaan pribadi maks. 5 kg per penumpang. Produk berbahan daging/susu/tumbuhan segar dapat memerlukan dokumen karantina. | — | Per BPOM 28/2023 (pangan olahan 5 kg/penumpang); UU 21/2019 tentang Karantina Hewan, Ikan, dan Tumbuhan. |
| `RI_ID_BEVERAGES_CATEGORY` | kategori Minuman Non-Alkohol | Minuman (pangan olahan) untuk penggunaan pribadi dalam jumlah wajar (bagian dari batas 5 kg). Cairan di kabin maks. 100 ml per wadah — bawa di bagasi tercatat. | — | Per BPOM 28/2023 (pangan olahan); aturan keamanan kabin maskapai. |
| `RI_ID_INFANT_FORMULA` | kata kunci: susu formula, infant formula, formula milk, susu bayi, baby formula | Susu formula bayi termasuk pangan olahan yang diawasi BPOM; hanya jumlah wajar untuk penggunaan pribadi. | — | Per BPOM 28/2023 (pangan olahan). |
| `RI_ID_ALCOHOL_KEYWORD` | kata kunci: minuman beralkohol, alcoholic beverage, sake, soju, makgeolli, umeshu, shochu, whisky … | Nama barang mengindikasikan minuman beralkohol. Jika benar beralkohol, pilih kategori Minuman Beralkohol (tidak dapat diproses). Jika bukan, lanjutkan dengan konfirmasi. | DG penerbangan | PMK 82/2024; kebijakan platform (jaring pengaman kategori). |
| `RI_ID_TOBACCO_VAPE_KEYWORD` | kata kunci: rokok, cigarette, cigarettes, cerutu, cigar, tembakau, tobacco, vape … | Nama barang mengindikasikan produk tembakau/vape. Jika benar, pilih kategori Rokok, Cerutu & Vape (tidak dapat diproses). | DG penerbangan | PMK 82/2024; kebijakan platform (jaring pengaman kategori). |
| `RI_ID_KNIVES` | kata kunci: pisau, knife, kitchen knife, pisau dapur, santoku, gyuto, pisau lipat, pocket knife | Pisau dapur/rumah tangga boleh, hanya di bagasi tercatat (dilarang di kabin). Pisau lipat/taktis dapat dianggap senjata tajam. | — | UU Darurat 12/1951 Pasal 2 (pengecualian pekerjaan rumah tangga); aturan keamanan kabin maskapai. |
| `RI_ID_CASH_KEYWORD` | kata kunci: uang tunai, uang kertas asing, valas, foreign currency, banknote, banknotes, traveler cheque, travellers cheque … | Nama barang mengindikasikan uang/valas. Titipan uang tidak dilayani; uang koleksi (numismatik) hanya setelah review admin. | — | PMK 157/PMK.04/2017 jo PMK 100/2018; PBI 20/2/PBI/2018; kebijakan platform. |
| `RI_ID_POWERBANK_CATEGORY` | kategori Baterai & Power Bank | Power bank & baterai cadangan hanya di kabin (dilarang di bagasi). <=100 Wh: maks. 20 unit per orang (IATA; maskapai sering lebih ketat, mis. 2 unit). 100-160 Wh: izin maskapai, maks. 2. >160 Wh: dilarang. | maks. 20, DG penerbangan | IATA DGR 67th ed. Tabel 2.3.A; FAA PackSafe (diperbarui 10-08-2026). |
| `RI_ID_POWERBANK_KEYWORD` | kata kunci: power bank, powerbank, portable charger, battery pack, baterai cadangan, spare battery, baterai lithium, lithium battery … | Baterai lithium cadangan/power bank hanya di kabin; batas Wh dan jumlah mengikuti IATA & maskapai. | maks. 20, DG penerbangan | IATA DGR 67th ed. Tabel 2.3.A; FAA PackSafe. |
| `RI_ID_AEROSOLS_CATEGORY` | kategori Aerosol & Bahan Mudah Terbakar | Aerosol toiletries (non-mudah terbakar): maks. 0,5 kg/0,5 L per wadah dan total 2 kg/2 L per orang. Aerosol non-toiletries yang mudah terbakar (cat semprot, gas) dilarang. | DG penerbangan | IATA DGR 67th ed. Tabel 2.3.A (medicinal/toilet articles & Division 2.2 aerosols). |

### 3.4 Wajib deklarasi (DECLARATION_REQUIRED)

| Kode | Cakupan | Ketentuan | Batas | Dasar |
|---|---|---|---|---|
| `RI_ID_MOBILE_PHONES_CATEGORY` | kategori Ponsel | Ponsel wajib dideklarasikan dan IMEI didaftarkan atas paspor traveler (maks. 2 unit per penumpang per kedatangan, termasuk ponsel pribadi traveler), di bandara atau maks. 60 hari setelah tiba. Bea & pajak impor dibayar saat registrasi. | maks. 2 | PER-13/BC/2021 jo PER-7/BC/2023; Permenkominfo 1/2020 (IMEI); deklarasi HKT via All Indonesia. |
| `RI_ID_HKT_KEYWORD` | kata kunci: smartphone, handphone, ponsel, telepon seluler, mobile phone, ipad cellular, tablet lte, tablet 5g … | Perangkat seluler (ponsel, tablet seluler, modem/MiFi) wajib registrasi IMEI atas paspor traveler, maks. 2 unit per penumpang per kedatangan. | — | PER-13/BC/2021 jo PER-7/BC/2023; Permenkominfo 1/2020. |

### 3.5 Dalam kajian (DRAFT — belum berlaku otomatis)

| Kode | Cakupan | Klasifikasi kandidat | Ketentuan | Catatan verifikasi |
|---|---|---|---|---|
| `RI_ID_HONEY_DAIRY` | kata kunci: madu, honey, manuka, keju, cheese, butter, mentega, yogurt | PERMIT_REQUIRED | Madu dan produk susu dapat termasuk produk hewan yang diawasi karantina. | NEEDS_VERIFICATION: apakah madu/keju/mentega kemasan ritel untuk jastip wajib sertifikat karantina (UU 21/2019) atau cukup pemeriksaan; risiko false-positive tinggi (mis. snack rasa keju/madu). |
| `RI_ID_USED_FOOTWEAR` | kategori Sepatu; kata kunci: preloved, bekas, second hand, secondhand, used, worn | PROHIBITED | Sepatu bekas kemungkinan termasuk barang bekas yang dilarang impor. | NEEDS_VERIFICATION: cakupan HS larangan Permendag 47/2025 (apakah HS 6309 "worn clothing and other worn articles" termasuk alas kaki bekas yang diklasifikasikan di bab 64). |
| `RI_ID_RICE_SUGAR` | kata kunci: beras, beras jepang, japanese rice, koshihikari, gula pasir, granulated sugar | PROHIBITED | Beras dan gula tertentu termasuk barang yang dilarang diimpor. | NEEDS_VERIFICATION: Permendag 47/2025 Pasal 2 mencantumkan gula dan beras — pos tarif (HS) yang dilarang dan penerapannya pada barang bawaan penumpang non-pribadi belum dikonfirmasi. |
| `RI_ID_GAMBLING_DEVICES` | kata kunci: mesin judi, slot machine, mesin slot, pachislot, pachislo, pachinko machine, mesin pachinko | PROHIBITED | Mesin/alat perjudian tidak dapat dititipkan. | NEEDS_VERIFICATION: perjudian dilarang KUHP; status larangan/pembatasan impor mesin judi untuk barang penumpang belum dikonfirmasi dari sumber primer. |
| `RI_JP_TAXFREE_NOT_FOR_RESALE` | rute JP | RESTRICTED | Fasilitas tax-free/refund pajak konsumsi Jepang hanya untuk barang pribadi wisatawan, bukan untuk dijual kembali. Barang titipan harus dibeli dengan harga termasuk pajak konsumsi; mulai 1 Nov 2026 sistem berubah menjadi refund saat keberangkatan. | NEEDS_VERIFICATION: sumber sekunder (japan-guide.com); perlu konfirmasi dari National Tax Agency/Japan Tourism Agency. Rule tingkat rute (berlaku untuk semua item JP) — pertimbangkan sebagai catatan harga, bukan acknowledgement. |

## 4. Ketentuan penerbangan

Selain aturan impor, Traveler wajib mematuhi aturan barang berbahaya (IATA Dangerous Goods) dan kebijakan maskapai, misalnya power bank dan baterai cadangan hanya di kabin dengan batas kapasitas, aerosol dan cairan mudah terbakar dibatasi, serta pisau hanya di bagasi tercatat. Maskapai berhak menolak barang.

## 5. Pelanggaran

Menitipkan atau membawa barang terlarang, menyamarkan deskripsi barang, atau memberikan keterangan palsu kepada petugas adalah pelanggaran berat: transaksi dapat dibatalkan, dana ditahan untuk penyelesaian sengketa, akun ditangguhkan atau ditutup, dan pelanggaran dilaporkan kepada pihak berwenang bila diwajibkan hukum.

## 6. Pelaporan

Temukan barang terlarang di Platform? Laporkan melalui menu **Laporkan** di aplikasi atau [E-MAIL CS].
