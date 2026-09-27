-- =============================================================================
-- 0101_restricted_items.sql — Barang dilarang/dibatasi (impor Indonesia + catatan asal)
-- -----------------------------------------------------------------------------
-- Riset: docs/research/01-customs-tax-indonesia.md (§2, §5), diverifikasi 2026-09-27.
-- Belum diverifikasi ahli kepabeanan / konsultan hukum.
--
-- Semantik engine (packages/core/src/restricted):
--   * Semua selector yang diisi harus cocok: category_code AND hs_code_prefix AND salah satu keyword.
--     Rule tanpa selector berlaku untuk seluruh rute origin->destination.
--   * Keyword dicocokkan per-kata (word boundary) setelah normalisasi lowercase; frasa boleh.
--   * max_quantity / max_value_usd terlampaui -> item dieskalasi menjadi PROHIBITED.
--   * PROHIBITED memblokir checkout; klasifikasi lain wajib acknowledgement pembeli.
--   * Pola: rule KATEGORI (tanpa keyword) = klasifikasi tegas; rule KEYWORD (category NULL) =
--     jaring pengaman untuk item yang salah kategori. Keyword yang rawan false-positive
--     (mis. "sword" -> figur anime, "replica" -> parfum Maison Margiela "Replica", "flare" ->
--     celana flare, "rice" -> rice cooker) sengaja TIDAK dipakai.
--   * airline_dg (boolean di DB) = ada batasan Dangerous Goods IATA/maskapai; detail di message.
--     Engine memakai enum AirlineDg -> perlu mapping di repository.
--   * effective_from = tanggal aturan diadopsi JastipKita (2026-09-27), BUKAN tanggal berlaku
--     dasar hukumnya (dasar hukum di source_reference).
--   * status ACTIVE = dasar hukum terkonfirmasi ATAU kebijakan platform konservatif;
--     status DRAFT = klasifikasi belum pasti dan berisiko memblokir barang sah;
--     source_reference diawali 'NEEDS_VERIFICATION:'.
-- =============================================================================
BEGIN;

INSERT INTO restricted_items (
  code, version, origin_country, destination_country, category_code, hs_code_prefix, keywords,
  classification, max_quantity, max_value_usd, permit_authority, airline_dg,
  message_id, message_en, source_reference, source_url,
  effective_from, effective_until, last_verified_at, status
) VALUES
-- ---------------------------------------------------------------------------
-- Narkotika & psikotropika
-- ---------------------------------------------------------------------------
('RI_ID_NARCOTICS_PSYCHOTROPICS', 1, NULL, 'ID', NULL, NULL,
 ARRAY['narkotika','narkoba','ganja','marijuana','marihuana','cannabis','cbd','cbd oil','thc','hashish','kokain','cocaine','heroin','sabu','shabu','methamphetamine','ekstasi','ecstasy','mdma','lsd','magic mushroom','psilocybin','kodein','codeine','psikotropika','psychotropic','alprazolam','xanax','diazepam','valium','zolpidem','ambien','adderall','amphetamine','amfetamin','ritalin','methylphenidate','tramadol'],
 'PROHIBITED', NULL, NULL, NULL, false,
 'Narkotika, psikotropika, produk ganja/CBD/THC, dan obat yang mengandung kodein/amfetamin dilarang dibawa masuk ke Indonesia. Sanksi pidana berat.',
 'Narcotics, psychotropics, cannabis/CBD/THC products and medicines containing codeine/amphetamine are prohibited from entering Indonesia. Severe criminal penalties apply.',
 'UU 35/2009 tentang Narkotika; UU 5/1997 tentang Psikotropika; Per BPOM 28/2023 (narkotika tidak diizinkan; psikotropika hanya WNA dengan resep maks. 90 hari).',
 'https://news.ddtc.co.id/berita/nasional/1806003/penumpang-bawa-obat-dan-makanan-dari-luar-negeri-begini-ketentuannya',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

-- ---------------------------------------------------------------------------
-- Obat, suplemen, kosmetik, parfum, pangan (BPOM)
-- ---------------------------------------------------------------------------
('RI_ID_MEDICINE_CATEGORY', 1, NULL, 'ID', 'MEDICINE', NULL, '{}'::text[],
 'RESTRICTED', 30, NULL, 'BPOM', false,
 'Obat hanya untuk penggunaan pribadi: maks. 30 pcs per jenis (tablet/kapsul) atau 3 pcs per jenis (cair/aerosol) tanpa resep. Barang titipan dianggap bukan barang pribadi traveler dan dapat ditahan Bea Cukai/BPOM.',
 'Medicines for personal use only: max 30 pcs per product (tablets/capsules) or 3 pcs per product (liquids/aerosols) without prescription. Items carried for others are not the traveler''s personal goods and may be held by Customs/BPOM.',
 'Per BPOM 28/2023 (mengubah Per BPOM 27/2022) — batas barang bawaan pribadi; DJBC 02-05-2024: barang jastip tidak dikecualikan dari lartas.',
 'https://news.ddtc.co.id/berita/nasional/1806003/penumpang-bawa-obat-dan-makanan-dari-luar-negeri-begini-ketentuannya',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_MEDICINE_PRESCRIPTION', 1, NULL, 'ID', NULL, NULL,
 ARRAY['obat resep','prescription drug','prescription medicine','ozempic','wegovy','semaglutide','mounjaro','zepbound','tirzepatide','saxenda','liraglutide','insulin','antibiotik','antibiotic','amoxicillin','isotretinoin','accutane','roaccutane','tretinoin','finasteride','sildenafil','viagra','tadalafil','cialis','botox','botulinum','dermal filler'],
 'PERMIT_REQUIRED', NULL, NULL, 'BPOM (izin khusus/SAS) + resep dokter atas nama pengguna', false,
 'Obat keras/resep (termasuk injeksi GLP-1 seperti Ozempic/Mounjaro, antibiotik, isotretinoin, tretinoin, botox/filler) memerlukan resep dokter dan izin BPOM. Titip beli untuk orang lain berisiko disita.',
 'Prescription-only medicines (incl. GLP-1 injections such as Ozempic/Mounjaro, antibiotics, isotretinoin, tretinoin, botox/fillers) require a doctor''s prescription and BPOM authorization. Buying on behalf of others risks confiscation.',
 'Per BPOM 28/2023 (obat sesuai resep maks. 90 hari pengobatan; penggunaan pribadi); kebijakan platform.',
 'https://news.ddtc.co.id/berita/nasional/1806003/penumpang-bawa-obat-dan-makanan-dari-luar-negeri-begini-ketentuannya',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_SUPPLEMENTS_CATEGORY', 1, NULL, 'ID', 'SUPPLEMENTS_VITAMINS', NULL, '{}'::text[],
 'RESTRICTED', 5, NULL, 'BPOM', false,
 'Suplemen & obat tradisional: maks. 5 pcs per jenis per penumpang untuk penggunaan pribadi. Jumlah komersial memerlukan izin edar BPOM.',
 'Supplements & traditional medicines: max 5 pcs per product per passenger for personal use. Commercial quantities require BPOM marketing authorization.',
 'Per BPOM 28/2023 — batas barang bawaan pribadi (5 pcs/jenis).',
 'https://news.ddtc.co.id/berita/nasional/1806003/penumpang-bawa-obat-dan-makanan-dari-luar-negeri-begini-ketentuannya',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_COSMETICS_CATEGORY', 1, NULL, 'ID', 'COSMETICS_SKINCARE', NULL, '{}'::text[],
 'RESTRICTED', 20, NULL, 'BPOM', false,
 'Kosmetik & skincare: maks. 20 pcs per penumpang untuk penggunaan pribadi (total semua jenis per traveler per kedatangan). Jumlah komersial memerlukan notifikasi BPOM.',
 'Cosmetics & skincare: max 20 pcs per passenger for personal use (total across products per traveler per arrival). Commercial quantities require BPOM notification.',
 'Per BPOM 28/2023 — batas barang bawaan pribadi (20 pcs); DJBC 02-05-2024 (jastip tidak dikecualikan dari lartas).',
 'https://news.ddtc.co.id/berita/nasional/1806003/penumpang-bawa-obat-dan-makanan-dari-luar-negeri-begini-ketentuannya',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_PERFUME_CATEGORY', 1, NULL, 'ID', 'PERFUME', NULL, '{}'::text[],
 'RESTRICTED', 20, NULL, 'BPOM', true,
 'Parfum termasuk kosmetik (maks. 20 pcs per penumpang). Aturan maskapai: toiletries maks. 0,5 L per wadah dan total 2 L/2 kg per orang; di kabin maks. 100 ml per wadah.',
 'Perfume counts as cosmetics (max 20 pcs per passenger). Airline rules: toiletries max 0.5 L per container and 2 L/2 kg total per person; cabin max 100 ml per container.',
 'Per BPOM 28/2023; IATA DGR 67 Tabel 2.3.A (medicinal/toilet articles).',
 'https://www.iata.org/contentassets/6fea26dd84d24b26a7a1fd5788561d6e/dgr-67-en-2.3.a.pdf',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_FOOD_CATEGORY', 1, NULL, 'ID', 'FOOD_SNACKS', NULL, '{}'::text[],
 'RESTRICTED', NULL, NULL, 'BPOM; Badan Karantina Indonesia (jika mengandung produk hewan/tumbuhan segar)', false,
 'Pangan olahan untuk penggunaan pribadi maks. 5 kg per penumpang. Produk berbahan daging/susu/tumbuhan segar dapat memerlukan dokumen karantina.',
 'Processed food for personal use: max 5 kg per passenger. Products containing meat/dairy/fresh plant material may require quarantine documents.',
 'Per BPOM 28/2023 (pangan olahan 5 kg/penumpang); UU 21/2019 tentang Karantina Hewan, Ikan, dan Tumbuhan.',
 'https://news.ddtc.co.id/berita/nasional/1806003/penumpang-bawa-obat-dan-makanan-dari-luar-negeri-begini-ketentuannya',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_BEVERAGES_CATEGORY', 1, NULL, 'ID', 'BEVERAGES_NONALCOHOLIC', NULL, '{}'::text[],
 'RESTRICTED', NULL, NULL, 'BPOM', false,
 'Minuman (pangan olahan) untuk penggunaan pribadi dalam jumlah wajar (bagian dari batas 5 kg). Cairan di kabin maks. 100 ml per wadah — bawa di bagasi tercatat.',
 'Beverages (processed food) in reasonable personal quantities (part of the 5 kg limit). Cabin liquids max 100 ml per container — pack in checked baggage.',
 'Per BPOM 28/2023 (pangan olahan); aturan keamanan kabin maskapai.',
 'https://news.ddtc.co.id/berita/nasional/1806003/penumpang-bawa-obat-dan-makanan-dari-luar-negeri-begini-ketentuannya',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_INFANT_FORMULA', 1, NULL, 'ID', NULL, NULL,
 ARRAY['susu formula','infant formula','formula milk','susu bayi','baby formula'],
 'RESTRICTED', NULL, NULL, 'BPOM', false,
 'Susu formula bayi termasuk pangan olahan yang diawasi BPOM; hanya jumlah wajar untuk penggunaan pribadi.',
 'Infant formula is BPOM-regulated processed food; only reasonable personal-use quantities.',
 'Per BPOM 28/2023 (pangan olahan).',
 'https://news.ddtc.co.id/berita/nasional/1806003/penumpang-bawa-obat-dan-makanan-dari-luar-negeri-begini-ketentuannya',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

-- ---------------------------------------------------------------------------
-- Alkohol & tembakau/vape (barang kena cukai)
-- ---------------------------------------------------------------------------
('RI_ID_ALCOHOL_CATEGORY', 1, NULL, 'ID', 'ALCOHOL', NULL, '{}'::text[],
 'PROHIBITED', NULL, NULL, 'DJBC (cukai) + perizinan impor minuman beralkohol', true,
 'Minuman beralkohol tidak dapat dititipkan. Pembebasan cukai 1 liter hanya untuk konsumsi pribadi orang dewasa; kelebihan dimusnahkan Bea Cukai. Maskapai: >24% ABV maks. 5 L, >70% ABV dilarang.',
 'Alcoholic beverages cannot be carried for others. The 1-liter excise exemption is for an adult''s personal consumption only; excess is destroyed by Customs. Airlines: >24% ABV max 5 L, >70% ABV forbidden.',
 'PMK 82/2024 (pembebasan cukai penumpang: MMEA 1 liter/orang dewasa); PMK 34/2025 Pasal 13 (kelebihan dimusnahkan); kebijakan platform (barang kena cukai non-pribadi).',
 'https://www.beacukai.go.id/fasilitas-pembebasan-cukai',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_ALCOHOL_KEYWORD', 1, NULL, 'ID', NULL, NULL,
 ARRAY['minuman beralkohol','alcoholic beverage','sake','soju','makgeolli','umeshu','shochu','whisky','whiskey','vodka','tequila','brandy','cognac','liqueur','champagne','sampanye','red wine','white wine','beer','bir'],
 'RESTRICTED', NULL, NULL, NULL, true,
 'Nama barang mengindikasikan minuman beralkohol. Jika benar beralkohol, pilih kategori Minuman Beralkohol (tidak dapat diproses). Jika bukan, lanjutkan dengan konfirmasi.',
 'The item name suggests an alcoholic beverage. If it is alcoholic, choose the Alcoholic Beverages category (cannot be processed). If not, continue after confirming.',
 'PMK 82/2024; kebijakan platform (jaring pengaman kategori).',
 'https://www.beacukai.go.id/fasilitas-pembebasan-cukai',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_TOBACCO_VAPE_CATEGORY', 1, NULL, 'ID', 'TOBACCO_VAPE', NULL, '{}'::text[],
 'PROHIBITED', NULL, NULL, 'DJBC (cukai)', true,
 'Rokok, cerutu, tembakau, dan rokok elektrik/liquid tidak dapat dititipkan. Pembebasan cukai (mis. 200 batang sigaret, 30 ml liquid sistem terbuka) hanya untuk konsumsi pribadi. Vape wajib di kabin, tidak boleh di bagasi.',
 'Cigarettes, cigars, tobacco and e-cigarettes/liquids cannot be carried for others. Excise exemptions (e.g., 200 cigarettes, 30 ml open-system liquid) are for personal consumption only. Vapes must be in cabin baggage, never checked.',
 'PMK 82/2024 (batas BKC penumpang); PMK 34/2025 Pasal 13; IATA DGR 67 Tabel 2.3.A (e-cigarettes).',
 'https://www.beacukai.go.id/fasilitas-pembebasan-cukai',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_TOBACCO_VAPE_KEYWORD', 1, NULL, 'ID', NULL, NULL,
 ARRAY['rokok','cigarette','cigarettes','cerutu','cigar','tembakau','tobacco','vape','vaporizer','liquid vape','e liquid','iqos','heets','terea','juul','snus','shisha','hookah'],
 'RESTRICTED', NULL, NULL, NULL, true,
 'Nama barang mengindikasikan produk tembakau/vape. Jika benar, pilih kategori Rokok, Cerutu & Vape (tidak dapat diproses).',
 'The item name suggests a tobacco/vape product. If so, choose the Tobacco & Vape category (cannot be processed).',
 'PMK 82/2024; kebijakan platform (jaring pengaman kategori).',
 'https://www.beacukai.go.id/fasilitas-pembebasan-cukai',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

-- ---------------------------------------------------------------------------
-- Ponsel, komputer genggam, tablet (HKT) — IMEI
-- ---------------------------------------------------------------------------
('RI_ID_MOBILE_PHONES_CATEGORY', 1, NULL, 'ID', 'MOBILE_PHONES', NULL, '{}'::text[],
 'DECLARATION_REQUIRED', 2, NULL, 'DJBC (registrasi IMEI) / Kemenperin / Komdigi (CEIR)', false,
 'Ponsel wajib dideklarasikan dan IMEI didaftarkan atas paspor traveler (maks. 2 unit per penumpang per kedatangan, termasuk ponsel pribadi traveler), di bandara atau maks. 60 hari setelah tiba. Bea & pajak impor dibayar saat registrasi.',
 'Phones must be declared and their IMEI registered under the traveler''s passport (max 2 units per passenger per arrival, including the traveler''s own phones), at the airport or within 60 days of arrival. Duties and taxes are paid at registration.',
 'PER-13/BC/2021 jo PER-7/BC/2023; Permenkominfo 1/2020 (IMEI); deklarasi HKT via All Indonesia.',
 'https://ngurahrai.beacukai.go.id/mandatory/registrasi-imei.html',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_HKT_KEYWORD', 1, NULL, 'ID', NULL, NULL,
 ARRAY['smartphone','handphone','ponsel','telepon seluler','mobile phone','ipad cellular','tablet lte','tablet 5g','modem 5g','mifi','pocket wifi'],
 'DECLARATION_REQUIRED', NULL, NULL, 'DJBC (registrasi IMEI) / Kemenperin / Komdigi (CEIR)', false,
 'Perangkat seluler (ponsel, tablet seluler, modem/MiFi) wajib registrasi IMEI atas paspor traveler, maks. 2 unit per penumpang per kedatangan.',
 'Cellular devices (phones, cellular tablets, modems/MiFi) require IMEI registration under the traveler''s passport, max 2 units per passenger per arrival.',
 'PER-13/BC/2021 jo PER-7/BC/2023; Permenkominfo 1/2020.',
 'https://ngurahrai.beacukai.go.id/mandatory/registrasi-imei.html',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

-- ---------------------------------------------------------------------------
-- Senjata, amunisi, alat bela diri, senjata tajam
-- ---------------------------------------------------------------------------
('RI_ID_WEAPONS_CATEGORY', 1, NULL, 'ID', 'WEAPONS_REPLICAS', NULL, '{}'::text[],
 'PROHIBITED', NULL, NULL, 'Polri', true,
 'Senjata api, airsoft/air gun, replika senjata, dan amunisi tidak dapat dititipkan. Impor memerlukan izin Polri.',
 'Firearms, airsoft/air guns, weapon replicas and ammunition cannot be carried. Import requires a Police (Polri) permit.',
 'UU Darurat 12/1951; Perpol 1/2022 (perizinan senjata api & peralatan yang digolongkan senjata api); IATA DGR (amunisi = barang berbahaya).',
 'https://marinews.mahkamahagung.go.id/artikel/problematika-kedudukan-keris-dalam-uu-darurat-nomor-121951-0BV',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_FIREARMS_KEYWORD', 1, NULL, 'ID', NULL, NULL,
 ARRAY['senjata api','firearm','handgun','senapan angin','airsoft','airsoft gun','airgun','gas blowback','replika senjata','replica gun','amunisi','ammunition','peluru tajam','mesiu'],
 'PROHIBITED', NULL, NULL, 'Polri', true,
 'Senjata api, airsoft/air gun, replika senjata, dan amunisi tidak dapat dititipkan.',
 'Firearms, airsoft/air guns, weapon replicas and ammunition cannot be carried.',
 'UU Darurat 12/1951; Perpol 1/2022; IATA DGR.',
 'https://marinews.mahkamahagung.go.id/artikel/problematika-kedudukan-keris-dalam-uu-darurat-nomor-121951-0BV',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_SELF_DEFENSE_DEVICES', 1, NULL, 'ID', NULL, NULL,
 ARRAY['pepper spray','semprotan merica','bear spray','stun gun','taser','setrum kejut','alat kejut listrik','tongkat listrik'],
 'PROHIBITED', NULL, NULL, NULL, true,
 'Semprotan merica, stun gun/taser, dan alat pelumpuh lain dilarang di kabin maupun bagasi pesawat.',
 'Pepper spray, stun guns/tasers and other disabling devices are forbidden in both cabin and checked baggage.',
 'IATA passenger guidance (disabling devices forbidden in carry-on and checked baggage); kebijakan platform.',
 'https://www.iata.org/en/programs/cargo/dangerous-goods/dgr-guidance-passengers/',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_BLADES_SWORDS', 1, NULL, 'ID', NULL, NULL,
 ARRAY['katana','samurai sword','wakizashi','tanto','pedang','belati','dagger','bayonet','karambit','machete','golok'],
 'PERMIT_REQUIRED', NULL, NULL, 'Polri', false,
 'Senjata tajam (pedang/katana/belati) tidak boleh dimasukkan tanpa hak. Hanya replika tumpul/mainan atau barang yang jelas untuk keperluan sah yang dapat diproses setelah review admin.',
 'Bladed weapons (swords/katana/daggers) may not be imported without legal right. Only blunt replicas/toys or items clearly for lawful use can proceed after admin review.',
 'UU Darurat 12/1951 Pasal 2 (senjata penikam/penusuk; pengecualian untuk pertanian, rumah tangga, pekerjaan sah, pusaka/barang kuno).',
 'https://marinews.mahkamahagung.go.id/artikel/problematika-kedudukan-keris-dalam-uu-darurat-nomor-121951-0BV',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_KNIVES', 1, NULL, 'ID', NULL, NULL,
 ARRAY['pisau','knife','kitchen knife','pisau dapur','santoku','gyuto','pisau lipat','pocket knife'],
 'RESTRICTED', NULL, NULL, NULL, false,
 'Pisau dapur/rumah tangga boleh, hanya di bagasi tercatat (dilarang di kabin). Pisau lipat/taktis dapat dianggap senjata tajam.',
 'Kitchen/household knives are allowed in checked baggage only (not in the cabin). Folding/tactical knives may be treated as bladed weapons.',
 'UU Darurat 12/1951 Pasal 2 (pengecualian pekerjaan rumah tangga); aturan keamanan kabin maskapai.',
 'https://marinews.mahkamahagung.go.id/artikel/problematika-kedudukan-keris-dalam-uu-darurat-nomor-121951-0BV',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

-- ---------------------------------------------------------------------------
-- Pornografi & alat bantu seks
-- ---------------------------------------------------------------------------
('RI_ID_PORNOGRAPHY', 1, NULL, 'ID', NULL, NULL,
 ARRAY['pornografi','pornography','porn','hentai','film dewasa','adult video','majalah dewasa','adult magazine','r18','eroge'],
 'PROHIBITED', NULL, NULL, NULL, false,
 'Barang bermuatan pornografi dilarang diimpor ke Indonesia.',
 'Pornographic material is prohibited from import into Indonesia.',
 'UU 44/2008 tentang Pornografi Pasal 4 ayat (1) (dikutip akun resmi Bravo Bea Cukai; diverifikasi via hasil pencarian).',
 'https://x.com/bravobeacukai/status/1332284677328015361',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_SEX_TOYS', 1, NULL, 'ID', NULL, NULL,
 ARRAY['sex toy','sex toys','alat bantu seks','dildo','fleshlight','onahole','masturbator'],
 'PROHIBITED', NULL, NULL, NULL, false,
 'Alat bantu seks termasuk barang yang lazim ditegah Bea Cukai (UU Pornografi) dan tidak dapat dititipkan.',
 'Sex toys are commonly seized by Customs (Pornography Law) and cannot be carried.',
 'UU 44/2008 Pasal 4 ayat (1); penindakan BC Kualanamu 2020 (sex toys paling dominan) — diverifikasi via hasil pencarian.',
 'https://regional.kompas.com/read/2020/02/18/06552011/133-kasus-diungkap-bea-dan-cukai-kuala-namu-selama-januari-sex-toys-paling',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

-- ---------------------------------------------------------------------------
-- Uang tunai & valas
-- ---------------------------------------------------------------------------
('RI_ID_CASH_CATEGORY', 1, NULL, 'ID', 'CASH_VALUABLES', NULL, '{}'::text[],
 'PROHIBITED', NULL, NULL, 'DJBC; Bank Indonesia', false,
 'JastipKita tidak melayani titipan uang tunai, valas, cek, atau surat berharga (bukan layanan transfer dana). Traveler wajib melapor ke Bea Cukai bila membawa uang/instrumen pembayaran senilai >= Rp100 juta; uang kertas asing >= Rp1 miliar hanya boleh dibawa badan berizin BI.',
 'JastipKita does not carry cash, foreign currency, cheques or securities (not a money-transfer service). Travelers must declare cash/payment instruments >= IDR 100 million to Customs; foreign banknotes >= IDR 1 billion may only be carried by BI-licensed entities.',
 'PMK 157/PMK.04/2017 jo PMK 100/2018 (deklarasi >= Rp100 juta; sanksi 10% maks. Rp300 juta); PBI 20/2/PBI/2018 (UKA >= Rp1 miliar); kebijakan platform.',
 'https://news.ddtc.co.id/berita/nasional/1800917/awas-denda-10-jika-keluar-masuk-ri-bawa-uang-tunai-rp100-juta-lebih',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_CASH_KEYWORD', 1, NULL, 'ID', NULL, NULL,
 ARRAY['uang tunai','uang kertas asing','valas','foreign currency','banknote','banknotes','traveler cheque','travellers cheque','bilyet giro'],
 'RESTRICTED', NULL, NULL, 'DJBC; Bank Indonesia', false,
 'Nama barang mengindikasikan uang/valas. Titipan uang tidak dilayani; uang koleksi (numismatik) hanya setelah review admin.',
 'The item name suggests cash/currency. Carrying money is not supported; collectible banknotes (numismatics) only after admin review.',
 'PMK 157/PMK.04/2017 jo PMK 100/2018; PBI 20/2/PBI/2018; kebijakan platform.',
 'https://www.hukumonline.com/berita/a/ingat-bawa-uang-asing-rp1-miliar-lebih-tanpa-izin-bisa-kena-denda-lt5b8e58817d517/',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

-- ---------------------------------------------------------------------------
-- Satwa/tumbuhan dilindungi (CITES) & karantina
-- ---------------------------------------------------------------------------
('RI_ID_WILDLIFE_CITES', 1, NULL, 'ID', NULL, NULL,
 ARRAY['gading','ivory','kulit ular','python leather','snakeskin','kulit buaya','crocodile leather','alligator leather','kulit biawak','cangkang penyu','sisik penyu','tortoiseshell','karang laut','cula badak','rhino horn','tiger bone','shahtoosh','kulit eksotis','exotic leather'],
 'PERMIT_REQUIRED', NULL, NULL, 'Kementerian Kehutanan (otoritas pengelola CITES) + izin CITES negara asal', false,
 'Produk dari satwa/tumbuhan dilindungi atau CITES (gading, kulit buaya/ular/biawak, penyu, karang) wajib dokumen CITES dari negara asal dan izin Indonesia. Tanpa dokumen, barang disita.',
 'Products from protected/CITES-listed species (ivory, crocodile/python/lizard leather, turtle shell, coral) require CITES documents from the origin country and Indonesian permits. Without them, items are seized.',
 'UU 5/1990 jo UU 32/2024 tentang Konservasi Sumber Daya Alam Hayati dan Ekosistemnya; CITES.',
 'https://peraturan.bpk.go.id/Details/295135/uu-no-32-tahun-2024',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_LIVE_ANIMALS', 1, NULL, 'ID', NULL, NULL,
 ARRAY['hewan hidup','live animal','kitten','puppy','anak kucing','anak anjing','ikan hias hidup','live fish','reptil hidup','live reptile','serangga hidup','live insect','kumbang hidup','burung hidup','live bird'],
 'PROHIBITED', NULL, NULL, 'Badan Karantina Indonesia', false,
 'Hewan hidup tidak dapat dititipkan (wajib karantina, sertifikat kesehatan, dan izin maskapai).',
 'Live animals cannot be carried (quarantine, health certificate and airline approval required).',
 'UU 21/2019 tentang Karantina Hewan, Ikan, dan Tumbuhan; kebijakan platform.',
 'https://karantinaindonesia.go.id/berita/pengawasan-produk-hewan-dan-tumbuhan-asal-luar-negeri-terus-diperketat',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_ANIMAL_PRODUCTS_CATEGORY', 1, NULL, 'ID', 'ANIMALS_ANIMAL_PRODUCTS', NULL, '{}'::text[],
 'PERMIT_REQUIRED', NULL, NULL, 'Badan Karantina Indonesia (sertifikat kesehatan negara asal)', false,
 'Hewan dan produk hewan wajib dilaporkan ke karantina (All Indonesia) dan disertai sertifikat kesehatan dari negara asal; tanpa dokumen dapat ditolak atau dimusnahkan.',
 'Animals and animal products must be reported to quarantine (All Indonesia) with a health certificate from the origin country; without documents they may be refused or destroyed.',
 'UU 21/2019; Badan Karantina Indonesia (berita 06-04-2026).',
 'https://karantinaindonesia.go.id/berita/pengawasan-produk-hewan-dan-tumbuhan-asal-luar-negeri-terus-diperketat',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_ANIMAL_PRODUCTS_KEYWORD', 1, NULL, 'ID', NULL, NULL,
 ARRAY['daging','meat','wagyu','beef jerky','dendeng','sosis','sausage','ham','bacon','salami','prosciutto','telur mentah','raw egg','susu segar','fresh milk','sarang burung walet','bird nest','birds nest'],
 'PERMIT_REQUIRED', NULL, NULL, 'Badan Karantina Indonesia (sertifikat kesehatan negara asal)', false,
 'Daging, olahan daging, telur mentah, susu segar, dan sarang burung walet adalah media pembawa karantina; wajib dokumen karantina negara asal.',
 'Meat, meat products, raw eggs, fresh milk and edible bird''s nest are quarantine-controlled; origin-country quarantine documents are required.',
 'UU 21/2019; Badan Karantina Indonesia (berita 06-04-2026).',
 'https://karantinaindonesia.go.id/berita/pengawasan-produk-hewan-dan-tumbuhan-asal-luar-negeri-terus-diperketat',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_HONEY_DAIRY', 1, NULL, 'ID', NULL, NULL,
 ARRAY['madu','honey','manuka','keju','cheese','butter','mentega','yogurt'],
 'PERMIT_REQUIRED', NULL, NULL, 'Badan Karantina Indonesia', false,
 'Madu dan produk susu dapat termasuk produk hewan yang diawasi karantina.',
 'Honey and dairy products may be quarantine-controlled animal products.',
 'NEEDS_VERIFICATION: apakah madu/keju/mentega kemasan ritel untuk jastip wajib sertifikat karantina (UU 21/2019) atau cukup pemeriksaan; risiko false-positive tinggi (mis. snack rasa keju/madu).',
 'https://karantinaindonesia.go.id/berita/pengawasan-produk-hewan-dan-tumbuhan-asal-luar-negeri-terus-diperketat',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'DRAFT'),

('RI_ID_PLANTS_SEEDS_CATEGORY', 1, NULL, 'ID', 'PLANTS_SEEDS', NULL, '{}'::text[],
 'PERMIT_REQUIRED', NULL, NULL, 'Badan Karantina Indonesia (sertifikat fitosanitari negara asal)', false,
 'Tanaman, benih, bibit, buah & sayur segar wajib sertifikat fitosanitari negara asal dan dilaporkan ke karantina; tanpa dokumen dapat dimusnahkan.',
 'Plants, seeds, seedlings, fresh fruit & vegetables require an origin phytosanitary certificate and quarantine declaration; without documents they may be destroyed.',
 'UU 21/2019 tentang Karantina Hewan, Ikan, dan Tumbuhan; Badan Karantina Indonesia.',
 'https://karantinaindonesia.go.id/berita/pengawasan-produk-hewan-dan-tumbuhan-asal-luar-negeri-terus-diperketat',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_PLANTS_KEYWORD', 1, NULL, 'ID', NULL, NULL,
 ARRAY['benih','bibit','seeds','biji tanaman','umbi','tanaman hidup','live plant','bonsai','buah segar','fresh fruit','sayur segar','fresh vegetables','shine muscat'],
 'PERMIT_REQUIRED', NULL, NULL, 'Badan Karantina Indonesia (sertifikat fitosanitari negara asal)', false,
 'Nama barang mengindikasikan tanaman/benih/buah segar yang diawasi karantina.',
 'The item name suggests plants/seeds/fresh produce subject to quarantine.',
 'UU 21/2019; Badan Karantina Indonesia.',
 'https://karantinaindonesia.go.id/berita/pengawasan-produk-hewan-dan-tumbuhan-asal-luar-negeri-terus-diperketat',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

-- ---------------------------------------------------------------------------
-- Barang dilarang impor (Permendag 47/2025, berlaku 2026-01-01)
-- ---------------------------------------------------------------------------
('RI_ID_USED_CLOTHING_HS', 1, NULL, 'ID', NULL, '6309', '{}'::text[],
 'PROHIBITED', NULL, NULL, 'Kemendag', false,
 'Pakaian bekas dan barang bekas sejenis dilarang diimpor ke Indonesia.',
 'Used clothing and similar worn articles are prohibited from import into Indonesia.',
 'Permendag 47/2025 tentang Barang yang Dilarang untuk Diimpor Pasal 2 (kantong bekas, karung bekas, pakaian bekas); mencabut Permendag 18/2021 jo 40/2022; berlaku 01-01-2026.',
 'https://pasal.id/peraturan/permen/permendag-no-47-tahun-2025',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_USED_CLOTHING_KEYWORD', 1, NULL, 'ID', NULL, NULL,
 ARRAY['pakaian bekas','baju bekas','used clothing','second hand clothing','secondhand clothing','karung bekas','kantong bekas','bal pakaian bekas'],
 'PROHIBITED', NULL, NULL, 'Kemendag', false,
 'Pakaian bekas, kantong bekas, dan karung bekas dilarang diimpor ke Indonesia.',
 'Used clothing, used bags (sacks) and used sacks are prohibited from import into Indonesia.',
 'Permendag 47/2025 Pasal 2.',
 'https://pasal.id/peraturan/permen/permendag-no-47-tahun-2025',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_USED_APPAREL', 1, NULL, 'ID', 'FASHION_APPAREL', NULL,
 ARRAY['preloved','bekas','second hand','secondhand','used','thrift','thrifting','worn'],
 'PROHIBITED', NULL, NULL, 'Kemendag', false,
 'Pakaian bekas/preloved dilarang diimpor ke Indonesia. Hanya pakaian baru yang dapat dititipkan.',
 'Used/preloved clothing is prohibited from import into Indonesia. Only new clothing can be carried.',
 'Permendag 47/2025 Pasal 2 (pakaian bekas).',
 'https://pasal.id/peraturan/permen/permendag-no-47-tahun-2025',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_USED_FOOTWEAR', 1, NULL, 'ID', 'FOOTWEAR', NULL,
 ARRAY['preloved','bekas','second hand','secondhand','used','worn'],
 'PROHIBITED', NULL, NULL, 'Kemendag', false,
 'Sepatu bekas kemungkinan termasuk barang bekas yang dilarang impor.',
 'Used footwear is likely covered by the used-goods import prohibition.',
 'NEEDS_VERIFICATION: cakupan HS larangan Permendag 47/2025 (apakah HS 6309 "worn clothing and other worn articles" termasuk alas kaki bekas yang diklasifikasikan di bab 64).',
 'https://pasal.id/peraturan/permen/permendag-no-47-tahun-2025',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'DRAFT'),

('RI_ID_RICE_SUGAR', 1, NULL, 'ID', NULL, NULL,
 ARRAY['beras','beras jepang','japanese rice','koshihikari','gula pasir','granulated sugar'],
 'PROHIBITED', NULL, NULL, 'Kemendag', false,
 'Beras dan gula tertentu termasuk barang yang dilarang diimpor.',
 'Rice and certain sugars are among goods prohibited from import.',
 'NEEDS_VERIFICATION: Permendag 47/2025 Pasal 2 mencantumkan gula dan beras — pos tarif (HS) yang dilarang dan penerapannya pada barang bawaan penumpang non-pribadi belum dikonfirmasi.',
 'https://pasal.id/peraturan/permen/permendag-no-47-tahun-2025',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'DRAFT'),

-- ---------------------------------------------------------------------------
-- Barang palsu
-- ---------------------------------------------------------------------------
('RI_ID_COUNTERFEIT', 1, NULL, 'ID', NULL, NULL,
 ARRAY['barang palsu','counterfeit','kw super','barang kw','tas kw','sepatu kw','jam kw','super copy','supercopy','mirror quality','replika tas','replica bag'],
 'PROHIBITED', NULL, NULL, NULL, false,
 'Barang palsu/tiruan merek tidak dapat dititipkan dan dapat disita.',
 'Counterfeit/imitation branded goods cannot be carried and may be seized.',
 'UU 20/2016 tentang Merek dan Indikasi Geografis; kebijakan platform (URL sumber belum diverifikasi).',
 NULL,
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

-- ---------------------------------------------------------------------------
-- Perangkat radio / drone (SDPPI)
-- ---------------------------------------------------------------------------
('RI_ID_DRONES', 1, NULL, 'ID', NULL, NULL,
 ARRAY['drone','dji mini','dji mavic','dji air','dji avata','dji neo','dji flip','quadcopter','fpv drone'],
 'PERMIT_REQUIRED', NULL, NULL, 'Komdigi/SDPPI (sertifikasi perangkat) + Kemenhub (registrasi & izin operasi)', true,
 'Drone wajib dideklarasikan, memerlukan sertifikasi perangkat (SDPPI) dan registrasi/izin operasi Kemenhub. Baterai cadangan hanya di kabin.',
 'Drones must be declared and require device certification (SDPPI) and Ministry of Transport registration/operating permits. Spare batteries in cabin only.',
 'Permenkominfo 16/2018 (sertifikasi alat/perangkat telekomunikasi); PM Perhubungan 37/2020 (pengoperasian pesawat udara tanpa awak); IATA DGR (baterai). Sumber sekunder: drone.co.id (2022).',
 'https://blog.drone.co.id/posts/aturan-impor-drone-ke-indonesia-dan-bea-cukai/',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_RADIO_DEVICES', 1, NULL, 'ID', NULL, NULL,
 ARRAY['walkie talkie','handy talky','radio ht','transceiver','ham radio','baofeng','starlink','radio pemancar'],
 'PERMIT_REQUIRED', NULL, NULL, 'Komdigi/SDPPI', false,
 'Perangkat pemancar radio (HT/walkie talkie, transceiver, terminal satelit) wajib bersertifikat SDPPI sebelum digunakan/diedarkan di Indonesia.',
 'Radio transmitting devices (walkie-talkies, transceivers, satellite terminals) must be SDPPI-certified before use/distribution in Indonesia.',
 'Permenkominfo 16/2018 tentang Ketentuan Operasional Sertifikasi Alat dan/atau Perangkat Telekomunikasi.',
 'https://peraturan.bpk.go.id/Details/149737/permenkominfo-no-16-tahun-2018',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_SIGNAL_JAMMER', 1, NULL, 'ID', NULL, NULL,
 ARRAY['jammer','signal jammer','gps jammer','pengacak sinyal'],
 'PROHIBITED', NULL, NULL, 'Komdigi/SDPPI', false,
 'Pengacak sinyal (jammer) tidak dapat dititipkan.',
 'Signal jammers cannot be carried.',
 'Kebijakan platform; dasar hukum spesifik (UU 36/1999 tentang Telekomunikasi — larangan gangguan) NEEDS_VERIFICATION.',
 NULL,
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

-- ---------------------------------------------------------------------------
-- Baterai lithium, aerosol, bahan mudah terbakar (Dangerous Goods — IATA DGR 67)
-- ---------------------------------------------------------------------------
('RI_ID_POWERBANK_CATEGORY', 1, NULL, 'ID', 'BATTERIES_POWERBANK', NULL, '{}'::text[],
 'RESTRICTED', 20, NULL, 'Maskapai', true,
 'Power bank & baterai cadangan hanya di kabin (dilarang di bagasi). <=100 Wh: maks. 20 unit per orang (IATA; maskapai sering lebih ketat, mis. 2 unit). 100-160 Wh: izin maskapai, maks. 2. >160 Wh: dilarang.',
 'Power banks & spare batteries are cabin-only (never checked). <=100 Wh: max 20 per person (IATA; airlines are often stricter, e.g., 2). 100-160 Wh: airline approval, max 2. >160 Wh: forbidden.',
 'IATA DGR 67th ed. Tabel 2.3.A; FAA PackSafe (diperbarui 10-08-2026).',
 'https://www.iata.org/contentassets/6fea26dd84d24b26a7a1fd5788561d6e/dgr-67-en-2.3.a.pdf',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_POWERBANK_KEYWORD', 1, NULL, 'ID', NULL, NULL,
 ARRAY['power bank','powerbank','portable charger','battery pack','baterai cadangan','spare battery','baterai lithium','lithium battery','18650'],
 'RESTRICTED', 20, NULL, 'Maskapai', true,
 'Baterai lithium cadangan/power bank hanya di kabin; batas Wh dan jumlah mengikuti IATA & maskapai.',
 'Spare lithium batteries/power banks are cabin-only; Wh and quantity limits follow IATA & the airline.',
 'IATA DGR 67th ed. Tabel 2.3.A; FAA PackSafe.',
 'https://www.faa.gov/hazmat/packsafe/airline-passengers-and-batteries',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_LARGE_LITHIUM', 1, NULL, 'ID', NULL, NULL,
 ARRAY['power station','portable power station','hoverboard','electric scooter','skuter listrik','otopet listrik','sepeda listrik','e bike','ebike','electric unicycle'],
 'PROHIBITED', NULL, NULL, 'Maskapai', true,
 'Power station portabel, hoverboard, skuter/sepeda listrik umumnya memakai baterai >160 Wh yang dilarang di pesawat penumpang.',
 'Portable power stations, hoverboards, e-scooters/e-bikes typically use batteries >160 Wh, which are forbidden on passenger aircraft.',
 'IATA DGR 67th ed. Tabel 2.3.A (>160 Wh terlarang); FAA PackSafe.',
 'https://www.faa.gov/hazmat/packsafe/airline-passengers-and-batteries',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_AEROSOLS_CATEGORY', 1, NULL, 'ID', 'AEROSOLS_FLAMMABLES', NULL, '{}'::text[],
 'RESTRICTED', NULL, NULL, 'Maskapai', true,
 'Aerosol toiletries (non-mudah terbakar): maks. 0,5 kg/0,5 L per wadah dan total 2 kg/2 L per orang. Aerosol non-toiletries yang mudah terbakar (cat semprot, gas) dilarang.',
 'Toiletry aerosols (non-flammable): max 0.5 kg/0.5 L per container and 2 kg/2 L total per person. Flammable non-toiletry aerosols (spray paint, gas) are forbidden.',
 'IATA DGR 67th ed. Tabel 2.3.A (medicinal/toilet articles & Division 2.2 aerosols).',
 'https://www.iata.org/contentassets/6fea26dd84d24b26a7a1fd5788561d6e/dgr-67-en-2.3.a.pdf',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

('RI_ID_FLAMMABLES_EXPLOSIVES', 1, NULL, 'ID', NULL, NULL,
 ARRAY['spray paint','cat semprot','pilox','pilok','lighter fluid','gas butana','butane','gas korek','isi ulang korek','bensin','gasoline','kerosene','minyak tanah','thinner','tiner','spiritus','kembang api','fireworks','petasan','firecracker','signal flare','bahan peledak'],
 'PROHIBITED', NULL, NULL, 'Maskapai', true,
 'Bahan mudah terbakar, gas, bahan bakar, dan kembang api/bahan peledak dilarang di pesawat penumpang.',
 'Flammable liquids, gases, fuels and fireworks/explosives are forbidden on passenger aircraft.',
 'IATA DGR 67th ed. Tabel 2.3.A (lighter fuel & refills forbidden); IATA passenger guidance.',
 'https://www.iata.org/en/programs/cargo/dangerous-goods/dgr-guidance-passengers/',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'ACTIVE'),

-- ---------------------------------------------------------------------------
-- Alat perjudian
-- ---------------------------------------------------------------------------
('RI_ID_GAMBLING_DEVICES', 1, NULL, 'ID', NULL, NULL,
 ARRAY['mesin judi','slot machine','mesin slot','pachislot','pachislo','pachinko machine','mesin pachinko'],
 'PROHIBITED', NULL, NULL, NULL, false,
 'Mesin/alat perjudian tidak dapat dititipkan.',
 'Gambling machines/devices cannot be carried.',
 'NEEDS_VERIFICATION: perjudian dilarang KUHP; status larangan/pembatasan impor mesin judi untuk barang penumpang belum dikonfirmasi dari sumber primer.',
 NULL,
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'DRAFT'),

-- ---------------------------------------------------------------------------
-- Sisi negara asal (terbatas)
-- ---------------------------------------------------------------------------
('RI_JP_TAXFREE_NOT_FOR_RESALE', 1, 'JP', 'ID', NULL, NULL, '{}'::text[],
 'RESTRICTED', NULL, NULL, 'National Tax Agency Japan', false,
 'Fasilitas tax-free/refund pajak konsumsi Jepang hanya untuk barang pribadi wisatawan, bukan untuk dijual kembali. Barang titipan harus dibeli dengan harga termasuk pajak konsumsi; mulai 1 Nov 2026 sistem berubah menjadi refund saat keberangkatan.',
 'Japan''s tax-free/consumption-tax refund is only for visitors'' personal goods, not for resale. Items bought for others must be purchased tax-inclusive; from 1 Nov 2026 the system becomes a refund at departure.',
 'NEEDS_VERIFICATION: sumber sekunder (japan-guide.com); perlu konfirmasi dari National Tax Agency/Japan Tourism Agency. Rule tingkat rute (berlaku untuk semua item JP) — pertimbangkan sebagai catatan harga, bukan acknowledgement.',
 'https://www.japan-guide.com/news/tax-free-shopping.html',
 DATE '2026-09-27', NULL, DATE '2026-09-27', 'DRAFT')
ON CONFLICT (code, version) DO NOTHING;

COMMIT;
