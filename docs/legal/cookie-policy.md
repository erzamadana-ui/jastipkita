---
title: Kebijakan Cookie & Penyimpanan Lokal
description: Penyimpanan yang dipakai situs JastipKita, mengapa diperlukan, dan bagaimana analitik hanya berjalan setelah persetujuan.
version: "0.1-draft"
effectiveDate: "[TANGGAL BERLAKU — diisi saat peluncuran]"
order: 9
---

> **TEMPLATE — wajib direview konsultan hukum sebelum production launch; bukan nasihat hukum.**
>
> Daftar di bawah mencerminkan kode situs saat ini (`apps/web`). Setiap penambahan cookie, SDK, atau analitik **wajib** memperbarui dokumen ini dan banner persetujuan sebelum dirilis.

**Versi:** 0.1 (draf) · **Berlaku sejak:** [TANGGAL BERLAKU] · **Pengendali data:** [NAMA BADAN USAHA — PT/CV, menunggu pendirian]

## 1. Ringkasnya

- Situs `antarkitaindonesia.com/jastipkita` **tidak memasang cookie pihak ketiga, pixel iklan, atau analitik** saat ini.
- Kami hanya memakai penyimpanan lokal peramban (*localStorage/sessionStorage*) yang **benar-benar diperlukan** agar fitur yang Anda minta berfungsi.
- Bila kelak analitik diaktifkan, analitik hanya berjalan **setelah Anda menyetujuinya** melalui banner privasi, dan dokumen ini diperbarui terlebih dahulu.

## 2. Penyimpanan yang dipakai

| Nama | Jenis | Tujuan | Kapan dibuat | Masa simpan |
|---|---|---|---|---|
| `jk-consent` | localStorage | Mengingat pilihan Anda pada banner privasi | setelah Anda memilih | sampai dihapus dari peramban |
| `jk-theme` | localStorage | Mengingat tema terang/gelap yang Anda pilih | hanya setelah Anda menekan tombol tema | sampai dihapus dari peramban |
| `jk-session` | sessionStorage | Token akses setelah Anda masuk (halaman Akun) | setelah login | berakhir saat tab ditutup atau token kedaluwarsa (±15 menit) |
| `jk-device` | sessionStorage | ID perangkat acak untuk keamanan sesi (hanya HMAC-nya yang disimpan server) | saat login | berakhir saat tab ditutup |

Kami tidak menyimpan token penyegar (*refresh token*) di peramban.

## 3. Pihak ketiga

- **Hosting situs**: [PENYEDIA HOSTING, mis. GitHub Pages] dapat mencatat alamat IP pengunjung dalam log server untuk keamanan dan operasional, sesuai kebijakan privasinya.
- **API JastipKita**: saat Anda memakai kalkulator, pemeriksa barang, pencarian trip, atau akun, peramban mengirim permintaan ke API kami ([DOMAIN API]); permintaan ini tidak memakai cookie.
- **Google Sign-In** (bila diaktifkan): skrip Google hanya dimuat setelah Anda menekan tombol "Masuk dengan Google".
- Tautan ke situs lain (mis. WhatsApp, toko aplikasi) tunduk pada kebijakan masing-masing.

## 4. Mengelola pilihan Anda

Buka **Pengaturan cookie** di bagian bawah setiap halaman untuk mengubah pilihan, atau hapus data situs melalui pengaturan peramban. Menghapus `jk-session` akan mengeluarkan Anda dari akun di web.

## 5. Kontak

[E-MAIL DPO] · Lihat juga [Kebijakan Privasi](privacy-policy.md).
