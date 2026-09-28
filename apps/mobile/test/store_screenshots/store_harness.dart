import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/design/theme.dart';
import 'package:jastipkita/core/l10n/l10n.dart';
import 'package:jastipkita/core/network/api_client.dart';
import 'package:jastipkita/core/storage/settings.dart';
import 'package:jastipkita/core/storage/token_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../fake_http.dart';

/// Store screenshots run only on request:
/// `flutter test --tags store --update-goldens --dart-define=STORE_SCREENSHOTS=true test/store_screenshots`
/// PNGs land in `build/store_screenshots/<device>/`.
const bool storeScreenshotsEnabled = bool.fromEnvironment('STORE_SCREENSHOTS');

/// Brand navy (adaptive-icon background, brand/README).
const Color storeNavy = Color(0xFF0B1E4A);
const Color storeNavyLight = Color(0xFF16336F);

/// Store canvas: the whole image; the phone inside renders the app at the same logical size,
/// scaled down under the caption band.
class StoreDevice {
  const StoreDevice({
    required this.name,
    required this.size,
    required this.pixelRatio,
    required this.platform,
    required this.statusBar,
    required this.homeIndicator,
  });

  final String name;

  /// Logical size (× [pixelRatio] = store pixels).
  final Size size;
  final double pixelRatio;
  final TargetPlatform platform;
  final double statusBar;
  final double homeIndicator;

  Size get pixels => size * pixelRatio;
  bool get isIos => platform == TargetPlatform.iOS;

  /// Google Play phone 1080×1920.
  static const StoreDevice android = StoreDevice(
    name: 'android-1080x1920',
    size: Size(360, 640),
    pixelRatio: 3,
    platform: TargetPlatform.android,
    statusBar: 24,
    homeIndicator: 0,
  );

  /// Google Play phone 1440×2560 (same layout, higher density).
  static const StoreDevice androidQhd = StoreDevice(
    name: 'android-1440x2560',
    size: Size(360, 640),
    pixelRatio: 4,
    platform: TargetPlatform.android,
    statusBar: 24,
    homeIndicator: 0,
  );

  /// App Store iPhone 6.7" 1290×2796.
  static const StoreDevice iphone67 = StoreDevice(
    name: 'iphone-6.7-1290x2796',
    size: Size(430, 932),
    pixelRatio: 3,
    platform: TargetPlatform.iOS,
    statusBar: 54,
    homeIndicator: 34,
  );

  static const List<StoreDevice> all = <StoreDevice>[android, androidQhd, iphone67];
}

/// One phone inside a screenshot: the screen plus the fake API it talks to.
class StorePhone {
  const StorePhone({required this.screen, required this.routes, this.label, this.labelColor});

  final Widget Function() screen;

  /// `'GET /transactions'` → JSON body (or a builder taking the request).
  final Map<String, Object Function(RequestOptions request)> routes;

  /// Optional pill above the phone (two-phone shots).
  final String? label;
  final Color? labelColor;
}

class StoreShot {
  const StoreShot({
    required this.file,
    required this.caption,
    required this.phones,
    this.subcaption,
    this.dark = false,
    this.interact,
  });

  final String file;
  final String caption;
  final String? subcaption;
  final List<StorePhone> phones;
  final bool dark;

  /// Taps / scrolls after the data has loaded (e.g. run the customs check, scroll to a card).
  final Future<void> Function(WidgetTester tester)? interact;
}

bool _fontsLoaded = false;
String? _emojiFamily;

/// Loads every font in the test asset bundle's FontManifest (Poppins from pubspec + the
/// MaterialIcons font) so text renders with the real brand font instead of test boxes. A colour
/// emoji font (Noto Color Emoji, if installed on the machine) is registered for the country flags.
Future<bool> loadStoreFonts() async {
  if (_fontsLoaded) return true;
  try {
    final manifest = json.decode(await rootBundle.loadString('FontManifest.json')) as List<dynamic>;
    var poppins = false;
    for (final entry in manifest) {
      final family = (entry as Map<String, dynamic>)['family'] as String;
      // Package fonts keep their `packages/<pkg>/<family>` name: that is what IconData.fontPackage resolves to.
      final loader = FontLoader(family);
      for (final font in entry['fonts'] as List<dynamic>) {
        loader.addFont(rootBundle.load((font as Map<String, dynamic>)['asset'] as String));
      }
      await loader.load();
      if (family == 'Poppins') poppins = true;
    }
    for (final path in <String>[
      '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
      '/usr/share/fonts/noto/NotoColorEmoji.ttf',
      '/usr/share/fonts/google-noto-emoji/NotoColorEmoji.ttf',
    ]) {
      final file = File(path);
      if (file.existsSync()) {
        await (FontLoader('StoreEmoji')..addFont(file.readAsBytes().then((bytes) => bytes.buffer.asByteData()))).load();
        _emojiFamily = 'StoreEmoji';
        break;
      }
    }
    _fontsLoaded = poppins;
    if (!poppins) debugPrint('store screenshots: Poppins missing from FontManifest.json');
    return poppins;
  } on Object catch (e) {
    debugPrint('store screenshots: fonts unavailable ($e)');
    return false;
  }
}

/// Fake `/v1` for one phone: unknown GETs answer `{}` (logged), every POST succeeds.
FakeAdapter storeAdapter(Map<String, Object Function(RequestOptions request)> routes) => FakeAdapter((RequestOptions o, int i) {
      final key = '${o.method} ${o.path}';
      final route = routes[key];
      if (route != null) return FakeReply(200, route(o));
      if (o.method == 'GET') debugPrint('store screenshots: no fake for $key');
      return const FakeReply(200, <String, dynamic>{});
    });

final GlobalKey _canvasKey = GlobalKey(debugLabel: 'store-canvas');

/// Renders [shot] on [device] and writes `build/store_screenshots/<device>/<file>.png`.
Future<void> captureStoreShot(WidgetTester tester, StoreDevice device, StoreShot shot) async {
  // Font files and the engine's font registration are real async work: inside testWidgets' fake-async zone they
  // never complete (each shot then hangs until the test timeout), so they run in runAsync.
  if (!(await tester.runAsync(loadStoreFonts) ?? false)) {
    debugPrint('store screenshots: Poppins could not be loaded — ${shot.file} skipped');
    return;
  }
  tester.view.physicalSize = device.pixels;
  tester.view.devicePixelRatio = device.pixelRatio;
  addTearDown(tester.view.reset);
  // Haptics / clipboard calls from the screens are no-ops here.
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (MethodCall call) async => null);
  addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));

  SharedPreferences.setMockInitialValues(<String, Object>{'jk.onboardingSeen': true, 'jk.haptics': false});
  final prefs = await SharedPreferences.getInstance();
  final brightness = shot.dark ? Brightness.dark : Brightness.light;
  var theme = buildJkTheme(brightness, platform: device.platform);
  final emoji = _emojiFamily;
  if (emoji != null) theme = theme.copyWith(textTheme: theme.textTheme.apply(fontFamilyFallback: <String>[emoji]));

  final phones = <Widget>[
    for (final phone in shot.phones)
      _PhoneApp(
        device: device,
        dark: shot.dark,
        overrides: <Override>[
          sharedPreferencesProvider.overrideWithValue(prefs),
          tokenStorageProvider.overrideWithValue(
            MemoryTokenStorage(
              AuthTokens(accessToken: 'store', refreshToken: 'store', accessTokenExpiresAt: DateTime.utc(2099), sessionId: 's'),
            ),
          ),
          apiClientProvider.overrideWithValue(ApiClient(fakeDio(storeAdapter(phone.routes)))),
        ],
        screen: phone.screen,
      ),
  ];

  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: theme,
      locale: const Locale('id'),
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      builder: (BuildContext context, Widget? child) => RepaintBoundary(
        key: _canvasKey,
        child: StoreCanvas(device: device, shot: shot, phones: phones),
      ),
    ),
  );
  await _settle(tester);
  final interact = shot.interact;
  if (interact != null) {
    await interact(tester);
    await _settle(tester);
  }
  await tester.runAsync(() async {
    for (final element in find.byType(Image).evaluate()) {
      await precacheImage((element.widget as Image).image, element);
    }
  });
  await _settle(tester);
  await expectLater(find.byKey(_canvasKey), matchesGoldenFile('../../build/store_screenshots/${device.name}/${shot.file}.png'));
}

/// Lets fake HTTP, post-frame callbacks and short animations finish (no pumpAndSettle: countdown
/// chips tick forever).
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 12; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

class _PhoneApp extends StatelessWidget {
  const _PhoneApp({required this.device, required this.dark, required this.overrides, required this.screen});

  final StoreDevice device;
  final bool dark;
  final List<Override> overrides;
  final Widget Function() screen;

  @override
  Widget build(BuildContext context) {
    final size = device.size;
    final padding = EdgeInsets.only(top: device.statusBar, bottom: device.homeIndicator);
    return SizedBox(
      width: size.width,
      height: size.height,
      child: MediaQuery(
        data: MediaQuery.of(context).copyWith(
          size: size,
          padding: padding,
          viewPadding: padding,
          viewInsets: EdgeInsets.zero,
          textScaler: TextScaler.noScaling,
          platformBrightness: dark ? Brightness.dark : Brightness.light,
        ),
        child: ProviderScope(
          overrides: overrides,
          child: Stack(
            children: <Widget>[
              Positioned.fill(
                child: HeroControllerScope.none(
                  child: Navigator(
                    onGenerateRoute: (RouteSettings settings) => MaterialPageRoute<void>(builder: (BuildContext context) => screen()),
                  ),
                ),
              ),
              Positioned(top: 0, left: 0, right: 0, height: device.statusBar, child: _StatusBar(device: device, dark: dark)),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatusBar extends StatelessWidget {
  const _StatusBar({required this.device, required this.dark});

  final StoreDevice device;
  final bool dark;

  @override
  Widget build(BuildContext context) {
    final color = dark ? Colors.white : const Color(0xFF0F172A);
    final style = TextStyle(fontFamily: 'Poppins', fontSize: device.isIos ? 16 : 13, fontWeight: FontWeight.w600, color: color);
    return IgnorePointer(
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: device.isIos ? 30 : 16),
        child: Row(
          children: <Widget>[
            Text(device.isIos ? '9.41' : '09.41', style: style),
            const Spacer(),
            Icon(Icons.signal_cellular_alt, size: 16, color: color),
            const SizedBox(width: 4),
            Icon(Icons.wifi, size: 16, color: color),
            const SizedBox(width: 4),
            Icon(Icons.battery_full, size: 16, color: color),
          ],
        ),
      ),
    );
  }
}

/// Marketing layout: navy caption band with the brand, then the phone(s).
class StoreCanvas extends StatelessWidget {
  const StoreCanvas({super.key, required this.device, required this.shot, required this.phones});

  final StoreDevice device;
  final StoreShot shot;
  final List<Widget> phones;

  @override
  Widget build(BuildContext context) {
    final size = device.size;
    final captionHeight = size.height * 0.26;
    final sub = shot.subcaption;
    return SizedBox(
      width: size.width,
      height: size.height,
      child: DecoratedBox(
        decoration: const BoxDecoration(
          gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: <Color>[storeNavy, storeNavyLight]),
        ),
        child: Column(
          children: <Widget>[
            SizedBox(
              height: captionHeight,
              child: Padding(
                padding: EdgeInsets.fromLTRB(size.width * 0.07, device.statusBar * 0.6, size.width * 0.07, 8),
                // a 3-line caption + subcaption can be taller than the band on small (360×640) canvases: scale it down
                // instead of overflowing
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: SizedBox(
                    width: size.width * 0.86,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        const Text(
                          'JastipKita',
                          style: TextStyle(fontFamily: 'Poppins', fontSize: 13, fontWeight: FontWeight.w600, color: Color(0xFFF5B83D), letterSpacing: 1.2),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          shot.caption,
                          textAlign: TextAlign.center,
                          maxLines: 3,
                          style: TextStyle(
                            fontFamily: 'Poppins',
                            fontSize: size.width * 0.064,
                            height: 1.2,
                            fontWeight: FontWeight.w700,
                            color: Colors.white,
                          ),
                        ),
                        if (sub != null) ...<Widget>[
                          const SizedBox(height: 6),
                          Text(
                            sub,
                            textAlign: TextAlign.center,
                            maxLines: 2,
                            style: TextStyle(fontFamily: 'Poppins', fontSize: size.width * 0.036, height: 1.35, color: const Color(0xCCFFFFFF)),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),
            Expanded(
              child: Padding(
                padding: EdgeInsets.fromLTRB(size.width * 0.06, 0, size.width * 0.06, device.homeIndicator * 0.5 + 12),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    for (var i = 0; i < phones.length; i++) ...<Widget>[
                      if (i > 0) SizedBox(width: size.width * 0.04),
                      Expanded(child: _PhoneFrame(device: device, phone: shot.phones[i], child: phones[i])),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PhoneFrame extends StatelessWidget {
  const _PhoneFrame({required this.device, required this.phone, required this.child});

  final StoreDevice device;
  final StorePhone phone;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final label = phone.label;
    final aspect = device.size.width / device.size.height;
    final radius = device.isIos ? 34.0 : 22.0;
    return Column(
      children: <Widget>[
        if (label != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: DecoratedBox(
              decoration: BoxDecoration(color: phone.labelColor ?? Colors.white24, borderRadius: BorderRadius.circular(99)),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontFamily: 'Poppins', fontSize: 11, fontWeight: FontWeight.w700, color: Colors.white),
                ),
              ),
            ),
          ),
        Expanded(
          child: Center(
            child: AspectRatio(
              aspectRatio: aspect,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: const Color(0xFF0B0F19),
                  borderRadius: BorderRadius.circular(radius + 5),
                  boxShadow: const <BoxShadow>[BoxShadow(color: Color(0x66000000), blurRadius: 24, offset: Offset(0, 12))],
                ),
                child: Padding(
                  padding: const EdgeInsets.all(5),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(radius),
                    child: FittedBox(fit: BoxFit.contain, child: child),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
