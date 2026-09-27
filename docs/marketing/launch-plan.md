# Rencana Peluncuran & Growth — JastipKita

> **Status: USULAN.** Semua anggaran, target dan eksperimen di dokumen ini adalah proposal yang **memerlukan
> persetujuan owner**. Tidak ada iklan berbayar yang boleh berjalan sebelum (1) gerbang launch P0 lulus
> (`docs/checklists/launch-checklist.md`), (2) status merek "JastipKita" jelas (L14–L15), dan (3) prasyarat atribusi §7
> terpenuhi. Angka bertanda **ASUMSI** belum punya data pendukung — ganti dengan data beta secepatnya.

Pasar: destinasi **Indonesia**; origin awal **JP, SG, KR, MY, AU, US** (sejalan dengan rute favorit & pesaing — research 04).
Positioning: *"Titip Mudah, Aman, Terpercaya."* — jastip dengan dana ditahan mitra pembayaran berlisensi BI sampai barang
diterima, rincian landed cost lengkap (termasuk estimasi bea & pajak), traveler terverifikasi.

## 1. Fase
| Fase | Minggu | Cakupan | Uang | Gerbang keluar (semua harus terpenuhi) |
|---|---|---|---|---|
| 0 — Dogfood | 1–2 | tim + 10 kenalan, staging | SANDBOX | alur penuh berhasil 10×; tidak ada bug P0; OTP/login jalan |
| 1A — Beta tertutup (UX) | 3–4 | 20 traveler (JP, SG), 50 penitip undangan | SANDBOX | ≥ 70 % peserta menyelesaikan simulasi checkout; CSAT ≥ 4,3/5 (ASUMSI) |
| 1B — Beta tertutup (uang nyata, terbatas) | 5–6 | peserta 1A, limit transaksi rendah (config) | **LIVE hanya jika** gerbang P0 & keputusan owner | ≥ 30 transaksi COMPLETED; dispute < 5 %; 0 insiden dana belum terselesaikan; rekonsiliasi harian 0 selisih |
| 2 — Soft launch | 7–10 | 6 origin, pendaftaran terbuka tanpa iklan berbayar | LIVE | ≥ 150 transaksi COMPLETED; ≥ 40 % permintaan dapat tawaran ≤ 48 jam; refund rate < 8 % (ASUMSI) |
| 3 — Publik | 11–13 | kampanye organik penuh; uji iklan kecil **hanya** jika §7 lulus | LIVE | CAC ≤ batas guardrail §5; kapasitas CS sesuai SLA |

Jika gerbang tidak lulus → tetap di fase yang sama; jangan dorong akuisisi ke produk yang belum stabil.

## 2. Akuisisi traveler (sisi pasokan — kendala utama marketplace ini)
| Kanal | Taktik | Biaya | KPI |
|---|---|---|---|
| PPI (Perhimpunan Pelajar Indonesia) di JP, KR, AU, US, MY, SG | kemitraan chapter: sesi info "jastip legal & aman", kode referral traveler | Rp0–Rp500 rb/acara (ASUMSI) | traveler KYC level 3 per chapter |
| Grup diaspora (WhatsApp/Facebook/Telegram) | posting trip + kalkulator bea cukai sebagai konten bernilai, bukan spam | Rp0 | trip terverifikasi/minggu |
| Frequent flyer & komunitas travel | konten "bawa titipan, tutup ongkos tiket" dengan transparansi pajak | Rp0 | pendaftaran traveler |
| **Program onboarding jastiper eksisting ("Jastiper Pro")** | bantu jastiper IG/TikTok memindahkan pelanggan ke escrow: KYC fast-track, kit konten, badge terverifikasi setelah trip terverifikasi, promo platform fee untuk 3 transaksi pertama (promo config, maker-checker) | biaya promo (kontra-pendapatan) | GMV dari jastiper yang dipindahkan |
Referral traveler (config): Rp50.000 credit ke perujuk setelah traveler baru menyelesaikan 2 transaksi, cap Rp250.000/bulan.
Pesan wajib: deklarasi jujur ke Bea Cukai (All Indonesia), barang jastip bukan barang pribadi (PMK 34/2025), tanpa
"tips lolos bea cukai" atau pemecahan barang.

## 3. Akuisisi penitip (sisi permintaan)
- **SEO** (sudah dibangun di `apps/web`): kalkulator bea cukai, cek barang terlarang, halaman per negara
  (`/jastipkita/<slug>/`), pusat bantuan. Target kata kunci: "jastip jepang", "kalkulator bea cukai", "barang terlarang
  jastip", "jastip aman". Ukur: klik organik, konversi ke pendaftaran.
- **ASO**: judul + deskripsi dengan kata kunci jastip/titip beli luar negeri; screenshot sesuai `docs/checklists/store-checklist.md` §C.
- **Konten organik TikTok/IG Reels — 5 pilar**: (1) *harga asli vs landed cost* (transparansi 11 baris), (2) cerita
  traveler & rute ("Tokyo 12–20 Okt, sisa 5 kg"), (3) edukasi bea cukai legal, (4) SafePay: bayar → dana ditahan →
  barang diterima → dana dilepas, (5) unboxing & bukti pembelian. 3–5 konten/minggu.
- **Kreator** (mikro, 10–100 rb pengikut; niche skincare Korea, merch K-pop, snack Jepang): wajib label kerja sama
  berbayar/`#iklan`, naskah tanpa klaim menyesatkan ("100% aman", "bebas pajak" dilarang), kode referral unik.

## 4. Ekonomi unit per transaksi (dari engine `packages/core` `buildQuote` dengan config default)

Parameter config (bukan asumsi): platform fee 5 % (min Rp10.000, maks Rp750.000), protection 1,5 % (min Rp5.000,
maks Rp300.000), PPN layanan 12 % × DPP 11/12 atas platform+protection, biaya VA dibebankan ke pembeli Rp4.500,
QRIS 0,7 %. **ASUMSI**: traveler fee 10 % harga barang; bea masuk 10 % + PPN impor 11 % efektif + PPh 5 % atas
(nilai + BM) ≈ 27,6 % (aturan jastip PMK 34/2025, research 01); biaya Xendit tarif publik (research 02 §8).

| Baris (Rp) | Barang Rp1.000.000 | Barang Rp2.500.000 | Barang Rp5.000.000 |
|---|---:|---:|---:|
| Harga barang | 1.000.000 | 2.500.000 | 5.000.000 |
| Traveler fee (ASUMSI 10 %) | 100.000 | 250.000 | 500.000 |
| Bea masuk + pajak impor (estimasi, pass-through) | 276.000 | 690.000 | 1.380.000 |
| Protection fee 1,5 % | 15.000 | 37.500 | 75.000 |
| Platform fee 5 % | 50.000 | 125.000 | 250.000 |
| PPN layanan (ke negara, bukan pendapatan) | 7.150 | 17.875 | 35.750 |
| Biaya pembayaran VA (dibayar pembeli) | 4.500 | 4.500 | 4.500 |
| **Total dibayar pembeli (GMV)** | **1.452.650** | **3.624.875** | **7.245.250** |
| **Pendapatan platform** (platform + protection) | **65.000** | **162.500** | **325.000** |
| Take rate thd GMV / thd harga barang | 4,47 % / 6,5 % | 4,48 % / 6,5 % | 4,49 % / 6,5 % |
| − Subsidi biaya VA (Xendit ±Rp14.430 − Rp4.500) | −9.930 | −9.930 | −9.930 |
| − Biaya payout ke traveler (ASUMSI Rp5.000) | −5.000 | −5.000 | −5.000 |
| − Klaim proteksi (ASUMSI loss ratio 40 %) | −6.000 | −15.000 | −30.000 |
| − CS & operasional (ASUMSI Rp10.000) | −10.000 | −10.000 | −10.000 |
| − Cadangan pembatalan (ASUMSI 5 % transaksi batal penuh) | −4.222 | −9.096 | −17.222 |
| **Contribution margin (VA)** | **29.848** | **113.474** | **252.848** |
| Contribution margin (QRIS, subsidi ±Rp4.440) | 35.328 | 118.188 | 256.286 |
| CM bila payout fee ternyata 1 % + Rp4.000 (NEEDS_VERIFICATION) | 17.088 | 80.074 | 185.048 |
| LTV 12 bulan (ASUMSI 2 transaksi/pembeli aktif/tahun, VA) | 59.696 | 226.948 | 505.696 |
| **Batas CAC** (guardrail config: CAC ≤ 0,33 × LTV) | **19.700** | **74.893** | **166.880** |

Temuan (realistis, bukan menyenangkan):
1. Barang bernilai rendah (≤ Rp1 juta — umum untuk skincare/snack) hampir tidak menguntungkan: CM ±Rp30 rb dan sangat
   sensitif terhadap biaya payout. **Yang akan rusak duluan:** bila biaya payout Xendit ternyata berbasis persen,
   CM transaksi Rp1 juta turun ke ±Rp17 rb → setiap kasus sengketa/CS tambahan membuatnya rugi.
2. Biaya VA yang dibebankan (Rp4.500) jauh di bawah biaya Xendit (±Rp14.430) → subsidi ±Rp9.930/transaksi. Usulan:
   tinjau `pricing.payment_fees` setelah kontrak Xendit (maker-checker).
3. PPN layanan hanya boleh dipungut bila PT sudah PKP — lihat launch checklist L8.

## 5. Program referral (config `referral.buyer`) & eksperimen
Aturan saat ini: perujuk Rp25.000 + teman Rp25.000 JastipKita Credit (tidak bisa dicairkan, berlaku 90 hari) setelah
transaksi pertama teman COMPLETED dengan nilai ≥ Rp500.000; cap perujuk Rp250.000/bulan; guardrail otomatis: jeda bila
CAC > 0,33 × LTV atau fraud > 5 % (`engagement.referral_guardrail`).

Biaya efektif per referral = 2 × nilai × tingkat pemakaian credit (**ASUMSI 70 %**):
| Varian (per sisi) | Biaya efektif | Titik impas transaksi pertama (nilai barang) | Status vs guardrail (barang Rp2,5 jt, batas Rp74.893) |
|---|---:|---:|---|
| A — Rp15.000 | Rp21.000 | ±Rp0,84 juta | lolos |
| B — Rp25.000 (default) | Rp35.000 | ±Rp1,09 juta | lolos |
| C — Rp50.000 | Rp70.000 | ±Rp1,72 juta | batas tipis |

Usulan eksperimen (butuh persetujuan owner, dijalankan lewat `referral.buyer.experiment`):
- A/B/C 1:1:1 selama 6 minggu atau sampai ≥ 100 referral berkualifikasi per varian (mana yang lebih dulu).
- Metrik utama: transaksi COMPLETED kedua dalam 60 hari per referral; metrik pengaman: fraud rate, CM setelah biaya referral.
- Usulan perubahan aturan untuk diuji: naikkan `minFirstTransactionIdr` ke Rp1.000.000 (hindari rugi di barang murah).
- Guardrail tambahan: anggaran credit referral maks. **Rp2.000.000/bulan** (USULAN) — credit adalah biaya nyata walau tanpa uang tunai.

## 6. Iklan berbayar (Google / Meta / TikTok) — hanya setelah §7
Estimasi kasar **ASUMSI**: CPI Rp8.000, instalasi → transaksi pertama 3 % → CAC ±Rp266.667. Itu **3,6×** batas CAC
pada barang Rp2,5 juta. Artinya iklan berbayar baru masuk akal jika konversi ≥ ±11 % atau AOV jauh lebih tinggi.
Karena itu: uji kecil dengan batas kerugian, bukan kanal utama.

## 7. Prasyarat atribusi (wajib sebelum 1 rupiah iklan)
1. Event funnel sisi server berjalan & tervalidasi (`payment_secured`, `transaction_completed`, `repeat_transaction`
   sudah ada di API — `docs/api/engagement.md` §9) + dashboard KPI §8.
2. Konversi didefinisikan = **transaksi pertama COMPLETED**, bukan instalasi/daftar.
3. UTM tertangkap di web & diteruskan lewat tautan referral/deep link (`/jastipkita/r/<kode>`); Android: Play Install
   Referrer; iOS: SKAdNetwork/AdAttributionKit (agregat) — **tanpa** pelacakan lintas aplikasi (tanpa ATT).
4. Persetujuan: consent `MARKETING`/`COOKIES` sebelum piksel apa pun; conversion API sisi server hanya setelah review
   hukum + DPA dengan platform iklan; tidak mengirim PII (termasuk hash) tanpa persetujuan eksplisit.
5. Laporan kohort mingguan (CAC per kanal, CM, repeat 60 hari) dan kriteria stop: CPA > target 7 hari berturut → jeda.
6. Status merek jelas (L14–L15).

## 8. Definisi KPI (dashboard)
| KPI | Definisi | Sumber |
|---|---|---|
| GMV | Σ TOTAL transaksi COMPLETED (dan "GMV secured" = PAYMENT_SECURED) per hari WIB | `v_gmv_daily` |
| Take rate | PLATFORM_REVENUE ÷ GMV | `v_take_rate` |
| Contribution margin | pendapatan − subsidi pembayaran − payout − klaim − promo/credit | ledger + config (bulanan, Finance) |
| Likuiditas | % request yang mendapat ≥ 1 offer ≤ 48 jam | requests/offers |
| Konversi checkout | `checkout_started` → `payment_secured` | `v_funnel_daily` |
| Completion rate | COMPLETED ÷ PAYMENT_SECURED (kohort 30 hari) | transactions |
| Refund rate / dispute rate | refund ÷ secured; dispute per 100 transaksi | `v_refund_rate`, `v_dispute_rate` |
| Utilisasi traveler | kapasitas terpakai ÷ kapasitas trip aktif | `v_traveler_utilization` |
| Aktivasi | % pendaftar mencapai KYC 2 dalam 7 hari; traveler KYC 3 dalam 14 hari | users/kyc |
| Repeat | % pembeli dengan transaksi ke-2 ≤ 60 hari | analytics `repeat_transaction` |
| CAC per kanal | biaya kanal ÷ pembeli dengan transaksi pertama COMPLETED | marketing sheet + atribusi |
| Referral | share transaksi dari referral; fraud rate referral | `referrals`, risk |
| Kualitas layanan | CSAT, first response vs SLA, sengketa lewat SLA | support, `dispute.sla_breached` |

## 9. Kalender 90 hari (USULAN)
| Minggu | Produk & ops | Pasokan (traveler) | Permintaan (penitip) | Ukur |
|---|---|---|---|---|
| 1 | staging hidup, login jalan, dogfood | daftar 30 calon traveler JP/SG | siapkan 20 konten pilar | bug P0 |
| 2 | perbaikan dogfood; SOP CS & sengketa | 2 sesi PPI (online) | waitlist di web | 10 alur sukses |
| 3–4 | beta 1A (SANDBOX) | onboarding 20 traveler (KYC 3) | undang 50 penitip | CSAT, drop-off |
| 5–6 | beta 1B (LIVE terbatas **jika disetujui**) | "Jastiper Pro" gelombang 1 (5 jastiper) | referral aktif (varian B) | 30 COMPLETED, dispute |
| 7 | soft launch 6 origin | PPI KR/AU/US/MY | SEO + ASO live | likuiditas 48 jam |
| 8 | review config fee & payout (data nyata) | diaspora groups | 3 kreator mikro | CM per transaksi |
| 9 | eksperimen referral A/B/C mulai | Jastiper Pro gelombang 2 | konten 5×/minggu | repeat 60 hari (awal) |
| 10 | go/no-go publik | target 60 traveler aktif | kreator 5 | gerbang fase 3 |
| 11 | publik; cek atribusi §7 | promo musim liburan (hati-hati kapasitas) | uji iklan kecil **hanya jika §7 lulus** | CAC vs batas |
| 12 | evaluasi kapasitas infra (Workers/Neon) | — | optimasi konten terbaik | biaya infra/transaksi |
| 13 | laporan 90 hari ke owner | — | — | semua KPI §8 |

## 10. Skenario anggaran per bulan (USULAN — perlu persetujuan owner)
| Pos | Rp0 | Rp5 juta | Rp25 juta |
|---|---:|---:|---:|
| Kreator mikro | 0 | 3.000.000 (±5 × Rp600 rb, ASUMSI) | 8.000.000 |
| Acara komunitas / PPI | 0 (online) | 1.000.000 | 3.000.000 |
| Iklan berbayar (hanya setelah §7) | 0 | 0 | 10.000.000 |
| Alat (desain, penjadwalan, analitik) | 0 (versi gratis) | 500.000 | 1.500.000 |
| Cadangan kreatif/konten | 0 | 500.000 | 2.500.000 |
| **Total kas** | **0** | **5.000.000** | **25.000.000** |
| Credit referral & promo (kontra-pendapatan, bukan kas) | cap 2.000.000 | cap 2.000.000 | cap 4.000.000 |
| Perkiraan pembeli baru bertransaksi/bulan (ASUMSI) | 20–40 | 40–80 | 80–150 |
Skenario Rp0 tetap punya biaya: credit referral/promo dan waktu tim.

## 11. Risiko
| Risiko | Dampak | Mitigasi |
|---|---|---|
| **Penegakan Bea Cukai atas jastip** (jastip = bukan barang pribadi; lartas berlaku) | traveler kena pajak/ditahan → pasokan turun; harga terlihat lebih mahal karena transparan | edukasi & kalkulator; kategori berisiko diblokir (`restricted_items`); jangan pernah pasarkan "hemat pajak" |
| **Insiden kepercayaan** (penipuan, barang palsu, hilang) | viral negatif, churn | SafePay, bukti pembelian wajib, sengketa ber-SLA, respons publik ≤ 24 jam, template krisis |
| **Konflik nama/merek** "JastipKita" | kampanye sia-sia, sengketa merek, reputasi akun lain melekat | L14–L15 sebelum kampanye |
| Kebijakan Xendit / regulasi escrow | pembayaran LIVE tertunda | L4–L5 sebelum fase 1B |
| Pasokan traveler musiman | likuiditas rendah di luar musim liburan | fokus rute padat (JP, SG, KR), program Jastiper Pro |
| Pesaing (mis. Jastip by Biissa) | CAC naik | diferensiasi transparansi landed cost + edukasi legal |
| Batas infrastruktur gratis | error saat lonjakan | `docs/01-architecture.md` §10; putuskan paket sebelum fase 2 |

---

**Catatan keterbatasan data:** tidak ada data pasar jastip yang kredibel (research 04); traveler fee 10 %, beban bea &
pajak 27,6 %, biaya payout, loss ratio proteksi, biaya CS, tingkat pembatalan, frekuensi transaksi, tingkat pemakaian
credit, CPI & konversi iklan, biaya kreator dan perkiraan pembeli baru adalah **ASUMSI**; angka fee/pajak layanan
dihitung dengan engine `buildQuote` dan config default v1 (sebagian juga bertanda asumsi di config); biaya Xendit dari
halaman harga publik 2026-09-27, bukan kontrak.
