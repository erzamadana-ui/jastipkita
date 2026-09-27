# 08 — Backup & Disaster Recovery

> Status: staging only. Production database belum ada. Angka biaya dan kuota pihak ketiga = **ASUMSI** (verifikasi di
> halaman harga penyedia saat keputusan diambil). Semua langkah restore di bawah telah diuji pada PostgreSQL 16 lokal
> (dump → age → decrypt → `pg_restore`); restore ke Neon sungguhan belum pernah dilakukan — lakukan pada restore test
> bulanan pertama.

## 1. Ringkasan
| Lapisan | Staging (sekarang) | Production (target) |
|---|---|---|
| L1 — PITR penyedia | Neon Free: 6 jam / 1 GB history (ASUMSI) | Neon berbayar: ≥ 7 hari PITR (ASUMSI) |
| L2 — snapshot pra-deploy | — | Neon branch `predeploy-*` otomatis (`deploy-production.yml`), simpan 3 terakhir |
| L3 — logical backup harian | `db-backup.yml` 02:17 WIB → `pg_dump` → **age** → artifact 14 hari (+ R2 opsional) | sama, + salinan R2 dengan lifecycle 35 hari |
| L4 — restore test | bulanan (§4) | bulanan + drill DR tiap kuartal |
| L5 — kunci enkripsi | kunci privat age offline (owner + DPO) | sama, 2 salinan offline terpisah |

## 2. Target RPO / RTO dan apa yang dibutuhkan

| Lingkungan | RPO | RTO | Terpenuhi oleh |
|---|---|---|---|
| Staging | **24 jam** | **8 jam** | backup harian L3 (PITR 6 jam membantu untuk kesalahan yang cepat ketahuan) — **terpenuhi dengan setup Rp0** |
| Production | **≤ 15 menit** | **≤ 4 jam** | lihat tabel di bawah — **TIDAK terpenuhi dengan paket gratis** |

Kebutuhan production per skenario:

| Skenario | RPO yang dicapai | Infrastruktur minimal | Biaya/bulan (ASUMSI) |
|---|---|---|---|
| Salah hapus/salah update, migrasi rusak, bug data | ≈ 0 s.d. menit (PITR ke titik sebelum kejadian) | Neon paket berbayar dengan PITR ≥ 7 hari | ±US$15–30 (tergantung compute & storage) |
| Kerusakan saat deploy | 0 (branch pra-deploy) | `NEON_API_KEY` di environment production | termasuk di atas |
| Kehilangan akun/penyedia (Neon down total, akun terkunci) | **24 jam** dengan L3 saja | salinan dump harian di R2 (di luar Neon) | ±US$0 (R2 < 10 GB) |
| Kehilangan penyedia dengan RPO ≤ 15 menit | ≤ 15 menit | replikasi logis berkelanjutan ke penyedia kedua (mis. Postgres terkelola lain) + pemantauan lag | +US$25–60 dan beban operasi |
| RTO ≤ 4 jam (semua skenario) | — | runbook teruji (§4, `docs/runbooks/db-restore.md`), on-call yang bisa dihubungi 24/7, kredensial darurat siap, drill kuartalan | waktu orang (faktor penentu sebenarnya) |

Kesimpulan jujur: target RPO ≤ 15 menit realistis untuk kesalahan operasional (PITR), **bukan** untuk hilangnya
penyedia kecuali ada replikasi logis. Keputusan paket & biaya = **owner**. Yang akan rusak duluan di staging: PITR 6 jam
berarti kesalahan yang baru ketahuan besok pagi hanya bisa dipulihkan dari dump harian (kehilangan hingga 24 jam data uji).

## 3. Setup backup harian (`.github/workflows/db-backup.yml`)

1. **Buat pasangan kunci age di laptop tepercaya (offline dari GitHub):**
   ```bash
   age-keygen -o jastipkita-backup.agekey      # file berisi kunci PRIVAT — JANGAN diunggah ke mana pun
   grep 'public key' jastipkita-backup.agekey   # age1… → ini yang disimpan di GitHub
   ```
   Simpan `jastipkita-backup.agekey` di password manager owner **dan** salinan kedua (USB terenkripsi di brankas/DPO).
   Kehilangan kunci privat = semua backup tidak bisa dibuka.
2. GitHub environment `staging`: secret `DATABASE_URL_BACKUP` (role `jk_backup_staging`, koneksi direct,
   `docs/07-deployment.md` §3) dan `BACKUP_ENCRYPTION_PUBLIC_KEY` = `age1…`.
3. Opsional salinan di luar GitHub: bucket R2 `jastipkita-backups` (token R2 terpisah, izin hanya bucket itu) →
   variabel `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, secret `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`.
   Pasang *Object lifecycle rule*: hapus objek `db/` setelah 35 hari.
4. Jalankan manual sekali: *Actions → DB backup → Run workflow*. Hasil: artifact `db-backup-staging-<n>` berisi
   `*.dump.age` + `*.manifest.json` (sha256, ukuran, versi server, versi skema, jumlah entri TOC).

Cara kerja: `pg_dump -Fc | tee (pg_restore --list) | age -r <public key>` — dump tidak pernah tersimpan tanpa enkripsi di
runner; TOC diverifikasi (harus ada data tabel). Jika secret belum ada, job dilewati dengan notice. Jika
`DATABASE_URL_MIGRATOR` tersedia, run dicatat di `db_operations` (type `BACKUP`) sehingga terlihat di Admin DB Center.
Kuota penyimpanan artifact GitHub Free ±500 MB (ASUMSI) — dump staging saat ini ±0,75 MB (diukur pada DB kosong + seed).

## 4. Restore test bulanan (wajib, catat hasilnya)

Target: membuktikan backup bisa dibuka **dan** mengukur waktu (bukti RTO). Dilakukan di laptop tepercaya.

```bash
# 1. ambil backup terbaru (Actions → DB backup → run terakhir → Artifacts), ekstrak zip
sha256sum jastipkita-staging-*.dump.age            # harus sama dengan manifest.sha256
age -d -i ~/secure/jastipkita-backup.agekey jastipkita-staging-*.dump.age > restore.dump
pg_restore --list restore.dump | head               # TOC terbaca

# 2. target kosong: Neon → Branches → Create branch "restore-test-YYYYMM" (atau Postgres lokal)
export RESTORE_URL='postgres://neondb_owner:…@ep-…/neondb?sslmode=require'   # database kosong
time pg_restore --no-owner --no-privileges --exit-on-error -d "$RESTORE_URL" restore.dump

# 3. validasi
psql "$RESTORE_URL" -At <<'SQL'
SELECT 'schema=' || max(version) FROM schema_migrations;                       -- = manifest.schemaVersion
SELECT 'audit_chain=' || coalesce(verify_audit_chain()::text, 'OK');           -- harus OK
SELECT 'unbalanced_journals=' || count(*) FROM (
  SELECT journal_id, currency FROM ledger_entries GROUP BY 1, 2
  HAVING sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) <> 0) x; -- harus 0
SELECT 'currencies=' || count(*) FROM currencies;                               -- > 0
SQL

# 4. bersihkan
shred -u restore.dump 2>/dev/null || rm -P restore.dump
# hapus branch restore-test di Neon
```
Catat di Admin DB Center (`db_operations` type `RESTORE_TEST`): tanggal, backup yang dipakai, durasi restore,
hasil validasi, siapa yang melakukan. Gagal = insiden P2 (`docs/runbooks/security-incident.md` tidak berlaku; buka tiket ops).

## 5. Runbook insiden DR (ringkas — detail di `docs/runbooks/db-restore.md`)

| Skenario | Deteksi | Tindakan pertama (≤ 15 menit) | Pemulihan |
|---|---|---|---|
| Data terhapus/terubah salah | laporan user/admin, rekonsiliasi harian berbeda | hentikan sumber (nonaktifkan job/admin terkait), catat waktu kejadian (UTC) | PITR ke titik sebelum kejadian → branch baru → validasi → switch atau salin baris yang hilang |
| Migrasi merusak data | smoke/CI deploy gagal, error rate naik | Worker sudah auto-rollback (production); stop deploy berikutnya | branch `predeploy-*` → validasi → switch; lalu migrasi kompensasi |
| Neon down (regional) | `/v1/health` degraded, status.neon.tech | umumkan gangguan, jangan ubah data | tunggu pemulihan penyedia bila ETA < RTO; jika tidak → restore dump terakhir ke penyedia lain (§6) |
| Kredensial DB bocor | secret scanning, akses aneh | rotasi password role di Neon, perbarui secret GitHub, deploy ulang | audit `security_events`, `audit_logs`; lihat runbook security |
| Kunci privat backup hilang | gagal restore test | buat pasangan kunci baru, ganti `BACKUP_ENCRYPTION_PUBLIC_KEY` | backup lama tidak bisa dibuka — catat sebagai insiden |

## 6. Workflow migrasi penyedia (Pre-check → Backup → Schema → Data → Validation → Switch → Monitoring → Rollback)

Dicatat sebagai `db_operations` type `MIGRATION` dengan 8 langkah `db_operation_steps` di Admin DB Center (maker-checker:
langkah SWITCH/ROLLBACK butuh approver ≠ pelaksana). Contoh: Neon → penyedia Postgres lain. `SRC` = direct URL owner
sumber, `DST` = direct URL owner tujuan.

**1. Pre-check**
```bash
psql "$SRC" -At -c "SELECT version(), pg_size_pretty(pg_database_size(current_database()))"
psql "$SRC" -At -c "SELECT extname FROM pg_extension ORDER BY 1"      # tujuan harus punya pgcrypto, citext, pg_trgm, btree_gist
DATABASE_URL="$SRC" bash db/scripts/migrate.sh --verify
bash scripts/ci/db-provider-parity.sh   # (di CI) owner non-superuser di tujuan harus lolos
```
Tetapkan jendela maintenance, umumkan ke pengguna (in-app + web), siapkan approver.

**2. Backup** — Neon branch + dump terenkripsi (`db-backup.yml` manual) sebelum apa pun.

**3. Schema (tujuan)** — buat role grup lalu pulihkan definisi:
```bash
psql "$DST" -v ON_ERROR_STOP=1 <<'SQL'
SET createrole_self_grant = 'set, inherit';        -- PG ≥ 16, owner non-superuser
CREATE ROLE jk_migrator NOLOGIN; CREATE ROLE jk_app NOLOGIN; CREATE ROLE jk_readonly NOLOGIN;
-- jk_migrator must be able to create the trusted extensions and objects it will own
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE neondb TO jk_migrator;   -- ganti "neondb" dengan nama DB tujuan
GRANT USAGE, CREATE ON SCHEMA public TO jk_migrator;
SQL
pg_dump -Fc "$SRC" > final.dump                     # di laptop tepercaya; hapus setelah selesai
pg_restore --section=pre-data --no-owner --no-privileges --role=jk_migrator --exit-on-error -d "$DST" final.dump
```

**4. Data** — hentikan tulis di sumber dulu (belum ada mode maintenance di API — gap, lihat §8):
```sql
-- di SRC, sebagai owner:
ALTER ROLE jk_api_production NOLOGIN;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'jk_api_production';
```
Nonaktifkan Cron Trigger (Dashboard → Worker → Triggers) agar job tidak menulis. Lalu dump final ulang dan:
```bash
pg_dump -Fc "$SRC" > final.dump
pg_restore --section=data      --no-owner --no-privileges --role=jk_migrator --exit-on-error -d "$DST" final.dump
pg_restore --section=post-data --no-owner --no-privileges --role=jk_migrator --exit-on-error -d "$DST" final.dump
psql "$DST" -v ON_ERROR_STOP=1 -f db/migrations/0016_roles_grants.sql   # ownership, default privileges, grants (idempotent)
```
(Trigger dibuat di tahap post-data, jadi data historis tidak diblokir trigger FSM/append-only saat dimuat.)

**5. Validation**
```bash
counts() { psql "$1" -At -c "SELECT string_agg(format('SELECT %L||''|''||count(*) FROM %I', tablename, tablename), ' UNION ALL ' ORDER BY tablename) FROM pg_tables WHERE schemaname='public'" | psql "$1" -At; }
diff <(counts "$SRC" | sort) <(counts "$DST" | sort) && echo "row counts identical"
DATABASE_URL="$DST" bash db/scripts/migrate.sh --verify
psql "$DST" -At -c "SELECT coalesce(verify_audit_chain()::text,'OK')"
```
Plus query saldo ledger (§4) dan cek 5 transaksi acak (timeline, pembayaran, jurnal) di kedua sisi.

**6. Switch** — buat LOGIN role di tujuan (`docs/07-deployment.md` §3.2), perbarui secret `DATABASE_URL`,
`DATABASE_URL_MIGRATOR`, `DATABASE_URL_BACKUP` di environment, jalankan workflow deploy dengan `force_secrets=true`,
smoke test, aktifkan lagi Cron Trigger. Catat `db_operations` type `SWITCH` (butuh approver).

**7. Monitoring (24–72 jam)** — error rate & p95 latensi (Workers Observability), antrean `jobs` (umur job QUEUED tertua),
lag `outbox_events` belum terbit, hasil `money.daily_reconciliation`, `v_app_health_latest`.

**8. Rollback** — sebelum ada tulis baru di tujuan: kembalikan secret ke sumber, `ALTER ROLE jk_api_production LOGIN`
di sumber, deploy. Setelah tujuan menerima tulis baru, rollback butuh migrasi data balik (manual) → tetapkan
*point of no return* (mis. 2 jam setelah switch) dan putuskan sebelum melewatinya.

## 7. Pelacakan di Admin DB Center
`db_operations` (BACKUP, RESTORE, RESTORE_TEST, EXPORT, IMPORT, MIGRATION, CONNECTION_TEST, SWITCH, ROLLBACK) dengan
maker-checker DB untuk RESTORE/IMPORT/SWITCH/ROLLBACK; `db_operation_steps` untuk 8 langkah migrasi; `params`/`evidence`
hanya berisi tautan run CI/ID backup — CHECK di DB menolak password/secret/token.

## 8. Gap & tindakan
| Gap | Dampak | Tindakan | PIC |
|---|---|---|---|
| Tidak ada mode maintenance di API | migrasi penyedia = API error selama jendela | tambah `MAINTENANCE_MODE` (503 + pesan) | Tim API |
| PITR staging 6 jam | kesalahan yang terlambat ketahuan → pakai dump harian (RPO 24 jam) | diterima untuk staging | Owner |
| Production belum punya paket DB | target RPO/RTO belum bisa dipenuhi | putuskan paket Neon berbayar + R2 salinan | **Owner** |
| Replikasi logis lintas penyedia | RPO kehilangan penyedia = 24 jam | usulan untuk fase publik, bukan MVP | Owner/Eng |
| Checkpoint audit chain ke WORM belum ada | penulisan ulang seluruh chain oleh superuser tidak terdeteksi | ekspor `(last_id, last_hash)` harian ke R2 dengan Object Lock | Eng |
| Restore ke Neon belum pernah diuji | RTO belum terbukti | restore test pertama segera setelah staging hidup | Owner/Eng |

---

**Catatan keterbatasan data:** kuota/biaya Neon, GitHub dan R2 adalah **ASUMSI** dari dokumentasi publik; durasi
restore belum diukur di Neon; RPO/RTO production adalah target, bukan kemampuan saat ini. Prosedur §6 diturunkan dari
perilaku `pg_restore` (trigger dibuat pada post-data) dan telah diuji secara lokal antar dua klaster PostgreSQL 16
(owner tujuan non-superuser: jumlah baris identik, checksum migrasi OK, audit chain OK, role API/migrator berfungsi),
bukan end-to-end antar penyedia terkelola.
