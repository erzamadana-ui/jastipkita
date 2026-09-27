---
title: Persetujuan Pemrosesan Data Verifikasi (KYC)
description: Persetujuan eksplisit terpisah untuk pemrosesan data identitas dan biometrik (selfie & liveness) dalam verifikasi akun JastipKita.
version: "0.1-template"
effectiveDate: "[TANGGAL BERLAKU — diisi saat peluncuran]"
order: 7
---

> **TEMPLATE — wajib direview konsultan hukum sebelum production launch; bukan nasihat hukum.**
>
> Data biometrik dan data keuangan pribadi adalah **data pribadi yang bersifat spesifik** (Pasal 4 ayat (2) UU 27/2022). Persetujuan ini diminta **terpisah** dari Syarat & Ketentuan, dicatat per versi, dan dapat ditarik. Wajib didahului DPIA (PP 33/2026) sebelum produksi. Lengkapi **[KURUNG SIKU]**.

**Versi:** 0.1 (draf) · **Berlaku sejak:** [TANGGAL BERLAKU] · **Pengendali data:** [NAMA BADAN USAHA — PT/CV, menunggu pendirian] · **DPO:** [E-MAIL DPO]

## 1. Untuk apa verifikasi dilakukan

Verifikasi identitas (Know Your Customer) diperlukan untuk menaikkan akun ke **Level 3 — Identitas terverifikasi** dan **Level 4 — Traveler terverifikasi**, agar Anda dapat menerima titipan, bertransaksi dengan nilai lebih tinggi, dan menerima payout. Tujuannya: mencegah penipuan dan penyalahgunaan identitas, melindungi pengguna lain, serta memenuhi kewajiban hukum yang berlaku.

## 2. Data yang diproses

| Data | Keterangan |
|---|---|
| Jenis & nomor dokumen identitas (KTP atau paspor) | dipakai untuk pencocokan; ditampilkan hanya tersamar |
| Nama lengkap sesuai dokumen | dicocokkan dengan profil dan rekening payout |
| Foto dokumen identitas | disimpan terenkripsi |
| **Selfie dan data liveness (biometrik)** | memastikan Anda adalah pemilik dokumen dan orang sungguhan |
| Rekening payout (Traveler) | validasi nama pemilik rekening; ditampilkan tersamar |
| Hasil pemeriksaan | skor kecocokan wajah, hasil liveness, deteksi duplikasi, catatan peninjau |

## 3. Cara pemrosesan

1. Pemeriksaan otomatis oleh sistem kami dan/atau penyedia verifikasi **[NAMA VENDOR KYC, LOKASI PEMROSESAN]**, dilanjutkan peninjauan manusia bila diperlukan. Anda dapat meminta peninjauan manusia atas penolakan otomatis.
2. File disimpan terenkripsi (envelope AES-256-GCM) di penyimpanan objek terpisah; basis data hanya menyimpan referensi dan hash. Akses dibatasi pada peran yang berwenang dan dicatat.
3. Data KYC **tidak** dibagikan kepada pengguna lain. Pengguna lain hanya melihat level verifikasi Anda.
4. Data biometrik **tidak** dipakai untuk pemasaran, pelatihan model pihak ketiga, atau tujuan lain di luar verifikasi dan pencegahan penipuan.

## 4. Retensi

Data identitas dan dokumen KYC disimpan selama akun aktif dan **5 tahun setelah akun ditutup** (asumsi berdasarkan praktik APU-PPT; **[LEGAL REVIEW]**), kemudian dihapus. Pengajuan yang ditinggalkan dihapus sesuai kebijakan retensi.

## 5. Transfer ke luar negeri

Bila penyedia verifikasi memproses data di luar Indonesia, transfer dilakukan dengan pelindungan sesuai Pasal 56 UU PDP. **[Sebutkan negara & dasar transfer.]**

## 6. Hak Anda

Anda dapat mengakses, memperbaiki, meminta penghapusan (dengan memperhatikan kewajiban retensi), dan **menarik persetujuan ini** kapan saja melalui **Profil → Keamanan & privasi** atau [E-MAIL DPO]. Penarikan persetujuan akan menurunkan level verifikasi dan membatasi fitur yang mensyaratkannya; transaksi yang sedang berjalan tetap diselesaikan.

## 7. Pernyataan persetujuan

> Dengan mencentang **"Saya setuju"**, saya memberikan persetujuan eksplisit kepada [NAMA BADAN USAHA] untuk memproses data identitas dan data biometrik saya (foto dokumen, selfie, dan data liveness) serta data rekening payout sebagaimana dijelaskan di atas, untuk tujuan verifikasi identitas dan pencegahan penipuan. Saya memahami bahwa saya dapat menarik persetujuan ini kapan saja.

Versi persetujuan dan waktu pemberiannya dicatat pada akun Anda.
