import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/format/dates.dart';
import '../../../core/format/money.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/marketplace.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/badges.dart';
import '../../../widgets/cards.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../../widgets/money_text.dart';
import '../../../widgets/pickers.dart';
import '../../../widgets/restricted_item_warning.dart';
import '../../../widgets/sheets_and_glass.dart';
import '../../../widgets/states.dart';
import '../../catalog/data/catalog_repository.dart';
import '../../trips/data/trip_repository.dart';
import '../data/request_repository.dart';

/// Request detail. Buyer (owner view): status, restriction acknowledgement + publish,
/// recommended travelers (score + Indonesian reasons) → invite, offers → accept (§6.4).
/// Traveler (listing view): request + "Kirim penawaran" from one of my ACTIVE trips.
class RequestDetailScreen extends ConsumerStatefulWidget {
  const RequestDetailScreen({super.key, required this.requestId, this.tripId});

  final String requestId;
  final String? tripId;

  @override
  ConsumerState<RequestDetailScreen> createState() => _RequestDetailScreenState();
}

class _RequestDetailScreenState extends ConsumerState<RequestDetailScreen> {
  bool _ack = false;
  String? _busy;

  void _reload() {
    ref.invalidate(requestDetailProvider(widget.requestId));
    ref.invalidate(requestOffersProvider(widget.requestId));
    ref.invalidate(recommendedTravelersProvider(widget.requestId));
  }

  Future<void> _act(String key, Future<void> Function() action, {String? success}) async {
    if (_busy != null) return;
    setState(() => _busy = key);
    try {
      await action();
      if (!mounted) return;
      if (success != null) showJkSnack(context, success);
      _reload();
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _publish() => _act(
        'publish',
        () => ref.read(requestRepositoryProvider).publish(widget.requestId, acknowledgeRestriction: _ack),
        success: context.l10n.requestPublished,
      );

  Future<void> _cancel() async {
    final l10n = context.l10n;
    final ok = await showJkConfirm(
      context,
      title: l10n.requestCancelTitle,
      message: l10n.requestCancelBody,
      confirmLabel: l10n.requestCancelConfirm,
      destructive: true,
    );
    if (!ok || !mounted) return;
    await _act('cancel', () => ref.read(requestRepositoryProvider).cancel(widget.requestId), success: l10n.requestCancelled);
  }

  Future<void> _invite(RecommendedTrip rec) => _act(
        'invite:${rec.trip.id}',
        () => ref.read(requestRepositoryProvider).invite(tripId: rec.trip.id, requestId: widget.requestId),
        success: context.l10n.inviteSent,
      );

  Future<void> _accept(Offer offer) async {
    if (_busy != null) return;
    setState(() => _busy = 'accept:${offer.id}');
    try {
      final txId = await ref.read(requestRepositoryProvider).accept(offer.id);
      if (!mounted) return;
      showJkSnack(context, context.l10n.offerAccepted);
      context.pushReplacement(Routes.transaction(txId));
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
      _reload();
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _decline(Offer offer) =>
      _act('decline:${offer.id}', () => ref.read(requestRepositoryProvider).decline(offer.id), success: context.l10n.offerDeclined);

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final value = ref.watch(requestDetailProvider(widget.requestId));
    final request = value.valueOrNull;
    final ownerCanCancel = request != null &&
        request.isOwnerView &&
        (request.status == RequestStatus.draft || request.status == RequestStatus.open);
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.requestDetailTitle),
        actions: <Widget>[
          if (ownerCanCancel)
            IconButton(
              tooltip: l10n.requestCancelTitle,
              onPressed: _busy == null ? _cancel : null,
              icon: const Icon(Icons.delete_outline),
            ),
        ],
      ),
      body: AsyncValueView<RequestItem>(
        value: value,
        onRetry: _reload,
        data: (RequestItem r) => JkRefresh(
          onRefresh: () => refreshSafely(() async {
            _reload();
            return ref.read(requestDetailProvider(widget.requestId).future);
          }),
          child: r.isOwnerView ? _ownerView(r) : _listingView(r),
        ),
      ),
    );
  }

  Widget _productCard(RequestItem r) {
    final jk = context.jk;
    final l10n = context.l10n;
    final locale = context.localeCode;
    final catalog = ref.watch(catalogProvider).valueOrNull;
    final price = r.unitPriceMinor;
    final currency = r.priceCurrency;
    final buyer = r.buyer;
    return JkCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              ProductThumb(imageUrl: r.imageUrl, size: 72),
              const SizedBox(width: JkSpacing.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(r.productName, style: JkTypeScale.titleM.copyWith(color: jk.onSurface)),
                    if (r.merchantDomain != null || r.merchantName != null)
                      Text(r.merchantName ?? r.merchantDomain ?? '', style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                    if (r.variant != null) Text(r.variant!, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                  ],
                ),
              ),
            ],
          ),
          if (r.isAutoFilled) ...<Widget>[
            const SizedBox(height: JkSpacing.s3),
            // AI-content label (Permendag 19/2026): the product data came from automated extraction.
            Semantics(
              container: true,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Icon(Icons.auto_awesome_outlined, size: 16, color: jk.onSurfaceMuted),
                  const SizedBox(width: 6),
                  Expanded(child: Text(l10n.autofillDetailLabel, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted))),
                ],
              ),
            ),
          ],
          const Divider(height: JkSpacing.s6),
          Wrap(
            spacing: JkSpacing.s5,
            runSpacing: JkSpacing.s3,
            children: <Widget>[
              if (price != null && currency != null)
                KeyValue(
                  label: l10n.fieldPrice,
                  value: Text(
                    '${r.quantity} × ${Money.minor(price, currency, locale: locale, minorUnits: catalog?.minorUnits(currency))}',
                    style: JkTypeScale.moneyS.copyWith(color: jk.onSurface),
                  ),
                ),
              if (r.itemValueIdr != null) KeyValue(label: l10n.itemValueIdr, value: MoneyText(r.itemValueIdr!)),
              if (r.maxBudgetIdr != null) KeyValue(label: l10n.fieldMaxBudget, value: MoneyText(r.maxBudgetIdr!)),
              KeyValue(
                label: l10n.fieldCountry,
                value: Text(
                  '${PopularOrigins.flag(r.merchantCountry ?? '')} ${catalog?.countryName(r.merchantCountry, locale) ?? r.merchantCountry ?? '-'}',
                ),
              ),
              KeyValue(label: l10n.fieldCategory, value: Text(catalog?.categoryName(r.categoryCode, locale) ?? r.categoryCode ?? '-')),
              if (r.neededBy != null) KeyValue(label: l10n.fieldNeededBy, value: Text(JkDates.calendar(r.neededBy!, locale))),
              KeyValue(label: l10n.fieldDestinationCity, value: Text(r.destinationCity ?? r.destinationCountry)),
              if (r.deliveryPreference != null)
                KeyValue(
                  label: l10n.fieldDeliveryPreference,
                  value: Text(r.deliveryPreference == 'ANY' ? l10n.deliveryAny : Labels.deliveryMethod(l10n, r.deliveryPreference)),
                ),
            ],
          ),
          if (buyer != null) ...<Widget>[
            const Divider(height: JkSpacing.s6),
            Row(
              children: <Widget>[
                InitialsAvatar(name: buyer.displayName, size: 36, verified: buyer.identityVerified),
                const SizedBox(width: JkSpacing.s2),
                Expanded(child: Text(l10n.requestBuyer(buyer.displayName), style: JkTypeScale.bodyM.copyWith(color: jk.onSurface))),
                if (buyer.kycLevel != null) KycLevelBadge(level: buyer.kycLevel!),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _ownerView(RequestItem r) {
    final l10n = context.l10n;
    final jk = context.jk;
    final cls = r.restrictionClass;
    final isDraft = r.status == RequestStatus.draft;
    final needsAck = isDraft && r.requiresAcknowledgement && r.acknowledgedAt == null;
    final offers = ref.watch(requestOffersProvider(r.id));
    final isOpen = r.status == RequestStatus.open;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s12),
      children: <Widget>[
        Wrap(
          spacing: JkSpacing.s2,
          children: <Widget>[
            StatusChip(label: Labels.requestStatus(l10n, r.status), tone: jk.status[isOpen ? 'open' : 'closed']!),
            if (r.pendingOffers > 0)
              StatusChip(label: l10n.requestOffersCount(r.pendingOffers), tone: jk.status['actionRequired']!, icon: Icons.local_offer_outlined),
          ],
        ),
        const SizedBox(height: JkSpacing.s3),
        _productCard(r),
        if (cls != null && cls != Restriction.allowed) ...<Widget>[
          const SizedBox(height: JkSpacing.s4),
          RestrictedItemWarning(
            classification: cls,
            ruleRef: r.restrictionRuleRef,
            acknowledged: _ack || r.acknowledgedAt != null,
            onAcknowledgedChanged: needsAck ? (bool v) => setState(() => _ack = v) : null,
          ),
        ],
        if (isDraft) ...<Widget>[
          const SizedBox(height: JkSpacing.s4),
          JkButton(
            label: l10n.requestPublish,
            icon: Icons.send_outlined,
            loading: _busy == 'publish',
            onPressed: r.blocksPublishing || (needsAck && !_ack) ? null : _publish,
            disabledReason: r.blocksPublishing
                ? l10n.restrictionProhibitedTitle
                : (needsAck && !_ack ? l10n.requestPublishNeedsAck : null),
          ),
        ],
        if (r.status == RequestStatus.matched)
          offers.maybeWhen(
            data: (List<Offer> list) {
              String? txId;
              for (final o in list) {
                if (o.status == 'ACCEPTED' && o.transactionId != null) txId = o.transactionId;
              }
              final id = txId;
              if (id == null) return const SizedBox.shrink();
              return Padding(
                padding: const EdgeInsets.only(top: JkSpacing.s4),
                child: JkButton(label: l10n.requestSeeTransaction, onPressed: () => context.push(Routes.transaction(id))),
              );
            },
            orElse: () => const SizedBox.shrink(),
          ),
        if (isOpen) ...<Widget>[
          SectionHeader(title: l10n.offersTitle),
          offers.when(
            data: (List<Offer> list) => list.isEmpty
                ? Text(l10n.offersEmpty, style: JkTypeScale.bodyM.copyWith(color: jk.onBackgroundMuted))
                : Column(
                    children: <Widget>[
                      for (final o in list)
                        Padding(
                          padding: const EdgeInsets.only(bottom: JkSpacing.s3),
                          child: OfferCard(
                            offer: o,
                            accepting: _busy == 'accept:${o.id}',
                            onAccept: _busy == null ? () => _accept(o) : null,
                            onDecline: _busy == null ? () => _decline(o) : null,
                          ),
                        ),
                    ],
                  ),
            loading: () => const Skeleton(height: 120, radius: JkRadii.lg),
            error: (Object e, StackTrace s) => ErrorView(error: e, compact: true, onRetry: _reload),
          ),
          SectionHeader(title: l10n.recommendedTravelersTitle),
          _RecommendedList(requestId: r.id, busy: _busy, onInvite: _invite),
        ],
      ],
    );
  }

  Widget _listingView(RequestItem r) {
    final l10n = context.l10n;
    final cls = r.restrictionClass;
    final canOffer = r.status == RequestStatus.open;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s12),
      children: <Widget>[
        _productCard(r),
        if (cls != null && cls != Restriction.allowed) ...<Widget>[
          const SizedBox(height: JkSpacing.s4),
          RestrictedItemWarning(classification: cls),
        ],
        const SizedBox(height: JkSpacing.s4),
        NoticeBox(tone: NoticeTone.info, message: l10n.offerSafepayNote, icon: Icons.shield_outlined),
        const SizedBox(height: JkSpacing.s4),
        JkButton(
          label: l10n.offerSend,
          icon: Icons.local_offer_outlined,
          onPressed: canOffer ? () => _showOfferSheet(r) : null,
          disabledReason: canOffer ? null : l10n.offerNotOpen,
        ),
      ],
    );
  }

  Future<void> _showOfferSheet(RequestItem r) async {
    final l10n = context.l10n;
    final sent = await showJkBottomSheet<bool>(
      context,
      title: l10n.offerSend,
      builder: (BuildContext sheetContext) => _OfferForm(requestId: r.id, initialTripId: widget.tripId),
    );
    if (sent != true) return;
    if (!mounted) return;
    showJkSnack(context, l10n.offerSent);
    _reload();
  }
}

class _RecommendedList extends ConsumerWidget {
  const _RecommendedList({required this.requestId, required this.busy, required this.onInvite});

  final String requestId;
  final String? busy;
  final Future<void> Function(RecommendedTrip) onInvite;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final value = ref.watch(recommendedTravelersProvider(requestId));
    return value.when(
      data: (List<RecommendedTrip> list) {
        if (list.isEmpty) {
          return EmptyState(icon: Icons.person_search_outlined, title: l10n.recommendedEmptyTitle, message: l10n.recommendedEmptyBody);
        }
        return Column(
          children: <Widget>[
            for (final rec in list)
              Padding(
                padding: const EdgeInsets.only(bottom: JkSpacing.s3),
                child: TravelerCard(
                  recommendation: rec,
                  actionLabel: l10n.inviteTraveler,
                  busy: busy == 'invite:${rec.trip.id}',
                  onAction: busy == null ? () => onInvite(rec) : null,
                  onTap: () => context.push(Routes.trip(rec.trip.id)),
                ),
              ),
          ],
        );
      },
      loading: () => const Skeleton(height: 220, radius: JkRadii.lg),
      error: (Object e, StackTrace s) => ErrorView(
        error: e,
        compact: true,
        onRetry: () => ref.invalidate(recommendedTravelersProvider(requestId)),
      ),
    );
  }
}

class _OfferForm extends ConsumerStatefulWidget {
  const _OfferForm({required this.requestId, this.initialTripId});

  final String requestId;
  final String? initialTripId;

  @override
  ConsumerState<_OfferForm> createState() => _OfferFormState();
}

class _OfferFormState extends ConsumerState<_OfferForm> {
  late String? _tripId = widget.initialTripId;
  final TextEditingController _fee = TextEditingController();
  final TextEditingController _message = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _fee.dispose();
    _message.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final tripId = _tripId;
    if (tripId == null) {
      setState(() => _error = context.l10n.offerChooseTrip);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final fee = int.tryParse(_fee.text.replaceAll(RegExp(r'[^0-9]'), ''));
      await ref.read(requestRepositoryProvider).sendOffer(
            requestId: widget.requestId,
            tripId: tripId,
            travelerFeeIdr: fee != null && fee > 0 ? fee : null,
            message: _message.text.trim(),
          );
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = errorMessage(context.l10n, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final locale = context.localeCode;
    final trips = ref.watch(myActiveTripsProvider);
    final error = _error;
    return trips.when(
      data: (List<Trip> list) {
        if (list.isEmpty) {
          return EmptyState(
            icon: Icons.flight_takeoff,
            title: l10n.offerNoActiveTrip,
            message: l10n.offerNoActiveTripBody,
            actionLabel: l10n.tripCreate,
            onAction: () {
              final router = GoRouter.of(context);
              Navigator.of(context).pop(false);
              router.push(Routes.newTrip);
            },
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            PickerField<String>(
              label: l10n.offerTrip,
              value: _tripId,
              options: <PickerOption<String>>[
                for (final t in list)
                  PickerOption<String>(
                    t.id,
                    routeLabel(t.originCity, t.destinationCity),
                    subtitle: JkDates.calendar(t.arrivalDate, locale),
                  ),
              ],
              onChanged: (String v) => setState(() => _tripId = v),
            ),
            const SizedBox(height: JkSpacing.s4),
            JkTextField(
              label: l10n.offerFeeLabel,
              controller: _fee,
              hint: l10n.offerFeeHint,
              prefixText: 'Rp ',
              keyboardType: TextInputType.number,
              inputFormatters: JkTextField.digitsOnly,
            ),
            const SizedBox(height: JkSpacing.s4),
            JkTextField(label: l10n.offerMessageLabel, controller: _message, maxLines: 3, minLines: 2, maxLength: 500),
            if (error != null) ...<Widget>[
              const SizedBox(height: JkSpacing.s2),
              NoticeBox(tone: NoticeTone.error, message: error),
            ],
            const SizedBox(height: JkSpacing.s4),
            JkButton(label: l10n.offerSend, loading: _busy, onPressed: _send),
          ],
        );
      },
      loading: () => const Padding(padding: EdgeInsets.all(JkSpacing.s6), child: Center(child: CircularProgressIndicator())),
      error: (Object e, StackTrace s) => ErrorView(error: e, onRetry: () => ref.invalidate(myActiveTripsProvider)),
    );
  }
}
