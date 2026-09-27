# Runbook — Restore Database

> Kapan: data rusak/terhapus, migrasi merusak data, penyedia bermasalah. **Database forward-only**: jangan edit migrasi
> yang sudah diterapkan; jangan UPDATE/DELETE manual pada tabel ledger/audit (trigger menolak). Restore production =
> operasi maker-checker: catat `db_operations` type `RESTORE`/`SWITCH` dengan approver ≠ pelaksana.
> Strategi & RPO/RTO: `docs/08-backup-dr.md`.

## 1. Putuskan sumber restore
| Situasi | Sumber | Kehilangan data |
|---|---|---|
| Kesalahan diketahui < jendela PITR (staging 6 jam; production ≥ 7 hari bila paket berbayar) | **Neon PITR** ke timestamp sebelum kejadian | ≈ 0 s.d. menit |
| Deploy production merusak data | branch **`predeploy-*`** dari run deploy (lihat ringkasan run) | perubahan sejak deploy |
| Di luar jendela PITR / penyedia hilang | **dump harian terenkripsi** (artifact `db-backup-*` atau R2) | ≤ 24 jam |

## 2. Neon PITR / branch (paling cepat)
1. Tentukan waktu kejadian `T` (UTC) dari log/audit (`audit_logs.created_at`, log Workers).
2. Neon Console → project → *Branches* → *Create branch* → *Parent: main*, **Point in time** `T − 1 menit`
   (atau pilih branch `predeploy-*`). Nama: `restore-YYYYMMDD-HHMM`. Tanpa compute tambahan bila tidak perlu.
3. Validasi di branch baru (Connect → role owner, direct):
   ```sql
   SELECT max(version) FROM schema_migrations;
   SELECT coalesce(verify_audit_chain()::text, 'OK');
   SELECT count(*) FROM (SELECT journal_id, currency FROM ledger_entries GROUP BY 1,2
     HAVING sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) <> 0) x;   -- 0
   -- cek data yang hilang/rusak ada kembali, mis.:
   SELECT id, status, updated_at FROM transactions WHERE number = 'JK-…';
   ```
4. Pilih salah satu:
   - **Salin baris yang hilang** ke main (kasus kecil, non-ledger): ekspor dari branch → impor ke main via SQL yang ditinjau
     2 orang. Ledger/audit tidak boleh diubah — gunakan jurnal balik (`reverse_journal`) melalui jalur aplikasi.
   - **Jadikan branch sebagai database utama** (kerusakan luas): Neon → *Set as default/primary* (atau ganti host di
     connection string), buat ulang role LOGIN bila perlu, perbarui secret `DATABASE_URL`, `DATABASE_URL_MIGRATOR`,
     `DATABASE_URL_BACKUP`, jalankan workflow deploy dengan `force_secrets=true`, smoke test.
5. Setelah switch: data yang ditulis **setelah T** di database lama hilang dari yang baru → ekspor dari DB lama transaksi/
   pembayaran/webhook setelah T dan proses ulang (webhook Xendit bisa di-*resend*; job rekonsiliasi menarik status pembayaran).

## 3. Dari dump terenkripsi (penyedia baru atau di luar PITR)
Di laptop tepercaya (kunci privat age hanya ada di sana):
```bash
sha256sum jastipkita-<env>-<ts>.dump.age      # cocokkan dengan manifest.json
age -d -i ~/secure/jastipkita-backup.agekey jastipkita-<env>-<ts>.dump.age > restore.dump
```
Target kosong (branch Neon kosong atau DB baru). Sebagai owner target:
```bash
psql "$DST" -v ON_ERROR_STOP=1 <<'SQL'
SET createrole_self_grant = 'set, inherit';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jk_migrator') THEN CREATE ROLE jk_migrator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jk_app') THEN CREATE ROLE jk_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jk_readonly') THEN CREATE ROLE jk_readonly NOLOGIN; END IF;
END $$;
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE neondb TO jk_migrator;   -- nama DB target
GRANT USAGE, CREATE ON SCHEMA public TO jk_migrator;
SQL
pg_restore --no-owner --no-privileges --role=jk_migrator --exit-on-error -d "$DST" restore.dump
psql "$DST" -v ON_ERROR_STOP=1 -f db/migrations/0016_roles_grants.sql      # ownership, grants, default privileges
DATABASE_URL="$DST" bash db/scripts/migrate.sh --verify                     # checksums OK
DATABASE_URL="$DST" bash db/scripts/migrate.sh                              # terapkan migrasi yang lebih baru dari backup
shred -u restore.dump 2>/dev/null || rm -P restore.dump
```
Lalu buat role LOGIN (`docs/07-deployment.md` §3.2), validasi (§2 langkah 3), switch (§2 langkah 4).

## 4. Setelah restore — wajib
- [ ] **Terapkan ulang penghapusan data pribadi**: semua `privacy_requests` penghapusan yang selesai setelah waktu backup
      harus dijalankan ulang (`anonymize_user`) — kewajiban UU PDP.
- [ ] Rekonsiliasi pembayaran vs Xendit untuk periode yang hilang; proses ulang webhook yang terlewat.
- [ ] Hitung selisih: transaksi/pesan/unggahan setelah titik restore — beri tahu pengguna terdampak bila perlu.
- [ ] Catat `db_operations` (RESTORE + SWITCH, approver), durasi (bukti RTO), backup yang dipakai.
- [ ] Post-mortem; bila penyebabnya migrasi → migrasi kompensasi, bukan edit migrasi lama.

## 5. Staging
Staging boleh di-reset total: buat branch kosong/DB baru → bootstrap (`docs/07-deployment.md` §3) → workflow deploy.
Jangan pernah memakai data production di staging.

---

**Catatan keterbatasan data:** alur §3 telah diuji antar dua klaster PostgreSQL 16 lokal (bukan Neon); alur §2 mengikuti
fitur Neon (PITR, branch) dari dokumentasi publik dan belum dilatih; nama tombol konsol Neon dapat berubah.
