# 05 — Peta Regulasi & Kepatuhan JastipKita

> **DISCLAIMER — BUKAN NASIHAT HUKUM.** Dokumen ini adalah ringkasan riset desk oleh research-agent (diverifikasi 2026-09-27) untuk membantu tim produk/engineering memetakan isu. Sebelum peluncuran, seluruh butir wajib ditinjau oleh konsultan hukum berizin di Indonesia (korporasi/fintech, pajak, kepabeanan, dan KI). Ringkasan pasal berasal dari sumber resmi dan sekunder; teks peraturan resmi yang berlaku mengikat.

## 1. Pelindungan Data Pribadi — UU 27/2022 (UU PDP) & PP 33/2026
| Aspek | Ketentuan | Sumber |
|---|---|---|
| Berlaku | Diundangkan 17-10-2022; masa penyesuaian **2 tahun** (Pasal 74) → kewajiban penuh sejak Oktober 2024 | [pasal.id UU 27/2022](https://pasal.id/peraturan/uu/uu-no-27-tahun-2022) |
| Dasar pemrosesan | 6 dasar (Pasal 20 ayat (2)): persetujuan eksplisit, kontrak, kewajiban hukum, kepentingan vital, tugas publik, kepentingan sah | idem |
| Data spesifik | Termasuk **data biometrik** dan **data keuangan pribadi** (Pasal 4 ayat (2)) → selfie/liveness KYC & rekening payout masuk kategori ini | idem |
| Hak subjek data | Pasal 5–13; akses dijawab **≤ 3×24 jam** (Pasal 32), koreksi **≤ 3×24 jam** (Pasal 30) | idem |
| Notifikasi kegagalan PDP | Tertulis ke subjek data **dan** lembaga **≤ 3×24 jam** (Pasal 46) | idem |
| Pejabat PDP (DPO) | Wajib jika layanan publik, pemantauan sistematis skala besar, atau pemrosesan data spesifik skala besar sebagai kegiatan inti (Pasal 53) | idem |
| Transfer lintas negara | Negara tujuan setara/lebih tinggi, atau safeguard mengikat, atau persetujuan subjek (Pasal 56) | idem |
| Sanksi administratif | Hingga **2% pendapatan tahunan** (Pasal 57; PP 33/2026 Pasal 184–185) | [Veritask](https://veritask.ai/id/artikel/pengaturan-teknis-pelindungan-data-pribadi-dan-kewajiban-pengendali-serta-prosesor-akhirnya-terbit-lewat-pp-33-2026) |
| **PP 33/2026** (peraturan pelaksana) | Ditetapkan **15 atau 16 Juli 2026**, berlaku **15 atau 16 Januari 2027** (sumber berbeda → `NEEDS_VERIFICATION`). Mengatur DPIA sebelum pemrosesan berisiko tinggi (Pasal 120–122; termasuk data spesifik, teknologi baru, AI/ML, keputusan otomatis), catatan aktivitas pemrosesan minimal 13 elemen (Pasal 74), persetujuan **terpisah dari syarat & ketentuan**, penarikan persetujuan ditindaklanjuti ≤ 3×24 jam, transfer lintas negara berjenjang (adequacy → SCC/BCR → persetujuan) | [Hukumonline](https://www.hukumonline.com/pusatdata/detail/lt6a9164bf1e96a/peraturan-pemerintah-nomor-33-tahun-2026/), [KRES.ID](https://www.kres.id/pp-33-2026-aturan-pelaksana-uu-pdp), Veritask |
| Lembaga PDP | PP menyebut "Lembaga" tanpa struktur; ±20 ketentuan menunggu aturan lembaga | KRES.ID |

## 2. PSE Lingkup Privat — PP 71/2019 & Permenkominfo 5/2020 jo 10/2021
- Setiap PSE lingkup privat (domestik/asing) **wajib terdaftar** (Permenkominfo 5/2020 Pasal 2 & 4) melalui OSS **sebelum** sistem elektronik digunakan pengguna.
- Penegakan aktif: Komdigi menyurati 25 PSE privat (57 sistem elektronik) pada 26-06-2026 dengan batas 03-07-2026; sanksi hingga **pemutusan akses** ([Komdigi, 30-06-2026](https://portal.komdigi.go.id/kanal-publik/berita-kini/10354)).
- Implikasi: aplikasi mobile, web, dan API JastipKita didaftarkan atas nama PT; pembaruan data bila ada perubahan sistem/penyedia cloud.

## 3. Perdagangan elektronik — PP 80/2019 & Permendag 19/2026
- **PP 80/2019** tentang PMSE: berlaku, tanpa catatan perubahan di JDIH BPK ([BPK](https://peraturan.bpk.go.id/Details/126143/pp-no-80-tahun-2019)).
- **Permendag 31/2023 sudah DICABUT** oleh **Permendag 19/2026** tentang Penyelenggaraan Usaha PMSE (ditetapkan 04-06-2026, diundangkan & berlaku **08-06-2026**) ([BPK Permendag 31/2023](https://peraturan.bpk.go.id/Details/265202/permendag-no-31-tahun-2023), [pasal.id](https://pasal.id/peraturan/permen/permendag-no-19-tahun-2026), [JDIH Kemendag](https://jdih.kemendag.go.id/peraturan/peraturan-menteri-perdagangan-republik-indonesia-nomor-19-tahun-2026-tentang-penyelenggaraan-usaha-perdagangan-melalui-sistem-elektronik), [CNN Indonesia](https://www.cnnindonesia.com/ekonomi/20260609133130-92-1367064/permendag-baru-e-commerce-terbit-ini-10-poin-pentingnya)). Poin relevan:
  - PPMSE wajib Perizinan Berusaha (OSS, tanpa biaya) (Pasal 4, 7, 8).
  - **Legalitas pedagang:** pedagang minimal NIB; status "Dalam Proses Legalisasi" maks. **6 bulan** (Pasal 17); pedagang eksisting diberi transisi **18 bulan** (Pasal 74). → Apakah **traveler** = "Pedagang"? Jika ya, traveler aktif wajib NIB → dampak besar ke onboarding. **Legal review.**
  - Transparansi biaya dalam kontrak tertulis/elektronik; perubahan biaya butuh persetujuan pedagang, keberatan 14 hari kerja (Pasal 14/18).
  - Kanal pengaduan di beranda dengan SLA (Pasal 10–14).
  - Lintas batas: harga minimum **FOB USD 100 per unit** untuk penjualan langsung barang dari luar negeri oleh pedagang luar negeri (Pasal 23); pedagang luar negeri wajib identitas, izin, dokumen kepatuhan produk berbahasa Indonesia (Pasal 6). → Traveler WNI bukan pedagang luar negeri, tetapi barang berasal dari luar negeri: penerapan Pasal 23 ke model jastip **perlu legal review**.
  - Pelabelan konten AI (Pasal 47) — relevan untuk fitur `ai-extraction`.
  - Pelaporan data transaksi ke pemerintah/BPS (Pasal 21, 53–55); prioritas produk dalam negeri (Pasal 36–39) — sulit diterapkan pada marketplace impor, **legal review**.
  - Sanksi berjenjang: teguran (maks. 3 dalam 14 hari) → daftar pengawasan → pemblokiran → pencabutan izin (Pasal 57–72).

## 4. Pajak atas layanan platform
| Isu | Ketentuan | Sumber |
|---|---|---|
| PPN atas platform fee & protection fee | Jasa Kena Pajak; tarif 12% × DPP 11/12 (efektif 11%) (PMK 131/2024) — wajib dipungut setelah JastipKita menjadi **PKP** | [BPK PMK 131/2024](https://peraturan.bpk.go.id/Details/311485/pmk-no-131-tahun-2024) |
| Batas pengusaha kecil | Omzet > **Rp4,8 miliar/tahun** wajib PKP (PMK 197/PMK.03/2013); wacana penurunan belum diundangkan (per Nov 2025) | [BPK PMK 197/2013](https://peraturan.bpk.go.id/Details/150339/pmk-no-197pmk032013), [Klikpajak](https://klikpajak.id/blog/batasan-pkp-terbaru-atau-treshold-pkp/) |
| PPh 22 oleh marketplace (PMK 37/2025) | Marketplace yang ditunjuk memungut **0,5%** dari peredaran bruto pedagang (orang pribadi omzet ≤ Rp500 juta dikecualikan dengan pernyataan); 4 marketplace ditunjuk, pemungutan mulai **01-08-2026**. Kriteria penunjukan (PER-15/2025): memakai **escrow account** + nilai transaksi > Rp600 juta/12 bln atau > Rp50 juta/bln, atau traffic > 12.000/12 bln atau > 1.000/bln | [DJP](https://www.pajak.go.id/en/node/120146), [Ortax](https://ortax.org/apa-saja-kriteria-marketplace-menjadi-pemungut-pph-pasal-22) |
| PPN PMSE | Relevan bagi JastipKita sebagai **pembeli** layanan digital luar negeri (cloud, SaaS), bukan sebagai penjual | — |
| Pembayaran ke traveler | Apakah platform harus memotong PPh atas penghasilan jasa traveler (mis. PPh 21 bukan pegawai) atau cukup meneruskan dana milik penitip → **`NEEDS_VERIFICATION`** (tergantung struktur kontrak: agen/escrow vs pemberi jasa) | — |
| Estimasi bea & pajak impor | Dikumpulkan ke `CUSTOMS_RESERVE` lalu dibayar **traveler** ke DJBC; JastipKita bukan pemungut → tampilkan sebagai "estimasi penggantian biaya bea & pajak", simpan bukti bayar | dokumen 01 |

## 5. Sikap Bea Cukai terhadap jastip
- Barang jastip = **bukan barang pribadi** → dikenai BM 10% + PPN + PPh 5% atas nilai penuh (PMK 34/2025 Pasal 24(3)) dan **tidak dikecualikan dari lartas** (DJBC, 02-05-2024) — detail di `01-customs-tax-indonesia.md`.
- Implikasi: platform **tidak boleh** mendorong traveler menyamarkan barang jastip sebagai barang pribadi, memecah (splitting) barang untuk memanfaatkan USD 500, atau memberi "tips lolos bea cukai". T&C traveler wajib memuat kewajiban deklarasi jujur via All Indonesia. Tanggung jawab pidana/administratif atas pemberitahuan pabean yang tidak benar dan posisi platform sebagai fasilitator → **legal review** (UU Kepabeanan).

## 6. Perlindungan konsumen — UU 8/1999
- Berlaku; Pasal 31 (BPKN) dinyatakan inkonstitusional bersyarat oleh Putusan MK 235/PUU-XXIII/2025 ([BPK](https://peraturan.bpk.go.id/Details/45288/uu-no-8-tahun-1999)).
- Implikasi: tetapkan dengan jelas peran para pihak (JastipKita = penyelenggara platform/perantara; traveler = penyedia jasa titip); **klausula baku** di T&C tidak boleh mengalihkan seluruh tanggung jawab pelaku usaha (rujuk Pasal 18 — isi pasal belum dikutip dari sumber primer, `NEEDS_VERIFICATION`); sediakan mekanisme pengaduan & sengketa (sejalan Permendag 19/2026); breakdown harga lengkap tanpa biaya tersembunyi (sudah menjadi aturan domain §10).

## 7. Toko aplikasi
### 7.1 Google Play
- **Financial features declaration** wajib untuk **semua** aplikasi (termasuk yang tidak punya fitur finansial) sejak 31-08-2023 ([Play Console Help](https://support.google.com/googleplay/android-developer/answer/13849271?hl=en)). **Koreksi premis brief:** deklarasi ini sendiri *tidak* mensyaratkan akun organisasi.
- **Akun organisasi** diwajibkan bagi penyedia "financial products and services, including but not limited to banking, loans, stock trading, investment funds, cryptocurrency software wallets, and cryptocurrency exchanges", juga health, VPN, government; membutuhkan **D-U-N-S** ([Choose account type](https://support.google.com/googleplay/android-developer/answer/13634885?hl=en), [Play Console Requirements](https://support.google.com/googleplay/android-developer/answer/10788890?hl=en)). Escrow via PJP berlisensi tidak eksplisit tercantum → **tetap gunakan akun organisasi** (atas nama PT) untuk menghindari penolakan & karena kebijakan Financial Services meminta keterkaitan akun developer dengan lisensi ([Financial Services](https://support.google.com/googleplay/android-developer/answer/9876821)).
- Akun **personal** yang dibuat setelah 13-11-2023 wajib closed test **≥ 12 penguji selama ≥ 14 hari** sebelum produksi ([Play Help](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en)).
- **Data safety form** wajib (termasuk data yang dikumpulkan SDK pihak ketiga) ([Play Help](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en)).
- **Penghapusan akun:** jalur di dalam aplikasi **dan** tautan web untuk meminta penghapusan akun & data ([Play Help](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en)).

### 7.2 Apple App Store ([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/))
- **4.8 Login Services:** jika memakai login pihak ketiga (Google, dll.) untuk akun utama, wajib menawarkan **opsi login setara** yang membatasi data ke nama & email, memungkinkan email disembunyikan, dan tidak melacak untuk iklan tanpa izin. *Sign in with Apple* adalah cara paling umum memenuhinya, tetapi teks saat ini tidak mewajibkannya secara eksplisit (koreksi premis brief). Pengecualian: hanya akun milik perusahaan sendiri, dll.
- **5.1.1(v):** aplikasi yang mendukung pembuatan akun **wajib menyediakan penghapusan akun di dalam aplikasi**.
- **5.1.1(ix):** aplikasi di bidang sangat teregulasi (termasuk *banking and financial services*) atau yang memerlukan informasi sensitif sebaiknya diajukan **oleh badan hukum**, bukan individu → akun Apple Developer atas nama PT.
- **3.1.3(e):** pembelian barang fisik/jasa yang dikonsumsi di luar aplikasi **harus memakai metode selain In-App Purchase** → Xendit sah dipakai.
- **App Privacy details** ("nutrition label"): wajib untuk aplikasi baru & setiap update; deklarasikan tipe data, keterkaitan dengan identitas, pelacakan, dan data SDK pihak ketiga; privacy manifest untuk SDK ([Apple](https://developer.apple.com/app-store/app-privacy-details/)). Tautan kebijakan privasi wajib di metadata & di dalam aplikasi (5.1.1).

## 8. Implikasi untuk JastipKita — checklist
| # | Prioritas | Butir | PIC | Status |
|---|---|---|---|---|
| 1 | P0 | Dirikan/konfirmasi **PT** sebagai entitas tunggal untuk Xendit KYB, OSS (KBLI PMSE), PSE, akun Google Play Organization (D-U-N-S) & Apple (badan hukum) | Legal/Founder | Terbuka |
| 2 | P0 | **Daftar PSE Lingkup Privat** sebelum aplikasi publik | Legal | Terbuka |
| 3 | P0 | Perizinan PPMSE (Permendag 19/2026) + **opini hukum**: apakah traveler = "Pedagang" (NIB), apakah Pasal 23 FOB USD 100 & kewajiban promosi produk dalam negeri berlaku | Legal | Terbuka |
| 4 | P0 | **Opini hukum escrow**: menahan dana di saldo Xendit hingga barang diterima; konfirmasi tertulis Xendit atas use-case & durasi hold; tidak ada dana melewati rekening PT | Legal/Finance | Terbuka |
| 5 | P0 | T&C traveler: kewajiban deklarasi jujur (All Indonesia), larangan splitting, tanggung jawab bea & pajak, larangan barang PROHIBITED | Legal/Product | Terbuka |
| 6 | P0 | Persetujuan PDP **terpisah** dari T&C; kebijakan privasi; mekanisme hak subjek data (akses/koreksi ≤ 3×24 jam; hapus; tarik persetujuan) | Eng/Legal | Terbuka |
| 7 | P0 | **Runbook insiden** dengan notifikasi ≤ 3×24 jam ke subjek data & Lembaga | Eng/Security | Terbuka |
| 8 | P1 | **DPIA** untuk KYC (biometrik, KTP/paspor), rekening payout, fraud/trust scoring & fitur AI; tunjuk **DPO** | Legal/Eng | Terbuka |
| 9 | P1 | Record of Processing Activities (≥ 13 elemen per PP 33/2026) & DPA dengan prosesor (Xendit, KYC vendor, cloud, email/SMS) | Legal | Terbuka |
| 10 | P1 | Transfer data lintas negara (cloud/KYC vendor di luar negeri): pilih region Indonesia atau siapkan SCC/persetujuan | Eng/Legal | Terbuka |
| 11 | P1 | Penghapusan akun **in-app + web** (Google & Apple); Data safety & App Privacy label akurat termasuk SDK | Eng | Terbuka |
| 12 | P1 | Login: jika ada Google Sign-In → sediakan Sign in with Apple (atau setara 4.8) | Eng | Terbuka |
| 13 | P1 | Pajak: rencana PKP (≥ Rp4,8 M) & e-Faktur/Coretax untuk PPN atas fee; kajian PPh atas pembayaran ke traveler; pantau potensi penunjukan PMK 37/2025 | Finance/Tax | Terbuka |
| 14 | P1 | Kanal pengaduan konsumen di beranda + SLA; sengketa (sesuai domain §6) | Product/Support | Terbuka |
| 15 | P2 | Label konten AI (Permendag 19/2026 Pasal 47) untuk hasil `ai-extraction` | Product | Terbuka |
| 16 | P2 | Klaim merek & nama (lihat dokumen 04) sebelum kampanye | Marketing/Legal | Terbuka |
| 17 | P2 | JastipKita Credit tetap closed-loop, tidak dapat diuangkan/ditransfer (hindari rezim uang elektronik) | Product/Legal | Terbuka |

## `NEEDS_VERIFICATION`
Tanggal pasti PP 33/2026; status traveler sebagai "Pedagang" & penerapan Pasal 23 Permendag 19/2026; kewajiban PPh atas pembayaran ke traveler; isi Pasal 18 UU 8/1999 (klausula baku) dari teks resmi; posisi hukum platform atas pemberitahuan pabean tidak benar oleh traveler; apakah akun organisasi Google Play wajib untuk model escrow via PJP.

## Sumber (diverifikasi 2026-09-27)
https://pasal.id/peraturan/uu/uu-no-27-tahun-2022 · https://www.hukumonline.com/pusatdata/detail/lt6a9164bf1e96a/peraturan-pemerintah-nomor-33-tahun-2026/ · https://www.kres.id/pp-33-2026-aturan-pelaksana-uu-pdp · https://veritask.ai/id/artikel/pengaturan-teknis-pelindungan-data-pribadi-dan-kewajiban-pengendali-serta-prosesor-akhirnya-terbit-lewat-pp-33-2026 · https://portal.komdigi.go.id/kanal-publik/berita-kini/10354 · https://peraturan.bpk.go.id/Details/126143/pp-no-80-tahun-2019 · https://peraturan.bpk.go.id/Details/265202/permendag-no-31-tahun-2023 · https://pasal.id/peraturan/permen/permendag-no-19-tahun-2026 · https://jdih.kemendag.go.id/peraturan/peraturan-menteri-perdagangan-republik-indonesia-nomor-19-tahun-2026-tentang-penyelenggaraan-usaha-perdagangan-melalui-sistem-elektronik · https://www.cnnindonesia.com/ekonomi/20260609133130-92-1367064/permendag-baru-e-commerce-terbit-ini-10-poin-pentingnya · https://veritask.ai/id/artikel/peraturan-menteri-perdagangan-nomor-19-tahun-2026-perbarui-tata-kelola-dan-pengawasan-perdagangan-digital · https://peraturan.bpk.go.id/Details/311485/pmk-no-131-tahun-2024 · https://peraturan.bpk.go.id/Details/150339/pmk-no-197pmk032013 · https://klikpajak.id/blog/batasan-pkp-terbaru-atau-treshold-pkp/ · https://www.pajak.go.id/en/node/120146 · https://ortax.org/apa-saja-kriteria-marketplace-menjadi-pemungut-pph-pasal-22 · https://peraturan.bpk.go.id/Details/45288/uu-no-8-tahun-1999 · https://support.google.com/googleplay/android-developer/answer/13849271?hl=en · https://support.google.com/googleplay/android-developer/answer/13634885?hl=en · https://support.google.com/googleplay/android-developer/answer/10788890?hl=en · https://support.google.com/googleplay/android-developer/answer/9876821 · https://support.google.com/googleplay/android-developer/answer/14151465?hl=en · https://support.google.com/googleplay/android-developer/answer/10787469?hl=en · https://support.google.com/googleplay/android-developer/answer/13327111?hl=en · https://developer.apple.com/app-store/review/guidelines/ · https://developer.apple.com/app-store/app-privacy-details/

> **Pengingat: dokumen ini bukan nasihat hukum.**
