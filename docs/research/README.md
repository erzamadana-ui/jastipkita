# Riset Regulasi & Integrasi — JastipKita

Riset desk per **2026-09-27** oleh research-agent. **Belum diverifikasi** ahli kepabeanan, konsultan pajak, konsultan hukum, maupun account manager Xendit. Bukan nasihat hukum.

## Indeks
| Dokumen | Isi |
|---|---|
| [01-customs-tax-indonesia.md](01-customs-tax-indonesia.md) | PMK 34/2025 (barang penumpang), PPN/PPnBM/PPh impor, kurs KMK, pembulatan, IMEI, BKC, uang tunai, All Indonesia, contoh JPY 60.000, konsekuensi desain engine |
| [02-xendit-integration.md](02-xendit-integration.md) | Payment Sessions vs Invoices vs Payment Requests v3, webhook, refund per channel, xenPlatform, payout, rekonsiliasi, biaya, batas regulasi BI, arsitektur & env vars |
| [03-fx-providers.md](03-fx-providers.md) | Frankfurter v1/v2, ECB, BI (JISDOR, Kurs Transaksi), KMK, OXR/Xe/Wise; strategi primary–fallback–customs |
| [04-market-and-naming.md](04-market-and-naming.md) | Lanskap jastip, fee lazim, pembanding global, pengecekan nama "JastipKita" |
| [05-legal-regulatory.md](05-legal-regulatory.md) | UU PDP & PP 33/2026, PSE, PP 80/2019 & Permendag 19/2026, pajak platform, UU 8/1999, Google Play & App Store; checklist implikasi |
| [`../../db/seeds/0100_customs_rules.sql`](../../db/seeds/0100_customs_rules.sql) | 4 rule (2 ACTIVE, 2 DRAFT) — **belum dijalankan** |
| [`../../db/seeds/0101_restricted_items.sql`](../../db/seeds/0101_restricted_items.sql) | 47 rule (42 ACTIVE, 5 DRAFT) — **belum dijalankan** |

## Ringkasan eksekutif (urut tingkat keparahan)
1. **[KRITIS] Barang jastip = bukan barang pribadi.** PMK 34/2025 Pasal 24(3) (berlaku 06-06-2025): BM **10% flat atas nilai penuh**, PPN 12%×11/12, PPh **5%**, tanpa pembebasan USD 500 → beban ±**27,6%** dari nilai barang (contoh JPY 60.000 → Rp1,88 juta). DJBC menegaskan jastip **tidak dikecualikan dari lartas** → kosmetik/obat/pangan/HKT dalam jumlah "komersial" berisiko ditahan. Ini risiko inti model bisnis, bukan detail teknis.
2. **[KRITIS] Menahan dana pembeli.** JastipKita tidak boleh menampung dana di rekening sendiri (rezim PJP BI, PBI 23/6/PBI/2021). Pola aman: dana di saldo Xendit (entitas berlisensi BI Kategori 1 & 3), ditahan secara ledger, dirilis setelah konfirmasi. Durasi hold panjang wajib **konfirmasi tertulis Xendit + opini hukum**.
3. **[KRITIS] Permendag 31/2023 sudah dicabut** oleh **Permendag 19/2026** (berlaku 08-06-2026): pedagang wajib NIB (status "Dalam Proses Legalisasi" maks. 6 bulan; transisi 18 bulan), transparansi biaya, FOB min. USD 100 lintas batas. Jika traveler dianggap "pedagang", onboarding traveler berubah drastis → opini hukum sebelum launch.
4. **[TINGGI] Refund:** Virtual Account, Alfamart/Indomaret, AstraPay **tidak bisa refund**; OVO hanya 14 hari, DANA 30, GoPay 45 — lebih pendek dari siklus jastip. Wajib jalur **refund via payout** ke rekening pembeli tervalidasi. QRIS maks. Rp10 juta/transaksi.
5. **[TINGGI] Nama "JastipKita" berisiko tinggi:** domain .com/.id/.co.id sudah terdaftar pihak lain; ada "CV JASTIP KITA INDONESIA" dan ≥ 8 akun IG + TikTok aktif dengan layanan jastip; nama deskriptif. Cek PDKI manual sebelum branding.
6. **[TINGGI] PDP:** PP 33/2026 (pelaksana UU PDP) berlaku ±Januari 2027 — persetujuan terpisah dari T&C, DPIA untuk biometrik KYC & data keuangan, DPO, notifikasi insiden ≤ 3×24 jam, sanksi hingga 2% pendapatan.
7. **[TINGGI] PSE wajib terdaftar** sebelum aplikasi publik; Komdigi menegakkan dengan ancaman pemutusan akses (Juni 2026).
8. **[SEDANG] Ketidakpastian tarif:** PPh 22 tanpa NPWP (5% teks PMK vs 10% UU PPh) → rule v2 DRAFT; PPN 2026 tidak berubah tetapi Menkeu menjadwalkan evaluasi akhir 2026.
9. **[SEDANG] Kurs:** Bea Cukai memakai **KMK mingguan (Rabu–Selasa)** — KMK 45/2026: USD 17.707 vs JISDOR 17.917. Config `fx.lock.maxRateAgeMinutes=1440` akan membuat rate ECB basi setiap akhir pekan → perlu fallback hourly (OXR USD 12/bln).
10. **[SEDANG] HKT:** registrasi IMEI maks. **2 unit per penumpang**, atas paspor traveler; titip ponsel = gesekan tinggi.
11. **[SEDANG] PMK 37/2025:** marketplace ber-escrow yang melewati ambang (> Rp600 juta/12 bln atau > 1.000 traffic/bln) dapat ditunjuk memungut PPh 22 0,5% omzet pedagang; 4 marketplace besar mulai 01-08-2026.
12. **[SEDANG] Barang terlarang untuk jastip:** alkohol, tembakau/vape, uang tunai, senjata/replika, narkotika/CBD, pornografi & sex toys, pakaian bekas (Permendag 47/2025, berlaku 01-01-2026), bahan mudah terbakar/baterai > 160 Wh → PROHIBITED di seed.
13. **[SEDANG] Jepang:** tax-free tidak untuk dijual kembali; mulai **01-11-2026** berubah menjadi refund saat keberangkatan → harga barang jastip JP harus termasuk pajak konsumsi (sumber sekunder, DRAFT).
14. **[RENDAH] Toko aplikasi:** pakai akun **organisasi** (Google, D-U-N-S) & badan hukum (Apple 5.1.1(ix)); penghapusan akun in-app (+ web untuk Google); Apple 4.8 mensyaratkan opsi login setara (Sign in with Apple lazim). Dua premis brief dikoreksi: *financial features declaration* wajib untuk semua aplikasi tetapi bukan sendirinya syarat akun organisasi; 4.8 tidak lagi menyebut Sign in with Apple secara eksplisit.
15. **[RENDAH] Ketidaksesuaian skema↔engine** yang ditemukan: `effective_until` inklusif (migrasi) vs eksklusif (engine); enum status berbeda (`RETIRED/PENDING_APPROVAL` vs `INACTIVE/ARCHIVED`); `airline_dg` boolean (DB) vs enum (engine).

## Cara memakai seed
Seed **tidak dijalankan** (skema belum final). Setelah migrasi `0005_config_rules.sql` dan seed `countries`/`product_categories` tersedia: jalankan 0100 lalu 0101. Baris `DRAFT` tidak dipakai engine; promosikan ke `ACTIVE` hanya setelah verifikasi ahli, sebagai **versi baru** (baris ACTIVE immutable, dijaga trigger `jk_versioned_rule_guard`).

---
*Catatan keterbatasan data:* (1) sebagian sumber adalah media/blog sekunder; sumber primer diutamakan bila dapat diakses. (2) Beberapa situs resmi (beacukai.go.id, PDKI, allindonesia) sebagian tidak dapat dibaca otomatis; nilai terkait ditandai `NEEDS_VERIFICATION`. (3) Harga Xendit & kurs bersifat dinamis — angka adalah snapshot 2026-09-27. (4) Tidak ada data ukuran pasar jastip yang kredibel ditemukan. (5) Semua ringkasan pasal perlu dicocokkan dengan teks resmi sebelum dipakai dalam dokumen hukum.
