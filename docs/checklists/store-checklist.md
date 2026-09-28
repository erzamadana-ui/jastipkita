# Checklist Toko Aplikasi (Google Play & Apple App Store)

> Submit ke toko = **keputusan owner** (biaya akun, identitas badan hukum, klaim publik). Tidak ada yang sudah
> disubmit. Sumber kebijakan: `docs/research/05-legal-regulatory.md` §7 (diverifikasi 2026-09-27) — kebijakan toko
> sering berubah, cek ulang di Play Console / App Store Connect saat submit.

Kolom **Status**: BELUM · PROSES · SELESAI · N/A.

## A. Prasyarat bersama
| # | Item | PIC | Status | Catatan |
|---|---|---|---|---|
| A1 | Badan hukum (PT) + NIB — nama pada akun developer = nama PT | Owner/Legal | BELUM | juga dipakai Xendit KYB & PSE |
| A2 | **D-U-N-S Number** untuk PT (gratis via Dun & Bradstreet; proses bisa berminggu-minggu — ASUMSI) | Owner | BELUM | wajib untuk akun organisasi Google & Apple |
| A3 | Kebijakan privasi & S&K publik di `antarkitaindonesia.com/jastipkita/…` | Legal + Web | BELUM | URL masuk ke metadata toko & aplikasi |
| A4 | **Halaman hapus akun web**: `https://antarkitaindonesia.com/jastipkita/akun/hapus/` (koordinasi tim web) + alur in-app | Web + Mobile | BELUM | API siap: `POST /v1/privacy/delete-account` |
| A5 | **Akun uji reviewer** (dibuat owner): login tanpa OTP yang tak bisa diterima reviewer → gunakan akun Google khusus reviewer (tanpa 2FA) **atau** fitur "akun review" di API (belum ada — gap, minta tim API) | Owner + Tim API | BELUM | akun harus sudah KYC level 3 agar reviewer bisa melihat fitur traveler |
| A6 | Build menunjuk API production (bukan staging); pembayaran tetap SANDBOX bila LIVE belum disetujui → sebutkan di catatan review | Owner/DevOps | BELUM | risiko ditolak sebagai "belum lengkap/beta" |
| A7 | Klaim listing jujur: "dana ditahan melalui mitra pembayaran berlisensi Bank Indonesia sampai barang diterima" — jangan menyiratkan JastipKita bank/escrow berlisensi atau "100% aman" | Marketing + Legal | BELUM | |
| A8 | Nama "JastipKita" — risiko merek tinggi (research 04) → cek PDKI sebelum listing | Owner/Legal | BELUM | lihat launch checklist L14–L15 |

## B. Google Play
| # | Item | PIC | Status | Catatan |
|---|---|---|---|---|
| B1 | Akun developer **ORGANIZATION** atas nama PT (bukan personal). Biaya pendaftaran sekali (±US$25, ASUMSI) | Owner | BELUM | owner pernah ditolak untuk fitur finansial dengan akun personal pada aplikasi lain; SafePay = fitur finansial; akun personal baru juga wajib closed test ≥ 12 penguji × 14 hari |
| B2 | *Financial features declaration* (wajib semua aplikasi): nyatakan pembayaran difasilitasi PJP berlisensi (Xendit), bukan pinjaman/bank/kripto | Owner + Legal | BELUM | jawab konsisten dengan S&K |
| B3 | App signing: Play App Signing + upload key (secret `ANDROID_KEYSTORE_*`, `mobile-release.yml`) | DevOps | PROSES | workflow siap; keystore dibuat owner |
| B4 | Target API level: aplikasi baru/update setelah 31-08-2026 kemungkinan wajib target API 36 (ASUMSI — cek Play Console) | Mobile | BELUM | |
| B5 | Izin & justifikasi (lihat tabel B-1) — tanpa lokasi, kontak, SMS read | Mobile | BELUM | |
| B6 | **Data safety form** (tabel B-2), termasuk data yang dikumpulkan SDK pihak ketiga | Mobile + DPO | BELUM | harus identik dengan kebijakan privasi |
| B7 | Account deletion: URL web (A4) + jalur in-app | Web + Mobile | BELUM | |
| B8 | Content rating (kuesioner IARC): marketplace, chat antarpengguna (dimoderasi), transaksi barang fisik | Owner | BELUM | |
| B9 | Aset listing: ikon 512×512 (`brand/app-icon/android/playstore-icon-512.png`), feature graphic 1024×500 (`brand/store/play-feature-graphic-1024x500.png`), screenshot ponsel 2–8 (tabel C) | Marketing | PROSES | aset brand sudah ada |
| B10 | Uji internal → closed → production (staged rollout 10 % → 50 % → 100 %) | Owner/Mobile | BELUM | |

### B-1. Izin Android
| Izin | Dipakai untuk | Wajib? |
|---|---|---|
| `INTERNET` | API | ya |
| `CAMERA` | foto KYC (selfie, dokumen), struk pembelian, bukti serah terima | ya, diminta saat dipakai |
| Photo Picker (tanpa izin `READ_MEDIA_*`) | pilih foto dari galeri | gunakan Android Photo Picker agar tidak perlu izin media |
| `POST_NOTIFICATIONS` (Android 13+) | notifikasi status transaksi | opsional, diminta setelah onboarding |
| Lokasi, kontak, SMS, mikrofon | **tidak dipakai** | OTP autofill pakai SMS User Consent/Retriever API (tanpa izin) |

### B-2. Pemetaan Data safety (usulan; "dibagikan" = ke pihak ketiga selain prosesor atas nama kita)
| Kategori Play | Data JastipKita | Dikumpulkan | Dibagikan | Tujuan | Opsional? |
|---|---|---|---|---|---|
| Personal info → Name | nama tampilan, nama KYC | ya | ya — ke lawan transaksi (nama tampilan saja) | fungsi aplikasi, penipuan & keamanan | nama KYC wajib untuk traveler |
| Personal info → Email address | e-mail login/transaksi | ya | tidak | akun, komunikasi | salah satu dari e-mail/HP wajib |
| Personal info → Phone number | nomor HP | ya | tidak | akun, verifikasi (KYC 2) | wajib untuk checkout |
| Personal info → Address | alamat pengiriman | ya | ya — ke traveler yang mengirim | fungsi aplikasi | hanya metode kurir |
| Personal info → Other info | nomor KTP/paspor, tanggal lahir | ya | tidak | verifikasi identitas, penipuan | wajib untuk traveler / limit tinggi |
| Financial info → User payment info | rekening payout; data kartu/e-wallet diproses Xendit di halaman Xendit | ya (rekening) | tidak | pembayaran payout/refund | wajib untuk traveler |
| Financial info → Purchase history | riwayat transaksi | ya | tidak | fungsi aplikasi | wajib |
| Photos and videos | selfie/liveness, foto dokumen, foto produk, struk, bukti | ya | ya — foto produk/struk/bukti ke lawan transaksi | fungsi, keamanan, sengketa | sebagian wajib |
| Messages → Other in-app messages | chat | ya | ya — ke lawan transaksi | fungsi, keamanan (moderasi) | opsional |
| App activity → App interactions, In-app search | event analitik tanpa PII | ya | tidak | analitik | ya |
| Device or other IDs | token push, sidik jari perangkat (HMAC) | ya | tidak | notifikasi, penipuan | push opsional |
| Location | — | **tidak** | — | — | — |
Enkripsi saat transit: **ya**. Permintaan hapus data: **ya** (A4).

## C. Screenshot (ponsel; 1080×1920 atau 1080×2400, bahasa Indonesia, label SANDBOX tidak boleh terlihat di build rilis)
1. Beranda penitip — cari barang & traveler ("Titip Mudah, Aman, Terpercaya.")
2. Buat titipan dari tautan/foto produk
3. Rekomendasi traveler (trust score, rute, tanggal)
4. Rincian harga lengkap (landed cost 11 baris, estimasi bea & pajak)
5. PAYMENT SECURED — dana ditahan mitra pembayaran
6. Mode traveler: banner DO NOT PURCHASE → PURCHASE APPROVED
7. Serah terima dengan PIN/QR
8. Pusat bantuan & sengketa / JastipKita Protection
Mockup acuan: `docs/design/mockups/*.png`.
Draf otomatis: setiap run CI menghasilkan artefak **`store-screenshots`** (14 hari) — 7 layar × Google Play 1080×1920 & 1440×2560 +
App Store iPhone 6.7" 1290×2796, dirender dari layar asli dengan data contoh (`apps/mobile/test/store_screenshots/`). Tinjau teks
& data contoh sebelum dipakai; screenshot final untuk listing harus dari build rilis (tanpa badge SANDBOX).

## D. Apple App Store
| # | Item | PIC | Status | Catatan |
|---|---|---|---|---|
| D1 | **Apple Developer Program** organisasi (US$99/tahun, D-U-N-S) — 5.1.1(ix): layanan finansial diajukan badan hukum | Owner | BELUM | biaya → persetujuan owner |
| D2 | **Sign in with Apple** (atau opsi setara sesuai 4.8) bila Google Sign-In ditawarkan | Mobile | BELUM | API mendukung `POST /v1/auth/apple` |
| D3 | Hapus akun di dalam aplikasi (5.1.1(v)) | Mobile | BELUM | |
| D4 | Pembayaran barang fisik via Xendit (3.1.3(e)) — bukan IAP | Mobile | BELUM | jelaskan di catatan review |
| D5 | **Privacy nutrition label** (tabel D-1) + privacy manifest SDK | Mobile + DPO | BELUM | |
| D6 | App Tracking Transparency: **tidak ada pelacakan** → tidak ada prompt ATT; pastikan tidak ada SDK iklan/atribusi yang melacak | Mobile/Marketing | BELUM | atribusi iklan nanti: SKAdNetwork/AdAttributionKit saja |
| D7 | Export compliance: hanya enkripsi standar (HTTPS/OS) → deklarasi pengecualian (verifikasi) | Mobile | BELUM | |
| D8 | Catatan review: model P2P, SafePay via Xendit (BI), kepatuhan bea cukai, akun demo (A5), cara uji pembayaran sandbox | Owner | BELUM | |
| D9 | Screenshot iPhone 6.9" (1320×2868) + 6.5" bila diminta; iPad bila mendukung iPad | Marketing | BELUM | |
| D10 | Build iOS: `mobile-release.yml` job iOS (nonaktif; butuh sertifikat & runner macOS = 10× menit) | DevOps | BELUM | |

### D-1. Privacy nutrition label (usulan)
| Kategori Apple | Data | Terhubung ke identitas | Pelacakan |
|---|---|---|---|
| Contact Info | nama, e-mail, nomor HP, alamat | ya | tidak |
| Financial Info → Other Financial Info | rekening payout | ya | tidak |
| Sensitive Info | biometrik (selfie/liveness) | ya | tidak |
| User Content | foto, chat, dukungan pelanggan | ya | tidak |
| Identifiers → User ID, Device ID | ID akun, token perangkat | ya | tidak |
| Purchases | riwayat transaksi | ya | tidak |
| Usage Data | interaksi produk | ya | tidak |
| Other Data | nomor & foto dokumen identitas | ya | tidak |

---

**Catatan keterbatasan data:** biaya akun developer, waktu proses D-U-N-S, persyaratan target API dan kategori
formulir toko adalah **ASUMSI** dari dokumentasi publik per September 2026 dan harus diverifikasi saat submit; pemetaan
data safety/nutrition label mengikuti desain API saat ini (klien mobile belum selesai, daftar SDK belum final).
