import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/format/dates.dart';
import '../../../core/format/money.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/engagement.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/common.dart';
import '../../../widgets/money_text.dart';
import '../../../widgets/states.dart';
import '../../engagement/data/engagement_repository.dart';
import '../../shell/presentation/main_shell.dart';

/// Wallet: JastipKita Credit (not withdrawable — stated plainly), expiring lots, history;
/// entry points to referrals and traveler payouts (§6.14).
class WalletScreen extends ConsumerWidget {
  const WalletScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final value = ref.watch(creditsProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.walletTitle), actions: const <Widget>[NotificationBell()]),
      body: AsyncValueView<Credits>(
        value: value,
        onRetry: () => ref.invalidate(creditsProvider),
        data: (Credits c) {
          final jk = context.jk;
          final locale = context.localeCode;
          final nextExpiry = c.nextExpiryAt;
          return JkRefresh(
            onRefresh: () => refreshSafely(() {
              ref.invalidate(creditsProvider);
              return ref.read(creditsProvider.future);
            }),
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s12 + MediaQuery.paddingOf(context).bottom),
              children: <Widget>[
                JkCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(l10n.creditBalance, style: JkTypeScale.bodyM.copyWith(color: jk.onSurfaceMuted)),
                      MoneyText(c.balanceIdr, size: MoneySize.l, emphasized: true, semanticsPrefix: l10n.creditBalance),
                      const SizedBox(height: 4),
                      Text(l10n.creditAvailable(Money.idr(c.availableIdr, locale: locale)), style: JkTypeScale.bodyS.copyWith(color: jk.onSurface)),
                      const SizedBox(height: JkSpacing.s2),
                      NoticeBox(message: l10n.creditNotWithdrawable),
                      if (c.expiringSoonIdr > 0) ...<Widget>[
                        const SizedBox(height: JkSpacing.s2),
                        NoticeBox(
                          tone: NoticeTone.warning,
                          message: l10n.creditExpiringSoon(Money.idr(c.expiringSoonIdr, locale: locale), c.expiringWithinDays),
                        ),
                      ],
                      if (nextExpiry != null) ...<Widget>[
                        const SizedBox(height: JkSpacing.s2),
                        Text(l10n.creditNextExpiry(JkDates.date(nextExpiry, locale)), style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: JkSpacing.s4),
                JkCard(
                  onTap: () => context.push(Routes.referrals),
                  child: Row(
                    children: <Widget>[
                      Icon(Icons.card_giftcard, color: jk.secondary),
                      const SizedBox(width: JkSpacing.s3),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(l10n.referralTitle, style: JkTypeScale.titleS.copyWith(color: jk.onSurface)),
                            Text(l10n.referralCardBody, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                          ],
                        ),
                      ),
                      const Icon(Icons.chevron_right),
                    ],
                  ),
                ),
                const SizedBox(height: JkSpacing.s3),
                JkCard(
                  onTap: () => context.push(Routes.payouts),
                  child: Row(
                    children: <Widget>[
                      Icon(Icons.payments_outlined, color: jk.secondary),
                      const SizedBox(width: JkSpacing.s3),
                      Expanded(child: Text(l10n.payoutsTitle, style: JkTypeScale.titleS.copyWith(color: jk.onSurface))),
                      const Icon(Icons.chevron_right),
                    ],
                  ),
                ),
                SectionHeader(title: l10n.creditHistory),
                if (c.history.isEmpty)
                  Text(l10n.creditHistoryEmpty, style: JkTypeScale.bodyM.copyWith(color: jk.onBackgroundMuted))
                else
                  for (final e in c.history)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(e.amountIdr >= 0 ? Icons.add_circle_outline : Icons.remove_circle_outline, color: e.amountIdr >= 0 ? jk.successText : jk.onSurfaceMuted),
                      title: Text(e.label),
                      subtitle: Text(
                        <String>[
                          if (e.createdAt != null) JkDates.date(e.createdAt!, locale),
                          if (e.expiresAt != null) l10n.creditExpires(JkDates.date(e.expiresAt!, locale)),
                        ].join(' · '),
                      ),
                      trailing: MoneyText(e.amountIdr, color: e.amountIdr >= 0 ? jk.successText : jk.onSurface),
                    ),
              ],
            ),
          );
        },
      ),
    );
  }
}
