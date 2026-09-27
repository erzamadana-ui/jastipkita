import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/config/app_config.dart';
import '../../../core/design/haptics.dart';
import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/format/dates.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/transaction.dart';
import '../../../core/router/deep_links.dart';
import '../../../core/storage/settings.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/money_text.dart';
import '../../../widgets/safepay_status_banner.dart';
import '../../../widgets/states.dart';
import '../../../widgets/status_timeline.dart';
import '../data/transaction_repository.dart';
import 'transaction_detail_screen.dart';

/// Payment status (§6.6): pending (invoice countdown, open provider page, check status — polls
/// until the webhook secures the payment), secured (medal, total, PAYMENT SECURED banner, next
/// steps), or failed/expired (pay again → a new quote & checkout).
class PaymentStatusScreen extends ConsumerStatefulWidget {
  const PaymentStatusScreen({super.key, required this.transactionId});

  final String transactionId;

  @override
  ConsumerState<PaymentStatusScreen> createState() => _PaymentStatusScreenState();
}

class _PaymentStatusScreenState extends ConsumerState<PaymentStatusScreen> {
  Timer? _timer;
  bool _celebrated = false;
  bool _checking = false;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 4), (Timer t) {
      if (!mounted) return;
      final status = ref.read(transactionDetailProvider(widget.transactionId)).valueOrNull?.status;
      if (status == null || status == TxStatus.awaitingPayment) {
        ref.invalidate(transactionDetailProvider(widget.transactionId));
      } else {
        t.cancel();
      }
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _check() async {
    setState(() => _checking = true);
    await refreshSafely(() {
      ref.invalidate(transactionDetailProvider(widget.transactionId));
      return ref.read(transactionDetailProvider(widget.transactionId).future);
    });
    if (mounted) setState(() => _checking = false);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final value = ref.watch(transactionDetailProvider(widget.transactionId));
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.paymentStatusTitle),
        leading: IconButton(
          tooltip: l10n.actionClose,
          icon: const Icon(Icons.close),
          onPressed: () => context.canPop() ? context.pop() : context.go(Routes.transaction(widget.transactionId)),
        ),
      ),
      body: AsyncValueView<TransactionDetail>(
        value: value,
        onRetry: _check,
        data: (TransactionDetail d) {
          if (TxStatus.fundsSecured.contains(d.status) || d.status == TxStatus.completed) return _secured(d);
          final pending = d.pendingPayment;
          if (d.status == TxStatus.awaitingPayment && pending != null) return _pending(d, pending);
          return _failed(d);
        },
      ),
    );
  }

  Widget _pending(TransactionDetail d, Payment p) {
    final l10n = context.l10n;
    final jk = context.jk;
    final url = p.checkoutUrl;
    return ListView(
      padding: const EdgeInsets.all(JkSpacing.s5),
      children: <Widget>[
        SafePayStatusBanner(variant: SafePayVariant.pending, expiresAt: p.expiresAt),
        const SizedBox(height: JkSpacing.s5),
        Center(child: MoneyText(p.amountIdr, size: MoneySize.l, emphasized: true, semanticsPrefix: l10n.totalToPay)),
        const SizedBox(height: JkSpacing.s1),
        Center(
          child: Wrap(
            spacing: JkSpacing.s2,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: <Widget>[
              Text(Labels.paymentChannel(l10n, p.channel), style: JkTypeScale.bodyM.copyWith(color: jk.onBackgroundMuted)),
              if (p.sandbox) const SandboxBadge(),
            ],
          ),
        ),
        const SizedBox(height: JkSpacing.s5),
        if (url != null)
          JkButton(
            label: l10n.openPaymentPage,
            icon: Icons.open_in_new,
            onPressed: () => launchUrl(Uri.parse(AppConfig.rewriteLoopbackUrl(url)), mode: LaunchMode.externalApplication),
          ),
        const SizedBox(height: JkSpacing.s2),
        JkButton(label: l10n.checkPaymentStatus, icon: Icons.refresh, variant: JkButtonVariant.secondary, loading: _checking, onPressed: _check),
        const SizedBox(height: JkSpacing.s4),
        NoticeBox(message: l10n.paymentPendingHelp),
      ],
    );
  }

  Widget _secured(TransactionDetail d) {
    final l10n = context.l10n;
    final jk = context.jk;
    final locale = context.localeCode;
    final payment = d.securedPayment;
    final securedAt = payment?.securedAt;
    if (!_celebrated) {
      _celebrated = true;
      JkHaptics.success(ref.read(settingsProvider).haptics);
    }
    final amount = payment?.amountIdr ?? d.totalIdr ?? d.securedIdr;
    final nextSteps = <TimelineStep>[
      TimelineStep(label: l10n.stepSecured, state: TimelineNodeState.done, meta: l10n.justNow),
      TimelineStep(label: l10n.nextTravelerConfirmsPrice, state: TimelineNodeState.current, meta: l10n.nextTravelerConfirmsPriceMeta),
      TimelineStep(label: l10n.nextPurchased, state: TimelineNodeState.upcoming),
      TimelineStep(label: l10n.nextHandover, state: TimelineNodeState.upcoming),
    ];
    return ListView(
      padding: const EdgeInsets.all(JkSpacing.s5),
      children: <Widget>[
        const SizedBox(height: JkSpacing.s4),
        Center(
          child: TweenAnimationBuilder<double>(
            tween: Tween<double>(begin: context.reduceMotion ? 1 : 0.6, end: 1),
            duration: context.motion(JkMotion.emphasized),
            curve: context.reduceMotion ? Curves.linear : Curves.easeOutBack,
            builder: (BuildContext context, double scale, Widget? child) => Transform.scale(scale: scale, child: child),
            child: Container(
              width: 112,
              height: 112,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: jk.safepaySecured,
                shape: BoxShape.circle,
                border: Border.all(color: jk.successContainer, width: 10),
              ),
              child: Icon(Icons.verified_user, size: 52, color: jk.onSafepaySecured),
            ),
          ),
        ),
        const SizedBox(height: JkSpacing.s4),
        Semantics(
          header: true,
          liveRegion: true,
          child: Text(
            l10n.safepaySecuredTitle,
            textAlign: TextAlign.center,
            style: JkTypeScale.headlineM.copyWith(color: jk.onBackground, fontWeight: FontWeight.w700),
          ),
        ),
        Center(child: MoneyText(amount, size: MoneySize.l, emphasized: true, semanticsPrefix: l10n.totalPaid)),
        if (payment != null)
          Text(
            <String>[
              Labels.paymentChannel(l10n, payment.channel),
              if (securedAt != null) JkDates.dateTime(securedAt, locale),
            ].join(' · '),
            textAlign: TextAlign.center,
            style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted),
          ),
        const SizedBox(height: JkSpacing.s5),
        const SafePayStatusBanner(variant: SafePayVariant.secured),
        const SizedBox(height: JkSpacing.s4),
        JkCard(
          child: Row(
            children: <Widget>[
              Expanded(
                child: KeyValue(
                  label: l10n.txNumber,
                  value: Text(d.number, style: JkTypeScale.titleS.copyWith(color: jk.onSurface)),
                ),
              ),
              TextButton.icon(
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: d.number));
                  showJkSnack(context, l10n.copied);
                },
                icon: const Icon(Icons.copy_rounded, size: 18),
                label: Text(l10n.actionCopy),
              ),
            ],
          ),
        ),
        const SizedBox(height: JkSpacing.s4),
        JkCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(l10n.nextStepsTitle, style: JkTypeScale.titleS.copyWith(color: jk.onSurface)),
              const SizedBox(height: JkSpacing.s3),
              StatusTimeline(steps: nextSteps),
            ],
          ),
        ),
        const SizedBox(height: JkSpacing.s5),
        Row(
          children: <Widget>[
            IconButton.outlined(
              tooltip: l10n.chatWithCounterpart,
              onPressed: () => openTransactionChat(context, ref, d.id, conversationId: d.conversationId),
              icon: const Icon(Icons.chat_bubble_outline),
            ),
            const SizedBox(width: JkSpacing.s3),
            Expanded(
              child: JkButton(label: l10n.seeTitipanStatus, onPressed: () => context.pushReplacement(Routes.transaction(d.id))),
            ),
          ],
        ),
      ],
    );
  }

  Widget _failed(TransactionDetail d) {
    final l10n = context.l10n;
    final Payment? last = d.payments.isEmpty ? null : d.payments.last;
    final reason = last?.failureReason;
    return ListView(
      padding: const EdgeInsets.all(JkSpacing.s5),
      children: <Widget>[
        NoticeBox(
          tone: NoticeTone.error,
          title: last?.status == 'FAILED' ? l10n.paymentFailedTitle : l10n.paymentExpiredTitle,
          message: reason ?? l10n.paymentFailedBody,
        ),
        const SizedBox(height: JkSpacing.s5),
        if (d.can('CHECKOUT') || d.can('QUOTE'))
          JkButton(label: l10n.payAgain, icon: Icons.refresh, onPressed: () => context.pushReplacement(Routes.checkout(d.id))),
        const SizedBox(height: JkSpacing.s2),
        JkButton(
          label: l10n.seeTitipanStatus,
          variant: JkButtonVariant.secondary,
          onPressed: () => context.pushReplacement(Routes.transaction(d.id)),
        ),
      ],
    );
  }
}
