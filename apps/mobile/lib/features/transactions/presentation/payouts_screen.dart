import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/format/dates.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/json.dart';
import '../../../core/models/transaction.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/common.dart';
import '../../../widgets/money_text.dart';
import '../../../widgets/paged_list.dart';
import '../../../widgets/states.dart';
import '../data/transaction_repository.dart';

/// Traveler earnings: scheduled / processing / held / paid / failed payouts, destination masked.
class PayoutsScreen extends ConsumerStatefulWidget {
  const PayoutsScreen({super.key});

  @override
  ConsumerState<PayoutsScreen> createState() => _PayoutsScreenState();
}

class _PayoutsScreenState extends ConsumerState<PayoutsScreen> {
  PayoutSummary? _summary;

  Future<Paged<Payout>> _fetch(String? cursor) async {
    final page = await ref.read(transactionRepositoryProvider).payouts(cursor: cursor);
    if (cursor == null && mounted) setState(() => _summary = page.summary);
    return Paged<Payout>(page.items, page.nextCursor);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final locale = context.localeCode;
    final summary = _summary;
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.payoutsTitle),
        actions: <Widget>[
          IconButton(
            tooltip: l10n.payoutAccountsTitle,
            onPressed: () => context.push(Routes.payoutAccounts),
            icon: const Icon(Icons.account_balance_outlined),
          ),
        ],
      ),
      body: PagedListView<Payout>(
        fetch: _fetch,
        header: summary == null
            ? null
            : JkCard(
                child: Wrap(
                  spacing: JkSpacing.s5,
                  runSpacing: JkSpacing.s3,
                  children: <Widget>[
                    KeyValue(label: l10n.payoutScheduled, value: MoneyText(summary.scheduledIdr, size: MoneySize.m)),
                    KeyValue(label: l10n.payoutProcessing, value: MoneyText(summary.processingIdr, size: MoneySize.m)),
                    KeyValue(label: l10n.payoutHeld, value: MoneyText(summary.heldIdr, size: MoneySize.m)),
                    KeyValue(label: l10n.payoutPaid, value: MoneyText(summary.paidIdr, size: MoneySize.m)),
                    if (summary.failedIdr > 0) KeyValue(label: l10n.payoutFailed, value: MoneyText(summary.failedIdr, size: MoneySize.m)),
                  ],
                ),
              ),
        empty: EmptyState(icon: Icons.payments_outlined, title: l10n.payoutsEmptyTitle, message: l10n.payoutsEmptyBody),
        itemBuilder: (BuildContext context, Payout p) {
          final when = p.paidAt ?? p.scheduledFor;
          return JkCard(
            onTap: p.transactionId == null ? null : () => context.push(Routes.transaction(p.transactionId!)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                LabeledAmount(
                  label: Text(p.number, style: JkTypeScale.titleS.copyWith(color: jk.onSurface)),
                  amount: MoneyText(p.netIdr, size: MoneySize.m, semanticsPrefix: l10n.payoutNet),
                ),
                const SizedBox(height: 4),
                Text(
                  <String>[
                    Labels.payoutStatus(l10n, p.status),
                    if (p.transactionNumber != null) p.transactionNumber!,
                    if (when != null) JkDates.date(when, locale),
                  ].join(' · '),
                  style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted),
                ),
                if (p.accountMask != null)
                  Text('${p.bankCode ?? ''} ${p.accountMask}'.trim(), style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                if (p.holdReason != null) ...<Widget>[
                  const SizedBox(height: JkSpacing.s2),
                  NoticeBox(tone: NoticeTone.warning, message: p.holdReason!),
                ],
              ],
            ),
          );
        },
      ),
    );
  }
}
