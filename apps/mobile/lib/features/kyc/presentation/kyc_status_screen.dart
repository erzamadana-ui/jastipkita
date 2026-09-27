import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/account.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/badges.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/money_text.dart';
import '../../../widgets/states.dart';
import '../../auth/application/session_controller.dart';
import '../data/kyc_repository.dart';
import 'phone_verification.dart';

/// Verification status: current level, the L1–L5 ladder with what each level unlocks, the next
/// level's requirements (from the API), submission state and the next action (§6.13).
class KycStatusScreen extends ConsumerWidget {
  const KycStatusScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final value = ref.watch(kycStatusProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.kycTitle)),
      body: AsyncValueView<KycStatus>(
        value: value,
        onRetry: () => ref.invalidate(kycStatusProvider),
        data: (KycStatus status) {
          final jk = context.jk;
          final open = status.openSubmission;
          final rejected = open == null ? status.lastRejected : null;
          final nextLevel = status.nextLevel;
          return JkRefresh(
            onRefresh: () => refreshSafely(() {
              ref.invalidate(kycStatusProvider);
              return ref.read(kycStatusProvider.future);
            }),
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(JkSpacing.s5),
              children: <Widget>[
                JkCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(l10n.kycCurrentLevel, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                      const SizedBox(height: JkSpacing.s2),
                      KycLevelBadge(level: status.level, full: true),
                      const SizedBox(height: JkSpacing.s2),
                      Text(Labels.kycBenefit(l10n, status.level), style: JkTypeScale.bodyM.copyWith(color: jk.onSurface)),
                    ],
                  ),
                ),
                if (open != null) ...<Widget>[
                  const SizedBox(height: JkSpacing.s4),
                  NoticeBox(
                    title: Labels.kycSubmissionStatus(l10n, open.status),
                    message: l10n.kycPendingBody,
                    icon: Icons.hourglass_top,
                  ),
                  if (open.providerEnv == 'TEST') ...<Widget>[const SizedBox(height: JkSpacing.s2), const SandboxBadge()],
                ],
                if (rejected != null) ...<Widget>[
                  const SizedBox(height: JkSpacing.s4),
                  NoticeBox(
                    tone: NoticeTone.error,
                    title: l10n.kycRejectedTitle,
                    message: rejected.decisionReason ?? l10n.kycRejectedBody,
                  ),
                ],
                if (nextLevel != null && status.requirements.isNotEmpty) ...<Widget>[
                  SectionHeader(title: l10n.kycNextRequirements(Labels.kycLevel(l10n, nextLevel))),
                  for (final r in status.requirements)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(
                        r.met ? Icons.check_circle : Icons.radio_button_unchecked,
                        color: r.met ? jk.successText : jk.onSurfaceMuted,
                      ),
                      title: Text(r.description),
                    ),
                ],
                const SizedBox(height: JkSpacing.s4),
                _NextAction(status: status),
                SectionHeader(title: l10n.kycLadderTitle),
                JkCard(child: KycLadder(currentLevel: status.level)),
                const SizedBox(height: JkSpacing.s3),
                Text(l10n.kycPrivacyNote, style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted)),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _NextAction extends ConsumerWidget {
  const _NextAction({required this.status});

  final KycStatus status;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final level = status.level;
    if (level < KycLevel.phoneVerified) {
      return JkButton(
        label: l10n.verifyPhone,
        icon: Icons.phone_iphone,
        onPressed: () async {
          final ok = await startPhoneVerification(context, ref);
          if (!context.mounted) return;
          if (ok) {
            ref.invalidate(kycStatusProvider);
            await ref.read(sessionControllerProvider.notifier).refreshProfile();
          }
        },
      );
    }
    if (level < KycLevel.identityVerified) {
      if (status.openSubmission != null) return const SizedBox.shrink();
      return JkButton(
        label: status.lastRejected != null ? l10n.kycTryAgain : l10n.kycStartIdentity,
        icon: Icons.badge_outlined,
        onPressed: () => context.push(Routes.kycSubmit),
      );
    }
    return JkButton(
      label: l10n.payoutAccountsTitle,
      icon: Icons.account_balance_outlined,
      variant: JkButtonVariant.secondary,
      onPressed: () => context.push(Routes.payoutAccounts),
    );
  }
}
