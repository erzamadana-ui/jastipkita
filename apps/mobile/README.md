# JastipKita — aplikasi mobile (Flutter)

**Titip Mudah, Aman, Terpercaya.** Satu codebase untuk Android, iOS (dan build web di
`/jastipkita/app/`). Mode **Penitip** (buyer) dan **Traveler/Mitra** dalam satu akun, dana
ditahan **SafePay** sampai barang diterima.

**CI status: green on Flutter 3.47.5** (stable) — job `mobile` di `.github/workflows/ci.yml`:
analyze (info pun fatal), tes, APK debug, build web. APK siap pasang: lihat
[Mengunduh APK dari CI](#mengunduh-apk-dari-ci). **iOS:** workflow terpisah `.github/workflows/mobile-ios.yml`
(macOS, build debug tanpa tanda tangan) — ditambahkan 2026-10-04, **belum pernah dijalankan**; lihat
[CI iOS](#ci-ios-githubworkflowsmobile-iosyml).

| | |
|---|---|
| Application ID / Bundle ID | `com.antarkitaindonesia.jastipkita` |
| Nama tampilan | JastipKita |
| Minimum OS | Android: `minSdk` bawaan Flutter · iOS **15.5** (`mobile_scanner` 6.x / GoogleMLKit 7.0; Flutter stable sendiri 15.0) |
| Bahasa | Indonesia (default), English — `lib/l10n/app_id.arb`, `app_en.arb` |
| Flutter | stable **≥ 3.32**, diverifikasi CI di **3.47.5** (Dart ≥ 3.8; `pubspec` mengizinkan SDK ^3.5 tapi `l10n.yaml` memakai `output-dir` tanpa `synthetic-package`) |
| State / routing / HTTP | flutter_riverpod 2 (tanpa codegen) · go_router 14 · dio 5 |

`android/`, `ios/` dan `web/` **belum di-commit**: CI membuatnya dengan `flutter create` bila
`android/` tidak ada. Jangan commit sebagian folder platform — begitu `android/` ada, CI melewati
scaffold. Commit ketiganya sekaligus (lihat *Native* di bawah) sebelum rilis toko pertama.

## CI (`.github/workflows/ci.yml`, job `mobile`)

```bash
flutter create --platforms=android,ios,web --org com.antarkitaindonesia --project-name jastipkita .   # bila android/ belum ada
python3 tool/configure_native.py         # deep link, izin, nama tampilan, app id (idempoten; exit 1 bila gagal)
flutter pub get
dart run flutter_launcher_icons          # assets/brand/app-icon-1024.png, adaptive #0B1E4A + monochrome
dart run flutter_native_splash:create    # assets/splash/* (light/dark, Android 12)
flutter gen-l10n                         # → lib/l10n/app_localizations*.dart (tidak di-commit)
flutter analyze                          # info pun fatal
flutter test --exclude-tags store        # screenshot toko tidak ikut menentukan hijau/merah
flutter test --tags store --update-goldens --dart-define=STORE_SCREENSHOTS=true test/store_screenshots   # continue-on-error
flutter build apk --debug --dart-define=API_BASE_URL=… --dart-define=APP_ENV=staging
flutter build web --release --base-href /jastipkita/app/ --dart-define=…
```

Artefak per run: `mobile-apk-debug` (7 hari), `mobile-web` (7 hari), `store-screenshots` (14 hari) dan —
hanya bila CI membuat scaffold — `mobile-platform-scaffold` (14 hari).

### CI iOS (`.github/workflows/mobile-ios.yml`)

Satu-satunya tempat iOS di-compile sampai owner punya Mac + akun Apple. Runner `macos-latest`, timeout 45 menit.

```bash
flutter create --platforms=ios --org com.antarkitaindonesia --project-name jastipkita .   # bila ios/ belum ada
python3 tool/configure_native.py --platforms=ios --ios-entitlements
flutter pub get && dart run flutter_launcher_icons && dart run flutter_native_splash:create && flutter gen-l10n
python3 tool/configure_native.py --platforms=ios --ios-entitlements          # lagi: Podfile dari pub get (+ --check)
(cd ios && pod install || pod install --repo-update)                          # hanya bila ios/Podfile ada
flutter build ios --debug --no-codesign --dart-define=API_BASE_URL=… --dart-define=APP_ENV=staging
```

- **Pemicu:** push ke `main` yang mengubah `apps/mobile/**`, `packages/design-tokens/**` atau workflow itu sendiri;
  mingguan (Senin 04.47 WIB); manual (*Actions → Mobile iOS → Run workflow*, boleh dari branch mana pun). Tidak jalan
  di PR. Variabel repository `IOS_CI_AUTO=false` mematikan pemicu otomatis (manual tetap bisa).
- **Biaya:** menit macOS dihitung **10×** di repo private — satu run ±150–250 menit tagihan (ASUMSI, belum diukur).
- **Device, bukan simulator:** `mobile_scanner` 6.x (GoogleMLKit 7.0) tidak punya slice arm64-simulator, dan runner
  macOS memakai Apple silicon. Di Mac Apple silicon lokal pun simulator akan gagal link — pakai iPhone fisik atau
  simulator Rosetta. Usulan (keputusan Eng-Mobile, bukan bagian CI): `mobile_scanner` ≥ 7 (Apple Vision, iOS 13+)
  menghapus MLKit di iOS, memulihkan simulator arm64 dan memungkinkan target iOS 15.0 — ada perubahan API, perlu tes.
- **Hasil:** ringkasan run (Flutter/Xcode/CocoaPods, bundle id, `MinimumOSVersion`, ukuran `Runner.app`) + artefak
  **`mobile-ios-logs`** (7 hari). Tidak ada `.app`/IPA yang diunggah; build ini tidak bisa dipasang (tanpa tanda tangan).
- Workflow ini terpisah dari `ci.yml`, jadi kegagalan iOS **tidak** memblokir deploy staging/production.

### Mengunduh APK dari CI

1. GitHub → tab **Actions** → workflow **CI** → pilih run hijau terbaru (branch/PR yang diinginkan).
2. Di halaman ringkasan run, bagian **Artifacts** paling bawah → klik **`mobile-apk-debug`** (zip; perlu login
   dengan akses baca ke repo). Atau lewat CLI:
   `gh run download <run-id> -n mobile-apk-debug` (daftar run: `gh run list -w CI`).
3. Ekstrak → `app-debug.apk` → pasang: `adb install -r app-debug.apk`, atau kirim ke ponsel dan izinkan
   *Install unknown apps*.

APK ini **debug**, bertanda tangan kunci debug, dan menunjuk ke API **staging** (`CI_API_BASE_URL`, `APP_ENV=staging`,
badge SANDBOX) — untuk QA internal saja, bukan untuk dibagikan ke pengguna. Build rilis bertanda tangan (AAB + APK)
dibuat manual lewat workflow **Mobile release** (`mobile-release.yml`, *Run workflow*), artefak
`android-release-<env>-<versi>-<kode>`.

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
| `APP_VERSION` | `0.1.0` | Ditampilkan di Pengaturan |

## Menjalankan lokal

```bash
cd apps/mobile
flutter create --platforms=android,ios . --org com.antarkitaindonesia --project-name jastipkita   # sekali
python3 tool/configure_native.py         # label, izin, deep link, Info.plist (idempoten)
flutter pub get && dart run flutter_launcher_icons && dart run flutter_native_splash:create && flutter gen-l10n
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8787      # emulator Android
flutter run --dart-define=API_BASE_URL=http://localhost:8787      # simulator iOS (Intel/Rosetta — lihat CI iOS) / web
```

iOS di Mac: Xcode + CocoaPods (`brew install cocoapods`); `flutter build ios`/`flutter run` menjalankan
`pod install` sendiri. Mac Apple silicon: simulator arm64 tidak didukung oleh `mobile_scanner` 6 (MLKit) — pakai
iPhone fisik (butuh Team di *Signing & Capabilities*) atau destinasi simulator Rosetta.

Di dev, URL loopback yang dibuat API (upload presigned, halaman checkout mock) otomatis diarahkan ke
host `API_BASE_URL` agar emulator bisa menjangkaunya (`AppConfig.rewriteLoopbackUrl`, nonaktif di production).

## Native (setelah `flutter create`)

`tool/configure_native.py` dijalankan otomatis oleh job CI `mobile`, oleh `mobile-ios.yml` (dua kali: sebelum dan
sesudah `flutter pub get`) dan oleh `mobile-release.yml` (Android dan iOS) tepat setelah `flutter create`;
idempoten, jadi aman juga di folder platform yang sudah di-commit.
`python3 tool/configure_native.py --check` hanya memverifikasi (exit 1 bila ada yang belum terpasang). Opsi:
`--platforms=android,ios,web` (subset; job macOS memakai `ios` saja), `--ios-entitlements` (lihat iOS di bawah),
`--google-ios-client-id=…` atau env `GOOGLE_IOS_CLIENT_ID` (nilai publik). Format scaffold Flutter stable didukung:
`android/app/build.gradle.kts` (Kotlin DSL; Groovy tetap bisa), `namespace` + `applicationId`, `MainActivity` dengan
nama pendek atau lengkap, `Info.plist` dengan `UIApplicationSceneManifest` (`SceneDelegate.swift`), bundle id di
`project.pbxproj` (target `RunnerTests` tetap bersufiks), Podfile dengan baris `platform` dikomentari. Skrip menerapkan:

- **Android** — label *JastipKita*; izin `INTERNET` di manifest utama (template hanya memberi di
  debug → build release tanpa jaringan) dan `CAMERA`; intent filter `jastipkita://…` dan App Links
  terverifikasi `https://antarkitaindonesia.com/jastipkita/app/…` + `/jastipkita/r/…` (cocok dengan
  `apps/web/well-known/assetlinks.json` — isi SHA-256 Play App Signing di sana); `flutter_deeplinking_enabled`.
- **iOS** — nama tampilan; purpose string Indonesia yang **dikelola skrip** (selalu disetel ulang):
  `NSCameraUsageDescription` (QR serah terima, foto barang/struk, KTP & swafoto KYC), `NSPhotoLibraryUsageDescription`
  (foto produk, struk/bukti pembelian, bukti sengketa, dokumen) dan `NSMicrophoneUsageDescription` (wajib karena
  `image_picker` merekam video bukti pembelian/sengketa — tanpa kunci ini iOS menghentikan app); URL scheme
  `jastipkita`; `FlutterDeepLinkingEnabled`; `IPHONEOS_DEPLOYMENT_TARGET` dan `platform :ios` di Podfile → **15.5**
  (`mobile_scanner` 6.x / MLKit 7.0). Dengan `GOOGLE_IOS_CLIENT_ID`: `GIDClientID` + URL scheme reversed client id
  (`com.googleusercontent.apps.…`) yang dibutuhkan `google_sign_in`. Dengan `--ios-entitlements`:
  `ios/Runner/Runner.entitlements` (*Sign in with Apple* + *Associated Domains* `applinks:` & `webcredentials:antarkitaindonesia.com`,
  cocok dengan `apps/web/well-known/apple-app-site-association`) + `CODE_SIGN_ENTITLEMENTS` di target Runner — opt-in
  karena build **bertanda tangan** gagal bila App ID/provisioning profile belum punya kedua capability itu (build CI
  `--no-codesign` tidak terpengaruh). **Sengaja tidak ditambahkan:** `UIBackgroundModes` (wiki `file_picker`
  menyarankannya untuk `FileType.custom`, tetapi mode latar yang tidak dipakai berisiko ditolak App Review 2.5.4 —
  verifikasi pemilihan file iCloud yang belum terunduh di iPhone), `NSAppleMusicUsageDescription` (tidak memilih audio),
  `ITSAppUsesNonExemptEncryption` (jawaban export compliance = keputusan owner). **Manual (owner, setelah akun Apple):**
  aktifkan capability di App ID, ganti `TEAMID` di `apple-app-site-association`.

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
- **Kontrak API** (`docs/api/CHANGELOG.md` 2026-09-27): detail transaksi bertipe penuh (pihak "Budi S." + trust
  tier/KYC dari server, rute trip, `purchaseCeilingIdr`, `payout`, `conversationId`, `delivery.pinAvailable`);
  pemilih kanal memakai `quote.paymentOptions` (biaya & total per kanal, refundable, `available:false` + alasan);
  batal selalu didahului `GET /transactions/{id}/cancel/preview`; chat via `GET /transactions/{id}/conversation`.
- **Persetujuan & dokumen legal** — jenis dan versi persetujuan (signup & KYC) dibaca dari
  `GET /v1/consents/requirements`, dokumen ditampilkan di app dari `GET /v1/legal/documents/{type}` (label TEMPLATE
  bila `isTemplate`). Tidak ada versi yang di-hard-code.
- **Step-up OTP (SEC-12)** — isi/ganti rekening refund, tambah rekening pencairan dan ganti rekening utama:
  panggilan pertama tanpa bukti → `403 STEP_UP_REQUIRED {action, targetId}` → sheet `step_up_sheet.dart` (pilih HP/e-mail
  terverifikasi → OTP `SENSITIVE_ACTION` → kode) → panggilan diulang sekali dengan `stepUp {challengeId, code}`.
  Bukti sekali pakai (`StepUpProof.take`); kode salah → kode lain di challenge yang sama, kedaluwarsa/terkunci → kode baru,
  error lain → sheet tertutup dan percobaan berikutnya mulai tanpa bukti. Nama pemilik ≠ identitas → rekening
  *Sedang ditinjau* (`NAME_MISMATCH` / `PENDING_REVIEW`). `TRIP_NOT_AVAILABLE` (checkout) dan
  `TRIP_HAS_PURCHASED_TRANSACTIONS` (batal trip) punya pesan sendiri.
- **URL file absolut** — dipakai apa adanya (tanpa prefiks base URL); file yang dilayani API
  (`/v1/files/{id}/content`) dimuat dengan bearer lewat `ApiImage`. Sign in with Apple mengirim `rawNonce`
  (Apple menerima SHA-256-nya); KYC mengirim `livenessFileIds` (1–5).
- Label **SANDBOX** pada integrasi mock: pembayaran (`sandbox`), ekstraksi AI (`mode != LIVE`), KYC
  (`providerEnv == TEST`), dan **liveness** — `PhotoSequenceLiveness` adalah default *SANDBOX* yang bisa
  diganti SDK liveness sungguhan lewat `livenessProvider` (antarmuka `LivenessProvider`).

## Tes

```bash
flutter test --exclude-tags store
```

| Berkas | Isi |
|---|---|
| `test/core/money_test.dart` | format Rupiah/valuta, minus sejati, parsing input, ejaan untuk pembaca layar |
| `test/core/api_exception_test.dart` | parsing envelope error, pemetaan DioException, matriks retry, pesan pengguna |
| `test/core/idempotency_test.dart` | key sama di setiap retry (unit + lewat HTTP palsu), dilepas setelah jawaban definitif |
| `test/core/auth_refresh_test.dart` | 401 bersamaan → tepat satu refresh, replay sekali, token ditolak → sesi berakhir |
| `test/core/models_test.dart` | fixture berbentuk OpenAPI: Quote (11 baris, paymentOptions), TransactionDetail bertipe, CancellationPreview, ConsentRequirements + payload, TripPublic, Tokens, Paged |
| `test/core/deep_links_test.dart` | normalisasi link & redirect auth dengan target tertunda |
| `test/widgets/price_breakdown_card_test.dart` | 11 baris urutan tetap, total, pengurangan, estimasi, kedaluwarsa |
| `test/widgets/safepay_gate_test.dart` | JANGAN BELI di `PAYMENT_SECURED`; tombol beli aktif hanya di `PURCHASE_APPROVED` (19 status) |
| `test/widgets/kyc_ladder_test.dart` | tangga L1–L5, status tercapai/berikutnya/terkunci, semantik |
| `test/widgets/text_scale_test.dart` | tanpa overflow pada text scale 2.0 (id & en), 360 dp |
| `test/core/step_up_test.dart` | step-up di repository: 403 → prompt → retry dengan `stepUp`, bukti tidak pernah dipakai ulang, `NAME_MISMATCH`/`PENDING_REVIEW`, `purchaseCeilingMinor`, pesan error trip |
| `test/widgets/step_up_sheet_test.dart` | sheet step-up lewat fake adapter: OTP terikat action+target, kode salah, error setelah kode terpakai, batal |
| `test/widgets/ink_surfaces_test.dart` | tile/ink di permukaan berwarna (peringatan barang terbatas, GlassSurface, OpaqueActionBar, TrustScoreBadge, ModeSwitch) berada di atas `Material` sendiri — tanpa assertion *"ListTile background color or ink splashes may be invisible"* |
| `test/l10n_test.dart` | locale, placeholder, plural |

### Screenshot toko (`test/store_screenshots/`, tag `store`)

```bash
flutter test --tags store --update-goldens --dart-define=STORE_SCREENSHOTS=true test/store_screenshots
```

Menghasilkan `build/store_screenshots/<perangkat>/NN_nama.png` untuk `android-1080x1920`,
`android-1440x2560` dan `iphone-6.7-1290x2796`: 01 onboarding, 02 beranda penitip, 03 buat titipan +
estimasi bea & pajak, 04 checkout SafePay + pilihan kanal & rincian 11 baris, 05 gerbang traveler
**JANGAN BELI DULU → BOLEH DIBELI**, 06 serah terima PIN/QR, 07 beranda tema gelap. Layar asli dengan data
API palsu, teks Indonesia, font Poppins asli (dimuat dengan `FontLoader` dari `FontManifest.json`) dan pita
keterangan navy di dalam gambar. Tanpa `STORE_SCREENSHOTS=true` tes di-skip, dan `dart_test.yaml`
mendaftarkan tag `store`, jadi `flutter test` biasa tidak bergantung pada font. Bendera negara memakai Noto
Color Emoji bila terpasang (`fonts-noto-color-emoji`; CI memasangnya). Di CI hasilnya diunggah sebagai
artefak **`store-screenshots`**.

## Catatan data

Estimasi bea/pajak dan kurs adalah perkiraan; nilai final mengikuti penetapan Bea Cukai dan kurs yang
dikunci saat bayar. Layar menampilkan catatan ini (Pengaturan › Tentang, rincian harga).
