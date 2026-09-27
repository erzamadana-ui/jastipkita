import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jastipkita/core/design/theme.dart';
import 'package:jastipkita/core/l10n/l10n.dart';

/// Hosts [child] the way the app does: JastipKita theme, `id` (default) / `en` localisations and
/// an optional text scale, inside a scrollable page so only horizontal overflow can fail a test.
Widget harness(
  Widget child, {
  Locale locale = const Locale('id'),
  double textScale = 1.0,
  Brightness brightness = Brightness.light,
}) {
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: buildJkTheme(brightness),
    locale: locale,
    supportedLocales: AppLocalizations.supportedLocales,
    localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
      AppLocalizations.delegate,
      GlobalMaterialLocalizations.delegate,
      GlobalWidgetsLocalizations.delegate,
      GlobalCupertinoLocalizations.delegate,
    ],
    builder: (BuildContext context, Widget? page) => MediaQuery(
      data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
      child: page ?? const SizedBox.shrink(),
    ),
    home: Scaffold(
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: child,
      ),
    ),
  );
}

/// Phone-sized logical surface (default 360 × 2400 dp) — tall, so long pages never overflow
/// vertically; width is what a narrow Android phone gives the layout.
void usePhoneSurface(WidgetTester tester, {double width = 360, double height = 2400}) {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = Size(width, height);
  addTearDown(tester.view.reset);
}

/// Indonesian strings, for assertions against the default locale.
AppLocalizations get idStrings => lookupAppLocalizations(const Locale('id'));
