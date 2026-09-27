import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/format/dates.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/account.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/states.dart';
import '../../auth/application/session_controller.dart';
import '../../auth/data/auth_repository.dart';

final _sessionsProvider = FutureProvider.autoDispose<List<SessionInfo>>((ref) => ref.watch(authRepositoryProvider).sessions());

/// Active sessions / devices with revoke, and sign-out of this device.
class SessionsScreen extends ConsumerWidget {
  const SessionsScreen({super.key});

  Future<void> _revoke(BuildContext context, WidgetRef ref, SessionInfo s) async {
    final l10n = context.l10n;
    final ok = await showJkConfirm(
      context,
      title: l10n.sessionRevokeTitle,
      message: l10n.sessionRevokeBody,
      confirmLabel: l10n.sessionRevoke,
      destructive: true,
    );
    if (!ok) return;
    try {
      await ref.read(authRepositoryProvider).revokeSession(s.id);
      if (!context.mounted) return;
      ref.invalidate(_sessionsProvider);
    } on Object catch (e) {
      if (!context.mounted) return;
      showJkSnack(context, errorMessage(l10n, e), error: true);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final value = ref.watch(_sessionsProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.sessionsTitle)),
      body: AsyncValueView<List<SessionInfo>>(
        value: value,
        onRetry: () => ref.invalidate(_sessionsProvider),
        data: (List<SessionInfo> sessions) {
          final jk = context.jk;
          final locale = context.localeCode;
          return ListView(
            padding: const EdgeInsets.all(JkSpacing.s5),
            children: <Widget>[
              for (final s in sessions)
                Padding(
                  padding: const EdgeInsets.only(bottom: JkSpacing.s3),
                  child: JkCard(
                    child: Row(
                      children: <Widget>[
                        Icon(_platformIcon(s.platform), color: jk.secondary),
                        const SizedBox(width: JkSpacing.s3),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: <Widget>[
                              Text(
                                <String>[s.platform ?? l10n.sessionUnknownDevice, if (s.appVersion != null) s.appVersion!].join(' · '),
                                style: JkTypeScale.titleS.copyWith(color: jk.onSurface),
                              ),
                              if (s.lastActiveAt != null)
                                Text(l10n.sessionLastActive(JkDates.dateTime(s.lastActiveAt!, locale)), style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                              if (s.current) StatusChip(label: l10n.sessionThisDevice, tone: jk.status['secured']!),
                            ],
                          ),
                        ),
                        if (!s.current)
                          IconButton(tooltip: l10n.sessionRevoke, onPressed: () => _revoke(context, ref, s), icon: const Icon(Icons.logout)),
                      ],
                    ),
                  ),
                ),
              const SizedBox(height: JkSpacing.s4),
              JkButton(
                label: l10n.signOut,
                variant: JkButtonVariant.destructive,
                onPressed: () => ref.read(sessionControllerProvider.notifier).signOut(),
              ),
            ],
          );
        },
      ),
    );
  }

  static IconData _platformIcon(String? platform) {
    switch (platform) {
      case 'IOS':
        return Icons.phone_iphone;
      case 'ANDROID':
        return Icons.phone_android;
      case 'WEB':
        return Icons.language;
      default:
        return Icons.devices_other;
    }
  }
}
