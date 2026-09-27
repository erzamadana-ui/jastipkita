import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

/// Overridden in `main()` (and tests) with the loaded instance.
final sharedPreferencesProvider = Provider<SharedPreferences>(
  (ref) => throw UnimplementedError('sharedPreferencesProvider must be overridden'),
);

enum AppThemePreference { system, light, dark }

/// Non-sensitive UI preferences only (theme, language, haptics, onboarding flag).
/// Tokens live in the keystore — see `token_storage.dart`.
class AppSettings {
  const AppSettings({
    this.theme = AppThemePreference.system,
    this.languageCode = 'id',
    this.haptics = true,
    this.onboardingSeen = false,
  });

  final AppThemePreference theme;
  final String languageCode;
  final bool haptics;
  final bool onboardingSeen;

  ThemeMode get themeMode => switch (theme) {
        AppThemePreference.light => ThemeMode.light,
        AppThemePreference.dark => ThemeMode.dark,
        AppThemePreference.system => ThemeMode.system,
      };

  Locale get locale => Locale(languageCode);

  AppSettings copyWith({AppThemePreference? theme, String? languageCode, bool? haptics, bool? onboardingSeen}) =>
      AppSettings(
        theme: theme ?? this.theme,
        languageCode: languageCode ?? this.languageCode,
        haptics: haptics ?? this.haptics,
        onboardingSeen: onboardingSeen ?? this.onboardingSeen,
      );
}

class SettingsController extends Notifier<AppSettings> {
  static const String _themeKey = 'jk.theme';
  static const String _localeKey = 'jk.locale';
  static const String _hapticsKey = 'jk.haptics';
  static const String _onboardingKey = 'jk.onboardingSeen';

  SharedPreferences get _prefs => ref.read(sharedPreferencesProvider);

  @override
  AppSettings build() {
    final prefs = ref.watch(sharedPreferencesProvider);
    final themeName = prefs.getString(_themeKey);
    final theme = AppThemePreference.values.firstWhere(
      (AppThemePreference t) => t.name == themeName,
      orElse: () => AppThemePreference.system,
    );
    final language = prefs.getString(_localeKey);
    return AppSettings(
      theme: theme,
      languageCode: language == 'en' ? 'en' : 'id',
      haptics: prefs.getBool(_hapticsKey) ?? true,
      onboardingSeen: prefs.getBool(_onboardingKey) ?? false,
    );
  }

  Future<void> setTheme(AppThemePreference theme) async {
    state = state.copyWith(theme: theme);
    await _prefs.setString(_themeKey, theme.name);
  }

  Future<void> setLanguage(String languageCode) async {
    final code = languageCode == 'en' ? 'en' : 'id';
    state = state.copyWith(languageCode: code);
    await _prefs.setString(_localeKey, code);
  }

  Future<void> setHaptics(bool enabled) async {
    state = state.copyWith(haptics: enabled);
    await _prefs.setBool(_hapticsKey, enabled);
  }

  Future<void> markOnboardingSeen() async {
    state = state.copyWith(onboardingSeen: true);
    await _prefs.setBool(_onboardingKey, true);
  }
}

final settingsProvider = NotifierProvider<SettingsController, AppSettings>(SettingsController.new);

/// Random per-install identifier sent as the device fingerprint on login (not a secret, not
/// derived from hardware identifiers).
final installationIdProvider = Provider<String>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  const key = 'jk.installationId';
  final existing = prefs.getString(key);
  if (existing != null && existing.isNotEmpty) return existing;
  final created = const Uuid().v4();
  prefs.setString(key, created);
  return created;
});
