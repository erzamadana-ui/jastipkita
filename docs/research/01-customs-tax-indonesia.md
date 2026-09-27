# 01 — Kepabeanan & Pajak Impor Barang Bawaan Penumpang (Indonesia)

> Status: **riset awal, belum diverifikasi ahli kepabeanan/PPJK**. Semua sumber diverifikasi (dibuka) pada **2026-09-27** oleh research-agent.
> Nilai yang tidak dapat dikonfirmasi dari sumber primer ditandai **`NEEDS_VERIFICATION`**.
> Seed terkait: `db/seeds/0100_customs_rules.sql`, `db/seeds/0101_restricted_items.sql`.

## Ringkasan eksekutif

1. **Dasar hukum yang berlaku hari ini:** PMK 203/PMK.04/2017 sebagaimana diubah **PMK 34 Tahun 2025** (ditetapkan 26-05-2025, diundangkan 28-05-2025, **berlaku 06-06-2025**, BN 2025 No. 371). Belum ada perubahan lebih baru per 2026-09-27 (halaman relasi JDIH hanya mencantumkan PMK 34/2025 sebagai pengubah dan PMK 82/2024 sebagai pencabut sebagian untuk pembebasan cukai).
2. **Barang pribadi penumpang:** bebas bea masuk s.d. **FOB USD 500 per orang per kedatangan**; dalam batas itu **tidak dipungut PPN/PPnBM dan dikecualikan dari PPh** (Pasal 12 ayat (1) & (5)).
3. **Barang pribadi di atas USD 500:** bea masuk **10%** atas kelebihan nilai (nilai pabean − USD 500); **PPN (dan PPnBM bila ada) dipungut**; **PPh dikecualikan** (Pasal 24 ayat (1)). Perlakuan PPh ini berlaku surut sejak 01-01-2025 (Pasal II ayat (1)).
4. **Barang yang BUKAN barang pribadi (termasuk jastip):** Pasal 24 ayat (3) PMK 34/2025 — **bea masuk 10% flat atas keseluruhan nilai pabean** (bukan lagi tarif MFN seperti PMK 203/2017 asli), **PPN/PPnBM sesuai tarif**, dan **PPh 5% dari nilai impor**. Tidak ada pembebasan USD 500.
5. **PPN impor 2026:** PMK 131/2024 — barang non-mewah: **12% × DPP nilai lain 11/12 × nilai impor** (efektif 11%); barang mewah (kena PPnBM): 12% × nilai impor. Tidak ada perubahan tarif PPN yang terkonfirmasi untuk 2026, tetapi Menkeu menyebut evaluasi akhir 2026 → **risiko perubahan**.
6. **PPnBM:** daftar barang mewah selain kendaraan (PMK 96/PMK.03/2021 jo PMK 15/PMK.03/2023) hanya hunian mewah, balon udara, peluru & senjata api, pesawat, kapal pesiar/yacht. **Tas/jam/perhiasan/parfum branded TIDAK kena PPnBM.**
7. **Jastip = non-pribadi** menurut DJBC (pernyataan Direktur Teknis Kepabeanan, 2 Mei 2024) dan **tidak dikecualikan dari lartas** (larangan/pembatasan impor). Ini risiko hukum utama model bisnis (lihat §6).

---

## 1. PMK 34/2025 — ketentuan inti

| Aspek | Ketentuan | Sumber |
|---|---|---|
| Tanggal | Ditetapkan 26-05-2025; diundangkan 28-05-2025; **berlaku 06-06-2025** | [JDIH PMK 34/2025](https://jdih.kemenkeu.go.id/dok/pmk-34-tahun-2025) |
| Pembebasan barang pribadi penumpang umum | Nilai pabean paling banyak **FOB USD 500,00 per orang per kedatangan** → pembebasan bea masuk (Pasal 12 ayat (1)) | [Teks PMK (PDF)](https://jdih.kemenkeu.go.id/api/download/4509c489-5dfb-42b7-a4a0-0f88295ffa85/2025pmkeuangan034.pdf) |
| PDRI atas barang pribadi dalam batas | "tidak dipungut PPN atau PPN dan PPnBM; dan dikecualikan dari pemungutan PPh" (Pasal 12 ayat (5)) | idem |
| Jemaah haji khusus / awak sarana pengangkut | USD 2.500 (Pasal 24 ayat (1a)) / **USD 50** per awak (Pasal 14 ayat (1), Pasal 24 ayat (2)) | idem, [pasal.id](https://pasal.id/peraturan/pmk/pmk-no-34-tahun-2025) |
| Barang pribadi melebihi batas | Tarif BM **10%**; nilai pabean = keseluruhan − batas pembebasan; PPN/PPnBM dipungut; **PPh dikecualikan** (Pasal 24 ayat (1)) | idem |
| Barang selain barang pribadi (Pasal 7 ayat (1) huruf b) | Tarif BM **10%**; nilai pabean = **keseluruhan** nilai pabean; PPN/PPnBM dipungut sesuai tarif; **PPh 5% dari nilai impor** (Pasal 24 ayat (3)) | idem (dicek dua kali: PDF JDIH & pasal.id) |
| Bea masuk tambahan | Barang penumpang dikecualikan dari BMAD, BMTP (safeguard), BM imbalan, BM pembalasan (Pasal 25A baru) | idem, [DDTC](https://news.ddtc.co.id/berita/nasional/1811151/pmk-342025-tegaskan-ketentuan-perpajakan-atas-barang-bawaan-penumpang) |
| Barang kena cukai | Pembebasan cukai per orang dewasa "sesuai ketentuan tata cara pembebasan cukai" (→ PMK 82/2024); **kelebihan langsung dimusnahkan** (Pasal 13) | PDF PMK |
| Penetapan | Pejabat Bea dan Cukai menetapkan tarif & nilai pabean (Pasal 23); dicatat dalam Customs Declaration (Pasal 25) | PDF PMK |
| Retroaktif PPh | Perlakuan PPh barang pribadi berlaku atas impor sejak 01-01-2025 (Pasal II ayat (1)); tidak berlaku untuk barang non-pribadi | PDF PMK |

### 1.1 Apa yang berubah dari PMK 203/2017 asli
- PMK 203/2017 Pasal 24 ayat (3) asli: barang non-pribadi dikenai **tarif bea masuk umum (MFN, BTKI)** — dikonfirmasi dari [teks PMK 203/2017](https://jdih.kemenkeu.go.id/api/download/2898f481-24d0-4620-bf60-ec74a6624c44/203~PMK.04~2017Per.pdf) dan pernyataan DJBC Mei 2024 ("dipungut bea masuk (tarif MFN), PPN, dan PPh Pasal 22 Impor") ([Bisnis.com, 02-05-2024](https://ekonomi.bisnis.com/read/20240502/259/1762362/barang-bawaan-dari-luar-negeri-tak-dibatasi-bea-cukai-wanti-wanti-jastiper)).
- PMK 34/2025: non-pribadi → **10% flat**, PPh **5%**. Siaran pers yang dimuat ulang media: "Tarif ini juga berlaku untuk barang bawaan penumpang yang bukan barang pribadi … PPN 12% dan PPh Pasal 22 impor sebesar 5%" ([tvOne, 04-06-2025](https://www.tvonenews.com/berita/nasional/340086-terbitnya-pmk-342025-sederanakan-aturan-barang-bawaan-penumpang); [Republika, 04-06-2025](https://republika.co.id/berita/sxbgwm472/pmk-342025-terbit-sederhanakan-aturan-barang-bawaan-penumpang)).

### 1.2 Konflik sumber yang ditemukan (dicatat terbuka)
| Konflik | Sumber A | Sumber B | Keputusan riset |
|---|---|---|---|
| PPN atas barang pribadi > USD 500 | Ringkasan media (tvOne) menyebut "dibebaskan dari PPN dan PPh" | Teks PMK Pasal 24 ayat (1): PPN/PPnBM **dipungut**, PPh dikecualikan | Ikuti teks PMK (primer). |
| Tarif pada FAQ resmi DJBC | [FAQ beacukai.go.id](https://www.beacukai.go.id/faq/ketentuan-barang-bawaan-pribadi-penumpang-dan-jasa-titipan-jastip-.html): "BM 10% (flat), PPN 11%, PPh 0,5–10% (NPWP) / 1–20% (tanpa NPWP)" | PMK 34/2025 + PMK 131/2024 | FAQ tampak **usang** (pra-2025). Ikuti PMK. |
| PPh tanpa NPWP untuk non-pribadi | PMK 34/2025 Pasal 24 tidak menyebut NPWP/API sama sekali (flat 5%) | UU PPh Pasal 22 ayat (3) (sebagaimana diubah UU 36/2008) mengatur tarif 100% lebih tinggi bagi WP tanpa NPWP; halaman IMEI [BC Ngurah Rai](https://ngurahrai.beacukai.go.id/mandatory/registrasi-imei.html) masih menulis PPh 10%/20% | **`NEEDS_VERIFICATION`** — seed v1 ACTIVE memakai 5% untuk semua; v2 DRAFT memakai 10% tanpa NPWP. |
| Nilai JPY pada provider "BI" di Frankfurter | lihat `03-fx-providers.md` | — | Jangan dipakai untuk JPY tanpa normalisasi. |

## 2. Jastip: bagaimana Bea Cukai memperlakukannya

- **Tidak ada pasal khusus "jastip"** di PMK 34/2025 maupun FAQ DJBC (FAQ berjudul "…dan Jasa Titipan (Jastip)" pun tidak memuat aturan spesifik).
- **Penentuan "pribadi vs bukan pribadi" adalah kewenangan pejabat BC** (Pasal 23). Indikator lapangan yang dikenal: jumlah tidak wajar, barang identik berulang, label/nota atas nama orang lain, frekuensi perjalanan. Barang non-pribadi diproses di **jalur merah** (pemeriksaan fisik) — [BC Lampung](https://lampung.beacukai.go.id/mandatory/barang-penumpang.html).
- **DJBC, 2 Mei 2024** (Fadjar Donny Tjahjadi, Direktur Teknis Kepabeanan): "barang bukan pribadi penumpang … tidak dikecualikan dari lartas" dan "barang jastip tidak mendapat pengecualian lartas, nanti ada konsekuensi" ([Bisnis.com](https://ekonomi.bisnis.com/read/20240502/259/1762362/barang-bawaan-dari-luar-negeri-tak-dibatasi-bea-cukai-wanti-wanti-jastiper)). Permendag 7/2024 hanya membebaskan **barang pribadi** penumpang dari lartas ([Hukumonline](https://www.hukumonline.com/berita/a/impor-barang-bawaan-penumpang-berjalan-normal-pasca-permendag-7-2024-lt6642b4c7bb37b/)).
- Konsekuensi praktis: barang jastip yang tergolong lartas (kosmetik/pangan/obat komersial → BPOM; HKT → IMEI & ketentuan impor; elektronik tertentu → SNI/postel; barang bekas → dilarang) dapat **ditahan, direekspor, atau dimusnahkan** bila izin tidak ada. Platform tidak dapat "menghilangkan" risiko ini — hanya mengungkapkannya (disclosure) dan mengestimasi PDRI.

## 3. PPN, PPnBM, PPh

### 3.1 PPN impor 2026
- **PMK 131/2024** ([BPK](https://peraturan.bpk.go.id/Details/311485/pmk-no-131-tahun-2024), [PDF](https://peraturan.bpk.go.id/Download/372221/131%20th%202024.pdf)): Pasal 2 — barang mewah: 12% × harga jual/nilai impor; **Pasal 3 — selain barang mewah: 12% × DPP nilai lain 11/12 dari nilai impor** (efektif 11%). Berlaku 01-01-2025. Status BPK: berlaku, tidak ada catatan perubahan.
- 2026: "tidak ada perubahan kebijakan [PPN]" (Dirjen SEF Febrio, 17-08-2025, [DDTC](https://news.ddtc.co.id/berita/nasional/1812992/tak-berubah-tarif-ppn-12-tetap-berlaku-untuk-barang-mewah-di-2026)); Menkeu Purbaya 15-12-2025: belum ada rencana naik/turun, evaluasi menyeluruh akhir 2026 ([Bisnis.com](https://ekonomi.bisnis.com/read/20251215/259/1936886/tarif-ppn-2026-naik-atau-turun-ini-kata-purbaya)).
- **Penerapan DPP 11/12 pada Customs Declaration penumpang:** secara hukum Pasal 3 PMK 131/2024 berlaku untuk seluruh impor BKP non-mewah; **praktik di formulir CD penumpang belum dikonfirmasi** (`NEEDS_VERIFICATION`, selisih nol bila dihitung benar karena 12%×11/12 = 11%).
- Catatan numerik: kolom `vat_dpp_factor numeric(9,6)` menyimpan **0.916667** (bukan 11/12 eksak) → PPN = nilai × 0,11000004. Selisih ≈ Rp0,04 per Rp1 juta; tertutup pembulatan. Engine boleh mengenali 0.916667 sebagai 11/12 bila ingin eksak.

### 3.2 PPnBM
- Daftar non-kendaraan (PMK 96/PMK.03/2021 jo PMK 15/PMK.03/2023; [JDIH](https://jdih.kemenkeu.go.id/dok/96-pmk-03-2021/summary), [DDTC](https://news.ddtc.co.id/berita/nasional/31670/pmk-962021-ini-daftar-barang-mewah-yang-kena-ppnbm-20-hingga-75)): hunian mewah ≥ Rp30 M (20%); balon udara & peluru/senjata api (40%); pesawat & senjata api (50%); kapal pesiar/yacht (75%). Kendaraan bermotor diatur terpisah.
- **Implikasi:** kategori app `LUXURY_GOODS`, `WATCHES_JEWELRY`, `PERFUME` → **PPnBM 0** dan PPN tetap memakai DPP 11/12. Senjata api/peluru (satu-satunya yang relevan) sudah **PROHIBITED** di restricted items.

### 3.3 PPh Pasal 22 impor
| Perlakuan | Tarif | Dasar | Status |
|---|---|---|---|
| Pribadi ≤ USD 500 | 0 (dikecualikan) | Pasal 12(5) | Terkonfirmasi |
| Pribadi > USD 500 | 0 (dikecualikan) | Pasal 24(1) | Terkonfirmasi |
| Non-pribadi (jastip), dengan NPWP | **5% × nilai impor** | Pasal 24(3) | Terkonfirmasi |
| Non-pribadi, tanpa NPWP | 5% (teks PMK) atau **10%** (UU PPh Pasal 22 ayat (3)) | — | **`NEEDS_VERIFICATION`** |
| NPWP siapa? | Pada CD penumpang, importir = **penumpang (traveler)**, bukan penitip. Sejak NIK berfungsi sebagai NPWP bagi WP orang pribadi penduduk, mayoritas traveler WNI kemungkinan dianggap ber-NPWP | — | **`NEEDS_VERIFICATION`** (praktik bandara) |

## 4. Nilai pabean, kurs, pembulatan

- **Basis nilai:** PMK memakai istilah "nilai pabean … **FOB** USD 500". Untuk barang bawaan tidak ada komponen freight/asuransi terpisah; dalam praktik nilai diambil dari **nota/struk (harga transaksi)** dan dapat ditetapkan pejabat (Pasal 23). Engine: `customsValue = harga beli aktual (termasuk pajak penjualan negara asal yang benar-benar dibayar) × qty × kurs`. Bila traveler memakai fasilitas tax-free/refund di negara asal, nilai transaksinya berubah (lihat §5.6).
- **Kurs:** Keputusan Menteri Keuangan mingguan "**Nilai kurs sebagai dasar pelunasan bea masuk, PPN, PPnBM, bea keluar, dan PPh**", periode **Rabu–Selasa**. Terbaru: **KMK 45/MK/EF.2/2026 berlaku 23–29 Sep 2026**: USD 17.707,00; JPY 11.371,25 **per 100 JPY**; SGD 13.893,47; KRW 12,92; MYR 4.335,21; AUD 12.604,12; EUR 20.369,44 ([fiskal.kemenkeu.go.id](https://fiskal.kemenkeu.go.id/informasi-publik/kurs-pajak), [daftar KMK](https://fiskal.kemenkeu.go.id/peraturan/kmk-kurs-pajak)). Ada "Layanan API Nilai Kurs" gratis (Rp0) tetapi prosedur akses tidak dipublikasikan ([halaman layanan](https://fiskal.kemenkeu.go.id/layanan/layanan-api-nilai-kurs)) → `NEEDS_VERIFICATION`.
- **Kurs yang relevan adalah kurs pada minggu kedatangan**, bukan saat checkout. Selisih kurs KMK vs pasar per 25–27 Sep 2026: KMK USD 17.707 vs JISDOR 17.917 (1,2%) — gunakan buffer.
- **Pembulatan:** PMK 190/2022 Pasal 22 ayat (4): **bea masuk dan cukai dibulatkan ke atas ke ribuan rupiah penuh** per pemberitahuan impor; PDRI (PPN/PPh) mengikuti ketentuan perpajakan ([DDTC, 16-10-2023](https://news.ddtc.co.id/berita/nasional/1797874/bea-masuk-dan-cukai-impor-dibulatkan-ribuan-ke-atas-begini-contohnya)). Penerapan pada CD penumpang: `NEEDS_VERIFICATION`. Engine JastipKita menerapkan satu aturan `rounding` ke semua komponen; seed memakai `CEIL_1000` → estimasi **konservatif** (maks. +Rp999 per komponen).

## 5. Rezim khusus

### 5.1 Ponsel, komputer genggam, tablet (HKT) — IMEI/CEIR
| Aspek | Ketentuan | Sumber |
|---|---|---|
| Batas unit | **Paling banyak 2 unit per penumpang/awak** per kedatangan | [BC Ngurah Rai](https://ngurahrai.beacukai.go.id/mandatory/registrasi-imei.html) (PER-13/BC/2021 jo PER-7/BC/2023; Permenkominfo 1/2020) |
| Waktu | Di kawasan pabean saat tiba, atau **≤ 60 hari** sejak kedatangan | idem |
| Kanal | Deklarasi HKT di **All Indonesia** / aplikasi Mobile Bea Cukai / portal beacukai.go.id | [Media Keuangan, 03-01-2026](https://mediakeuangan.id/detail/351482/aturan-barang-bawaan-penumpang-luar-negeri-berlaku-ketat-mulai-2026) |
| Siapa bayar | **Penumpang** (atas namanya; dokumen: paspor, tiket, boarding pass, perangkat) | BC Ngurah Rai |
| Pajak | Halaman BC masih menulis BM 10%, PPN 11%, PPh 10%/20% — **tidak sinkron** dengan PMK 34/2025 | `NEEDS_VERIFICATION` |
| Implikasi jastip | IMEI terdaftar atas **paspor traveler**, bukan penitip. Ponsel titipan = non-pribadi → PDRI penuh (§3). Kuota 2 unit dibagi dengan ponsel pribadi traveler. | analisis |

### 5.2 Minuman beralkohol & hasil tembakau (PMK 82/2024)
Per **orang dewasa** per kedatangan ([beacukai.go.id – Fasilitas Pembebasan Cukai](https://www.beacukai.go.id/fasilitas-pembebasan-cukai)):

| Barang | Penumpang | Awak |
|---|---|---|
| Sigaret | 200 batang | 40 batang |
| Cerutu | 25 batang | 10 batang |
| Tembakau iris / HPTL lainnya | 100 g | 40 g |
| Rokok elektrik padat | 140 batang atau 40 kapsul | 20 batang / 5 kapsul |
| Rokok elektrik cair sistem terbuka | 30 ml | 15 ml |
| Rokok elektrik cair sistem tertutup | 12 ml | 6 ml |
| Minuman mengandung etil alkohol | **1 liter** | 350 ml |

Kelebihan **langsung dimusnahkan** (PMK 34/2025 Pasal 13). PMK 82/2024 telah diubah PMK 113/2025 dan PMK 34/2026 (ditetapkan 20-05-2026; menurut ringkasan sekunder menyangkut pembebasan cukai etil alkohol untuk industri) — **pengaruh ke batas penumpang tidak terlihat, `NEEDS_VERIFICATION`** ([JDIH PMK 82/2024](https://jdih.kemenkeu.go.id/dok/pmk-82-tahun-2024), [PMK 34/2026](https://jdih.kemenkeu.go.id/dok/pmk-34-tahun-2026)).
**Keputusan desain:** alkohol & tembakau/vape **untuk orang lain** = barang kena cukai non-pribadi (butuh pelunasan cukai + perizinan impor) → **PROHIBITED** di platform (lihat seed 0101), bukan dimodelkan di `customs_rules`.

### 5.3 Uang tunai & instrumen pembayaran
- Membawa **≥ Rp100 juta** (atau ekuivalen valas) keluar/masuk wajib diberitahukan ke BC; sanksi **10%, maks. Rp300 juta** (PMK 157/PMK.04/2017 jo PMK 100/2018) ([DDTC, 28-02-2024](https://news.ddtc.co.id/berita/nasional/1800917/awas-denda-10-jika-keluar-masuk-ri-bawa-uang-tunai-rp100-juta-lebih)).
- **Uang kertas asing ≥ Rp1 miliar** hanya boleh dibawa **badan berizin** (bank/KUPVA dengan izin & kuota BI); sanksi 10%, maks. Rp300 juta (PBI 20/2/PBI/2018) ([Hukumonline](https://www.hukumonline.com/berita/a/ingat-bawa-uang-asing-rp1-miliar-lebih-tanpa-izin-bisa-kena-denda-lt5b8e58817d517/), [PDF BI](https://www.bi.go.id/id/publikasi/peraturan/Documents/PBI_200218.pdf)).
- **Implikasi:** traveler **tidak boleh** membawa uang tunai milik penitip/menjadi kurir uang (juga menyentuh izin transfer dana BI) → kategori `CASH_VALUABLES` PROHIBITED.

### 5.4 Deklarasi elektronik (e-CD → All Indonesia)
- **All Indonesia** (allindonesia.imigrasi.go.id) menggabungkan deklarasi imigrasi, pabean, kesehatan, karantina; uji coba 24-07-2025, **wajib 01-10-2025** untuk kedatangan internasional; dapat diisi **≤ 3 hari sebelum kedatangan** ([Wikipedia](https://en.wikipedia.org/wiki/All_Indonesia_Arrival_Card) — sekunder).
- Portal [ecd.beacukai.go.id](https://ecd.beacukai.go.id/) kini mengarahkan kedatangan **udara & laut → All Indonesia**, sedangkan **e-CD tetap untuk kedatangan darat** (primer).
- Wajib dideklarasikan: barang melebihi pembebasan, barang non-pribadi, HKT (IMEI), BKC di atas batas, uang ≥ Rp100 juta, media pembawa karantina.

### 5.5 Obat & makanan (BPOM) — batas barang pribadi penumpang
Per BPOM 28/2023 (mengubah Per BPOM 27/2022) via [DDTC 05-10-2024](https://news.ddtc.co.id/berita/nasional/1806003/penumpang-bawa-obat-dan-makanan-dari-luar-negeri-begini-ketentuannya): obat padat **30 pcs/jenis** (tanpa resep) atau sesuai resep ≤ 90 hari; obat cair/aerosol **3 pcs/jenis**; psikotropika hanya WNA dengan resep; **narkotika dilarang**; obat tradisional & suplemen **5 pcs/jenis**; **kosmetik 20 pcs**; pangan olahan **5 kg** per penumpang. Batas ini untuk **penggunaan pribadi** — barang jastip secara hukum bukan pribadi traveler (lihat §2), sehingga batas ini hanya proksi risiko (`NEEDS_VERIFICATION` untuk perlakuan jastip).

### 5.6 Catatan negara asal (terbatas)
- **Jepang:** mulai **01-11-2026** sistem tax-free berubah menjadi **refund saat keberangkatan**; tetap hanya untuk barang yang dibawa keluar oleh wisatawan dan **tidak untuk tujuan bisnis/jual kembali** ([japan-guide, sekunder](https://www.japan-guide.com/news/tax-free-shopping.html)) → barang jastip sebaiknya **dibeli dengan pajak konsumsi**; nilai pabean = harga termasuk pajak. `NEEDS_VERIFICATION` dari sumber NTA/JTA.

## 6. Worked example — item jastip JPY 60.000

**Asumsi (eksplisit):** kurs = **KMK 45/MK/EF.2/2026** (berlaku 23–29 Sep 2026): JPY 1 = Rp113,7125 (11.371,25/100), USD 1 = Rp17.707. Kurs aktual yang dipakai BC = kurs minggu kedatangan. Pembulatan: BM `CEIL_1000`; PPN/PPh dibulatkan ke bawah ke rupiah (asumsi).

| Langkah | Rumus | Nilai (Rp) |
|---|---|---|
| Nilai pabean (FOB) | 60.000 × 113,7125 | **6.822.750** (≈ USD 385,31) |
| **A. Jika barang pribadi traveler** | ≤ USD 500 → bebas BM, PPN, PPh | **0** |
| **B. Jika barang jastip (non-pribadi)** | | |
| Bea masuk 10% | 6.822.750 × 10% = 682.275 → ceil ribuan | 683.000 |
| Nilai impor | 6.822.750 + 683.000 | 7.505.750 |
| PPN (12% × 11/12) | 7.505.750 × 11% | 825.632 |
| PPnBM | tidak berlaku | 0 |
| PPh 22 impor 5% | 7.505.750 × 5% | 375.287 |
| **Total PDRI + BM (B)** | | **1.883.919** (27,61% dari nilai) |
| Varian tanpa NPWP (PPh 10%, `NEEDS_VERIFICATION`) | 7.505.750 × 10% = 750.575 | total 2.259.207 (33,11%) |

Rumus cepat untuk sanity check: beban efektif non-pribadi ≈ `0,10 + 1,10 × (0,11 + 0,05) = 27,6%` dari nilai pabean.
Catatan engine: dengan rule seed `ID_PAX_NON_PERSONAL` v1 (`CEIL_1000` diterapkan ke **semua** komponen), `estimateCustoms` akan menghasilkan BM 683.000 + PPN 826.000 + PPh 376.000 = **Rp1.885.000** (selisih +Rp1.081 dari hitungan manual di atas — disengaja, konservatif).
Catatan tarif: PMK 34/2025 membuat tarif **10% flat berlaku bahkan untuk HS yang tarif MFN-nya 0%** (dugaan: sebagian ponsel/laptop yang tercakup ITA — **asumsi, belum dicek di BTKI, `NEEDS_VERIFICATION`**). Untuk barang seperti itu, jalur penumpang non-pribadi bisa **lebih mahal** daripada impor umum — relevan untuk positioning harga kategori elektronik.
Pembanding **barang pribadi** JPY 100.000 (Rp11.371.250 ≈ USD 642,19): kelebihan = Rp11.371.250 − (500 × 17.707) = Rp2.517.750 → BM 252.000 → PPN 11% × 2.769.750 = 304.672 → **total Rp556.672**; bila barang yang sama jastip: BM 1.138.000 + PPN 1.376.017 + PPh 625.462 = **Rp3.139.479**.

## 7. Konsekuensi desain untuk engine

| # | Yang harus dimodelkan | Alasan / sumber | Status |
|---|---|---|---|
| 1 | **Default `treatment = NON_PERSONAL`** untuk semua item jastip; `PERSONAL` hanya untuk barang milik traveler sendiri (informasi) | DJBC 2024; PMK 34/2025 Pasal 24(3) | Terkonfirmasi |
| 2 | Non-pribadi: **tanpa pembebasan USD 500**, BM 10% atas nilai penuh, PPN 12%×11/12, PPh 5% | PMK 34/2025; PMK 131/2024 | Terkonfirmasi |
| 3 | Pembebasan USD 500 **per orang per kedatangan**, dibagi seluruh barang pribadi traveler — **jangan pernah dialokasikan ke item penitip** | Pasal 12(1) | Terkonfirmasi |
| 4 | PPh tanpa NPWP → kolom `income_tax_rate_no_npwp`; NPWP yang relevan adalah milik **traveler** | UU PPh 22(3) vs PMK 34/2025 | `NEEDS_VERIFICATION` |
| 5 | Kurs customs = **KMK mingguan (Rabu–Selasa) pada tanggal kedatangan**; checkout memakai kurs pasar + buffer; selisih masuk `CUSTOMS_RESERVE` dan direkonsiliasi dengan bukti bayar BC | KMK kurs | Terkonfirmasi |
| 6 | Pembulatan `CEIL_1000` (konservatif) | PMK 190/2022 Pasal 22(4) | Penerapan ke CD penumpang `NEEDS_VERIFICATION` |
| 7 | PPnBM = 0 untuk semua kategori app (termasuk `LUXURY_GOODS`) | PMK 96/2021 jo 15/2023 | Terkonfirmasi |
| 8 | Alkohol/tembakau/vape/uang tunai **tidak** dimodelkan sebagai tarif → **restricted items (PROHIBITED)** | PMK 82/2024; PMK 157/2017 | Terkonfirmasi (kebijakan platform) |
| 9 | Lartas tetap melekat pada barang jastip → restricted-item engine wajib jalan **sebelum** quote; tampilkan `isEstimate=true` + disclaimer "keputusan akhir di tangan Bea Cukai" | DJBC 2024 | Terkonfirmasi |
| 10 | **Batas kuantitas per traveler per kedatangan** (HKT 2 unit, BKC, kosmetik 20 pcs, dst.) harus diagregasi **lintas transaksi** pada satu trip, bukan per item | PER-13/BC/2021; BPOM 28/2023 | Perlu fitur agregasi di `limits` |
| 11 | Simpan `source_reference`, `last_verified_at`; tampilkan peringatan jika verifikasi > 180 hari (engine sudah punya `RULE_VERIFICATION_STALE`) | governance | — |
| 12 | Versi aturan: PPN dapat berubah akhir 2026 → rancang supaya rule baru = **versi baru**, bukan update | DB guard `jk_versioned_rule_guard` | — |
| 13 | Bukti bayar BC (SSPCP/billing) diunggah traveler → rekonsiliasi estimasi vs aktual (transisi `CUSTOMS_PROCESS → READY_FOR_HANDOVER`) | domain model §4 | — |

### 7.1 Temuan ketidaksesuaian skema ↔ engine (untuk tim engineering)
- `packages/core/src/customs`: `effectiveUntil` diperlakukan **eksklusif**, sedangkan komentar migrasi `0005_config_rules.sql` menyebut **inklusif**. Pilih satu.
- Engine `RuleStatus` = `ACTIVE|DRAFT|INACTIVE|ARCHIVED`; DB = `DRAFT|PENDING_APPROVAL|ACTIVE|RETIRED`.
- Engine `priority`: **angka lebih besar menang** pada spesifisitas seri. Seed mengikuti ini.
- `restricted_items.airline_dg` di DB = `boolean`, di engine = enum (`NONE|CARRY_ON_ONLY|CHECKED_ONLY|OPERATOR_APPROVAL|FORBIDDEN`) → perlu mapping di repository (detail DG ada di `message_*`).

## 8. Daftar `NEEDS_VERIFICATION`
1. Tarif PPh 22 impor non-pribadi **tanpa NPWP** (5% vs 10%) dan NPWP siapa yang dipakai (traveler).
2. Penerapan DPP 11/12 dan pembulatan pada CD penumpang di lapangan.
3. Tarif pajak untuk registrasi IMEI pasca PMK 34/2025 (halaman BC masih versi lama).
4. Prosedur akses API Kurs Kemenkeu.
5. Dampak PMK 113/2025 & PMK 34/2026 terhadap batas BKC penumpang.
6. Perlakuan batas BPOM untuk barang jastip (bukan pribadi traveler).
7. Aturan tax-free Jepang (sumber primer NTA/JTA).

## Sumber (semua diverifikasi 2026-09-27)
- PMK 34/2025 — https://jdih.kemenkeu.go.id/dok/pmk-34-tahun-2025 ; teks: https://jdih.kemenkeu.go.id/api/download/4509c489-5dfb-42b7-a4a0-0f88295ffa85/2025pmkeuangan034.pdf ; https://pasal.id/peraturan/pmk/pmk-no-34-tahun-2025
- PMK 203/PMK.04/2017 — https://jdih.kemenkeu.go.id/api/download/2898f481-24d0-4620-bf60-ec74a6624c44/203~PMK.04~2017Per.pdf ; relasi: https://jdih.kemenkeu.go.id/dok/e3c89711-1a89-42b1-82b3-8266c9993764
- DDTC PMK 34/2025 — https://news.ddtc.co.id/berita/nasional/1811151/pmk-342025-tegaskan-ketentuan-perpajakan-atas-barang-bawaan-penumpang
- tvOne / Republika (siaran pers) — https://www.tvonenews.com/berita/nasional/340086-terbitnya-pmk-342025-sederanakan-aturan-barang-bawaan-penumpang ; https://republika.co.id/berita/sxbgwm472/pmk-342025-terbit-sederhanakan-aturan-barang-bawaan-penumpang
- FAQ DJBC jastip — https://www.beacukai.go.id/faq/ketentuan-barang-bawaan-pribadi-penumpang-dan-jasa-titipan-jastip-.html
- DJBC soal jastip & lartas (Bisnis, 02-05-2024) — https://ekonomi.bisnis.com/read/20240502/259/1762362/barang-bawaan-dari-luar-negeri-tak-dibatasi-bea-cukai-wanti-wanti-jastiper
- Permendag 7/2024 — https://www.hukumonline.com/berita/a/impor-barang-bawaan-penumpang-berjalan-normal-pasca-permendag-7-2024-lt6642b4c7bb37b/
- PMK 131/2024 — https://peraturan.bpk.go.id/Details/311485/pmk-no-131-tahun-2024 ; https://peraturan.bpk.go.id/Download/372221/131%20th%202024.pdf ; https://www.pajak.go.id/en/node/113453
- PPN 2026 — https://news.ddtc.co.id/berita/nasional/1812992/tak-berubah-tarif-ppn-12-tetap-berlaku-untuk-barang-mewah-di-2026 ; https://ekonomi.bisnis.com/read/20251215/259/1936886/tarif-ppn-2026-naik-atau-turun-ini-kata-purbaya
- PPnBM — https://jdih.kemenkeu.go.id/dok/96-pmk-03-2021/summary ; https://news.ddtc.co.id/berita/nasional/31670/pmk-962021-ini-daftar-barang-mewah-yang-kena-ppnbm-20-hingga-75
- Kurs pajak — https://fiskal.kemenkeu.go.id/informasi-publik/kurs-pajak ; https://fiskal.kemenkeu.go.id/peraturan/kmk-kurs-pajak ; https://fiskal.kemenkeu.go.id/layanan/layanan-api-nilai-kurs
- Pembulatan — https://news.ddtc.co.id/berita/nasional/1797874/bea-masuk-dan-cukai-impor-dibulatkan-ribuan-ke-atas-begini-contohnya
- BKC penumpang — https://www.beacukai.go.id/fasilitas-pembebasan-cukai ; https://jdih.kemenkeu.go.id/dok/pmk-82-tahun-2024 ; https://jdih.kemenkeu.go.id/dok/pmk-34-tahun-2026
- IMEI — https://ngurahrai.beacukai.go.id/mandatory/registrasi-imei.html ; https://mediakeuangan.id/detail/351482/aturan-barang-bawaan-penumpang-luar-negeri-berlaku-ketat-mulai-2026
- Barang penumpang (BC Lampung) — https://lampung.beacukai.go.id/mandatory/barang-penumpang.html
- Uang tunai — https://news.ddtc.co.id/berita/nasional/1800917/awas-denda-10-jika-keluar-masuk-ri-bawa-uang-tunai-rp100-juta-lebih ; https://www.hukumonline.com/berita/a/ingat-bawa-uang-asing-rp1-miliar-lebih-tanpa-izin-bisa-kena-denda-lt5b8e58817d517/ ; https://www.bi.go.id/id/publikasi/peraturan/Documents/PBI_200218.pdf
- All Indonesia / e-CD — https://en.wikipedia.org/wiki/All_Indonesia_Arrival_Card ; https://ecd.beacukai.go.id/
- BPOM — https://news.ddtc.co.id/berita/nasional/1806003/penumpang-bawa-obat-dan-makanan-dari-luar-negeri-begini-ketentuannya ; https://standar-otskk.pom.go.id/regulasi/perbpom-no-28-tahun-2023
- Jepang tax-free — https://www.japan-guide.com/news/tax-free-shopping.html
