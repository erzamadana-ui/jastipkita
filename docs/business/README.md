# Model Bisnis & Proyeksi Keuangan JastipKita

> **Status:** model pra-peluncuran. Belum ada transaksi nyata dan seluruh integrasi masih MOCK/SANDBOX. **Dokumen ini bukan nasihat keuangan, investasi, hukum, atau pajak.** Angka berstatus ASUMSI wajib diganti dengan data beta (fase 1A/1B) sebelum keputusan pendanaan diambil.

Berkas: `jastipkita-model-bisnis.xlsx`. Seluruh angka dihitung dengan rumus aktif (7.250 rumus). Hasil rekalkulasi LibreOffice pada 2026-10-04 bersih, tanpa #REF!, #DIV/0!, atau #VALUE!.

## Cara memakai
1. Buka sheet **Asumsi** dan pilih skenario di sel **D4** (Konservatif / Dasar / Optimis). Sheet Ringkasan (kolom "Skenario aktif"), Unit Economics kolom F–H, dan Sensitivitas akan mengikuti pilihan ini. Tiga blok di sheet Proyeksi selalu dihitung bersamaan.
2. Ubah hanya sel **biru** (input). Sel kuning adalah asumsi kunci, sel hitam berisi rumus, dan sel hijau adalah tautan antar-sheet. Kolom *Status* menandai setiap input sebagai SUMBER, ASUMSI, atau USULAN; kolom *Sumber / catatan* menyebut asal angkanya.
3. Urutan sheet: **Ringkasan** (KPI per skenario, temuan, grafik kas) → **Unit Economics** (satu transaksi melewati 11 baris harga, alokasi dana, subsidi kanal bayar, ekonomi proteksi, LTV/CAC) → **Proyeksi 24 Bulan** (Bulan 0 pra-peluncuran ditambah Bulan 1–24) → **Sensitivitas** → **Sumber**.
4. Rencana biaya (SDM, marketing, legal) dibuat sama di ketiga skenario. Dengan begitu, perbedaan antarskenario hanya mencerminkan ketidakpastian pasar dan tarif.

## Hasil utama (soft launch diasumsikan Februari 2027)
| KPI | Konservatif | Dasar | Optimis |
|---|---:|---:|---:|
| Transaksi selesai per bulan pada Bulan 24 | 178 | 589 | 1.425 |
| GMV Tahun 2 (Rp juta) | 3.548 | 15.274 | 42.461 |
| Take rate bruto / bersih atas GMV | 4,5% / 4,2% | 4,5% / 4,2% | 4,4% / 4,2% |
| Pendapatan bersih Tahun 2 (Rp juta) | 149 | 643 | 1.789 |
| Margin kontribusi per transaksi (Rp) | 19.350 | 77.258 | 110.884 |
| BEP: transaksi per bulan (biaya tetap + marketing) | 8.470 | 2.122 | 1.479 |
| Puncak kebutuhan kas (Rp juta) | 3.917 | 3.513 | 2.577 |
| Bulan pertama EBITDA ≥ 0 | belum ≤ B24 | belum ≤ B24 | belum ≤ B24 (EBITDA B24 −Rp23 jt) |

Temuan utama:
- **Tidak ada skenario yang mencapai titik impas dalam 24 bulan.** Kas masih terus turun pada Bulan 24, sehingga kebutuhan dana sebenarnya lebih besar daripada puncak yang tercatat di tabel. Skenario Dasar baru mencapai 28% volume BEP pada Bulan 24.
- **Subsidi biaya kanal pembayaran** rata-rata Rp16.233 per transaksi pada skenario Dasar, setara 12% pendapatan bruto. Untuk VA, pembeli dibebankan Rp4.500 sedangkan biaya Xendit Rp14.430 (launch-checklist B4). Subsidi terbesar per transaksi justru ada di e-wallet: config 1,5% berada di bawah tarif publik (≥2% + Rp4.000 + PPN). Bila semua kanal dibebankan sesuai biaya, BEP Dasar turun dari 2.122 menjadi 1.753 transaksi per bulan (Sensitivitas tabel 2c).
- **Yang rusak duluan:** jika biaya payout Xendit ternyata 1% + Rp4.000 (tarif publik, NEEDS_VERIFICATION), margin per transaksi Konservatif tinggal Rp19.350. Keranjang Rp500 ribu sudah merugi per transaksi. Setiap bulan penundaan soft launch menambah sekitar Rp96 juta biaya tetap.
- Dengan asumsi CAC Rp180–350 ribu, akuisisi berbayar **belum balik modal dalam 12 bulan** karena melewati guardrail config CAC ≤ 0,33 × LTV. Kanal organik dan referral (sekitar Rp35 ribu per referral berkualifikasi) jauh lebih efisien. Pasokan traveler membatasi skenario Konservatif dengan fill rate Tahun 2 sebesar 72%.

## Angka bersumber vs asumsi
- **Bersumber (repo/URL, lihat sheet Sumber):** platform fee 5% dan protection fee 1,5% beserta batas min/maks, PPN layanan 12% × 11/12, batas traveler fee, biaya kanal yang dibebankan, referral dan cap-nya, serta limit transaksi (`business-config.defaults.json`). Juga rumus 11 baris harga dan gross-up (`packages/core/src/pricing`), bea masuk 10% + PPN impor + PPh 5% (PMK 34/2025, seed 0100), tarif publik Xendit (diverifikasi ulang 2026-10-04), tier infrastruktur (Cloudflare US$5, Neon Launch), akun toko (US$25 dan US$99/tahun), SMS OTP Twilio, serta kurs JISDOR.
- **ASUMSI/USULAN:** semua volume (traveler, pembeli, frekuensi, churn), CAC, nilai keranjang, traveler fee 10%, bauran kanal, tingkat batal, loss ratio proteksi, biaya CS, biaya SDM, kepatuhan, biaya pendirian, legal dan pentest, tanggal soft launch, serta anggaran marketing (USULAN launch plan, belum disetujui owner).
- **Pass-through, bukan pendapatan:** harga barang, traveler fee, bea dan pajak impor, PPN layanan, dan biaya kanal yang dibayar pembeli. Markup kurs juga bukan pendapatan karena sisa dana barang dikembalikan ke pembeli.

---
**Catatan keterbatasan data:** tidak tersedia data pasar jastip yang kredibel (research 04). Tarif Xendit memakai harga publik, bukan kontrak. Tarif bea dan pajak berasal dari seed DRAFT sampai diverifikasi konsultan. Model disajikan pra-pajak: PT baru tidak lagi dapat memakai PPh final 0,5% menurut PP 20/2026 (sumber sekunder, NEEDS_VERIFICATION). Dana escrow di saldo Xendit bukan kas perusahaan. Kebutuhan dana pada tabel belum termasuk buffer. Daftar lengkap ada di sheet **Sumber**.
