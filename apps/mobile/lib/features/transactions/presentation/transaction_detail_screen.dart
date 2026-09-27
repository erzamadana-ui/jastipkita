import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/haptics.dart';
import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/format/dates.dart';
import '../../../core/format/money.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/marketplace.dart';
import '../../../core/models/transaction.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/router/deep_links.dart';
import '../../../core/storage/settings.dart';
import '../../../widgets/api_image.dart';
import '../../../widgets/badges.dart';
import '../../../widgets/cards.dart';
import '../../../widgets/common.dart';
import '../../../widgets/countdown_chip.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/money_text.dart';
import '../../../widgets/price_breakdown_card.dart';
import '../../../widgets/safepay_status_banner.dart';
import '../../../widgets/states.dart';
import '../../../widgets/status_timeline.dart';
import '../../catalog/data/catalog_repository.dart';
import '../../engagement/data/engagement_repository.dart';
import '../data/transaction_repository.dart';
import 'transaction_sheets.dart';

/// Opens the transaction's conversation: straight to [conversationId] when the detail already
/// has it, otherwise via `GET /transactions/{id}/conversation` (created lazily at MATCHED).
Future<void> openTransactionChat(BuildContext context, WidgetRef ref, String transactionId, {String? conversationId}) async {
  final l10n = context.l10n;
  if (conversationId != null) {
    context.push(Routes.conversation(conversationId));
    return;
  }
  try {
    final conversation = await ref.read(engagementRepositoryProvider).conversationForTransaction(transactionId);
    if (!context.mounted) return;
    context.push(Routes.conversation(conversation.id));
  } on ApiException catch (e) {
    if (!context.mounted) return;
    showJkSnack(context, e.code == 'CONVERSATION_NOT_AVAILABLE' ? l10n.chatNotAvailable : errorMessage(l10n, e), error: true);
  } on Object catch (e) {
    if (!context.mounted) return;
    showJkSnack(context, errorMessage(l10n, e), error: true);
  }
}

/// Transaction detail for both roles. Buyer: SafePay status, timeline, transparent breakdown,
/// price confirmation, handover PIN, confirm receipt, dispute, cancel, rating. Traveler: the
/// DO NOT PURCHASE gate (sticky, solid red until PURCHASE_APPROVED), price check, purchase
/// proof, travel status, customs, delivery & handover verification.
class TransactionDetailScreen extends ConsumerStatefulWidget {
  const TransactionDetailScreen({super.key, required this.transactionId});

  final String transactionId;

  @override
  ConsumerState<TransactionDetailScreen> createState() => _TransactionDetailScreenState();
}

class _TransactionDetailScreenState extends ConsumerState<TransactionDetailScreen> {
  Timer? _poll;
  bool _breakdownExpanded = false;
  String? _busy;

  @override
  void initState() {
    super.initState();
    // Light polling while open so status changes made by the other party appear (push is optional).
    _poll = Timer.periodic(const Duration(seconds: 20), (Timer t) {
      if (!mounted) return;
      final status = ref.read(transactionDetailProvider(widget.transactionId)).valueOrNull?.status;
      if (status != null && TxStatus.isTerminal(status)) return;
      _reload();
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  void _reload() {
    ref.invalidate(transactionDetailProvider(widget.transactionId));
    ref.invalidate(transactionTimelineProvider(widget.transactionId));
  }

  Future<void> _run(String key, Future<void> Function() action, {String? success}) async {
    if (_busy != null) return;
    setState(() => _busy = key);
    try {
      await action();
      if (!mounted) return;
      if (success != null) showJkSnack(context, success);
      _reload();
      ref.invalidate(activeTransactionsProvider('buyer'));
      ref.invalidate(activeTransactionsProvider('traveler'));
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _confirmReceipt(TransactionDetail d) async {
    final l10n = context.l10n;
    final ok = await showJkConfirm(
      context,
      title: l10n.confirmReceiptTitle,
      message: l10n.confirmReceiptBody,
      confirmLabel: l10n.confirmReceipt,
    );
    if (!ok || !mounted) return;
    final haptics = ref.read(settingsProvider).haptics;
    await _run('confirm', () async {
      await ref.read(transactionRepositoryProvider).confirmReceipt(d.id);
      JkHaptics.success(haptics);
    }, success: l10n.confirmReceiptDone);
    if (!mounted) return;
    await showRatingSheet(context, d.id);
  }

  Future<void> _updateStatus(String to) {
    final l10n = context.l10n;
    return _run('status:$to', () async {
      await ref.read(transactionRepositoryProvider).updateTravelStatus(widget.transactionId, to);
    }, success: l10n.statusUpdated(Labels.txStatus(l10n, to)));
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final value = ref.watch(transactionDetailProvider(widget.transactionId));
    final events = ref.watch(transactionTimelineProvider(widget.transactionId)).valueOrNull ?? const <TimelineEvent>[];
    final detail = value.valueOrNull;
    return Scaffold(
      appBar: AppBar(
        title: FittedBox(
          fit: BoxFit.scaleDown,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: context.isCupertino ? CrossAxisAlignment.center : CrossAxisAlignment.start,
            children: <Widget>[
              Text(l10n.txDetailTitle),
              if (detail != null) Text(detail.number, style: JkTypeScale.labelM.copyWith(color: context.jk.onSurfaceMuted)),
            ],
          ),
        ),
        actions: <Widget>[
          IconButton(
            tooltip: l10n.chatWithCounterpart,
            onPressed: () => openTransactionChat(context, ref, widget.transactionId, conversationId: detail?.conversationId),
            icon: const Icon(Icons.chat_bubble_outline),
          ),
        ],
      ),
      body: AsyncValueView<TransactionDetail>(
        value: value,
        onRetry: _reload,
        data: (TransactionDetail d) => d.isBuyer ? _buyerView(d, events) : _travelerView(d, events),
      ),
      bottomNavigationBar: detail == null ? null : _bottomBar(detail),
    );
  }

  Future<void> _refresh() => refreshSafely(() async {
        _reload();
        return ref.read(transactionDetailProvider(widget.transactionId).future);
      });

  EdgeInsets get _listPadding => const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s8);

  // ------------------------------------------------------------------ buyer
  Widget _buyerView(TransactionDetail d, List<TimelineEvent> events) {
    final l10n = context.l10n;
    final jk = context.jk;
    final locale = context.localeCode;
    final variant = SafePayStatusBanner.buyerVariant(d.status);
    final pc = d.openPriceConfirmation;
    final quote = d.quote;
    final delivery = d.delivery;
    final proof = d.purchaseProof;
    final autoConfirm = d.autoConfirmAt;
    final actionNeeded = d.allowedActions.any((String a) => a != 'CANCEL' && a != 'OPEN_DISPUTE');
    final refundsNeedingDestination = d.refunds.where((RefundInfo r) => r.needsDestination).toList();
    final refundsUnderReview = d.refunds.where((RefundInfo r) => r.destinationUnderReview).toList();
    return JkRefresh(
      onRefresh: _refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: _listPadding,
        children: <Widget>[
          if (variant != null) ...<Widget>[
            SafePayStatusBanner(variant: variant, expiresAt: d.pendingPayment?.expiresAt),
            const SizedBox(height: JkSpacing.s4),
          ],
          if (pc != null) ...<Widget>[
            NoticeBox(
              tone: NoticeTone.warning,
              title: l10n.pcAlertTitle,
              message: pc.status == 'CLARIFICATION_REQUESTED' ? l10n.pcWaitingTraveler : l10n.pcAlertBody,
            ),
            const SizedBox(height: JkSpacing.s2),
            JkButton(
              label: l10n.pcReview,
              variant: JkButtonVariant.tonal,
              onPressed: () => showPriceConfirmationSheet(context, ref, d, pc),
            ),
            const SizedBox(height: JkSpacing.s4),
          ],
          for (final refund in refundsNeedingDestination) ...<Widget>[
            NoticeBox(
              tone: NoticeTone.warning,
              message: refund.destinationRejected
                  ? l10n.refundDestinationRejected
                  : l10n.refundDestinationNeeded(Money.idr(refund.amountIdr, locale: locale)),
            ),
            const SizedBox(height: JkSpacing.s2),
            JkButton(
              label: l10n.refundDestinationTitle,
              variant: JkButtonVariant.tonal,
              onPressed: () => showRefundDestinationSheet(context, ref, d.id, refund),
            ),
            const SizedBox(height: JkSpacing.s4),
          ],
          for (final refund in refundsUnderReview) ...<Widget>[
            NoticeBox(
              tone: NoticeTone.info,
              icon: Icons.hourglass_top_rounded,
              title: <String>[l10n.statusUnderReview, '${refund.destinationBankCode ?? ''} ${refund.destinationMask ?? ''}'.trim()]
                  .where((String part) => part.isNotEmpty)
                  .join(' · '),
              message: l10n.refundDestinationReview,
            ),
            const SizedBox(height: JkSpacing.s4),
          ],
          _itemCard(d, counterpart: d.traveler, counterpartLabel: l10n.travelerLabel),
          const SizedBox(height: JkSpacing.s4),
          _timelineCard(d, events, actionNeeded),
          if (quote != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s4),
            PriceBreakdownCard(
              lines: quote.lines,
              compact: !_breakdownExpanded,
              onExpand: () => setState(() => _breakdownExpanded = true),
              itemSubLabel: _itemSubLabel(quote, locale),
              channelLabel: Labels.paymentChannel(l10n, quote.paymentChannel),
            ),
          ],
          if (delivery != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s4),
            _deliveryCard(delivery),
          ],
          if (d.status == TxStatus.delivered && autoConfirm != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s3),
            Row(
              children: <Widget>[
                Expanded(child: Text(l10n.autoConfirmIn, style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted))),
                CountdownChip(expiresAt: autoConfirm, icon: Icons.schedule),
              ],
            ),
          ],
          if (proof != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s4),
            _proofCard(proof),
          ],
          if (d.payments.isNotEmpty) ...<Widget>[
            SectionHeader(title: l10n.paymentsTitle),
            for (final p in d.payments) _paymentTile(p),
          ],
          if (d.refunds.isNotEmpty) ...<Widget>[
            SectionHeader(title: l10n.refundsTitle),
            for (final r in d.refunds)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.undo),
                title: MoneyText(r.amountIdr),
                subtitle: Text(<String>[Labels.refundStatus(l10n, r.status), if (r.destinationMask != null) r.destinationMask!].join(' · ')),
              ),
          ],
          _secondaryActions(d),
        ],
      ),
    );
  }

  String? _itemSubLabel(Quote quote, String locale) {
    final unit = quote.itemUnitPriceMinor;
    final currency = quote.itemCurrency;
    if (unit == null || currency == null) return null;
    final units = ref.read(catalogProvider).valueOrNull?.minorUnits(currency);
    return '${quote.itemQuantity ?? 1} × ${Money.minor(unit, currency, locale: locale, minorUnits: units)}';
  }

  Widget _itemCard(TransactionDetail d, {required PublicProfile? counterpart, required String counterpartLabel}) {
    final jk = context.jk;
    final l10n = context.l10n;
    final locale = context.localeCode;
    final item = d.item;
    final price = item?.unitPriceMinor;
    final currency = item?.currency;
    final catalog = ref.watch(catalogProvider).valueOrNull;
    final trip = d.trip;
    final (double? rating, int ratingCount) = counterpart?.ratingAs(d.isBuyer ? 'TRAVELER' : 'BUYER') ?? (null, 0);
    return JkCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              ProductThumb(imageUrl: item?.imageUrl, icon: Icons.work_outline),
              const SizedBox(width: JkSpacing.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(item?.productName ?? d.number, style: JkTypeScale.titleS.copyWith(color: jk.onSurface)),
                    if (item?.merchantName != null)
                      Text(item!.merchantName!, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                    if (price != null && currency != null)
                      Text(
                        '${item?.quantity ?? 1} × ${Money.minor(price, currency, locale: locale, minorUnits: catalog?.minorUnits(currency))}',
                        style: JkTypeScale.moneyS.copyWith(color: jk.onSurface),
                      ),
                  ],
                ),
              ),
              StatusChip(label: Labels.txStatus(l10n, d.status), tone: jk.statusTone(d.status)),
            ],
          ),
          if (counterpart != null) ...<Widget>[
            const Divider(height: JkSpacing.s6),
            Row(
              children: <Widget>[
                InitialsAvatar(name: counterpart.displayName, size: 40, verified: counterpart.identityVerified),
                const SizedBox(width: JkSpacing.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(counterpartLabel, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                      Text(counterpart.displayName, style: JkTypeScale.titleS.copyWith(color: jk.onSurface)),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: JkSpacing.s2),
            Wrap(
              spacing: JkSpacing.s2,
              runSpacing: JkSpacing.s2,
              children: <Widget>[
                if (counterpart.trustScore != null) TrustScoreBadge(score: counterpart.trustScore!, tier: counterpart.trustTier),
                if (counterpart.kycLevel != null) KycLevelBadge(level: counterpart.kycLevel!),
                if (rating != null)
                  StatusChip(
                    label: l10n.ratingShort(rating.toStringAsFixed(1), ratingCount),
                    tone: jk.status['open']!,
                    icon: Icons.star_rounded,
                  ),
              ],
            ),
          ],
          if (trip != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s3),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Icon(Icons.flight_takeoff, size: 18, color: jk.secondary),
                const SizedBox(width: JkSpacing.s2),
                Expanded(
                  child: RouteText.trip(
                    trip,
                    suffix: ' · ${l10n.tripDates(JkDates.calendarShort(trip.departureDate, locale), JkDates.calendarShort(trip.arrivalDate, locale))}',
                    style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _timelineCard(TransactionDetail d, List<TimelineEvent> events, bool actionNeeded) {
    final l10n = context.l10n;
    final jk = context.jk;
    final pending = d.pendingPayment?.expiresAt;
    return JkCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: JkSpacing.s2,
            runSpacing: JkSpacing.s2,
            children: <Widget>[
              Text(l10n.txStatusTitle, style: JkTypeScale.titleS.copyWith(color: jk.onSurface)),
              if (d.status == TxStatus.awaitingPayment && pending != null)
                CountdownChip(expiresAt: pending, label: l10n.invoiceCountdownLabel, icon: Icons.schedule),
            ],
          ),
          const SizedBox(height: JkSpacing.s3),
          StatusTimeline(
            steps: TxTimeline.build(
              l10n: l10n,
              status: d.status,
              locale: context.localeCode,
              events: events,
              traveler: !d.isBuyer,
              actionNeeded: actionNeeded,
            ),
          ),
        ],
      ),
    );
  }

  Widget _deliveryCard(DeliveryInfo delivery) {
    final l10n = context.l10n;
    final locale = context.localeCode;
    final scheduled = delivery.scheduledAt;
    return JkCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(l10n.deliveryTitle, style: JkTypeScale.titleS.copyWith(color: context.jk.onSurface)),
          const SizedBox(height: JkSpacing.s2),
          KeyValue(label: l10n.deliveryMethodLabel, value: Text(Labels.deliveryMethod(l10n, delivery.method))),
          if (delivery.meetupPoint != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            KeyValue(label: l10n.meetupPoint, value: Text(delivery.meetupPoint!)),
          ],
          if (scheduled != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            KeyValue(label: l10n.meetupTime, value: Text(JkDates.dateTime(scheduled, locale))),
          ],
          if (delivery.trackingNumber != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            KeyValue(
              label: l10n.trackingNumber,
              value: SelectableText('${delivery.courierName ?? ''} ${delivery.trackingNumber}'.trim()),
            ),
          ],
          if (delivery.pinLocked) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            NoticeBox(tone: NoticeTone.error, message: l10n.pinLocked),
          ],
        ],
      ),
    );
  }

  Widget _proofCard(PurchaseProof proof) {
    final l10n = context.l10n;
    final locale = context.localeCode;
    final price = proof.actualPriceMinor;
    final currency = proof.currency;
    final purchasedAt = proof.purchasedAt;
    return JkCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.receipt_long_outlined, color: context.jk.secondary),
              const SizedBox(width: JkSpacing.s2),
              Expanded(child: Text(l10n.proofTitle, style: JkTypeScale.titleS.copyWith(color: context.jk.onSurface))),
              if (proof.status == 'FLAGGED') StatusChip(label: l10n.proofUnderReview, tone: context.jk.status['actionRequired']!),
            ],
          ),
          const SizedBox(height: JkSpacing.s2),
          if (proof.merchantName != null) KeyValue(label: l10n.fieldMerchant, value: Text(proof.merchantName!)),
          if (price != null && currency != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            KeyValue(label: l10n.proofActualPrice, value: Text(Money.minor(price, currency, locale: locale))),
          ],
          if (purchasedAt != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            KeyValue(label: l10n.proofPurchasedAt, value: Text(JkDates.dateTime(purchasedAt, locale))),
          ],
          const SizedBox(height: JkSpacing.s2),
          Text(l10n.proofPhotos(proof.productPhotoFileIds.length), style: JkTypeScale.bodyS.copyWith(color: context.jk.onSurfaceMuted)),
          if (proof.images.isNotEmpty) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            Wrap(
              spacing: JkSpacing.s2,
              runSpacing: JkSpacing.s2,
              children: <Widget>[
                for (final f in proof.images)
                  Semantics(
                    button: true,
                    label: f.kind == 'RECEIPT' ? l10n.proofReceipt : l10n.proofPhotosLabel,
                    child: InkWell(
                      borderRadius: JkRadii.mdAll,
                      onTap: () => showApiImageDialog(context, f.contentUrl),
                      child: ProductThumb(imageUrl: f.contentUrl, size: 72, icon: Icons.image_outlined),
                    ),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _paymentTile(Payment p) {
    final l10n = context.l10n;
    final locale = context.localeCode;
    final at = p.securedAt ?? p.expiresAt;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(p.isSecured ? Icons.verified_user_outlined : Icons.receipt_outlined),
      title: Row(
        children: <Widget>[
          Flexible(child: MoneyText(p.amountIdr)),
          if (p.sandbox) ...<Widget>[const SizedBox(width: JkSpacing.s2), const SandboxBadge()],
        ],
      ),
      subtitle: Text(
        <String>[
          Labels.paymentStatus(l10n, p.status),
          if (p.channel != null) Labels.paymentChannel(l10n, p.channel),
          if (at != null) JkDates.shortDateTime(at, locale),
        ].join(' · '),
      ),
    );
  }

  Widget _secondaryActions(TransactionDetail d) {
    final l10n = context.l10n;
    return Padding(
      padding: const EdgeInsets.only(top: JkSpacing.s5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          if (d.can('OPEN_DISPUTE'))
            JkButton(
              label: l10n.disputeOpen,
              icon: Icons.report_gmailerrorred_outlined,
              variant: JkButtonVariant.secondary,
              onPressed: () => context.push(Routes.openDispute(d.id)),
            ),
          if (d.can('CANCEL')) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            JkButton(
              label: l10n.cancelTitle,
              icon: Icons.cancel_outlined,
              variant: JkButtonVariant.tertiary,
              onPressed: () => cancelTransactionFlow(context, ref, d),
            ),
          ],
          const SizedBox(height: JkSpacing.s2),
          JkButton(
            label: l10n.helpWithTransaction,
            icon: Icons.support_agent,
            variant: JkButtonVariant.tertiary,
            onPressed: () => context.push('${Routes.newTicket}?transactionId=${d.id}'),
          ),
        ],
      ),
    );
  }

  // ------------------------------------------------------------------ traveler
  Widget _travelerView(TransactionDetail d, List<TimelineEvent> events) {
    final l10n = context.l10n;
    final jk = context.jk;
    final locale = context.localeCode;
    final catalog = ref.watch(catalogProvider).valueOrNull;
    final haptics = ref.watch(settingsProvider).haptics;
    final quote = d.quote;
    final ceilingMinor = d.purchaseCeilingMinor;
    final ceilingIdr = d.purchaseCeilingIdr;
    final currency = d.itemCurrency ?? quote?.itemCurrency;
    final approvedText = ceilingMinor != null && currency != null
        ? Money.minor(ceilingMinor, currency, locale: locale, minorUnits: catalog?.minorUnits(currency))
        : (ceilingIdr != null ? Money.idr(ceilingIdr, locale: locale) : null);
    final fee = quote?.line(PriceLineType.travelerFee)?.amountIdr;
    final pc = d.openPriceConfirmation;
    final trip = d.trip;
    final payout = d.payout;
    final statusActions = d.allowedActions.where((String a) => a.startsWith('UPDATE_STATUS:')).map((String a) => a.substring(14)).toList();
    final actionNeeded = d.allowedActions.any((String a) => a != 'CANCEL' && a != 'OPEN_DISPUTE' && a != 'SET_DELIVERY' && a != 'CUSTOMS_DECLARATION');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s3, JkSpacing.s5, 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Wrap(
                spacing: JkSpacing.s2,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: <Widget>[
                  StatusChip(label: l10n.modeTravelerPill, tone: JkTone(fg: jk.onPrimary, bg: jk.primary, dot: jk.onPrimary), icon: Icons.flight_takeoff),
                  if (trip != null)
                    RouteText.trip(trip, upperCase: true, style: JkTypeScale.labelM.copyWith(color: jk.onBackgroundMuted, letterSpacing: 1)),
                ],
              ),
              const SizedBox(height: JkSpacing.s3),
              SafePayStatusBanner.forTraveler(status: d.status, approvedCeiling: approvedText, haptics: haptics),
            ],
          ),
        ),
        Expanded(
          child: JkRefresh(
            onRefresh: _refresh,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: _listPadding,
              children: <Widget>[
                JkCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(d.item?.productName ?? d.number, style: JkTypeScale.titleM.copyWith(color: jk.onSurface)),
                      if (d.buyer != null) ...<Widget>[
                        const SizedBox(height: 4),
                        Wrap(
                          spacing: JkSpacing.s2,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: <Widget>[
                            Text(l10n.requestBuyer(d.buyer!.displayName), style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                            if (d.buyer!.kycLevel != null) KycLevelBadge(level: d.buyer!.kycLevel!),
                            if (d.buyer!.trustScore != null) TrustScoreBadge(score: d.buyer!.trustScore!, tier: d.buyer!.trustTier),
                          ],
                        ),
                      ],
                      const Divider(height: JkSpacing.s6),
                      Row(
                        children: <Widget>[
                          Expanded(
                            child: KeyValue(
                              label: l10n.maxApprovedPrice,
                              value: Text(approvedText ?? '-', style: JkTypeScale.moneyM.copyWith(color: jk.onSurface)),
                            ),
                          ),
                          if (fee != null)
                            Expanded(child: KeyValue(label: l10n.yourTravelerFee, value: MoneyText(fee, size: MoneySize.m))),
                        ],
                      ),
                    ],
                  ),
                ),
                if (pc != null && d.can('CLARIFY_PRICE')) ...<Widget>[
                  const SizedBox(height: JkSpacing.s4),
                  NoticeBox(tone: NoticeTone.warning, title: l10n.clarifyTitle, message: pc.responseNote ?? l10n.clarifyBody),
                  const SizedBox(height: JkSpacing.s2),
                  JkButton(label: l10n.clarifyTitle, variant: JkButtonVariant.tonal, onPressed: () => showClarifySheet(context, ref, d, pc)),
                ],
                if (pc != null && pc.status == 'PENDING') ...<Widget>[
                  const SizedBox(height: JkSpacing.s4),
                  NoticeBox(message: l10n.pcTravelerWaiting),
                ],
                const SizedBox(height: JkSpacing.s4),
                _timelineCard(d, events, actionNeeded),
                if (statusActions.isNotEmpty) ...<Widget>[
                  SectionHeader(title: l10n.travelStatusTitle),
                  for (final to in statusActions)
                    Padding(
                      padding: const EdgeInsets.only(bottom: JkSpacing.s2),
                      child: JkButton(
                        label: l10n.markStatus(Labels.txStatus(l10n, to)),
                        variant: JkButtonVariant.secondary,
                        loading: _busy == 'status:$to',
                        onPressed: _busy == null ? () => _updateStatus(to) : null,
                      ),
                    ),
                ],
                if (d.can('CUSTOMS_DECLARATION') || d.can('SET_DELIVERY')) SectionHeader(title: l10n.travelerTasksTitle),
                if (d.can('CUSTOMS_DECLARATION'))
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(Icons.account_balance_outlined, color: jk.secondary),
                    title: Text(l10n.customsTitle),
                    subtitle: Text(l10n.customsSubtitle),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => context.push(Routes.customs(d.id)),
                  ),
                if (d.can('SET_DELIVERY'))
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(Icons.local_shipping_outlined, color: jk.secondary),
                    title: Text(l10n.deliverySetTitle),
                    subtitle: Text(d.delivery == null ? l10n.deliveryNotSet : Labels.deliveryMethod(l10n, d.delivery!.method)),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => context.push(Routes.delivery(d.id)),
                  ),
                if (d.delivery != null) ...<Widget>[
                  const SizedBox(height: JkSpacing.s3),
                  _deliveryCard(d.delivery!),
                ],
                if (d.purchaseProof != null) ...<Widget>[
                  const SizedBox(height: JkSpacing.s4),
                  _proofCard(d.purchaseProof!),
                ],
                if (payout != null) ...<Widget>[
                  SectionHeader(title: l10n.payoutTitle),
                  JkCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: <Widget>[
                        LabeledAmount(
                          label: Text(Labels.payoutStatus(l10n, payout.status), style: JkTypeScale.bodyM.copyWith(color: jk.onSurface)),
                          amount: MoneyText(payout.netIdr, size: MoneySize.m, semanticsPrefix: l10n.payoutNet),
                        ),
                        if (payout.paidAt != null || payout.scheduledAt != null)
                          Text(
                            payout.paidAt != null
                                ? l10n.payoutPaidOn(JkDates.date(payout.paidAt!, locale))
                                : l10n.payoutScheduledOn(JkDates.date(payout.scheduledAt!, locale)),
                            style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted),
                          ),
                        if (payout.holdReason != null)
                          Text(payout.holdReason!, style: JkTypeScale.bodyS.copyWith(color: jk.warningText)),
                      ],
                    ),
                  ),
                ],
                _secondaryActions(d),
              ],
            ),
          ),
        ),
      ],
    );
  }

  // ------------------------------------------------------------------ bottom action bar
  Widget? _bottomBar(TransactionDetail d) {
    final l10n = context.l10n;
    final children = <Widget>[];
    if (d.isBuyer) {
      final pc = d.openPriceConfirmation;
      if (d.can('CHECKOUT') || d.can('QUOTE')) {
        children.add(JkButton(label: l10n.goToPayment, icon: Icons.shield_outlined, onPressed: () => context.push(Routes.checkout(d.id))));
      } else if (d.can('PAY')) {
        children.add(JkButton(label: l10n.continuePayment, icon: Icons.payments_outlined, onPressed: () => context.push(Routes.payment(d.id))));
      } else if (pc != null && (d.can('RESPOND_PRICE_CONFIRMATION') || d.can('REJECT_PRICE_CONFIRMATION'))) {
        children.add(JkButton(label: l10n.pcReview, onPressed: () => showPriceConfirmationSheet(context, ref, d, pc)));
      } else if (d.can('CONFIRM_RECEIPT')) {
        children.add(
          JkButton(
            label: l10n.confirmReceipt,
            icon: Icons.inventory_outlined,
            loading: _busy == 'confirm',
            onPressed: _busy == null ? () => _confirmReceipt(d) : null,
          ),
        );
      } else if (d.can('VIEW_HANDOVER_PIN') || (d.delivery?.pinAvailable ?? false)) {
        children.add(JkButton(label: l10n.showHandoverPin, icon: Icons.qr_code_2, onPressed: () => context.push(Routes.handover(d.id))));
      } else if (d.status == TxStatus.completed) {
        children.add(
          JkButton(label: l10n.ratingTitle, icon: Icons.star_outline, variant: JkButtonVariant.secondary, onPressed: () => showRatingSheet(context, d.id)),
        );
      }
    } else {
      final prePurchase = TxStatus.prePurchase.contains(d.status) || d.status == TxStatus.purchaseApproved;
      if (d.can('PRICE_CHECK')) {
        children.add(
          JkButton(label: l10n.priceCheckTitle, icon: Icons.price_check, onPressed: () => context.push(Routes.priceCheck(d.id))),
        );
        children.add(const SizedBox(height: JkSpacing.s2));
      }
      if (prePurchase) {
        children.add(PurchaseGateButton(status: d.status, gate: d.purchaseGate, onUploadProof: () => context.push(Routes.purchaseProof(d.id))));
      } else if (d.can('VERIFY_HANDOVER')) {
        children.add(
          JkButton(label: l10n.verifyHandover, icon: Icons.qr_code_scanner, onPressed: () => context.push(Routes.verifyHandover(d.id))),
        );
      } else if (d.can('MARK_SHIPPED')) {
        children.add(JkButton(label: l10n.shippedTitle, icon: Icons.local_shipping_outlined, onPressed: () => showShippedSheet(context, ref, d.id)));
      } else if (d.can('MARK_DELIVERED')) {
        children.add(JkButton(label: l10n.deliveredTitle, icon: Icons.task_alt, onPressed: () => showDeliveredSheet(context, ref, d.id)));
      } else if (d.status == TxStatus.completed) {
        children.add(
          JkButton(label: l10n.ratingTitle, icon: Icons.star_outline, variant: JkButtonVariant.secondary, onPressed: () => showRatingSheet(context, d.id)),
        );
      }
    }
    if (children.isEmpty) return null;
    return OpaqueActionBar(children: children);
  }
}

/// Bottom action bar for transactional screens: always opaque (`surfaceElevated` + divider),
/// never glass — money is never shown blurred.
class OpaqueActionBar extends StatelessWidget {
  const OpaqueActionBar({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    return DecoratedBox(
      decoration: BoxDecoration(color: jk.surfaceElevated, border: Border(top: BorderSide(color: jk.divider))),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s3, JkSpacing.s5, JkSpacing.s3),
          child: Material(
            type: MaterialType.transparency,
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: children),
          ),
        ),
      ),
    );
  }
}
