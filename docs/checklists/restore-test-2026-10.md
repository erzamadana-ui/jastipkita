# Restore drill 2026-10 — LOKAL (bukan production)

> **Jenis:** drill lokal di container pengembangan (PostgreSQL 16.13, 2 vCPU, 7 GB RAM, dipakai bersamaan oleh proses
> lain → angka waktu bising). **Bukan** bukti RTO production: tidak ada production, tidak ada Neon, tidak ada dekripsi
> `age`, tidak ada transfer jaringan. Gerbang **T5** (`launch-checklist.md`) tetap **BELUM** sampai backup harian
> production + restore test atas backup sungguhan ≤ 4 jam tercatat. Yang dibuktikan di sini: alat drill bekerja,
> pemeriksaannya mendeteksi kerusakan, dan skala waktunya untuk ukuran data awal peluncuran.

Tanggal: 2026-10-04 · Pelaksana: Claude (agen engineering, sesi lokal) · Alat: [`db/scripts/restore-test.sh`](../../db/scripts/restore-test.sh)

## 1. Apa yang dilakukan skrip

1. **Snapshot sumber** — satu sesi `REPEATABLE READ READ ONLY` mengekspor snapshot (`pg_export_snapshot()`), menghitung
   baris **setiap** tabel `public`, membuat sidik isi (md5 seluruh baris, urut, UTC, `COLLATE "C"`) untuk tabel ≤ 200 000
   baris, mencatat objek skema, posisi sequence, versi skema dan head rantai audit.
2. **`pg_dump -Fc --snapshot=<id>`** — dump memakai snapshot yang **sama**, jadi hitungan & dump konsisten walau sumber
   sedang menerima tulisan (wajib koneksi *direct*, bukan pooler transaksi).
3. **Restore** ke database **baru** (`jk_restore_test_<UTC>`; skrip menolak nama yang sudah ada) dengan
   `pg_restore --no-owner --no-privileges --exit-on-error [--jobs N]`.
4. **Pemeriksaan** pada salinan: jumlah baris & set tabel, sidik isi, objek (tabel/view/fungsi/trigger/indeks/constraint/
   ekstensi), sequence, ledger seimbang (per jurnal per mata uang + global), `verify_audit_chain()` + head = sumber +
   checkpoint audit (T12) masih cocok, checksum `schema_migrations` = SHA-256 file `db/migrations/*.sql`.
5. **Laporan** Markdown (waktu per fase), database & dump dihapus (kecuali `--keep` / `--keep-dump`), opsional dicatat
   sebagai `db_operations` `RESTORE_TEST` (`--record-url`) sehingga tampil di Admin DB Center.

Mode `--dump FILE` menguji dump yang sudah ada (mis. backup harian setelah `age -d`); tanpa `--source` pemeriksaan
pembanding sumber dilaporkan N/A dan sisanya (restore, ledger, audit, checksum migrasi) tetap berjalan.

## 2. Data uji

Dibuat dengan `node tests/load/run.mjs --keep-db` (migrasi + seed + API sungguhan + worker in-process; MOCK providers):

| Set | Perintah seed | Ukuran DB | Isi utama |
|---|---|---:|---|
| A | `--duration 15 --concurrency 20` | 43 MB | 475 pengguna, 800 transaksi, 150 pembayaran SECURED, 150 jurnal / 600 entri ledger, 2 681 baris audit, 1 checkpoint audit |
| B | `--duration 8 --concurrency 20 --buyers 3000 --trips 2000 --webhook-payments 600` | 76 MB | 3 500 pengguna, 6 000 transaksi, 404 pembayaran SECURED, 404 jurnal / 1 616 entri, 11 044 baris audit, 1 checkpoint audit |

Catatan set B: load test sendiri melaporkan `Invariants: VIOLATED` karena hanya 404/600 webhook selesai dalam jendela
8 detik (rate limit webhook); integritas datanya diperiksa terpisah — 0 jurnal tidak seimbang, `verify_audit_chain()` OK.

## 3. Hasil

Perintah (contoh set A):
```bash
bash db/scripts/restore-test.sh --source postgres://…/jk_load_mut8kp91 --target-admin postgres://…/postgres \
  --label "local drill (load-test data)" --report restore.md --record-url postgres://…/jk_load_mut8kp91
```

| Run | Data | Dump | Snapshot + sidik | pg_dump | pg_restore | Cek | **Total** | Hasil |
|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | A, jobs=1 | 2,4 MB, TOC 1 738 | 0,81 s | 0,75 s | 5,50 s | 2,34 s | **10,24 s** | PASS 8/8 |
| 2 | B, jobs=1 | 7,0 MB, TOC 1 738 | 0,93 s | 0,83 s | 2,63 s | 2,11 s | **6,87 s** | PASS 8/8 |
| 3 | B, jobs=4 | 7,0 MB | 1,13 s | 1,18 s | 2,80 s | 2,76 s | **8,33 s** | PASS 8/8 |
| 4 | A, `--dump` (dump yang sudah ada, tanpa sumber) | 2,4 MB | — | — | 1,94 s | — | **3,24 s** | PASS 4/4 (4 N/A) |
| 5 | A, uji pencatatan `--record-url` | 2,4 MB | — | 0,57 s | 2,84 s | — | **6,21 s** | PASS 8/8, baris `RESTORE_TEST` SUCCEEDED |

Detail run 2 (B, jobs=1):

| Check | Result | Detail |
|---|---|---|
| restore | PASS | pg_restore exit 0 (--no-owner --no-privileges --exit-on-error) |
| row_counts | PASS | 111 tables, 83793 rows — identical to the source snapshot |
| content | PASS | 111/111 tables fingerprinted (md5 of all rows, ≤ 200000 rows), all identical |
| objects | PASS | constraints=899 functions=369 indexes=506 tables=111 triggers=155 views=18 |
| sequences | PASS | 16 sequences at the source position |
| ledger | PASS | 404 journals / 1616 entries; 0 unbalanced journal/currency; debit = credit per currency |
| audit_chain | PASS | verify_audit_chain()=OK, head #11044; head = source; checkpoints mismatched/total: 0/1 |
| migrations | PASS | schema 0140; 30 checksums match db/migrations |

**Drill negatif** (salinan set A yang sengaja dirusak sebagai superuser: 1 baris audit diubah dengan trigger
dimatikan, 1 entri ledger +1, checksum `schema_migrations` 0009 diganti) → **FAIL 3/8, exit 1**, tepat pada yang dirusak:

| Check | Result | Detail |
|---|---|---|
| ledger | FAIL | 1 unbalanced journal/currency pairs, 1 currencies with debit ≠ credit |
| audit_chain | FAIL | verify_audit_chain()=100 (baris yang diubah) |
| migrations | FAIL | 29 checksums match db/migrations; CHECKSUM MISMATCH: 0009 |

Catatan: run 1 lebih lambat dari run 2 walau datanya lebih kecil — mesin dipakai bersamaan oleh tes agen lain (bising);
`--jobs 4` tidak membantu di 2 vCPU dan ukuran sekecil ini.

## 4. Interpretasi (realistis)

- **Untuk ukuran data awal (< 100 MB), restore + verifikasi lokal < 15 detik.** RTO 4 jam tidak akan gagal karena
  `pg_restore`; yang akan gagal duluan: (1) kunci privat `age` tidak bisa ditemukan saat insiden, (2) tidak ada orang
  on-call yang bisa membuat branch/DB baru dan mengganti secret `DATABASE_URL`, (3) grant/role belum diterapkan ulang
  setelah `--no-privileges` sehingga API menolak konek (`psql -f db/migrations/0016_roles_grants.sql`, `docs/08-backup-dr.md` §6).
- Restore ke Neon lewat internet akan lebih lambat (bandwidth + latensi per statement). **Belum diukur** — ASUMSI tetap
  jauh di bawah 4 jam untuk < 1 GB, tetapi harus dibuktikan pada restore test bulanan pertama di staging.
- Sidik isi md5 membuat waktu verifikasi tumbuh linear dengan data; di atas ±1 GB turunkan `--fingerprint-max-rows`
  (tabel besar tetap dibandingkan lewat jumlah baris + ledger + rantai audit).

## 5. Yang BELUM dibuktikan / langkah berikut

| # | Langkah | PIC | Bukti yang dicatat |
|---|---|---|---|
| 1 | Staging hidup → backup harian `db-backup.yml` jalan | Owner/Eng | artifact + `db_operations` BACKUP |
| 2 | Restore test bulanan dari backup sungguhan: unduh artifact → `age -d` → `bash db/scripts/restore-test.sh --dump restore.dump --target-admin <Neon owner URL> --record-url <DATABASE_URL_MIGRATOR> --environment STAGING` | Owner/Eng | laporan Markdown + `db_operations` RESTORE_TEST |
| 3 | Ukur durasi end-to-end termasuk unduh, dekripsi, buat DB/branch, terapkan grant, smoke test API terhadap salinan | Owner/Eng | tabel waktu di file ini (bulan berikutnya: `restore-test-YYYY-MM.md`) |
| 4 | Production: ulangi pada backup production sebelum go-live → syarat T5 | Owner | catatan `RESTORE_TEST` production |

Neon: membuat database lewat SQL (`CREATE DATABASE`) dengan role owner proyek — **ASUMSI**, verifikasi di staging; bila
tidak diizinkan, buat branch kosong/DB baru lewat konsol lalu jalankan skrip dengan `--target-admin` ke DB itu.

---

**Catatan keterbatasan data:** semua angka diukur di container lokal yang dipakai bersamaan (timing bising, satu
kali per konfigurasi); data berasal dari seed load test dengan provider MOCK, bukan data pengguna nyata; bukan
pengujian production, Neon, R2, maupun dekripsi `age`.
