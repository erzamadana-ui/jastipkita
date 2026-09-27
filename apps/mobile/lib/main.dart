import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app.dart';
import 'core/storage/settings.dart';

/// Entry point. Configuration comes from `--dart-define` (see `lib/core/config/app_config.dart`).
///
/// Push notifications (FCM/APNs) are optional: the app works fully without
/// `google-services.json` / `GoogleService-Info.plist` (in-app inbox + polling); see README.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  runApp(
    ProviderScope(
      overrides: <Override>[sharedPreferencesProvider.overrideWithValue(prefs)],
      child: const JastipKitaApp(),
    ),
  );
}
