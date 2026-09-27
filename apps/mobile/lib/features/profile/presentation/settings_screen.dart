import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/app_config.dart';
import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/router/deep_links.dart';
import '../../../core/storage/settings.dart';
import '../../../widgets/common.dart';
import '../../../widgets/money_text.dart';
import '../../auth/data/auth_repository.dart';
import '../../auth/presentation/consent_screen.dart';

/// Settings: language (id/en), theme (system/light/dark), haptics, notifications, sessions,
/// privacy & data, legal and licenses (incl. Poppins OFL).
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  Future<void> _setLanguage(WidgetRef ref, String code) async {
    await ref.read(settingsProvider.notifier).setLanguage(code);
    try {
      await ref.read(authRepositoryProvider).updateProfile(locale: code);
    } on Object {
      // The UI language is local; syncing it to the account (e-mail/push language) is best effort.
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final jk = context.jk;
    final settings = ref.watch(settingsProvider);
    Widget section(String title) => Padding(
          padding: const EdgeInsets.only(top: JkSpacing.s5, bottom: JkSpacing.s2),
          child: Semantics(header: true, child: Text(title, style: JkTypeScale.labelL.copyWith(color: jk.onBackgroundMuted))),
        );
    return Scaffold(
      appBar: AppBar(title: Text(l10n.settingsTitle)),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(JkSpacing.s5, 0, JkSpacing.s5, JkSpacing.s8),
        children: <Widget>[
          section(l10n.settingsLanguage),
          Wrap(
            spacing: JkSpacing.s2,
            children: <Widget>[
              ChoiceChip(label: Text(l10n.languageIndonesian), selected: settings.languageCode == 'id', onSelected: (bool v) => _setLanguage(ref, 'id')),
              ChoiceChip(label: Text(l10n.languageEnglish), selected: settings.languageCode == 'en', onSelected: (bool v) => _setLanguage(ref, 'en')),
            ],
          ),
          section(l10n.settingsTheme),
          Wrap(
            spacing: JkSpacing.s2,
            children: <Widget>[
              for (final t in AppThemePreference.values)
                ChoiceChip(
                  label: Text(switch (t) {
                    AppThemePreference.system => l10n.themeSystem,
                    AppThemePreference.light => l10n.themeLight,
                    AppThemePreference.dark => l10n.themeDark,
                  }),
                  selected: settings.theme == t,
                  onSelected: (bool v) => ref.read(settingsProvider.notifier).setTheme(t),
                ),
            ],
          ),
          section(l10n.settingsGeneral),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: settings.haptics,
            onChanged: (bool v) => ref.read(settingsProvider.notifier).setHaptics(v),
            title: Text(l10n.settingsHaptics),
            subtitle: Text(l10n.settingsHapticsHelp),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.person_outline),
            title: Text(l10n.editProfileTitle),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.push(Routes.editProfile),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.notifications_none),
            title: Text(l10n.notificationSettingsTitle),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.push(Routes.notificationSettings),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.devices_outlined),
            title: Text(l10n.sessionsTitle),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.push(Routes.sessions),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.privacy_tip_outlined),
            title: Text(l10n.privacyTitle),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => context.push(Routes.privacy),
          ),
          section(l10n.settingsAbout),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.description_outlined),
            title: Text(l10n.consentReadTerms),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => openLegalDocument(context, 'TOS'),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.policy_outlined),
            title: Text(l10n.consentReadPrivacy),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => openLegalDocument(context, 'PRIVACY'),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.article_outlined),
            title: Text(l10n.settingsLicenses),
            onTap: () => showLicensePage(context: context, applicationName: l10n.appName, applicationVersion: AppConfig.appVersion),
          ),
          const SizedBox(height: JkSpacing.s4),
          Wrap(
            spacing: JkSpacing.s2,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: <Widget>[
              Text(l10n.appVersionLabel(AppConfig.appVersion, AppConfig.appEnv), style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted)),
              if (AppConfig.showSandboxBadge) const SandboxBadge(),
            ],
          ),
          const SizedBox(height: JkSpacing.s2),
          NoticeBox(message: l10n.dataLimitationsNote),
        ],
      ),
    );
  }
}
