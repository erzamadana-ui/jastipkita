# brand/ — JastipKita brand assets

Sumber tunggal untuk logo, ikon aplikasi, splash, grafis sosial/store, font, dan pratinjau brand. Pedoman pemakaian: **[BRAND-GUIDE.md](BRAND-GUIDE.md)**. Sistem UI: **[docs/05-ui-design-system.md](../docs/05-ui-design-system.md)**.

```
brand/
├── logo/          20 SVG (horizontal · vertical · vertical-tagline · symbol × light/dark/mono-black/mono-white, favicon, wordmark)
├── app-icon/      ios/AppIcon.appiconset (+Contents.json), android/mipmap-*, drawable-* (notifikasi), adaptive XML, Play 512
├── web/           favicon (svg/ico/png), PWA icons, apple-touch-icon, site.webmanifest
├── splash/        flutter_native_splash: logo light/dark, Android 12 icon, branding
├── social/        profile 1080/400, og-image 1200×630, cover 1500×500
├── store/         Play feature graphic 1024×500, App Store icon 1024
├── fonts/OFL.txt  lisensi Poppins
├── preview/       brand-sheet.png, logo-anatomy.png, asset-inventory.json
└── scripts/       generate-assets.mjs, render-mockups.mjs, lib/ (geometry, wordmark, lockups, raster, brand-sheet)
```

Semua file di atas adalah **output generator** — jangan diedit manual. Ubah kode di `brand/scripts/lib/*`, lalu jalankan ulang.

## Menjalankan generator

Dependensi tooling **tidak** di-install di dalam workspace monorepo (supaya pnpm workspace tetap bersih). Pasang di folder scratch, lalu arahkan lewat `BRAND_DEPS_DIR`:

```bash
# 1) sekali saja — deps tooling di luar repo
mkdir -p /tmp/brandtools && cd /tmp/brandtools && npm init -y >/dev/null
npm i sharp@0.35.4 opentype.js@2.0.0 paper@0.12.18 @fontsource/poppins@5.3.0 \
      @expo-google-fonts/poppins@0.4.1 lucide-static@1.48.0 playwright@1.56.1
# Chromium: pakai yang sudah ada (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers, build 1194 ↔ playwright 1.56.x)
# atau di mesin lokal: npx playwright install chromium

# 2) dari root repo
export BRAND_DEPS_DIR=/tmp/brandtools PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
node packages/design-tokens/scripts/build.mjs     # tokens → CSS/TS/Dart + CONTRAST.md (dipakai mockup)
node brand/scripts/generate-assets.mjs            # semua aset brand + font + brand sheet (±5 detik)
node brand/scripts/generate-assets.mjs --no-preview   # tanpa Playwright
node brand/scripts/render-mockups.mjs             # docs/design/mockups/*.png (light + dark)
```

Alternatif: `cd brand/scripts && npm install` (node_modules lokal diabaikan git) — `lib/deps.mjs` otomatis memakai `BRAND_DEPS_DIR` → `brand/scripts/node_modules` → `/tmp/brandtools`.

Generator deterministik: menjalankan ulang tanpa perubahan kode menghasilkan file identik.

### Apa yang dilakukan generator

| Langkah | Detail |
|---|---|
| Geometri simbol | `lib/geometry.mjs` — tas (poligon dengan fillet lingkaran sejati), handle (busur konstan), grommet+strap, orbit (band lebar-variabel sepanjang elips miring), pesawat; digabung/di-knock-out dengan boolean paper.js → path datar. `FAVICON_PARAMS` = versi ≤ 32 px. |
| Wordmark | `lib/wordmark.mjs` — Poppins SemiBold via opentype.js → outline path (kerning font + tracking −15/1000 em); serializer path sendiri karena `toPathData` opentype.js 2.0 bisa menghasilkan `NaN`. |
| Lockup | `lib/lockups.mjs` — proporsi relatif tinggi kapital (simbol 2,25× cap-height di horizontal; 60 % lebar wordmark di vertikal), centering optis (campuran bbox + centroid massa). |
| Raster | `lib/raster.mjs` — sharp/librsvg, ICO writer sendiri (PNG-compressed), ikon opaque untuk iOS/App Store/Play. |
| Pratinjau | `lib/brand-sheet.mjs` — Playwright + Poppins woff2 asli. |

## Integrasi

### Flutter (`apps/mobile`)

```yaml
# pubspec.yaml
flutter:
  fonts:
    - family: Poppins
      fonts:
        - asset: assets/fonts/Poppins-Regular.ttf
        - asset: assets/fonts/Poppins-Italic.ttf
          style: italic
        - asset: assets/fonts/Poppins-Medium.ttf
          weight: 500
        - asset: assets/fonts/Poppins-SemiBold.ttf
          weight: 600
        - asset: assets/fonts/Poppins-Bold.ttf
          weight: 700

# flutter_native_splash.yaml — salin brand/splash/*.png ke apps/mobile/assets/splash/ dulu
flutter_native_splash:
  color: "#F7F8FB"
  image: assets/splash/splash-logo-light.png
  branding: assets/splash/splash-branding.png
  color_dark: "#070B19"
  image_dark: assets/splash/splash-logo-dark.png
  branding_dark: assets/splash/splash-branding-dark.png
  android_12:
    image: assets/splash/android12-splash-icon.png
    color: "#F7F8FB"
    image_dark: assets/splash/android12-splash-icon-dark.png
    color_dark: "#070B19"
```

- iOS: salin `app-icon/ios/AppIcon.appiconset/` ke `ios/Runner/Assets.xcassets/` (timpa). Ingin mode single-size Xcode 14+? Ganti `Contents.json` dengan `app-icon/ios/Contents.single-size.json` dan hapus PNG lain.
- Android: salin isi `app-icon/android/` ke `android/app/src/main/res/` (mipmap-*, mipmap-anydpi-v26, values, drawable-*). Ikon notifikasi: `@drawable/ic_stat_jastipkita` (FCM: `com.google.firebase.messaging.default_notification_icon`), warna aksen notifikasi cobalt-500.
- Token: `lib/core/design/tokens.g.dart` (di-generate `packages/design-tokens`).

### Web & admin

```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#0B1E4A">
<meta property="og:image" content="/og-image-1200x630.png">
<link rel="stylesheet" href="/fonts/poppins.css">
```

Salin `brand/web/*` + `brand/social/og-image-1200x630.png` ke `apps/web/public/` (dan `apps/admin/public/`). Font sudah ditulis generator ke `apps/{web,admin}/public/fonts/`. Token: `import '@jastipkita/design-tokens/tokens.css'`.

## Kompromi & catatan

- **Font TTF** diambil langsung dari biner resmi Google Fonts (Poppins v4.004, via `@expo-google-fonts/poppins`, glyph set penuh 1059) — lebih baik daripada round-trip woff2→TTF dari subset fontsource. Jika sumber itu tidak tersedia, konversi fallback: `python3 -c "from fontTools.ttLib import TTFont; f=TTFont('in.woff2'); f.flavor=None; f.save('out.ttf')"` (butuh `fonttools` + `brotli`), dengan catatan subset latin saja.
- **Web font** = subset latin + latin-ext (woff2) dengan `unicode-range`; cukup untuk id/en.
- **Glass di mockup** di-"bake" oleh `render-mockups.mjs` (screenshot tanpa lapisan kaca → blur σ20 + saturasi 1,8 via sharp) karena headless Chromium tidak konsisten merender `backdrop-filter`. Di produk, CSS `.jk-glass` / Flutter `BackdropFilter` yang dipakai.
- Logo belum diuji cetak (CMYK/Pantone belum ditetapkan) dan belum dicek merek dagang (DJKI/PDKI).
