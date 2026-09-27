import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/format/dates.dart';
import '../../../core/format/money.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/models/engagement.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../../widgets/money_text.dart';
import '../../../widgets/states.dart';
import '../../engagement/data/engagement_repository.dart';

/// Referral: my code + share, honest program terms, stats and reward status; apply a friend's
/// code (new accounts only). No misleading gamification (§6.14).
class ReferralScreen extends ConsumerStatefulWidget {
  const ReferralScreen({super.key, this.initialCode});

  /// Prefilled from a referral link (`/jastipkita/r/{code}`); the user still taps "apply".
  final String? initialCode;

  @override
  ConsumerState<ReferralScreen> createState() => _ReferralScreenState();
}

class _ReferralScreenState extends ConsumerState<ReferralScreen> {
  late final TextEditingController _code = TextEditingController(text: widget.initialCode?.toUpperCase() ?? '');
  bool _applying = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _copy(String text, String channel) async {
    trackEvent(ref, 'referral_shared', <String, Object?>{'channel': channel});
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    showJkSnack(context, context.l10n.copied);
  }

  Future<void> _shareWhatsApp(MyReferrals r) async {
    final message = context.l10n.referralShareMessage(r.code, r.shareLink);
    trackEvent(ref, 'referral_shared', <String, Object?>{'channel': 'whatsapp'});
    await launchUrl(Uri.parse('https://wa.me/?text=${Uri.encodeComponent(message)}'), mode: LaunchMode.externalApplication);
  }

  Future<void> _apply() async {
    final code = _code.text.trim().toUpperCase();
    if (code.isEmpty) return;
    setState(() => _applying = true);
    try {
      final message = await ref.read(engagementRepositoryProvider).applyReferral(code);
      if (!mounted) return;
      showJkSnack(context, message.isEmpty ? context.l10n.referralApplied : message);
      _code.clear();
      ref.invalidate(referralsProvider);
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _applying = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final value = ref.watch(referralsProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.referralTitle)),
      body: AsyncValueView<MyReferrals>(
        value: value,
        onRetry: () => ref.invalidate(referralsProvider),
        data: (MyReferrals r) {
          final jk = context.jk;
          final locale = context.localeCode;
          return ListView(
            padding: const EdgeInsets.all(JkSpacing.s5),
            children: <Widget>[
              JkCard(
                child: Column(
                  children: <Widget>[
                    Text(l10n.referralYourCode, style: JkTypeScale.bodyM.copyWith(color: jk.onSurfaceMuted)),
                    const SizedBox(height: JkSpacing.s2),
                    SelectableText(r.code, style: JkTypeScale.headlineM.copyWith(color: jk.onSurface, letterSpacing: 3)),
                    const SizedBox(height: JkSpacing.s3),
                    Row(
                      children: <Widget>[
                        Expanded(
                          child: JkButton(
                            label: l10n.actionCopy,
                            icon: Icons.copy_rounded,
                            variant: JkButtonVariant.secondary,
                            onPressed: () => _copy(r.shareLink.isEmpty ? r.code : r.shareLink, 'copy'),
                          ),
                        ),
                        const SizedBox(width: JkSpacing.s2),
                        Expanded(
                          child: JkButton(label: l10n.referralShareWhatsapp, icon: Icons.share_outlined, onPressed: () => _shareWhatsApp(r)),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              SectionHeader(title: l10n.referralTerms),
              if (r.buyerEnabled)
                NoticeBox(
                  icon: Icons.shopping_bag_outlined,
                  title: l10n.referralBuyerProgram,
                  message: l10n.referralBuyerTerms(
                    Money.idr(r.buyerReferrerCreditIdr, locale: locale),
                    Money.idr(r.buyerRefereeCreditIdr, locale: locale),
                    Money.idr(r.buyerMinFirstTransactionIdr, locale: locale),
                    Money.idr(r.buyerMonthlyCapIdr, locale: locale),
                    r.creditExpiryDays,
                  ),
                ),
              if (r.travelerEnabled) ...<Widget>[
                const SizedBox(height: JkSpacing.s2),
                NoticeBox(
                  icon: Icons.flight_takeoff,
                  title: l10n.referralTravelerProgram,
                  message: l10n.referralTravelerTerms(Money.idr(r.travelerReferrerCreditIdr, locale: locale), r.travelerRequiredCompleted),
                ),
              ],
              const SizedBox(height: JkSpacing.s2),
              Text(l10n.creditNotWithdrawable, style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted)),
              SectionHeader(title: l10n.referralStats),
              JkCard(
                child: Wrap(
                  spacing: JkSpacing.s5,
                  runSpacing: JkSpacing.s3,
                  children: <Widget>[
                    KeyValue(label: l10n.referralInvited, value: Text('${r.invited}', style: JkTypeScale.titleM)),
                    KeyValue(label: l10n.referralPending, value: Text('${r.pending}', style: JkTypeScale.titleM)),
                    KeyValue(label: l10n.referralRewarded, value: Text('${r.rewarded}', style: JkTypeScale.titleM)),
                    KeyValue(label: l10n.referralEarned, value: MoneyText(r.totalEarnedIdr, size: MoneySize.m)),
                    KeyValue(label: l10n.referralEarnedMonth, value: MoneyText(r.monthEarnedIdr, size: MoneySize.m)),
                  ],
                ),
              ),
              if (r.rewards.isNotEmpty) ...<Widget>[
                SectionHeader(title: l10n.referralRewards),
                for (final rw in r.rewards)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.person_add_alt),
                    title: Text(rw.refereeName),
                    subtitle: Text(<String>[rw.status, if (rw.createdAt != null) JkDates.date(rw.createdAt!, locale)].join(' · ')),
                    trailing: MoneyText(rw.rewardIdr),
                  ),
              ],
              SectionHeader(title: l10n.referralApplyTitle),
              JkTextField(label: l10n.referralApplyLabel, controller: _code, textCapitalization: TextCapitalization.characters, helper: l10n.referralApplyHelp),
              const SizedBox(height: JkSpacing.s2),
              JkButton(label: l10n.referralApply, variant: JkButtonVariant.secondary, loading: _applying, onPressed: _apply),
            ],
          );
        },
      ),
    );
  }
}
