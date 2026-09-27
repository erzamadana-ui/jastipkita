import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/badges.dart';
import '../../../widgets/common.dart';
import '../../auth/application/session_controller.dart';
import '../../shell/presentation/main_shell.dart';

/// Profile tab (§6.15): header with KYC + Trust badges, mode switch, verification, payouts,
/// wallet/referrals, disputes, help, settings and sign-out.
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  Future<void> _signOut(BuildContext context, WidgetRef ref) async {
    final l10n = context.l10n;
    final ok = await showJkConfirm(
      context,
      title: l10n.signOutTitle,
      message: l10n.signOutBody,
      confirmLabel: l10n.signOut,
    );
    if (!ok) return;
    await ref.read(sessionControllerProvider.notifier).signOut();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final jk = context.jk;
    final profile = ref.watch(currentProfileProvider);
    final traveler = profile?.isTraveler ?? false;
    final name = profile?.nameOrContact ?? '';
    Widget item(IconData icon, String label, String route, {String? subtitle}) => ListTile(
          leading: Icon(icon, color: jk.secondary),
          title: Text(label),
          subtitle: subtitle == null ? null : Text(subtitle),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => context.push(route),
        );
    return Scaffold(
      appBar: AppBar(title: Text(l10n.profileTitle), actions: const <Widget>[NotificationBell()]),
      body: ListView(
        padding: EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s12 + MediaQuery.paddingOf(context).bottom),
        children: <Widget>[
          JkCard(
            onTap: () => context.push(Routes.editProfile),
            child: Row(
              children: <Widget>[
                InitialsAvatar(name: name.isEmpty ? '?' : name, size: 64, verified: (profile?.kycLevel ?? 1) >= KycLevel.identityVerified),
                const SizedBox(width: JkSpacing.s4),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(name, style: JkTypeScale.titleM.copyWith(color: jk.onSurface)),
                      if (profile?.email != null) Text(profile!.email!, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                      const SizedBox(height: JkSpacing.s2),
                      Wrap(
                        spacing: JkSpacing.s2,
                        runSpacing: JkSpacing.s2,
                        children: <Widget>[
                          KycLevelBadge(level: profile?.kycLevel ?? 1, full: true),
                          if (profile != null) TrustScoreBadge(score: profile.trustScore, full: true),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: JkSpacing.s4),
          const ModeSwitch(),
          if (profile?.deletionScheduledFor != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s4),
            NoticeBox(tone: NoticeTone.error, message: l10n.deletionScheduledNotice),
          ],
          const SizedBox(height: JkSpacing.s3),
          item(Icons.verified_user_outlined, l10n.kycTitle, Routes.kyc),
          if (traveler) item(Icons.account_balance_outlined, l10n.payoutAccountsTitle, Routes.payoutAccounts),
          if (traveler) item(Icons.payments_outlined, l10n.payoutsTitle, Routes.payouts),
          item(Icons.account_balance_wallet_outlined, l10n.walletTitle, Routes.wallet),
          item(Icons.card_giftcard, l10n.referralTitle, Routes.referrals),
          item(Icons.gavel_outlined, l10n.disputesTitle, Routes.disputes),
          item(Icons.support_agent, l10n.supportTitle, Routes.support),
          item(Icons.settings_outlined, l10n.settingsTitle, Routes.settings),
          const Divider(height: JkSpacing.s6),
          ListTile(
            leading: Icon(Icons.logout, color: jk.errorText),
            title: Text(l10n.signOut, style: TextStyle(color: jk.errorText)),
            onTap: () => _signOut(context, ref),
          ),
        ],
      ),
    );
  }
}
