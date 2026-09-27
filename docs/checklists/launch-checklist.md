# Launch Checklist — Gerbang Go-Live Production

> Tidak ada satu pun gerbang di bawah yang sudah lulus per 2026-09-27. Production (dan terutama **pembayaran LIVE**)
> hanya boleh dinyalakan setelah semua gerbang **P0** berstatus SELESAI dan owner mencatat keputusan tertulis
> (variabel `ALLOW_LIVE_PAYMENTS` + `LIVE_PAYMENTS_DECISION_REF` di environment `production`).
> Bukan nasihat hukum/pajak — setiap butir legal/pajak wajib diverifikasi profesional berizin.

Status: BELUM · PROSES · SELESAI · N/A. Prioritas: **P0** = blokir launch, **P1** = sebelum publik luas, **P2** = segera setelahnya.

## 1. Legal & regulasi
| # | Prio | Gerbang | PIC | Status | Bukti yang diminta |
|---|---|---|---|---|---|
| L1 | P0 | Badan hukum **PT** + **NIB** (OSS) dengan KBLI PMSE yang tepat (konfirmasi konsultan) | Owner/Legal | BELUM | akta, NIB |
| L2 | P0 | **Pendaftaran PSE Lingkup Privat** (Komdigi) untuk aplikasi, web, API — **sebelum** dipakai publik; Komdigi aktif menegakkan (pemutusan akses) | Legal | BELUM | tanda daftar PSE |
| L3 | P0 | Perizinan PPMSE (Permendag 19/2026) + **opini hukum**: apakah traveler = "pedagang" (NIB), berlakunya FOB USD 100 (Pasal 23) | Legal | BELUM | memo hukum |
| L4 | P0 | **Xendit**: akun bisnis (KYB atas nama PT), kontrak ditandatangani, **konfirmasi tertulis** bahwa dana boleh ditahan di saldo Xendit sampai barang diterima (bisa > 30 hari) dan jenis bisnis jastip diterima | Owner/Finance | BELUM | kontrak + surat/e-mail resmi Xendit |
| L5 | P0 | **Opini hukum escrow** (PBI 23/6/2021): model dana di PJP + ledger internal; tidak ada dana lewat rekening PT; perlu trustee/escrow bank? | Legal | BELUM | memo hukum |
| L6 | P0 | Review hukum semua template: S&K penitip & traveler (deklarasi jujur bea cukai, larangan splitting, tanggung jawab bea/pajak, barang terlarang), kebijakan privasi, teks persetujuan terpisah, kebijakan sengketa/refund, klausula baku (UU 8/1999) | Legal | BELUM | versi final di `legal_documents` |
| L7 | P0 | **Kepabeanan PMK 34/2025** ditinjau PPJK/konsultan kepabeanan: tarif jastip (BM 10 % + PPN + PPh 5 %), rule `db/seeds/0100_customs_rules.sql` & `0101_restricted_items.sql` (baris DRAFT → ACTIVE hanya setelah verifikasi), posisi platform atas pemberitahuan pabean yang tidak benar | Compliance + konsultan | BELUM | memo + rule versi baru disetujui maker-checker |
| L8 | P0 | **Konsultan pajak**: status PKP & kewajiban PPN atas platform/protection fee; **jika belum PKP, `pricing.service_tax.enabled` harus dimatikan (tidak boleh memungut PPN)**; PPh atas penghasilan traveler; potensi penunjukan pemungut PPh 22 (PMK 37/2025) | Finance + konsultan | BELUM | memo pajak + config versi baru |
| L9 | P0 | **JastipKita Protection** (fee 1,5 %): mitra asuransi berkontrak **atau** opini hukum bahwa proteksi ini bukan produk asuransi (OJK); saat ini `INSURANCE_PROVIDER=mock` | Owner/Legal | BELUM | kontrak/memo |
| L10 | P0 | Penunjukan **DPO**, RoPA, DPIA KYC biometrik & rekening (`docs/10-privacy.md`) | Owner/DPO | BELUM | dokumen DPIA ditandatangani |
| L11 | P1 | DPA dengan semua prosesor + pengungkapan transfer lintas negara | Legal | BELUM | DPA |
| L12 | P1 | Kanal pengaduan konsumen di beranda + SLA (Permendag 19/2026) | Product/Support | BELUM | halaman kontak + SLA |
| L13 | P2 | Label konten AI untuk ekstraksi produk (Permendag 19/2026 Pasal 47) | Product | BELUM | UI |

## 2. Merek & nama
| # | Prio | Gerbang | PIC | Status | Bukti |
|---|---|---|---|---|---|
| L14 | P0 | Cek **PDKI** "JastipKita"/"Jastip Kita" kelas 9, 35, 36, 39, 42 + konsultasi konsultan KI. Risiko **TINGGI**: domain .com/.id/.co.id dimiliki pihak lain, ada "CV JASTIP KITA INDONESIA" + ≥ 8 akun IG & TikTok aktif dengan layanan sama, nama deskriptif | Owner/Legal | BELUM | hasil PDKI + rekomendasi KI |
| L15 | P0 | Keputusan owner: tetap "JastipKita" (ajukan merek kombinasi logo+kata) **atau** ganti merek utama sebelum kampanye & listing toko | **Owner** | BELUM | keputusan tertulis |
| L16 | P1 | Amankan handle sosial konsisten | Marketing | BELUM | daftar handle |

## 3. Teknologi & operasi
| # | Prio | Gerbang | PIC | Status | Bukti |
|---|---|---|---|---|---|
| T1 | P0 | Paket infrastruktur production disetujui (Workers Paid, Neon berbayar dengan PITR ≥ 7 hari, R2) — biaya bulanan tercatat | **Owner** | BELUM | keputusan + anggaran |
| T2 | P0 | Risiko CPU Workers W1/W2 ditutup (app di-cache per isolate, unggah KYC 10 MB lolos di production) | Tim API/DevOps | BELUM | hasil uji |
| T3 | P0 | **Pentest** independen API + admin + mobile; temuan high/critical ditutup | Owner/Security | BELUM | laporan |
| T4 | P0 | **Load test**: target ASUMSI 50 request/detik selama 15 menit, p95 < 800 ms, error < 0,5 %, tanpa jurnal tidak seimbang | DevOps | BELUM | laporan k6/Artillery |
| T5 | P0 | **Backup terverifikasi**: backup harian production + restore test ≤ 4 jam berhasil (`docs/08-backup-dr.md` §4) | DevOps | BELUM | catatan `RESTORE_TEST` |
| T6 | P0 | **Monitoring & on-call**: alert 5xx, latensi, antrean job, lag outbox, selisih rekonsiliasi, `payment.amount_mismatch`; siapa on-call 24/7 dan eskalasi | DevOps/Owner | BELUM | jadwal on-call |
| T7 | P0 | Pemindai malware nyata (clamd) aktif | DevOps | BELUM | uji EICAR ditolak |
| T8 | P0 | Secret production baru (tidak reuse staging), escrow offline `DATA_ENCRYPTION_KEYS` & kunci privat backup | DevOps/Owner | BELUM | checklist rotasi |
| T9 | P0 | Uji end-to-end Xendit TEST penuh: bayar, kedaluwarsa, bayar terlambat, refund kanal, refund via payout, payout traveler, rekonsiliasi harian = 0 selisih | QA/Finance | BELUM | laporan uji |
| T10 | P0 | Validasi nama rekening (Iluma/penny-drop) aktif sebelum payout LIVE | Finance/Tim API | BELUM | uji |
| T11 | P1 | Domain kustom API + aturan WAF rate limit | DevOps | BELUM | |
| T12 | P1 | Checkpoint audit chain ke penyimpanan WORM | DevOps | BELUM | |
| T13 | P1 | Paket GitHub mendukung environment protection & branch protection | Owner | BELUM | |

## 4. Bisnis, dukungan & keuangan
| # | Prio | Gerbang | PIC | Status | Bukti |
|---|---|---|---|---|---|
| B1 | P0 | **SLA dukungan** ditetapkan & dikomunikasikan (config `support.sla`: URGENT 4 j, HIGH 12 j, NORMAL 24 j, LOW 72 j — ASUMSI), jam operasional CS, kanal WhatsApp resmi | Owner/Support | BELUM | SOP CS |
| B2 | P0 | SLA sengketa (`dispute.sla`) & SOP resolusi (maker-checker refund) dilatih ke staf | Ops | BELUM | SOP + pelatihan |
| B3 | P0 | ≥ 2 admin dengan peran berbeda (maker-checker), semua ber-MFA; FINANCE_SUPER_ADMIN ditunjuk | Owner | BELUM | daftar akun |
| B4 | P0 | Review angka config bertanda asumsi: biaya pembayaran (VA dibebankan Rp4.500 vs biaya Xendit ±Rp14.430 — subsidi ±Rp9.930/transaksi, ASUMSI tarif publik), limit transaksi, ambang auto-refund Rp10 juta | Finance | BELUM | config versi baru |
| B5 | P1 | Rekening settlement PT dicatat via maker-checker (secret store) | Finance Super Admin | BELUM | audit log |
| B6 | P1 | Rencana peluncuran & anggaran marketing disetujui (`docs/marketing/launch-plan.md`) | Owner | BELUM | keputusan |

## 5. Toko aplikasi
Lihat `docs/checklists/store-checklist.md` (akun organisasi + D-U-N-S, data safety, hapus akun, akun reviewer).

## 6. Keputusan akhir owner (diisi terakhir)
| Keputusan | Nilai | Tanggal | Referensi dokumen |
|---|---|---|---|
| Production boleh dideploy | ya / tidak | | |
| Pembayaran LIVE (`ALLOW_LIVE_PAYMENTS`) | true / false | | `LIVE_PAYMENTS_DECISION_REF` = |
| Submit Google Play / App Store | ya / tidak | | |
| Anggaran iklan berbayar per bulan | Rp | | |

---

**Catatan keterbatasan data:** daftar ini disusun dari riset desk (`docs/research/*`, diverifikasi 2026-09-27), bukan
opini hukum/pajak; target load test, SLA dukungan, subsidi biaya pembayaran dan biaya paket infrastruktur adalah
**ASUMSI** yang perlu divalidasi; status seluruh butir = BELUM pada tanggal penulisan.
