# 03 — Sumber Kurs (FX) untuk Harga, FX Lock, dan Estimasi Bea

> Diverifikasi **2026-09-27** (semua angka di bawah diambil langsung dari endpoint/halaman pada tanggal tersebut). Mata uang wajib: IDR, JPY, SGD, KRW, MYR, AUD, EUR, USD.

## Ringkasan rekomendasi
| Kebutuhan | Sumber | Alasan |
|---|---|---|
| **Primary** (quote & FX lock) | **Frankfurter v2**, provider **ECB** (`/v2/providers/ecb/rates` atau `/v2/rates?providers=ecb`) | Gratis, tanpa API key, tanpa kuota, semua 8 mata uang ada, sumber resmi & deterministik |
| **Fallback** | **Open Exchange Rates** (Developer USD 12/bln, hourly) — atau Frankfurter **self-hosted** (Docker) | Update per jam (menutup celah akhir pekan ECB), independen dari Frankfurter publik |
| **Cross-check** | **Kurs Transaksi BI** (mid = (jual+beli)/2) | Kurs resmi IDR; deteksi deviasi |
| **Bea & pajak impor** | **Kurs KMK mingguan** (Kurs Menteri Keuangan, Rabu–Selasa) | Satu-satunya kurs yang dipakai Bea Cukai untuk BM/PPN/PPh |

Temuan penting untuk konfigurasi: `fx.lock.maxRateAgeMinutes = 1440` (24 jam) di `business-config.defaults.json` **akan membuat rate ECB basi setiap akhir pekan** (ECB tidak terbit Sabtu–Minggu/hari libur TARGET; rate Jumat ±16:00 CET dipakai sampai Senin ±16:00 CET ≈ 72 jam). Pilih: (a) naikkan ke ≥ 4.320 menit untuk sumber ECB **dengan buffer markup akhir pekan**, atau (b) pakai fallback hourly saat ECB > 24 jam.

## 1. Frankfurter
| Aspek | Temuan | Sumber |
|---|---|---|
| Domain | `api.frankfurter.app` → **302** ke `https://api.frankfurter.dev/v1/...` | uji langsung 2026-09-27 |
| Versi | **v2 = current**; "v1 API is deprecated in favor of v2, but remains available indefinitely" | [frankfurter.dev/docs](https://frankfurter.dev/docs/) |
| Endpoint v2 | `/v2/rates` (latest/historis; `base`, `quotes`, `date`, `from`/`to`, `group`, `providers`, `expand=providers`), `/v2/rate/{base}/{quote}`, `/v2/currencies`, `/v2/currency/{code}`, `/v2/providers`, `/v2/providers/{id}/rates` | [frankfurter.dev](https://frankfurter.dev/) |
| Endpoint v1 | `/v1/latest?base=USD&symbols=…` (juga `from`/`to`), `/v1/{date}`, `/v1/{start}..{end}`, `/v1/currencies` (ECB-based) | uji langsung |
| Sumber data | 104 bank sentral & sumber resmi, 208 mata uang; **default v2 = blended** lintas provider; ECB adalah sumber orisinal | [frankfurter.dev](https://frankfurter.dev/) |
| Provider relevan | ECB (EUR pivot, harian, sejak 1999), **BI** (IDR pivot, harian, sejak 2024-01-02), BOJ (USD pivot), BNM (MYR), MAS (SGD), RBA (AUD); **tidak ada** provider bank sentral Korea | [`/v2/providers`](https://api.frankfurter.dev/v2/providers) |
| Kuota | "no quotas… rate-limited to prevent abuse"; self-host via Docker | frankfurter.dev |
| Lisensi | "The rates themselves fall under each provider's terms" | docs |

**Snapshot 2026-09-27 (base USD):**
| Quote | v1 (ECB, tanggal 2026-09-25) | v2 blended (tanggal 2026-09-27) |
|---|---|---|
| IDR | 17.914 | 17.908 |
| JPY | 157,59 | 158,25 |
| KRW | 1.355,05 | 1.360,65 |
| MYR | 4,074 | 4,0766 |
| SGD | 1,2771 | 1,2783 |
| AUD | 1,4224 | 1,4233 |
| EUR | 0,87696 | 0,87734 |

**Anomali:** `/v2/providers/bi/rates?quotes=JPY` mengembalikan EUR→JPY **1,8025** (seharusnya ±180) — kemungkinan satuan "per 100 JPY" dari BI tidak dinormalisasi. **Jangan pakai provider BI di Frankfurter untuk JPY** tanpa validasi. Blended v2 juga kurang transparan (bobot tidak didokumentasikan) → untuk audit, kunci `providers=ecb` dan simpan `provider` + `date` di `fx_locks`.

## 2. ECB (sumber hulu)
Diterbitkan **±16:00 CET setiap hari kerja TARGET**; mencakup IDR, JPY, SGD, KRW, MYR, AUD, USD; tersedia XML (`eurofxref-daily.xml`), CSV, SDMX. Disclaimer: "reference rates are **not intended to be used in any market transactions** … but for information purposes only" ([ECB](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)). → JastipKita memakai ECB sebagai **referensi**; harga final = referensi + markup (`pricing.fx_markup`) dan dikunci (FX lock). Konsultasikan klausul ini di T&C pengguna.

## 3. Bank Indonesia
| Produk | Isi | Snapshot | Sumber |
|---|---|---|---|
| **JISDOR** | USD/IDR (Jakarta Interbank Spot Dollar Rate), harian hari kerja | Rp17.917 (25-09-2026) | [BI JISDOR](https://www.bi.go.id/id/statistik/informasi-kurs/jisdor/default.aspx) |
| **Kurs Transaksi BI** | 26 mata uang (jual/beli), **JPY per 100**, diumumkan sekali tiap hari kerja | 25-09-2026: USD 17.987,49/17.808,51; JPY(100) 11.369,38/11.255,54; SGD 14.062,61/13.921,60; KRW 13,17/13,02; MYR 4.416,28/4.366,97; AUD 12.663,19/12.533,63; EUR 20.494,95/20.287,45 | [BI Kurs Transaksi](https://www.bi.go.id/id/statistik/informasi-kurs/transaksi-bi/default.aspx) |
| Web service | SOAP `wsKursBI.asmx` — operasi `getSubKursLokal1..4` (kurs transaksi), `getSubKursJisdor1..4`, `getSubKursAsing1..4`, `getSubKursNonUSD_IDR1..4`; status operasional tidak dinyatakan → **`NEEDS_VERIFICATION`** | — | [wsKursBI](https://www.bi.go.id/biwebservice/wskursbi.asmx) |

## 4. Kurs Menteri Keuangan (KMK) — untuk bea & pajak
- Judul: "Nilai kurs sebagai dasar pelunasan bea masuk, PPN barang dan jasa dan PPnBM, bea keluar, dan PPh", terbit **mingguan**, berlaku **Rabu–Selasa**.
- Terbaru: **KMK 45/MK/EF.2/2026 (23–29 Sep 2026)** — USD 17.707,00; JPY 11.371,25/100; SGD 13.893,47; KRW 12,92; MYR 4.335,21; AUD 12.604,12; EUR 20.369,44. Sebelumnya: KMK 44 (16–22 Sep), 42 (9–15 Sep), 41 (2–8 Sep), 39 (26 Agu–1 Sep).
- Format: PDF + **unduhan Excel**; "Layanan API Nilai Kurs" gratis (Rp0) — cara registrasi/endpoint tidak dipublikasikan (`NEEDS_VERIFICATION`, hubungi DJSEF).
- Sumber: [Kurs Pajak](https://fiskal.kemenkeu.go.id/informasi-publik/kurs-pajak), [Daftar KMK](https://fiskal.kemenkeu.go.id/peraturan/kmk-kurs-pajak), [Layanan API](https://fiskal.kemenkeu.go.id/layanan/layanan-api-nilai-kurs).

## 5. Opsi komersial
| Provider | Paket & harga | Frekuensi | Catatan | Sumber |
|---|---|---|---|---|
| Open Exchange Rates | Free: 1.000 req/bln, **base USD saja**; Developer **USD 12/bln** (10.000 req, semua base); Enterprise USD 47/bln (100.000, 30 menit, time-series); Unlimited USD 97/bln (5 menit); tahunan = 2 bulan gratis | hourly → 5 menit | Cukup untuk fallback (cross-rate dari base USD) | [openexchangerates.org/signup](https://openexchangerates.org/signup) |
| Xe Currency Data API | Lite **USD 799/thn** (10.000 req/bln, harian); Intermediate USD 1.799/thn (50.000, hourly); Prime USD 4.499/thn (150.000, 15 menit); Enterprise custom; ada free trial | harian → menit | Mahal untuk MVP | [xe.com/xecurrencydata](https://www.xe.com/xecurrencydata/) |
| Wise Platform | `GET /rates` (source/target, `time`, riwayat `from`/`to`/`group`); **Bearer token** (UserToken/PersonalToken) — bagian dari Wise Platform untuk partner; harga tidak dipublikasikan | — | Butuh akun/kemitraan Wise | [docs.wise.com/api-reference/rate](https://docs.wise.com/api-reference/rate) |

## 6. Perbandingan silang (sanity check, 25–27 Sep 2026)
| Pasangan | Frankfurter v1 (ECB) | Frankfurter v2 | BI Kurs Transaksi (mid) | JISDOR | KMK 45/2026 |
|---|---|---|---|---|---|
| USD→IDR | 17.914 | 17.908 | 17.898,00 | 17.917 | **17.707** |
| JPY→IDR | 113,67 | 113,16 | 113,12 | — | 113,71 |
KMK berlaku seminggu dan tertinggal dari pasar (USD −1,2% vs JISDOR) → estimasi bea yang memakai kurs pasar sedikit **lebih tinggi** dari tagihan BC (aman bagi pembeli; selisih dikembalikan dari `CUSTOMS_RESERVE`).

## 7. Strategi yang direkomendasikan
1. **Rate harga (FX lock):** job tiap 60 menit mengambil Frankfurter `providers=ecb` (base EUR → turunkan cross-rate ke IDR dengan `crossRate()`), simpan `fx_rates` (`provider`, `as_of`, `fetched_at`). `quoteRate = spot × (1 + pricing.fx_markup)`; lock 30 menit (config existing).
2. **Fallback otomatis** bila (a) Frankfurter gagal/timeout, atau (b) data ECB > 24 jam (akhir pekan): pakai Open Exchange Rates; tandai lock `source=FALLBACK`.
3. **Guard deviasi:** bandingkan dengan sumber kedua (OXR atau BI mid); jika selisih > **150 bps** → jangan buat quote baru, alert `FINANCE`.
4. **Kurs bea (customs):** admin/job mengimpor KMK tiap Selasa malam (Excel) ke tabel kurs pajak dengan `valid_from/valid_to`; estimasi bea memakai KMK **minggu kedatangan** bila sudah terbit, jika belum pakai KMK terbaru + buffer (mis. 100 bps). Simpan nomor KMK di `ruleRef`.
5. **JPY/KRW:** normalisasi satuan (BI & KMK memakai JPY per 100; KMK KRW per 1) — tulis unit test khusus.
6. Semua integrasi bertanda **SANDBOX/MOCK** sampai diverifikasi; provider di balik interface `apps/api/src/providers/fx/`.

**Variabel lingkungan (nama saja):** `FX_PROVIDER_PRIMARY`, `FX_PROVIDER_FALLBACK`, `FRANKFURTER_BASE_URL`, `FRANKFURTER_PROVIDER_ID`, `OPENEXCHANGERATES_APP_ID`, `FX_MAX_DEVIATION_BPS`, `FX_FETCH_INTERVAL_MINUTES`, `KMK_KURS_API_URL`, `KMK_KURS_API_KEY`.

## `NEEDS_VERIFICATION`
Status operasional web service SOAP BI; akses API Kurs Kemenkeu; bobot blending Frankfurter v2 & bug satuan JPY provider BI; perlunya klausul T&C terkait disclaimer ECB.

## Sumber (diverifikasi 2026-09-27)
https://frankfurter.dev/ · https://frankfurter.dev/docs/ · https://api.frankfurter.dev/v1/latest?base=USD&symbols=IDR,JPY,SGD,KRW,MYR,AUD,EUR · https://api.frankfurter.dev/v2/rates?base=USD&quotes=IDR,JPY,SGD,KRW,MYR,AUD,EUR · https://api.frankfurter.dev/v2/providers · https://api.frankfurter.dev/v2/providers/bi/rates?quotes=USD,JPY,SGD,KRW,MYR,AUD,EUR · https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html · https://www.bi.go.id/id/statistik/informasi-kurs/jisdor/default.aspx · https://www.bi.go.id/id/statistik/informasi-kurs/transaksi-bi/default.aspx · https://www.bi.go.id/biwebservice/wskursbi.asmx · https://fiskal.kemenkeu.go.id/informasi-publik/kurs-pajak · https://fiskal.kemenkeu.go.id/peraturan/kmk-kurs-pajak · https://fiskal.kemenkeu.go.id/layanan/layanan-api-nilai-kurs · https://openexchangerates.org/signup · https://www.xe.com/xecurrencydata/ · https://docs.wise.com/api-reference/rate
