import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/account.dart';
import '../../../core/network/step_up.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/sheets_and_glass.dart';
import '../../../widgets/states.dart';
import '../../auth/application/session_controller.dart';
import '../../auth/presentation/step_up_sheet.dart';
import '../../transactions/presentation/transaction_sheets.dart';
import '../data/kyc_repository.dart';

/// Payout (bank) accounts — the API only ever returns the mask (`****0961`); the full number is
/// typed once, sent over TLS and not kept by the app. Requires KYC ≥ 3.
class PayoutAccountsScreen extends ConsumerStatefulWidget {
  const PayoutAccountsScreen({super.key});

  @override
  ConsumerState<PayoutAccountsScreen> createState() => _PayoutAccountsScreenState();
}

class _PayoutAccountsScreenState extends ConsumerState<PayoutAccountsScreen> {
  String? _busy;

  /// Adding an account needs the step-up OTP (SEC-12). A holder name that differs from the verified
  /// identity is saved as `NAME_MISMATCH` for admin review.
  Future<void> _add() async {
    final l10n = context.l10n;
    PayoutAccount? added;
    await showJkBottomSheet<void>(
      context,
      title: l10n.payoutAccountAdd,
      builder: (BuildContext sheetContext) => BankAccountForm(
        submitLabel: sheetContext.l10n.payoutAccountAdd,
        intro: sheetContext.l10n.payoutAccountIntro,
        onSubmit: (String bank, String number, String holder) async {
          added = await ref.read(kycRepositoryProvider).addPayoutAccount(
                bankCode: bank,
                accountNumber: number,
                holderName: holder,
                stepUp: stepUpPrompt(sheetContext),
              );
        },
      ),
    );
    if (!mounted) return;
    ref.invalidate(payoutAccountsProvider);
    final account = added;
    if (account != null) showJkSnack(context, account.isUnderReview ? l10n.payoutAccountAddedReview : l10n.payoutAccountAdded);
  }

  Future<void> _run(String key, Future<Object?> Function() action, {String? success}) async {
    setState(() => _busy = key);
    try {
      await action();
      if (!mounted) return;
      ref.invalidate(payoutAccountsProvider);
      if (success != null) showJkSnack(context, success);
    } on StepUpCancelled {
      // Step-up sheet closed: nothing changed.
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _remove(PayoutAccount a) async {
    final l10n = context.l10n;
    final ok = await showJkConfirm(
      context,
      title: l10n.payoutAccountRemoveTitle,
      message: l10n.payoutAccountRemoveBody(a.accountMask),
      confirmLabel: l10n.actionRemove,
      destructive: true,
    );
    if (!ok) return;
    await _run('remove:${a.id}', () => ref.read(kycRepositoryProvider).removePayoutAccount(a.id));
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final level = ref.watch(currentProfileProvider)?.kycLevel ?? 1;
    final value = ref.watch(payoutAccountsProvider);
    if (level < KycLevel.identityVerified) {
      return Scaffold(
        appBar: AppBar(title: Text(l10n.payoutAccountsTitle)),
        body: EmptyState(
          icon: Icons.badge_outlined,
          title: l10n.payoutAccountsNeedKyc,
          message: l10n.payoutAccountsNeedKycBody,
          actionLabel: l10n.travelerKycCardCta,
          onAction: () => context.push(Routes.kyc),
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(l10n.payoutAccountsTitle)),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'payout-account-fab',
        onPressed: _add,
        icon: const Icon(Icons.add),
        label: Text(l10n.payoutAccountAdd),
      ),
      body: AsyncValueView<List<PayoutAccount>>(
        value: value,
        onRetry: () => ref.invalidate(payoutAccountsProvider),
        data: (List<PayoutAccount> accounts) {
          if (accounts.isEmpty) {
            return EmptyState(
              icon: Icons.account_balance_outlined,
              title: l10n.payoutAccountsEmpty,
              message: l10n.payoutAccountIntro,
              actionLabel: l10n.payoutAccountAdd,
              onAction: _add,
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.all(JkSpacing.s5),
            itemCount: accounts.length,
            separatorBuilder: (BuildContext context, int index) => const SizedBox(height: JkSpacing.s3),
            itemBuilder: (BuildContext context, int index) {
              final a = accounts[index];
              final jk = context.jk;
              return JkCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Row(
                      children: <Widget>[
                        Icon(Icons.account_balance_outlined, color: jk.secondary),
                        const SizedBox(width: JkSpacing.s3),
                        Expanded(
                          child: Text('${a.bankCode} ${a.accountMask}', style: JkTypeScale.titleS.copyWith(color: jk.onSurface)),
                        ),
                        if (a.isDefault) StatusChip(label: l10n.payoutAccountDefault, tone: jk.status['secured']!),
                      ],
                    ),
                    Text(a.holderName, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                    const SizedBox(height: JkSpacing.s2),
                    StatusChip(
                      label: Labels.payoutAccountStatus(l10n, a.verificationStatus),
                      tone: jk.status[a.isVerified ? 'secured' : (a.isUnderReview ? 'open' : 'actionRequired')]!,
                    ),
                    if (a.isUnderReview) ...<Widget>[
                      const SizedBox(height: JkSpacing.s2),
                      NoticeBox(tone: NoticeTone.info, title: l10n.statusUnderReview, message: l10n.payoutAccountReviewBody),
                    ],
                    const SizedBox(height: JkSpacing.s2),
                    Wrap(
                      spacing: JkSpacing.s2,
                      children: <Widget>[
                        if (a.isVerified && !a.isDefault)
                          JkButton(
                            label: l10n.payoutAccountMakeDefault,
                            expand: false,
                            variant: JkButtonVariant.tertiary,
                            loading: _busy == 'default:${a.id}',
                            onPressed: _busy == null
                                ? () => _run(
                                      'default:${a.id}',
                                      () => ref.read(kycRepositoryProvider).makeDefault(a.id, stepUp: stepUpPrompt(this.context)),
                                      success: l10n.payoutAccountDefaultChanged,
                                    )
                                : null,
                          ),
                        JkButton(
                          label: l10n.actionRemove,
                          expand: false,
                          variant: JkButtonVariant.tertiary,
                          loading: _busy == 'remove:${a.id}',
                          onPressed: _busy == null ? () => _remove(a) : null,
                        ),
                      ],
                    ),
                  ],
                ),
              );
            },
          );
        },
      ),
    );
  }
}
