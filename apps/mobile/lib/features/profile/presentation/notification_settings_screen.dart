import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/engagement.dart';
import '../../../widgets/common.dart';
import '../../../widgets/states.dart';
import '../../engagement/data/engagement_repository.dart';

/// Notification preferences per group × channel. Locked channels (critical transaction and
/// payment notices) are shown but cannot be turned off.
class NotificationSettingsScreen extends ConsumerStatefulWidget {
  const NotificationSettingsScreen({super.key});

  @override
  ConsumerState<NotificationSettingsScreen> createState() => _NotificationSettingsScreenState();
}

class _NotificationSettingsScreenState extends ConsumerState<NotificationSettingsScreen> {
  String? _saving;

  Future<void> _toggle(String group, String channel, bool enabled) async {
    setState(() => _saving = '$group:$channel');
    try {
      await ref.read(engagementRepositoryProvider).updateNotificationPreference(group: group, channel: channel, enabled: enabled);
      if (!mounted) return;
      ref.invalidate(notificationPreferencesProvider);
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _saving = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final value = ref.watch(notificationPreferencesProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.notificationSettingsTitle)),
      body: AsyncValueView<NotificationPreferences>(
        value: value,
        onRetry: () => ref.invalidate(notificationPreferencesProvider),
        data: (NotificationPreferences prefs) {
          final jk = context.jk;
          return ListView(
            padding: const EdgeInsets.all(JkSpacing.s5),
            children: <Widget>[
              if (prefs.criticalNotice.isNotEmpty) NoticeBox(message: prefs.criticalNotice),
              for (final g in prefs.groups) ...<Widget>[
                SectionHeader(title: Labels.notificationGroup(l10n, g.group, g.label)),
                for (final c in g.channels)
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    value: c.enabled,
                    onChanged: c.locked || _saving != null ? null : (bool v) => _toggle(g.group, c.channel, v),
                    title: Text(Labels.notificationChannel(l10n, c.channel)),
                    subtitle: c.locked ? Text(l10n.notifLocked, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)) : null,
                  ),
              ],
              const SizedBox(height: JkSpacing.s4),
              Text(l10n.pushOptionalNote, style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted)),
            ],
          );
        },
      ),
    );
  }
}
