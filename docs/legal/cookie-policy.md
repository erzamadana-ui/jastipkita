---
title: Kebijakan Cookie & Penyimpanan Lokal
description: Cookie dan penyimpanan yang dipakai situs JastipKita, mengapa diperlukan, dan bagaimana analitik hanya berjalan setelah persetujuan.
version: "0.3-template"
effectiveDate: "[TANGGAL BERLAKU — diisi saat peluncuran]"
order: 9
---

> **TEMPLATE — wajib direview konsultan hukum sebelum production launch; bukan nasihat hukum.**
>
> Daftar di bawah mencerminkan kode situs saat ini (`apps/web`) dan API (`apps/api`). Setiap penambahan cookie, SDK, atau analitik **wajib** memperbarui dokumen ini dan banner persetujuan sebelum dirilis.

**Versi:** 0.3 (draf) — token penyegar (*refresh token*) dipindahkan dari *sessionStorage* ke cookie keamanan `jk_rt` (HttpOnly) yang dipasang server API · **Berlaku sejak:** [TANGGAL BERLAKU] · **Pengendali data:** [NAMA BADAN USAHA — PT/CV, menunggu pendirian]

## 1. Ringkasnya

- Situs `antarkitaindonesia.com/jastipkita` **tidak memasang cookie pihak ketiga, pixel iklan, atau analitik** saat ini.
- Kami hanya memakai **satu cookie yang benar-benar diperlukan** (`jk_rt`, untuk menjaga Anda tetap masuk dengan aman) dan penyimpanan lokal peramban (*localStorage/sessionStorage*) yang diperlukan agar fitur yang Anda minta berfungsi. Keduanya tidak dipakai untuk iklan atau pelacakan, sehingga tidak memerlukan persetujuan analitik.
- Bila kelak analitik diaktifkan, analitik hanya berjalan **setelah Anda menyetujuinya** melalui banner privasi, dan dokumen ini diperbarui terlebih dahulu.

## 2. Cookie dan penyimpanan yang dipakai

| Nama | Jenis | Tujuan | Kapan dibuat | Masa simpan |
|---|---|---|---|---|
| `jk_rt` | cookie *strictly necessary*, dipasang oleh server API JastipKita ([DOMAIN API], satu domain induk `antarkitaindonesia.com`) | Token penyegar (*refresh token*) agar Anda tetap masuk tanpa memasukkan kode OTP setiap membuka halaman. Atribut keamanan: `HttpOnly` (tidak dapat dibaca skrip halaman mana pun), `Secure` (hanya lewat HTTPS), `SameSite=Strict` (tidak dikirim dari situs lain), `Path=/v1/auth` (hanya dikirim ke endpoint login/penyegaran/keluar API) | setelah login di web | 30 hari sejak login atau penyegaran terakhir (token diganti setiap kali sesi disegarkan); dihapus saat Anda keluar (logout) atau saat sesi dicabut |
| `jk:consent` | localStorage | Mengingat pilihan Anda pada banner privasi | setelah Anda memilih | sampai dihapus dari peramban atau Anda keluar (logout) |
| `jk:theme` | localStorage | Mengingat tema terang/gelap yang Anda pilih | hanya setelah Anda menekan tombol tema | sampai dihapus dari peramban atau Anda keluar (logout) |
| `jk:device` | sessionStorage | ID perangkat acak untuk keamanan sesi (hanya HMAC-nya yang disimpan server) | saat login | berakhir saat tab ditutup atau logout |

Token akses (*access token*) **hanya disimpan di memori** halaman dan hilang saat halaman ditutup; tidak pernah ditulis ke penyimpanan peramban. Token penyegar **tidak lagi** disimpan di *sessionStorage* (kunci lama `jk:refresh` dihapus otomatis saat Anda membuka situs). Semua kunci penyimpanan lokal memakai awalan `jk:` dan dihapus seluruhnya saat Anda keluar (logout). Karena situs ini berbagi domain `antarkitaindonesia.com` dengan layanan AntarKita lain, kami menerapkan Content-Security-Policy ketat di setiap halaman dan menyimpan token penyegar di cookie yang tidak dapat dibaca skrip.

## 3. Pihak ketiga

- **Hosting situs**: [PENYEDIA HOSTING, mis. GitHub Pages] dapat mencatat alamat IP pengunjung dalam log server untuk keamanan dan operasional, sesuai kebijakan privasinya.
- **API JastipKita**: saat Anda memakai kalkulator, pemeriksa barang, pencarian trip, atau akun, peramban mengirim permintaan ke API kami ([DOMAIN API]). Permintaan ini tidak memakai cookie, **kecuali** permintaan login, penyegaran sesi, dan keluar yang membawa cookie `jk_rt` di atas.
- **Google Sign-In** (bila diaktifkan): skrip Google hanya dimuat setelah Anda menekan tombol "Masuk dengan Google".
- Tautan ke situs lain (mis. WhatsApp, toko aplikasi) tunduk pada kebijakan masing-masing.

## 4. Mengelola pilihan Anda

Buka **Pengaturan cookie** di bagian bawah setiap halaman untuk mengubah pilihan analitik, atau hapus data situs melalui pengaturan peramban. Cookie `jk_rt` diperlukan agar Anda tetap masuk; menghapusnya (atau memblokir cookie untuk [DOMAIN API]) akan mengeluarkan Anda dari akun di web — Anda tetap dapat masuk kembali, tetapi sesi hanya bertahan selama halaman terbuka.

## 5. Kontak

[E-MAIL DPO] · Lihat juga [Kebijakan Privasi](privacy-policy.md).
