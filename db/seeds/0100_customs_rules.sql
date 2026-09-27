-- =============================================================================
-- 0100_customs_rules.sql — Aturan bea masuk & pajak impor barang bawaan penumpang (ID)
-- -----------------------------------------------------------------------------
-- Riset: docs/research/01-customs-tax-indonesia.md (diverifikasi 2026-09-27).
-- Status verifikasi: research-agent, BELUM diverifikasi ahli kepabeanan/PPJK.
--
-- Konvensi:
--   * Rate = pecahan (0.10 = 10%). vat_dpp_factor 0.916667 = 11/12 (PMK 131/2024 Pasal 3);
--     numeric(9,6) tidak bisa menyimpan 11/12 eksak -> PPN efektif 0.11000004 (selisih diabaikan).
--   * priority: engine (packages/core/src/customs) memilih rule paling spesifik
--     (HS prefix > kategori > origin > treatment eksak); jika seri, priority LEBIH BESAR menang.
--   * effective_until NULL = open-ended.
--   * Baris yang nilainya belum terkonfirmasi: status DRAFT + notes diawali 'NEEDS_VERIFICATION:'.
--   * Sengaja TIDAK ada override kategori untuk PPnBM: riset menunjukkan barang branded
--     (tas, jam, perhiasan, parfum) tidak termasuk daftar PPnBM (PMK 96/PMK.03/2021 jo
--     PMK 15/PMK.03/2023). Menduplikasi rule default per kategori hanya menambah risiko
--     rule kategori basi ketika default diperbarui.
--   * Alkohol, tembakau/vape, uang tunai: TIDAK dimodelkan sebagai tarif — ditangani
--     sebagai PROHIBITED di 0101_restricted_items.sql.
--   * Tarif flat 10% PMK 34/2025 berlaku untuk semua HS barang penumpang (tidak ada tarif
--     preferensi FTA/ATIGA dan tidak ada BMAD/BMTP — Pasal 25A), sehingga origin_country NULL.
--
-- JANGAN dijalankan sebelum migrasi 0005_config_rules.sql + seed countries/product_categories.
-- =============================================================================
BEGIN;

-- -----------------------------------------------------------------------------
-- 1) DEFAULT JASTIP: barang bukan barang pribadi penumpang (NON_PERSONAL)
--    PMK 34/2025 Pasal 24 ayat (3): BM 10% atas keseluruhan nilai pabean,
--    PPN/PPnBM sesuai tarif, PPh 5% dari nilai impor. PPN: PMK 131/2024 Pasal 3.
-- -----------------------------------------------------------------------------
INSERT INTO customs_rules (
  code, version, origin_country, destination_country, hs_code_prefix, category_code,
  treatment, formula_code, exemption_usd, duty_rate, vat_rate, vat_dpp_factor,
  luxury_tax_rate, income_tax_rate, income_tax_rate_no_npwp, rounding, priority,
  effective_from, effective_until, source_reference, source_url, last_verified_at,
  verified_by, notes, status
) VALUES (
  'ID_PAX_NON_PERSONAL', 1, NULL, 'ID', NULL, NULL,
  'NON_PERSONAL', 'ID_PASSENGER_V2025', NULL, 0.100000, 0.120000, 0.916667,
  0.000000, 0.050000, NULL, 'CEIL_1000', 100,
  DATE '2025-06-06', NULL,
  'PMK 34 Tahun 2025 (mengubah PMK 203/PMK.04/2017) Pasal 24 ayat (3) jo Pasal 7 ayat (1) huruf b; Pasal 25A (tanpa BMAD/BMTP). PPN: PMK 131/2024 Pasal 3 (12% x DPP 11/12). Pembulatan BM: PMK 190/2022 Pasal 22 ayat (4).',
  'https://jdih.kemenkeu.go.id/api/download/4509c489-5dfb-42b7-a4a0-0f88295ffa85/2025pmkeuangan034.pdf',
  DATE '2026-09-27',
  'research-agent (belum diverifikasi ahli kepabeanan)',
  'Default untuk semua item jastip. Tanpa pembebasan USD 500 (nilai pabean = keseluruhan). PPh 5% berlaku tanpa pembedaan NPWP menurut teks PMK 34/2025; income_tax_rate_no_npwp NULL sehingga engine memakai 5% untuk semua (lihat v2 DRAFT). NPWP yang relevan adalah milik traveler (importir pada Customs Declaration). Rounding CEIL_1000 diterapkan engine ke semua komponen = konservatif (maks +Rp999/komponen); pembulatan PDRI di CD penumpang belum dikonfirmasi. Kurs: KMK mingguan (Rabu-Selasa) pada tanggal kedatangan.',
  'ACTIVE'
) ON CONFLICT (code, version) DO NOTHING;

-- 1b) Versi kandidat: PPh 22 tanpa NPWP 10% (UU PPh Pasal 22 ayat (3): 100% lebih tinggi).
INSERT INTO customs_rules (
  code, version, origin_country, destination_country, hs_code_prefix, category_code,
  treatment, formula_code, exemption_usd, duty_rate, vat_rate, vat_dpp_factor,
  luxury_tax_rate, income_tax_rate, income_tax_rate_no_npwp, rounding, priority,
  effective_from, effective_until, source_reference, source_url, last_verified_at,
  verified_by, notes, status
) VALUES (
  'ID_PAX_NON_PERSONAL', 2, NULL, 'ID', NULL, NULL,
  'NON_PERSONAL', 'ID_PASSENGER_V2025', NULL, 0.100000, 0.120000, 0.916667,
  0.000000, 0.050000, 0.100000, 'CEIL_1000', 100,
  DATE '2025-06-06', NULL,
  'PMK 34 Tahun 2025 Pasal 24 ayat (3); UU PPh Pasal 22 ayat (3) sebagaimana diubah UU 36/2008 (tarif 100% lebih tinggi tanpa NPWP) — penerapan pada barang penumpang belum dikonfirmasi.',
  'https://jdih.kemenkeu.go.id/api/download/4509c489-5dfb-42b7-a4a0-0f88295ffa85/2025pmkeuangan034.pdf',
  DATE '2026-09-27',
  'research-agent (belum diverifikasi ahli kepabeanan)',
  'NEEDS_VERIFICATION: tarif PPh 22 impor untuk traveler tanpa NPWP (5% flat per teks PMK 34/2025 vs 10% per UU PPh Pasal 22 ayat (3)); halaman registrasi IMEI BC Ngurah Rai masih mencantumkan 10%/20% (versi lama). Jika terkonfirmasi 10%: set v1 RETIRED + effective_until, lalu aktifkan v2 dengan effective_from tanggal persetujuan.',
  'DRAFT'
) ON CONFLICT (code, version) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2) BARANG PRIBADI PENUMPANG (PERSONAL) — informasi / barang milik traveler sendiri.
--    PMK 34/2025 Pasal 12 ayat (1),(5) & Pasal 24 ayat (1): bebas BM/PPN/PPh s.d.
--    FOB USD 500 per orang per kedatangan; kelebihan: BM 10%, PPN/PPnBM dipungut,
--    PPh DIKECUALIKAN (berlaku surut sejak 2025-01-01 untuk PPh — Pasal II ayat (1)).
-- -----------------------------------------------------------------------------
INSERT INTO customs_rules (
  code, version, origin_country, destination_country, hs_code_prefix, category_code,
  treatment, formula_code, exemption_usd, duty_rate, vat_rate, vat_dpp_factor,
  luxury_tax_rate, income_tax_rate, income_tax_rate_no_npwp, rounding, priority,
  effective_from, effective_until, source_reference, source_url, last_verified_at,
  verified_by, notes, status
) VALUES (
  'ID_PAX_PERSONAL', 1, NULL, 'ID', NULL, NULL,
  'PERSONAL', 'ID_PASSENGER_V2025', 500.00, 0.100000, 0.120000, 0.916667,
  0.000000, 0.000000, NULL, 'CEIL_1000', 100,
  DATE '2025-06-06', NULL,
  'PMK 34 Tahun 2025 Pasal 12 ayat (1) dan (5); Pasal 24 ayat (1) (nilai pabean = keseluruhan - FOB USD 500; PPh dikecualikan). PPN: PMK 131/2024 Pasal 3.',
  'https://jdih.kemenkeu.go.id/api/download/4509c489-5dfb-42b7-a4a0-0f88295ffa85/2025pmkeuangan034.pdf',
  DATE '2026-09-27',
  'research-agent (belum diverifikasi ahli kepabeanan)',
  'Engine memakai NON_PERSONAL untuk item jastip secara default; rule ini hanya untuk barang pribadi traveler (mis. simulasi sisa allowance). Pembebasan USD 500 berlaku per ORANG per KEDATANGAN untuk seluruh barang pribadinya dan TIDAK boleh dialokasikan ke item penitip. Awak sarana pengangkut hanya USD 50 (Pasal 14) dan jemaah haji khusus USD 2.500 — tidak dimodelkan (skema tidak membedakan jenis penumpang).',
  'ACTIVE'
) ON CONFLICT (code, version) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3) Override kandidat: buku (PPN dibebaskan untuk buku pelajaran umum, kitab suci,
--    buku pelajaran agama — PMK 5/PMK.010/2020). BM 10% & PPh 5% tetap (PMK 34/2025).
-- -----------------------------------------------------------------------------
INSERT INTO customs_rules (
  code, version, origin_country, destination_country, hs_code_prefix, category_code,
  treatment, formula_code, exemption_usd, duty_rate, vat_rate, vat_dpp_factor,
  luxury_tax_rate, income_tax_rate, income_tax_rate_no_npwp, rounding, priority,
  effective_from, effective_until, source_reference, source_url, last_verified_at,
  verified_by, notes, status
) VALUES (
  'ID_PAX_NON_PERSONAL_BOOKS', 1, NULL, 'ID', '4901', NULL,
  'NON_PERSONAL', 'ID_PASSENGER_V2025', NULL, 0.100000, 0.000000, 1.000000,
  0.000000, 0.050000, NULL, 'CEIL_1000', 100,
  DATE '2025-06-06', NULL,
  'PMK 5/PMK.010/2020 (impor/penyerahan buku pelajaran umum, kitab suci, buku pelajaran agama dibebaskan PPN); PMK 34 Tahun 2025 Pasal 24 ayat (3).',
  'https://jdih.kemenkeu.go.id/dok/5-pmk-010-2020',
  DATE '2026-09-27',
  'research-agent (belum diverifikasi ahli kepabeanan)',
  'NEEDS_VERIFICATION: (a) apakah komik/manga/majalah/novel termasuk "buku pelajaran umum" menurut kriteria PMK 5/PMK.010/2020; (b) apakah pembebasan PPN diterapkan pada Customs Declaration penumpang; (c) rule dibatasi HS 4901 (buku cetak) karena kategori BOOKS_MEDIA juga mencakup media non-buku (CD/DVD/vinyl) yang TIDAK bebas PPN; HS 4902/4903 (surat kabar/majalah, buku gambar anak) belum dianalisis.',
  'DRAFT'
) ON CONFLICT (code, version) DO NOTHING;

COMMIT;
