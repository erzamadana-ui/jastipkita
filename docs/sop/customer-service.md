# SOP Layanan Pelanggan & Pengaduan Konsumen

> **TEMPLATE UNTUK REVIEW PROFESIONAL — bukan nasihat hukum.** SOP ini mengikuti perilaku kode per 2026-10-04
> (`apps/api/src/modules/support/*`, `apps/api/src/modules/admin/support/*`, config `support.sla`). Jam layanan, target
> penyelesaian, dan struktur tim berstatus **ASUMSI** sampai diputuskan Owner (launch checklist B1). Wajib ditinjau
> Legal (perlindungan konsumen) dan DPO (data pribadi) sebelum dipakai melayani pengguna nyata.

| Atribut | Isi |
|---|---|
| Versi | 0.1 (draf) · 2026-10-04 |
| Pemilik proses | Supervisor CS [belum ditunjuk] |
| Berlaku untuk | peran admin `SUPPORT`, `OPERATIONS`; eskalasi ke `FINANCE`, `RISK`, `COMPLIANCE`, DPO, Legal |
| Terkait | [`dispute-resolution.md`](dispute-resolution.md) · [`refund-payout-operations.md`](refund-payout-operations.md) · [`incident-communication.md`](incident-communication.md) · `docs/api/engagement.md` §8–8.1 · `docs/api/admin.md` (Support & chat moderation) |

## 1. Dasar & prinsip

| Kewajiban | Implementasi |
|---|---|
| Layanan pengaduan tampil jelas di laman utama, **> 1 kanal elektronik aktif**, SLA **ditetapkan & diumumkan**, ditanggapi sesuai SLA — Permendag 19/2026 Pasal 10 ayat (2) huruf a–d | halaman publik `/jastipkita/pengaduan/` (`apps/web/src/pages/pengaduan/`), `GET /v1/support/complaint-info`, tiket in-app; **kanal kedua (e-mail/WhatsApp) belum aktif** — env `SUPPORT_EMAIL`/`SUPPORT_WHATSAPP` kosong |
| Layanan pengaduan konsumen berupa nomor kontak dan/atau e-mail yang dapat dihubungi & ditanggapi — Pasal 12 ayat (3) | wajib diisi sebelum launch (B1) |
| Menayangkan kontak layanan pengaduan **Ditjen PKTN** — Pasal 13 | sudah tampil di halaman pengaduan & `complaint-info` |
| Pelaku usaha melayani konsumen secara benar, jujur, tidak diskriminatif; memberi kompensasi bila tidak sesuai perjanjian — UU 8/1999 Pasal 7 huruf c, f, g | §4, §7 |
| Konsumen dapat menggugat lewat lembaga penyelesaian sengketa atau peradilan; penyelesaian di luar pengadilan sukarela — UU 8/1999 Pasal 45 | §7.3: JastipKita tidak boleh menghalangi |
| Hak subjek data (akses, koreksi ≤ 3×24 jam) — UU 27/2022 Pasal 30, 32 (riset 05) | §5.4 |

Prinsip layanan: (1) jujur — jangan menjanjikan hasil yang tidak dijalankan sistem; (2) satu tiket = satu kasus, semua
tercatat; (3) data pribadi seminimal mungkin; (4) uang hanya bergerak lewat alur sistem (refund/payout/dispute), tidak
pernah lewat transfer manual oleh agen.

## 2. Peran & hak akses (seed RBAC `db/scripts/gen-reference-seed.mjs`)

| Peran | Boleh | Tidak boleh |
|---|---|---|
| SUPPORT | tiket (`support.tickets.manage`), moderasi chat (`chat.moderate`), ajukan refund (`refunds.request`), lihat pengguna & transaksi ter-mask, FAQ | memutus dispute, menyetujui refund, suspend akun |
| OPERATIONS | semua di atas + dispute (`disputes.manage`), KYC, override transaksi | menyetujui refund, payout |
| FINANCE / FINANCE_SUPER_ADMIN | approval refund, review rekening tujuan refund, payout | tiket (tidak punya `support.tickets.manage`) |
| RISK | suspend/reactivate, review risiko | — |
| DPO / COMPLIANCE | permintaan privasi, dokumen hukum | — |

Semua akses admin wajib sesi ber-MFA ≤ 12 jam; aksi sensitif butuh step-up ≤ 15 menit (`docs/api/admin.md`).

## 3. Kanal & jam layanan

| Kanal | Status kode (2026-10-04) | Cara kerja | Jam (ASUMSI) |
|---|---|---|---|
| **Tiket in-app / web akun** (`POST /v1/support/tickets`, login wajib) | ADA | membuat `TKT-…`, kategori, lampiran milik sendiri, tautan transaksi/dispute; `channel = APP` | masuk 24/7; ditangani sesuai jam operasional |
| **Pengaduan konsumen** (kategori `COMPLAINT`) | ADA (migrasi `0130`) | dari *Bantuan → Pengaduan konsumen* / halaman `/pengaduan/`; prioritas default **HIGH** | idem |
| **E-mail CS** (`SUPPORT_EMAIL`) | **belum diisi** | tidak ada ingest otomatis ke tiket | Senin–Minggu 08.00–21.00 WIB |
| **WhatsApp CS** (`SUPPORT_WHATSAPP`) | **belum diisi** | tidak ada ingest otomatis ke tiket | Senin–Minggu 08.00–21.00 WIB |
| E-mail DPO (hak privasi) | placeholder di kebijakan privasi | DPO | hari kerja |
| On-call URGENT (dana salah kirim, ATO, kebocoran data) | — | sesuai `docs/runbooks/security-incident.md` & `payment-incident.md` | 24/7 (ASUMSI, T6) |

**Gap kanal:** admin tidak memiliki endpoint untuk membuat tiket atas nama pengguna, dan tabel menyimpan `channel = 'APP'`
untuk semua tiket pengguna. Sampai dibangun: (1) arahkan pelapor via e-mail/WA untuk membuat tiket in-app dan kirim
nomornya; (2) bila tidak bisa (akun terkunci/terhapus/bukan pengguna), catat di kotak masuk e-mail CS sebagai catatan
resmi dengan nomor referensi manual `EXT-YYMMDD-NN` (ASUMSI), dan tindak lanjuti dengan SLA yang sama. Usulan ke Tim
API: endpoint "buat tiket atas nama" dengan `channel = EMAIL | WHATSAPP | ADMIN`.

**Catatan SLA jam kalender:** `sla_due_at = waktu dibuat + jam prioritas` (tanpa kalender hari kerja). Tiket HIGH yang
masuk 20.30 WIB jatuh tempo 08.30 WIB — jadwal shift harus menutup itu (lihat §9).

## 4. Klasifikasi, prioritas & SLA

### 4.1 Kategori (kode `TICKET_CATEGORIES`, `apps/api/src/modules/support/schemas.ts`)
| Kategori | Contoh | Prioritas default | Pemilik lanjutan |
|---|---|---|---|
| `COMPLAINT` | ketidakpuasan atas layanan/perilaku traveler/biaya/kebijakan | **HIGH** | Supervisor CS |
| `DISPUTE` | barang tidak sesuai/tidak diterima (transaksi berbayar) | **HIGH** | OPERATIONS (dispute) |
| `REFUND` | status refund, rekening tujuan | **HIGH** | FINANCE |
| `PAYMENT` | sudah bayar tapi belum terkonfirmasi, tagihan | **HIGH** | FINANCE / on-call |
| `TRANSACTION` | status, konfirmasi harga, serah terima | NORMAL | SUPPORT/OPERATIONS |
| `ACCOUNT` | login, OTP, KYC, hapus akun, data pribadi | NORMAL | SUPPORT / DPO |
| `CUSTOMS` | estimasi bea & pajak, barang terbatas | NORMAL | COMPLIANCE |
| `OTHER` | lainnya | NORMAL | SUPPORT |

Pengguna dapat memilih prioritas LOW/NORMAL/HIGH sendiri; **URGENT hanya diset agen** (`PATCH /v1/admin/support/tickets/{id}`).
Naikkan ke **URGENT** bila: dana salah kirim/terindikasi dialihkan, pengambilalihan akun, dugaan kebocoran data,
ancaman keselamatan saat meet-up, surat/permintaan instansi, atau liputan media.

### 4.2 SLA respons pertama — config `support.sla` (ASUMSI operasional, `business-config.defaults.json`)
| Prioritas | Respons pertama | Target penyelesaian (ASUMSI, bukan config) |
|---|---|---|
| URGENT | **4 jam** | penahanan risiko ≤ 4 jam; tuntas ≤ 1 hari kalender |
| HIGH (termasuk `COMPLAINT`) | **12 jam** | jawaban final ≤ 3 hari kerja; `COMPLAINT` ≤ 5 hari kerja |
| NORMAL | **24 jam** | ≤ 5 hari kerja |
| LOW | **72 jam** | ≤ 10 hari kerja |

- SLA dihitung dari konfigurasi berversi (sumber yang sama untuk tiket baru dan perubahan prioritas sebelum respons
  pertama). Mengubah angka = versi config baru lewat maker-checker (`POST /v1/admin/config/support.sla/versions`), bukan
  janji per kasus.
- "Respons pertama" = balasan **publik** agen (`internal:false`); catatan internal tidak menghentikan jam SLA.
- Permendag 19/2026 tidak memuat angka tenggat yang terverifikasi; SLA adalah target internal yang diumumkan
  (`docs/api/engagement.md` §8.1).

## 5. Alur penanganan tiket (langkah demi langkah)

| # | Langkah | Cara di sistem | Catatan |
|---|---|---|---|
| 1 | Ambil tiket | `GET /v1/admin/support/tickets?sla=BREACHED` → lalu `DUE_SOON` → antrean per prioritas; `POST …/{id}/assign` (status OPEN → IN_PROGRESS) | kerjakan BREACHED dulu |
| 2 | Verifikasi pelapor | tiket in-app = pemilik akun sudah terautentikasi. Kanal luar: cocokkan dengan kontak terdaftar; minta pelapor membuka tiket in-app untuk hal yang menyangkut uang/data | **jangan pernah** meminta OTP, PIN serah terima, password e-mail, nomor kartu |
| 3 | Pahami kasus | `GET …/tickets/{id}` (pesan, transaksi tertaut, `conversationId`); detail transaksi `GET /v1/admin/transactions/{id}` (ter-mask) | jangan membuka kontak penuh kecuali perlu |
| 4 | Klasifikasi ulang | `PATCH …/{id}` `{priority, note}` | perubahan prioritas sebelum respons pertama menghitung ulang `sla_due_at` |
| 5 | Respons pertama | `POST …/{id}/reply` `{body, internal:false}` → status PENDING_USER | pakai makro §6; sebut nomor tiket |
| 6 | Tindak lanjut | catatan internal `{internal:true}`; rute ke tim lain (§5.1) | catatan internal tidak pernah terlihat pengguna |
| 7 | Selesaikan | balasan berisi hasil + tindakan → `status: RESOLVED`; pengguna membalas → otomatis OPEN lagi | |
| 8 | Tutup | `RESOLVED → CLOSED` setelah 3 hari tanpa balasan (ASUMSI); tiket CLOSED tidak dapat dibalas pengguna (`TICKET_CLOSED`) | |

### 5.1 Rute per jenis kasus
| Kasus | Tindakan CS | Penerima | Referensi |
|---|---|---|---|
| Barang tidak sesuai / tidak diterima pada transaksi berbayar | arahkan membuka **dispute** dari halaman transaksi (bukan tiket) — dana tetap ditahan SafePay | OPERATIONS | [`dispute-resolution.md`](dispute-resolution.md) |
| Refund terlambat / butuh rekening tujuan | cek status refund di detail transaksi; jelaskan langkah isi rekening (OTP step-up) | FINANCE | [`refund-payout-operations.md`](refund-payout-operations.md) |
| Permintaan refund oleh agen | `POST /v1/admin/transactions/{id}/refund` hanya oleh peran dengan `transactions.override` + `refunds.request` (OPERATIONS); > Rp10 juta (ASUMSI) masuk antrean maker-checker FINANCE | OPERATIONS → FINANCE | `docs/api/admin.md` |
| Sudah bayar, status belum berubah | cek mode (`GET /v1/health`), usia pembayaran; job rekonsiliasi pending berjalan tiap 10 menit | on-call bila > 1 jam | `docs/runbooks/payment-incident.md` §1, §3 |
| Akun diambil alih / transaksi yang tidak dikenal | URGENT; minta RISK `force-logout` + `suspend`; tahan payout | RISK | `docs/runbooks/security-incident.md` §3 |
| Hak data pribadi (salinan, hapus, tarik persetujuan, koreksi KYC) | §5.4 | DPO | `docs/10-privacy.md` §3 |
| Pengaduan (`COMPLAINT`) | §7 | Supervisor CS | — |
| Ancaman keselamatan, pelecehan di chat | sembunyikan pesan (`POST /v1/admin/chat/messages/{id}/hide` `{reason}`), URGENT, pertimbangkan suspend | RISK | — |

### 5.2 Akses chat & data pribadi
- Percakapan transaksi hanya dapat dibaca agen bila ada **dispute atau tiket terbuka** yang terkait transaksi itu, dengan
  alasan tertulis; diaudit `chat.conversation_viewed` (`GET /v1/admin/chat/conversations/{id}/messages?ticketId=…&reason=…`).
- Kontak tak-termask hanya lewat `POST /v1/admin/users/{id}/reveal-contact` `{reason}` (step-up MFA; audit
  `users.pii_revealed` + security event `ADMIN_PII_REVEALED`). Gunakan hanya bila harus menghubungi di luar aplikasi.
- Dilarang menyalin data pribadi ke chat pribadi, spreadsheet pribadi, atau tangkapan layar di perangkat pribadi.

### 5.3 Lampiran & bukti
Lampiran tiket hanya file milik pelapor (purpose EVIDENCE/CHAT/RECEIPT/PRODUCT_PHOTO/DELIVERY_PROOF, tidak INFECTED).
Untuk sengketa, bukti diunggah ke dispute, bukan ke tiket.

### 5.4 Permintaan hak subjek data
| Permintaan | Jalur mandiri (arahkan dulu) | Peran CS | Tenggat |
|---|---|---|---|
| Salinan data | Profil → Keamanan & privasi → unduh data (`POST /v1/privacy/export`; file terenkripsi 7 hari) | pastikan dari akun pemilik | 3×24 jam (`privacy_requests.due_at`) |
| Hapus akun | in-app atau `/jastipkita/hapus-akun/`; tenggang 14 hari; ditolak bila ada transaksi/sengketa/refund/payout berjalan (`DELETION_BLOCKED`) | jelaskan pengecualian retensi (catatan keuangan, KYC) | sesuai kebijakan privasi |
| Tarik persetujuan | `POST /v1/me/consents {type, granted:false}` | jelaskan dampak (mis. tarik KYC → fitur traveler terbatas) | 3×24 jam (PP 33/2026 menurut riset) |
| Koreksi profil | `PATCH /v1/me` | — | 3×24 jam |
| Koreksi data KYC | **tidak ada jalur mandiri** → tiket `ACCOUNT` diteruskan ke DPO/OPERATIONS; pengguna mengajukan KYC ulang bila perlu | jangan mengubah data identitas atas permintaan chat | 3×24 jam |
| Keberatan atas keputusan otomatis (BLOCK/HOLD, KYC ditolak) | tiket `ACCOUNT` → RISK/OPERATIONS meninjau manual | catat alasan pengguna | ASUMSI 5 hari kerja |

## 6. Makro (templat balasan)

Ganti `{…}`. Nada: sopan, jelas, tanpa jargon internal. Jangan menyebut nama staf lain atau data pihak lawan.

**M-01 Penerimaan (otomatis bila belum ada)**
> Halo {nama}, terima kasih sudah menghubungi JastipKita. Laporanmu tercatat dengan nomor **{TKT-…}**. Tim kami akan
> merespons paling lambat **{jam SLA} jam** sejak tiket dibuat. Mohon jangan membagikan kode OTP atau PIN serah terima
> kepada siapa pun, termasuk yang mengaku staf JastipKita.

**M-02 Minta informasi tambahan**
> Agar dapat kami telusuri, mohon kirimkan: (1) nomor transaksi (JK-…), (2) kronologi singkat, (3) foto/tangkapan
> layar pendukung dari aplikasi. Balas langsung di tiket ini; tiket akan kembali ke antrean kami begitu kamu membalas.

**M-03 Pembayaran belum terkonfirmasi**
> Pembayaranmu sedang kami cocokkan dengan mitra pembayaran. Sistem memeriksa ulang status pembayaran yang tertunda
> secara berkala; bila dana sudah kami terima, status transaksi akan berubah otomatis. Bila setelah {X} jam belum
> berubah, kami akan menindaklanjuti langsung dan mengabarimu di tiket ini.

**M-04 Refund ke rekening (kanal VA/gerai ritel)**
> Metode pembayaran yang kamu gunakan tidak mendukung pengembalian dana otomatis, sehingga refund akan kami kirim ke
> rekening bank atas namamu. Buka transaksi → Refund → **Isi rekening tujuan**. Untuk keamanan, kami akan mengirim kode
> verifikasi ke nomor HP/e-mail terdaftar. Bila nama pemilik rekening berbeda dengan nama di identitas terverifikasi,
> rekening akan ditinjau tim keuangan terlebih dahulu.

**M-05 Status refund**
> Refund **{RFD-…}** sebesar Rp{nominal} berstatus **{status}**. {Bila PENDING_APPROVAL: Nominal ini memerlukan
> persetujuan tim keuangan.} {Bila FAILED: Pengiriman gagal karena {alasan ringkas}; kami akan mencoba ulang / mohon
> perbarui rekening.} Kami akan mengabarimu setiap ada perubahan.

**M-06 Arahkan ke dispute**
> Karena transaksimu sudah dibayar, keluhan barang sebaiknya diajukan lewat **dispute** di halaman transaksi agar dana
> tetap ditahan SafePay selama ditinjau. Unggah bukti (foto, video, struk, resi) dalam {evidenceHours} jam setelah
> dispute dibuka. {Bila barang sudah berstatus Terkirim: segera ajukan sebelum transaksi terkonfirmasi otomatis pada
> {waktu auto_confirm}.}

**M-07 Estimasi bea & pajak**
> Bea masuk dan pajak pada rincian harga adalah **estimasi** berdasarkan aturan yang berlaku saat penawaran dibuat.
> Jumlah final ditetapkan petugas Bea dan Cukai, dan barang titipan (jastip) tidak diperlakukan sebagai barang pribadi
> penumpang. Selisih diproses sesuai Syarat & Ketentuan.

**M-08 KYC ditolak**
> Pengajuan verifikasi identitasmu belum dapat kami setujui karena: {alasan}. Kamu dapat mengajukan ulang dengan foto
> dokumen yang jelas, tidak terpotong, dan selfie dengan pencahayaan cukup. Bila menurutmu keputusan ini keliru, balas
> tiket ini dan kami akan meninjaunya kembali secara manual.

**M-09 Penerimaan pengaduan (`COMPLAINT`)**
> Pengaduanmu kami terima dengan nomor **{TKT-…}** dan ditangani dengan prioritas tinggi. Kami akan merespons paling
> lambat {jam SLA} jam dan menyampaikan hasil penelusuran secara tertulis di tiket ini. Bila kamu tidak puas dengan
> penyelesaian kami, kamu berhak menyampaikan pengaduan kepada Direktorat Jenderal Perlindungan Konsumen dan Tertib
> Niaga, Kementerian Perdagangan (WhatsApp 0853-1111-1010, e-mail pengaduan.konsumen@kemendag.go.id) atau ke BPSK di
> kota/kabupaten domisilimu.

**M-10 Jawaban final pengaduan**
> Hasil penelusuran: {fakta singkat}. Tindakan yang kami ambil: {tindakan, mis. refund Rp…, peringatan ke traveler,
> perbaikan proses}. {Bila ditolak: Alasan: {alasan berdasarkan S&K/kebijakan pasal …}.} Bila masih ada yang belum
> tuntas, balas tiket ini dalam 3 hari. Informasi saluran pengaduan pemerintah: {M-09 kalimat terakhir}.

**M-11 Penutupan**
> Kami menutup tiket ini karena belum ada balasan selama 3 hari. Kamu tetap dapat membuat tiket baru kapan saja dan
> menyebut nomor {TKT-…} sebagai rujukan.

## 7. Penanganan pengaduan konsumen (`COMPLAINT`)

1. **Terima & catat (≤ SLA HIGH 12 jam):** M-09; tautkan transaksi/dispute bila ada; assign ke agen senior.
2. **Pisahkan jalur uang:** bila pengaduan menyangkut transaksi berbayar yang masih dalam jendela dispute, bantu pengguna
   membuka dispute (dana ditahan). Pengaduan tetap dicatat untuk evaluasi layanan.
3. **Telusuri (≤ 3 hari kerja, ASUMSI):** data transaksi, rincian harga & versi aturan, riwayat chat (dengan dasar tiket),
   log keputusan admin (audit). Minta keterangan pihak lain bila perlu.
4. **Tinjauan supervisor:** jawaban final pengaduan **wajib** dibaca Supervisor CS sebelum dikirim; pengaduan yang
   menyangkut kebijakan, biaya, atau klausula baku → Legal.
5. **Jawaban tertulis (≤ 5 hari kerja, ASUMSI):** M-10, status RESOLVED.
6. **Eskalasi internal** bila pengguna tidak puas: §8.
7. **Eskalasi eksternal:** pengguna berhak mengadu ke Ditjen PKTN atau BPSK, atau menggugat ke pengadilan (UU 8/1999
   Pasal 45). Agen **tidak boleh** mencegah, menunda, atau mensyaratkan hal itu. Bila Ditjen PKTN atau BPSK menghubungi
   JastipKita: catat sebagai URGENT, teruskan ke Legal dalam 1 hari kerja, kumpulkan kronologi & bukti, jawab dalam
   tenggat yang disebut surat.
8. **Catat akar masalah** (kategori: produk, kebijakan, traveler, pembayaran, bea cukai, komunikasi) untuk laporan
   bulanan (§10).

## 8. Matriks eskalasi

| Tingkat | Pemicu | Kepada | Waktu |
|---|---|---|---|
| E1 | SLA respons pertama BREACHED; pengguna meminta atasan | Supervisor CS | segera |
| E2 | pengaduan tidak selesai 5 hari kerja; nilai > Rp10 juta (ASUMSI); pola keluhan sama ≥ 3 dalam seminggu | Ops Manager | ≤ 1 hari kerja |
| E3 | ancaman hukum, media, surat instansi (Ditjen PKTN, BPSK, polisi, Komdigi); dugaan penipuan terorganisasi | Owner + Legal | ≤ 4 jam |
| E4 | dana pengguna salah catat/salah kirim; kebocoran data; ATO massal | Incident Commander (runbook) | segera, 24/7 |

## 9. Penjadwalan & kapasitas (ASUMSI)

- Shift CS 08.00–14.30 & 14.30–21.00 WIB; on-call URGENT di luar jam (T6).
- Tiket HIGH yang masuk setelah 20.30 WIB jatuh tempo sebelum 08.30 WIB → shift pagi mulai dengan filter `sla=DUE_SOON`.
- Kapasitas awal: 1 agen per ±40 tiket/hari (ASUMSI, kalibrasi setelah 4 minggu data soft launch).

## 10. Pelaporan & KPI

| KPI | Sumber | Target awal (ASUMSI) |
|---|---|---|
| Median waktu respons pertama, rasio SLA terpenuhi (30 hari) | `GET /v1/admin/support/sla` (`last30Days`; `dataQuality` bila n < 30) | ≥ 90 % terpenuhi |
| Tiket BREACHED & DUE_SOON per prioritas | idem `byPriority` | 0 BREACHED URGENT |
| Backlog per prioritas | `GET /v1/admin/dashboard/kpis` (support backlog) | — |
| Volume per kategori, jumlah `COMPLAINT` per 1.000 transaksi | kueri read-only `support_tickets` | tren turun |
| Waktu penyelesaian (`resolved_at − created_at`) | kueri read-only | sesuai §4.2 |
| Tingkat buka ulang (RESOLVED → OPEN) | event `support.ticket_updated` `USER_REPLIED` | < 10 % |
| Kepuasan pelanggan (CSAT) | **belum ada di sistem** | — |

Laporan mingguan ke Ops Manager; laporan bulanan pengaduan (jumlah, kategori akar masalah, tindakan perbaikan) ke Owner.
Angka dengan sampel < 30 wajib diberi catatan "sampel kecil".

## 11. Mutu & pelatihan

Kalibrasi mingguan 5 tiket acak per agen (ketepatan, nada, kepatuhan data pribadi); pelatihan wajib sebelum akses:
SOP ini, kebijakan privasi, S&K, matriks pembatalan, dispute SOP, pengenalan phishing/social engineering. Akses admin
dicabut pada hari terakhir kerja (`DELETE /v1/admin/users/{id}/roles/{roleCode}` — mencabut semua sesi).

## 12. Retensi catatan layanan

`support_tickets`/`ticket_messages` belum memiliki kebijakan retensi (lihat `docs/privacy/ropa.md` PA-13, G-02); saat akun
dihapus isi pesan diganti `[dihapus atas permintaan pengguna]`. Catatan kanal luar (kotak masuk e-mail) mengikuti
kebijakan yang sama setelah ditetapkan.

## Sumber (diverifikasi 2026-10-04)

| Rujukan | Sumber |
|---|---|
| Permendag 19/2026 Pasal 10, 12, 13 (teks) | https://pasal.id/peraturan/permen/permendag-no-19-tahun-2026 |
| UU 8/1999 Pasal 7, Pasal 45 | https://pasal.id/peraturan/uu/uu-no-8-tahun-1999/pasal-7 · https://pasal.id/peraturan/uu/uu-no-8-tahun-1999/pasal-45 |
| Kanal pengaduan Ditjen PKTN (WhatsApp 0853 1111 1010, pengaduan.konsumen@kemendag.go.id, (021) 3441839; Direktorat Pemberdayaan Konsumen) | Siaran pers Kemendag 15-07-2026, https://www.kemendag.go.id/berita/siaran-pers/komitmen-lindungi-konsumen-kemendag-terima-1911-layanan-konsumen-sepanjang-semester-i-2026 ; konsisten dengan `docs/api/engagement.md` §8.1 |
| Hak akses/koreksi 3×24 jam | `docs/research/05-legal-regulatory.md` §1 |

---

**Catatan keterbatasan data:** jam layanan, target penyelesaian, kapasitas, dan target KPI adalah ASUMSI pra-peluncuran
tanpa data volume nyata; nilai `support.sla` sendiri ditandai asumsi di config; kanal e-mail/WhatsApp belum aktif dan
tidak ada ingest otomatis ke tiket; kategori `COMPLAINT` dan endpoint `complaint-info` ditambahkan engineer lain pada
2026-10-04 — kodenya dibaca tetapi tesnya tidak dijalankan penyusun; kontak instansi pemerintah dapat berubah tanpa
pemberitahuan dan wajib diverifikasi ulang sebelum launch.
