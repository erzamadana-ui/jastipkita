# SOP Komunikasi Insiden — Pengguna, Regulator & Mitra

> **TEMPLATE UNTUK REVIEW PROFESIONAL — bukan nasihat hukum.** Melengkapi runbook teknis di `docs/runbooks/` dengan
> **siapa diberi tahu, kapan, lewat apa, dan dengan kalimat apa**. Kewajiban hukum dikutip dari sumber yang diverifikasi
> 2026-10-04 (§Sumber); tenggat yang bukan dari peraturan berstatus **ASUMSI**. Semua templat wajib ditinjau Legal sebelum
> launch (launch checklist L10, `docs/runbooks/security-incident.md` §5).

| Atribut | Isi |
|---|---|
| Versi | 0.1 (draf) · 2026-10-04 |
| Pemilik | Incident Commander (IC) = Owner/delegasi [belum diisi]; DPO untuk insiden data pribadi [belum ditunjuk] |
| Runbook teknis | `docs/runbooks/payment-incident.md` · `docs/runbooks/security-incident.md` · `docs/runbooks/db-restore.md` · `docs/runbooks/dispute-sla-breach.md` |

## 1. Prinsip

1. **Satu suara:** hanya IC (atau delegasi tertulis) yang menyetujui komunikasi eksternal. CS memakai teks yang disetujui.
2. **Fakta, bukan spekulasi:** sebut yang diketahui, yang belum diketahui, dan kapan kabar berikutnya.
3. **Tanpa data pribadi** di pengumuman publik/media; tanpa menyalahkan pihak tertentu sebelum investigasi selesai.
4. **Catat semua** komunikasi (waktu WIB + UTC, kanal, penerima, versi teks) di dokumen insiden (§7).
5. **Jangan menunda kewajiban hukum** demi kelengkapan informasi — kirim yang ada, lengkapi bertahap.
6. **Peringatan anti-phishing** pada setiap pesan ke pengguna: JastipKita tidak pernah meminta OTP, PIN, atau password.

## 2. Matriks pemberitahuan

| Jenis insiden | Audiens | Tenggat | Kanal | Penyetuju | Dasar |
|---|---|---|---|---|---|
| **Kegagalan pelindungan data pribadi** | Subjek data terdampak | **≤ 3×24 jam**, tertulis | e-mail + in-app (+ SMS bila e-mail ikut terdampak) | DPO + IC + Legal | UU 27/2022 Pasal 46 ayat (1) huruf a; PP 71/2019 Pasal 14 ayat (5) |
| | Lembaga PDP | **≤ 3×24 jam**, tertulis | surat resmi — **kanal interim belum ada** (lembaga belum terbentuk per 16-09-2026); [LEGAL REVIEW: kirim ke Komdigi selaku pengawas PSE dan arsipkan bukti] | DPO + Legal | Pasal 46 ayat (1) huruf b |
| | Masyarakat | "dalam hal tertentu" — dampak luas/serius | pengumuman situs + media sosial | IC + Legal | Pasal 46 ayat (3) |
| | Prosesor/mitra terkait | segera | e-mail kontak insiden di DPA | DPO | DPA Pasal 7 (`docs/privacy/dpa-template.md`) |
| **Gangguan/kegagalan sistem berdampak serius akibat perbuatan pihak lain** (peretasan, sabotase) | Aparat penegak hukum + Kementerian/Lembaga terkait | **segera, pada kesempatan pertama** | laporan resmi | IC + Legal | PP 71/2019 Pasal 24 ayat (3) |
| **Insiden pembayaran** (dana salah catat/kirim, LIVE terganggu) | Pengguna terdampak | **≤ 2 jam** sejak P1 ditetapkan (runbook pembayaran §0); status refund ≤ 1×24 jam | in-app + e-mail | IC + Finance Lead | runbook pembayaran (ASUMSI internal) |
| | Xendit | segera bila terkait penyedia/rekonsiliasi | kanal dukungan/account manager | Finance Lead | kontrak (L4) |
| | Regulator keuangan | JastipKita **bukan** PJP; pelaporan ke BI dilakukan PJP berlisensi (riset 02 §9). Bila disertai kebocoran data/peretasan → baris di atas | — | Legal | PBI 23/6/PBI/2021 (riset) |
| **Gangguan layanan** (API/app tidak dapat dipakai) | Pengguna | awal ≤ 30 menit (SEV1) / ≤ 2 jam (SEV2); pembaruan tiap 60 menit (ASUMSI) | banner aplikasi/web bila memungkinkan, media sosial, auto-reply WA/e-mail CS | IC | ASUMSI |
| | Mitra (Xendit, penyedia cloud) | bila memengaruhi mereka | kanal dukungan | Tech lead | — |
| Pengaduan berskala / surat Ditjen PKTN, BPSK | Instansi pengirim | sesuai tenggat surat | surat resmi | Legal | `docs/sop/customer-service.md` §7 |

**Penilaian awal (≤ 24 jam, `docs/10-privacy.md` §8 & runbook keamanan §4):** data apa (KYC/biometrik? rekening? kontak?),
berapa subjek, periode, apakah terenkripsi (kolom `*_enc` / envelope dengan kunci yang **tidak** ikut bocor = risiko lebih
rendah, tetap dinilai), apakah dana terdampak. Titik mulai perhitungan 3×24 jam belum dikutip dari teks resmi — pakai
**T0 = saat insiden diketahui** (pendekatan konservatif, sejalan `docs/10-privacy.md` §8).

## 3. Lini waktu baku

| Waktu | Kegiatan |
|---|---|
| T0 | insiden diketahui; IC ditunjuk; dokumen insiden dibuka |
| T0 + 1 jam | penilaian awal: kategori (data pribadi / pembayaran / gangguan), SEV, audiens wajib |
| T0 + 2 jam | (pembayaran P1) pesan A1 ke pengguna terdampak; holding statement B5/C1 siap |
| T0 + 24 jam | penilaian data pribadi selesai; daftar subjek; draf B1/B2 diperiksa Legal |
| **≤ T0 + 72 jam** | **B1 terkirim ke subjek; B2 terkirim ke lembaga** (+ B3 bila diputuskan) |
| setiap 24 jam | pembaruan status ke audiens yang sudah diberi tahu sampai tertangani |
| ≤ 5 hari kerja setelah pulih | post-mortem (runbook) & ringkasan publik C4 bila relevan |

## 4. Templat — insiden pembayaran

**A1 · Pengguna terdampak — dana/pembayaran tertunda**
> Subjek: [JastipKita] Pembaruan status pembayaran transaksi {JK-…}
>
> Halo {nama}, saat ini terjadi gangguan pada pemrosesan pembayaran sejak {waktu WIB}. Dana pembayaranmu sebesar
> Rp{nominal} **tercatat aman** dan tidak akan diteruskan ke traveler sebelum status transaksi terkonfirmasi. Traveler
> tidak akan membeli barang sebelum pembayaran berstatus aman. Kami akan mengabarimu paling lambat {waktu berikutnya}.
> Kamu tidak perlu membayar ulang. JastipKita tidak pernah meminta OTP, PIN, atau transfer ke rekening pribadi.

**A2 · Pengguna — refund terlambat**
> Refund {RFD-…} sebesar Rp{nominal} tertunda karena {gangguan pada mitra pembayaran / validasi rekening}. Refund tetap
> tercatat dan akan diproses otomatis setelah gangguan selesai. Perkiraan: {waktu}. Status dapat dipantau di halaman transaksi.

**A3 · Pengguna — selesai**
> Gangguan pembayaran sejak {waktu} telah teratasi pada {waktu}. Status transaksimu kini {status}. {Bila ada koreksi:
> kami telah {mengembalikan/mencatat ulang} Rp{nominal}.} Mohon maaf atas ketidaknyamanannya. Pertanyaan: tiket {TKT-…}.

**A4 · Mitra pembayaran (ID/EN)**
> Subject: [JastipKita] Payment incident {INC-ID} — {short title}
> Business ID: {●} · Environment: {LIVE/TEST} · Detected: {UTC} · Impact: {webhooks failing / amount mismatch / refund errors}
> since {UTC}; affected references: {JK-… list or count}. Observed errors: {codes}. Actions taken on our side: {…}.
> Request: {resend webhooks for window …, confirm status of …, balance report}. Contact: {name, phone 24/7}.
> *(Versi Indonesia: struktur sama.)*

**A5 · Internal (tiap pembaruan)**
> [{SEV}] {judul} · Status: {investigasi/penahanan/pemulihan/selesai} · Dampak: {n pengguna, Rp…} · Sejak: {WIB}
> · Tindakan terakhir: {…} · Berikutnya: {…} pukul {…} · IC: {nama}

## 5. Templat — kegagalan pelindungan data pribadi

Isi minimum pemberitahuan tertulis menurut UU 27/2022 Pasal 46 ayat (2): **(a)** data pribadi yang terungkap; **(b)** kapan
dan bagaimana terungkap; **(c)** upaya penanganan dan pemulihan. PP 33/2026 Pasal 114–115 menurut sumber sekunder
menambahkan informasi mengenai pejabat PDP (`NEEDS_VERIFICATION`) — sertakan kontak DPO.

**B1 · Subjek data** (e-mail + in-app; bahasa sederhana)
> Subjek: Pemberitahuan insiden pelindungan data pribadi — JastipKita
>
> Halo {nama},
> Kami memberi tahu bahwa pada **{tanggal/waktu WIB}** kami mengetahui adanya insiden yang memengaruhi sebagian data
> pribadimu di JastipKita.
> **Data yang terungkap:** {daftar spesifik, mis. alamat e-mail dan nomor HP; *tidak termasuk* foto KTP/selfie dan nomor
> rekening, yang tersimpan terenkripsi}.
> **Kapan dan bagaimana:** {periode} — {penjelasan singkat, mis. akses tidak sah ke …}.
> **Yang sudah kami lakukan:** {menutup akses, merotasi kredensial, memperkuat …, melapor ke lembaga terkait}.
> **Yang sebaiknya kamu lakukan:** waspadai pesan yang mengatasnamakan JastipKita; kami tidak pernah meminta OTP, PIN,
> atau password; {periksa riwayat transaksi/rekening; ganti password e-mail bila sama dengan layanan lain}.
> **Kontak:** Pejabat Pelindungan Data Pribadi JastipKita, {e-mail DPO}, {alamat}. Rujukan insiden: {INC-ID}.
> Kami mohon maaf dan akan menyampaikan perkembangan berikutnya bila ada informasi baru.

**B2 · Lembaga PDP / instansi** (surat resmi, kop pengendali)
> Nomor: {●} · Lampiran: {kronologi, daftar kategori data & jumlah subjek} · Perihal: Pemberitahuan Kegagalan
> Pelindungan Data Pribadi
>
> Dengan hormat, sesuai Pasal 46 Undang-Undang Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi, [NAMA PT] selaku
> Pengendali Data Pribadi layanan JastipKita memberitahukan:
> 1. **Identitas pengendali & pejabat PDP:** {nama, alamat, kontak DPO}.
> 2. **Data pribadi yang terungkap:** {kategori; data spesifik ya/tidak (biometrik, keuangan pribadi); status enkripsi};
>    perkiraan jumlah subjek {n}.
> 3. **Kapan dan bagaimana:** terjadi {perkiraan waktu}, diketahui {T0}; penyebab {…}.
> 4. **Upaya penanganan & pemulihan:** {penahanan, rotasi kunci, perbaikan, pemberitahuan subjek pada {tanggal} melalui
>    {kanal}}.
> 5. **Dampak & mitigasi bagi subjek:** {…}. **Kontak koordinasi:** {nama, jabatan, telepon, e-mail}.
> Demikian disampaikan. {Kota, tanggal} — {nama, jabatan, tanda tangan}.

**B3 · Pengumuman publik** (bila diputuskan Pasal 46 ayat (3))
> Pada {tanggal} kami mengetahui insiden keamanan yang memengaruhi {kategori data} sebagian pengguna JastipKita. Kami telah
> {tindakan} dan memberi tahu pengguna terdampak secara langsung. {Data terenkripsi seperti dokumen identitas dan rekening
> tidak terdampak — hanya bila terverifikasi.} Pengguna yang tidak menerima pemberitahuan tidak terdampak. Kami tidak
> pernah meminta OTP/PIN. Informasi: {URL}.

**B4 · Prosesor/mitra** — gunakan Lampiran 4 DPA (`docs/privacy/dpa-template.md`), minta pelestarian bukti & daftar
log akses.

**B5 · Holding statement (media/sosial)**
> Kami sedang menangani dugaan insiden keamanan dan telah mengambil langkah pengamanan. Pengguna yang terdampak akan kami
> hubungi langsung. Kami akan menyampaikan informasi lebih lanjut setelah investigasi awal selesai.

## 6. Templat — gangguan layanan

**C1 · Awal**
> Kami sedang mengalami gangguan pada {aplikasi/pembayaran/login} sejak {waktu WIB}. Tim kami sedang menanganinya. Dana
> dan data transaksimu tetap tercatat. Pembaruan berikutnya pukul {waktu}.

**C2 · Pembaruan**
> Pembaruan {waktu}: {penyebab bila sudah diketahui / masih diinvestigasi}. {Fitur yang sudah pulih}. Pembaruan berikutnya
> pukul {waktu}.

**C3 · Pulih**
> Layanan {…} telah pulih pada {waktu WIB}. Bila masih mengalami kendala, tutup dan buka kembali aplikasi atau hubungi kami
> lewat tiket. {Bila ada tenggat yang terlewat selama gangguan: lihat §6.3.}

**C4 · Ringkasan pasca-insiden** (≤ 5 hari kerja, bila dampak luas)
> Ringkasan gangguan {tanggal}: durasi {…}, dampak {…}, penyebab {…}, perbaikan {…}, langkah pencegahan {…}.

**C5 · Mitra** — format A4 dengan dampak terhadap integrasi mereka.

### 6.3 Tenggat otomatis yang tetap berjalan saat gangguan (perlu keputusan IC)
Timer berikut berjalan di server walau pengguna tidak dapat membuka aplikasi: konfirmasi harga 15 menit (kedaluwarsa =
ditolak → refund), kedaluwarsa pembayaran (±30 menit), **konfirmasi otomatis 48 jam setelah Terkirim** (menutup jendela
dispute), jendela bukti 72 jam dan banding 72 jam (`business-config.defaults.json`). Belum ada mode maintenance API
(`docs/09-security.md` §3 #11). Untuk gangguan > 1 jam, IC memutuskan (usulan): (1) perpanjangan sementara lewat versi config
baru (maker-checker) — berlaku untuk timer yang dihitung setelah aktivasi; (2) penanganan per kasus: dispute dengan
`request-evidence` (memberi tenggat baru), transaksi yang terlanjur dikonfirmasi otomatis ditangani lewat refund admin
setelah ditinjau; (3) komunikasi C3 menyebut hak pengguna mengajukan peninjauan lewat tiket.

## 7. Log komunikasi (wajib di dokumen insiden)

| Waktu WIB / UTC | Audiens | Kanal | Templat & versi | Pengirim | Penyetuju | Bukti terkirim |
|---|---|---|---|---|---|---|
| | | | | | | |

## 8. Pasca-insiden

Post-mortem tanpa menyalahkan ≤ 5 hari kerja (runbook); perbarui [`../privacy/ropa.md`](../privacy/ropa.md),
[`../privacy/dpia-kyc-payout.md`](../privacy/dpia-kyc-payout.md) bila menyangkut data pribadi; perbarui templat ini bila
ada pelajaran komunikasi; arsipkan log §7 bersama bukti pemberitahuan (minimal selama retensi `audit_logs`, ASUMSI).

## Sumber (diverifikasi 2026-10-04)

| Rujukan | Isi | Sumber |
|---|---|---|
| UU 27/2022 Pasal 46 ayat (1)–(3) | 3×24 jam ke subjek & lembaga; isi minimum; masyarakat dalam hal tertentu | https://pasal.id/peraturan/uu/uu-no-27-tahun-2022/pasal-46 |
| PP 71/2019 Pasal 14 ayat (5) | PSE wajib memberi tahu pemilik data secara tertulis bila terjadi kegagalan pelindungan | https://pasal.id/peraturan/pp/pp-no-71-tahun-2019/pasal-14 |
| PP 71/2019 Pasal 24 ayat (3) | gangguan serius akibat pihak lain → amankan informasi & lapor segera ke aparat penegak hukum dan K/L terkait | https://pasal.id/peraturan/pp/pp-no-71-tahun-2019/pasal-24 |
| Lembaga PDP belum terbentuk | per 16-09-2026 | https://www.cnbcindonesia.com/tech/20260916115609-37-768328/lembaga-perlindungan-data-belum-ada-di-ri-padahal-aturannya-sudah-ada |
| PP 33/2026 Pasal 114–115 (sekunder) | isi notifikasi termasuk info pejabat PDP | https://veritask.ai/id/artikel/pengaturan-teknis-pelindungan-data-pribadi-dan-kewajiban-pengendali-serta-prosesor-akhirnya-terbit-lewat-pp-33-2026 |
| PBI 23/6/PBI/2021 | posisi JastipKita bukan PJP | `docs/research/02-xendit-integration.md` §9 (2026-09-27) |

---

**Catatan keterbatasan data:** kanal pelaporan ke lembaga PDP belum ada karena lembaga belum terbentuk, dan kanal interim
belum dikonfirmasi Legal; titik mulai perhitungan 3×24 jam belum dikutip dari teks resmi; tenggat komunikasi pembayaran
dan gangguan layanan adalah target internal (ASUMSI); peran IC/DPO/on-call belum diisi; templat belum ditinjau Legal;
kutipan pasal dari pasal.id (agregator) dan PP 33/2026 dari sumber sekunder perlu dicocokkan dengan teks resmi.
