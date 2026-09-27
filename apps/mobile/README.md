# JastipKita — aplikasi mobile (Flutter)

**Titip Mudah, Aman, Terpercaya.** Satu codebase untuk Android, iOS (dan build web di
`/jastipkita/app/`). Mode **Penitip** (buyer) dan **Traveler/Mitra** dalam satu akun, dana
ditahan **SafePay** sampai barang diterima.

| | |
|---|---|
| Application ID / Bundle ID | `com.antarkitaindonesia.jastipkita` |
| Nama tampilan | JastipKita |
| Bahasa | Indonesia (default), English — `lib/l10n/app_id.arb`, `app_en.arb` |
| Flutter | stable **≥ 3.32** (Dart ≥ 3.8; `pubspec` mengizinkan SDK ^3.5 tapi `l10n.yaml` memakai `output-dir` tanpa `synthetic-package`) |
| State / routing / HTTP | flutter_riverpod 2 (tanpa codegen) · go_router 14 · dio 5 |

`android/`, `ios/` dan `web/` **belum di-commit**: CI membuatnya dengan `flutter create` bila
`android/` tidak ada. Jangan commit sebagian folder platform — begitu `android/` ada, CI melewati
scaffold. Commit ketiganya sekaligus (lihat *Native* di bawah) sebelum rilis toko pertama.

## CI (`.github/workflows/ci.yml`, job `mobile`)

```bash
flutter create --platforms=android,ios,web --org com.antarkitaindonesia --project-name jastipkita .   # bila android/ belum ada
flutter pub get
dart run flutter_launcher_icons          # assets/brand/app-icon-1024.png, adaptive #0B1E4A + monochrome
dart run flutter_native_splash:create    # assets/splash/* (light/dark, Android 12)
flutter gen-l10n                         # → lib/l10n/app_localizations*.dart (tidak di-commit)
flutter analyze                          # info pun fatal
flutter test
flutter build apk --debug --dart-define=API_BASE_URL=… --dart-define=APP_ENV=staging
flutter build web --release --base-href /jastipkita/app/ --dart-define=…
```

Tanpa SDK Flutter, pemeriksaan statis tetap bisa dijalankan:

```bash
python3 tool/check_imports.py   # impor relatif/package:jastipkita ada, paket terdaftar di pubspec,
                                # semua kunci l10n ada di KEDUA ARB dengan jumlah argumen yang benar
```

## Konfigurasi (`--dart-define`)

Semua nilai **publik** (ikut ter-compile ke APK/IPA) — jangan pernah menaruh secret. Contoh lengkap:
`dart_defines.example.json` → salin ke `dart_defines.json` (di-ignore git) lalu
`flutter run --dart-define-from-file=dart_defines.json`.

| Nama | Default | Keterangan |
|---|---|---|
| `API_BASE_URL` | `http://10.0.2.2:8787` | Origin API tanpa `/v1` (default = emulator Android → `apps/api` dev server di host) |
| `APP_ENV` | `development` | `development` · `staging` · `production` |
| `GOOGLE_SERVER_CLIENT_ID` | kosong | OAuth *web* client id (audience ID token yang diterima API). Kosong → tombol Google menampilkan "belum dikonfigurasi" |
| `GOOGLE_IOS_CLIENT_ID` | kosong | Client id iOS (alias lama `GOOGLE_CLIENT_ID`) |
| `APPLE_SERVICE_ID`, `APPLE_REDIRECT_URI` | kosong | Sign in with Apple di Android/web. Kosong → tombol Apple hanya di iOS |
| `WEB_BASE_URL` | `https://antarkitaindonesia.com/jastipkita` | Link legal, share, universal link |
| `TERMS_URL`, `PRIVACY_POLICY_URL`, `ACCOUNT_DELETION_URL` | turunan `WEB_BASE_URL` | `/legal/terms-of-service/`, `/legal/privacy-policy/`, `/hapus-akun/` |
| `SUPPORT_WHATSAPP`, `SUPPORT_EMAIL` | kosong | Kontak CS di layar Bantuan (disembunyikan bila kosong) |
| `SHOW_SANDBOX_BADGE` | on kecuali production | Badge SANDBOX di Pengaturan (badge per pembayaran/KYC mengikuti flag dari API) |
| `CONSENT_VERSION` | `2026-09` | Versi dokumen persetujuan; bila API menolak (`CONSENT_VERSION_INVALID`) app memakai `allowedVersions` dari respons |
| `APP_VERSION` | `0.1.0` | Ditampilkan di Pengaturan |

## Menjalankan lokal

```bash
cd apps/mobile
flutter create --platforms=android,ios . --org com.antarkitaindonesia --project-name jastipkita   # sekali
python3 tool/configure_native.py         # label, izin, deep link, Info.plist (idempoten)
flutter pub get && dart run flutter_launcher_icons && dart run flutter_native_splash:create && flutter gen-l10n
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8787      # emulator Android
flutter run --dart-define=API_BASE_URL=http://localhost:8787      # simulator iOS / web
```

Di dev, URL loopback yang dibuat API (upload presigned, halaman checkout mock) otomatis diarahkan ke
host `API_BASE_URL` agar emulator bisa menjangkaunya (`AppConfig.rewriteLoopbackUrl`, nonaktif di production).

## Native (setelah `flutter create`)

`tool/configure_native.py` menerapkan:

- **Android** — label *JastipKita*; izin `INTERNET` di manifest utama (template hanya memberi di
  debug → build release tanpa jaringan) dan `CAMERA`; intent filter `jastipkita://…` dan App Links
  terverifikasi `https://antarkitaindonesia.com/jastipkita/app/…` + `/jastipkita/r/…` (cocok dengan
  `apps/web/well-known/assetlinks.json` — isi SHA-256 Play App Signing di sana); `flutter_deeplinking_enabled`.
- **iOS** — nama tampilan, `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`, URL scheme
  `jastipkita`, `FlutterDeepLinkingEnabled`. **Manual di Xcode:** capability *Associated Domains*
  `applinks:antarkitaindonesia.com` (+ Team ID di `apple-app-site-association`), *Sign in with Apple*,
  dan URL scheme reversed client id Google.

Tidak ada keystore/sertifikat di repo. Rilis Android memakai `mobile-release.yml` (secret
`ANDROID_KEYSTORE_*`, kontrak standar `android/key.properties`).

**FCM/push bersifat opsional** dan belum disertakan (tidak ada `google-services.json` /
`GoogleService-Info.plist` di repo). Aplikasi berjalan penuh tanpa push: notifikasi in-app + badge
dipolling, e-mail tetap terkirim. Saat menambah `firebase_messaging`, daftarkan token lewat
`AuthRepository.registerPushToken` (sudah ada) dan jaga agar app tetap jalan bila Firebase tidak dikonfigurasi.

## Deep link

| Masuk | Rute app |
|---|---|
| `jastipkita://transactions/{id}` · `https://antarkitaindonesia.com/jastipkita/app/transactions/{id}` | detail transaksi |
| `…/transactions/{id}/receipt` | status pembayaran |
| `…/disputes/{id}`, `…/conversations/{id}`, `…/support/tickets/{id}`, `…/trips/{id}`, `…/requests/{id}` | detail terkait |
| `…/account/verification`, `…/referrals`, `…/wallet`, `…/home` | layar terkait |
| `https://antarkitaindonesia.com/jastipkita/r/{KODE}/` | Ajak teman, kode terisi |
| QR serah terima `jastipkita://handover/{txId}?t={token}` | dipindai traveler di app |

Link yang dibuka saat belum login disimpan dan diputar ulang setelah login (`AuthRedirector`).
Nilai `data.deepLink` notifikasi dari API memakai format yang sama.

## Arsitektur

```
lib/
  main.dart, app.dart          MaterialApp.router, tema terang/gelap, id/en, text scale ≤ 2.0
  core/config                  AppConfig (dart-define)
  core/design                  tema M3 dari tokens.g.dart (Android) + nuansa Cupertino (iOS), haptics
  core/network                 ApiClient (dio), AuthInterceptor + TokenRefresher (single-flight),
                               IdempotencyKeys + FinancialCaller, ApiException
  core/storage                 token di flutter_secure_storage; preferensi non-sensitif di shared_preferences
  core/router                  go_router + redirect auth/consent + normalisasi deep link
  core/models, core/domain     model tulisan tangan (fromJson toleran), kosakata domain (19 status, 11 baris harga)
  core/l10n                    context.l10n, label domain, pesan error
  widgets/                     JkButton, MoneyText, PriceBreakdownCard, SafePayStatusBanner, StatusTimeline,
                               CountdownChip, TrustScoreBadge, KycLevelBadge/Ladder, kartu, state, glass …
  features/<fitur>/{data,application,presentation}
```

Aturan yang ditegakkan di kode:

- **Golden rule** — traveler hanya boleh membeli di `PURCHASE_APPROVED` *dan* bila `purchaseGate.canPurchase`
  dari server; sebelum itu banner merah **JANGAN BELI DULU** (termasuk `PAYMENT_SECURED`).
- **Uang** — integer minor unit, `Rp1.250.000` angka tabular, minus sejati `−`; kurs tetap string desimal.
- **Idempotensi** — checkout, respons konfirmasi harga, konfirmasi terima, batal: satu `Idempotency-Key`
  per aksi logis, dipakai ulang untuk setiap retry (jaringan/5xx/429/`IDEMPOTENCY_IN_PROGRESS`).
- **Glass** hanya di lapisan navigasi (tab bar iOS); konten transaksi selalu opak. Reduce-motion dihormati.
- **Tidak ada optimistic update** untuk aksi finansial.
- Label **SANDBOX** pada integrasi mock: pembayaran (`sandbox`), ekstraksi AI (`mode != LIVE`), KYC
  (`providerEnv == TEST`), dan **liveness** — `PhotoSequenceLiveness` adalah default *SANDBOX* yang bisa
  diganti SDK liveness sungguhan lewat `livenessProvider` (antarmuka `LivenessProvider`).

## Tes

```bash
flutter test
```

| Berkas | Isi |
|---|---|
| `test/core/money_test.dart` | format Rupiah/valuta, minus sejati, parsing input, ejaan untuk pembaca layar |
| `test/core/api_exception_test.dart` | parsing envelope error, pemetaan DioException, matriks retry, pesan pengguna |
| `test/core/idempotency_test.dart` | key sama di setiap retry (unit + lewat HTTP palsu), dilepas setelah jawaban definitif |
| `test/core/auth_refresh_test.dart` | 401 bersamaan → tepat satu refresh, replay sekali, token ditolak → sesi berakhir |
| `test/core/models_test.dart` | fixture berbentuk OpenAPI: Quote (11 baris), TransactionDetail, TripPublic, Tokens, Paged |
| `test/core/deep_links_test.dart` | normalisasi link & redirect auth dengan target tertunda |
| `test/widgets/price_breakdown_card_test.dart` | 11 baris urutan tetap, total, pengurangan, estimasi, kedaluwarsa |
| `test/widgets/safepay_gate_test.dart` | JANGAN BELI di `PAYMENT_SECURED`; tombol beli aktif hanya di `PURCHASE_APPROVED` (19 status) |
| `test/widgets/kyc_ladder_test.dart` | tangga L1–L5, status tercapai/berikutnya/terkunci, semantik |
| `test/widgets/text_scale_test.dart` | tanpa overflow pada text scale 2.0 (id & en), 360 dp |
| `test/l10n_test.dart` | locale, placeholder, plural |

## Catatan data

Estimasi bea/pajak dan kurs adalah perkiraan; nilai final mengikuti penetapan Bea Cukai dan kurs yang
dikunci saat bayar. Layar menampilkan catatan ini (Pengaturan › Tentang, rincian harga).
