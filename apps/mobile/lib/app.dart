import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/design/theme.dart';
import 'core/l10n/l10n.dart';
import 'core/router/app_router.dart';
import 'core/storage/settings.dart';

/// Root widget: Material 3 light/dark themes from tokens, `id` (default) + `en`, router with auth
/// redirect, text scaling clamped to 2.0×.
class JastipKitaApp extends ConsumerWidget {
  const JastipKitaApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(settingsProvider);
    final router = ref.watch(routerProvider);
    final platform = Theme.of(context).platform;
    return MaterialApp.router(
      onGenerateTitle: (BuildContext context) => context.l10n.appName,
      debugShowCheckedModeBanner: false,
      theme: buildJkTheme(Brightness.light, platform: platform),
      darkTheme: buildJkTheme(Brightness.dark, platform: platform),
      themeMode: settings.themeMode,
      locale: settings.locale,
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: const <LocalizationsDelegate<dynamic>>[
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      routerConfig: router,
      builder: (BuildContext context, Widget? child) => MediaQuery.withClampedTextScaling(
        maxScaleFactor: 2.0,
        child: child ?? const SizedBox.shrink(),
      ),
    );
  }
}
