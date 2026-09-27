import 'package:flutter/material.dart';

import '../core/design/theme.dart';
import '../core/design/tokens.g.dart';
import '../core/domain/domain.dart';
import '../core/format/dates.dart';
import '../core/format/money.dart';
import '../core/l10n/l10n.dart';
import '../core/l10n/labels.dart';
import '../core/models/marketplace.dart';
import '../core/models/transaction.dart';
import 'badges.dart';
import 'common.dart';
import 'countdown_chip.dart';
import 'jk_button.dart';
import 'money_text.dart';
import 'restricted_item_warning.dart';
import 'status_timeline.dart';

JkTone _tripTone(BuildContext context, String status) {
  final jk = context.jk;
  switch (status) {
    case TripStatus.active:
    case TripStatus.verified:
      return jk.status['secured']!;
    case TripStatus.verificationPending:
    case TripStatus.draft:
      return jk.status['actionRequired']!;
    case TripStatus.full:
    case TripStatus.traveling:
      return jk.status['inTransit']!;
    case TripStatus.completed:
      return jk.status['completed']!;
    default:
      return jk.status['closed']!;
  }
}

/// Plain-text route for pickers and chips ("Tokyo – Jakarta"; Poppins has no arrow glyph).
String routeLabel(String from, String to) => '$from \u2013 $to';

/// "Tokyo (JP) ➜ Jakarta (ID)" with an arrow icon (the brand font has no arrow glyph).
class RouteText extends StatelessWidget {
  const RouteText({super.key, required this.from, required this.to, this.suffix, this.style, this.maxLines, this.upperCase = false});

  /// Route of a transaction's trip (`TransactionDetail.trip`).
  factory RouteText.trip(TripRoute trip, {Key? key, String? suffix, TextStyle? style, bool upperCase = false}) => RouteText(
        key: key,
        from: '${trip.originCity} (${trip.originCountry})',
        to: '${trip.destinationCity} (${trip.destinationCountry})',
        suffix: suffix,
        style: style,
        upperCase: upperCase,
      );

  final String from;
  final String to;

  /// Appended after the destination, e.g. " · 13 Okt".
  final String? suffix;
  final TextStyle? style;
  final int? maxLines;
  final bool upperCase;

  @override
  Widget build(BuildContext context) {
    final effective = DefaultTextStyle.of(context).style.merge(style);
    String cased(String s) => upperCase ? s.toUpperCase() : s;
    final tail = suffix;
    return Text.rich(
      TextSpan(
        children: <InlineSpan>[
          TextSpan(text: cased(from)),
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Icon(Icons.arrow_forward_rounded, size: (effective.fontSize ?? 14) * 1.05, color: effective.color),
            ),
          ),
          TextSpan(text: cased(to)),
          if (tail != null) TextSpan(text: tail),
        ],
      ),
      style: style,
      maxLines: maxLines,
      overflow: maxLines == null ? null : TextOverflow.ellipsis,
      semanticsLabel: '${context.l10n.routeSemantics(from, to)}${tail ?? ''}',
    );
  }
}

/// Trip card (§5.11): route, dates, verified badge, remaining capacity, status, fee, CTA.
class TripCard extends StatelessWidget {
  const TripCard({super.key, required this.trip, this.onTap, this.ctaLabel, this.onCta});

  final Trip trip;
  final VoidCallback? onTap;
  final String? ctaLabel;
  final VoidCallback? onCta;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final locale = context.localeCode;
    final used = trip.usedRatio;
    final cta = ctaLabel;
    final isFull = trip.status == TripStatus.full;
    return JkCard(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(Icons.flight_takeoff, color: jk.secondary),
              const SizedBox(width: JkSpacing.s2),
              Expanded(
                child: RouteText(
                  from: '${trip.originCity} (${trip.originCountry})',
                  to: '${trip.destinationCity} (${trip.destinationCountry})',
                  style: JkTypeScale.titleS.copyWith(color: jk.onSurface),
                ),
              ),
            ],
          ),
          const SizedBox(height: JkSpacing.s1),
          Text(
            l10n.tripDates(JkDates.calendarShort(trip.departureDate, locale), JkDates.calendarShort(trip.arrivalDate, locale)),
            style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted),
          ),
          const SizedBox(height: JkSpacing.s2),
          Wrap(
            spacing: JkSpacing.s2,
            runSpacing: JkSpacing.s2,
            children: <Widget>[
              StatusChip(label: Labels.tripStatus(l10n, trip.status), tone: _tripTone(context, trip.status)),
              if (trip.verified)
                StatusChip(label: l10n.tripVerifiedBadge, tone: jk.status['secured']!, icon: Icons.verified_outlined),
              if (trip.fee.label.isNotEmpty) StatusChip(label: trip.fee.label, tone: jk.status['open']!, icon: Icons.sell_outlined),
            ],
          ),
          const SizedBox(height: JkSpacing.s3),
          Text(
            l10n.tripCapacityRemaining(trip.remainingKg.toStringAsFixed(1)),
            style: JkTypeScale.labelM.copyWith(color: jk.onSurface),
          ),
          if (used != null) ...<Widget>[
            const SizedBox(height: 6),
            Semantics(
              label: l10n.tripCapacityUsedSemantics((used * 100).round()),
              excludeSemantics: true,
              child: ClipRRect(
                borderRadius: JkRadii.pillAll,
                child: LinearProgressIndicator(value: used, minHeight: 6, backgroundColor: jk.surfaceMuted, color: jk.secondary),
              ),
            ),
          ],
          if (cta != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s3),
            JkButton(
              label: cta,
              variant: JkButtonVariant.tonal,
              onPressed: isFull ? null : onCta,
              disabledReason: isFull ? l10n.tripFullReason : null,
            ),
          ],
        ],
      ),
    );
  }
}

/// Request card (§5.12): thumbnail, name, merchant, original price, status, offers, restriction.
class RequestCard extends StatelessWidget {
  const RequestCard({super.key, required this.request, this.onTap, this.trailing});

  final RequestItem request;
  final VoidCallback? onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final locale = context.localeCode;
    final price = request.unitPriceMinor;
    final currency = request.priceCurrency;
    final domain = request.merchantDomain ?? request.merchantName;
    final cls = request.restrictionClass;
    final extra = trailing;
    return JkCard(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              ProductThumb(imageUrl: request.imageUrl),
              const SizedBox(width: JkSpacing.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      request.productName,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: JkTypeScale.titleS.copyWith(color: jk.onSurface),
                    ),
                    if (domain != null)
                      Text(domain, maxLines: 1, overflow: TextOverflow.ellipsis, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                    const SizedBox(height: JkSpacing.s1),
                    Wrap(
                      spacing: JkSpacing.s2,
                      runSpacing: JkSpacing.s1,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: <Widget>[
                        if (price != null && currency != null)
                          Text(
                            '${request.quantity} × ${Money.minor(price, currency, locale: locale)}',
                            style: JkTypeScale.moneyS.copyWith(color: jk.onSurface),
                          ),
                        if (request.merchantCountry != null)
                          Text(
                            '${PopularOrigins.flag(request.merchantCountry!)} ${request.merchantCountry}',
                            style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: JkSpacing.s3),
          Wrap(
            spacing: JkSpacing.s2,
            runSpacing: JkSpacing.s2,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: <Widget>[
              StatusChip(label: Labels.requestStatus(l10n, request.status), tone: _requestTone(context, request.status)),
              if (request.pendingOffers > 0)
                StatusChip(label: l10n.requestOffersCount(request.pendingOffers), tone: jk.status['actionRequired']!, icon: Icons.local_offer_outlined),
              if (cls != null && cls != Restriction.allowed) RestrictedItemWarning(classification: cls, compact: true),
              if (request.neededBy != null)
                Text(l10n.requestNeededBy(JkDates.calendarShort(request.neededBy!, locale)), style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
            ],
          ),
          if (extra != null) ...<Widget>[const SizedBox(height: JkSpacing.s3), extra],
        ],
      ),
    );
  }

  static JkTone _requestTone(BuildContext context, String status) {
    final jk = context.jk;
    switch (status) {
      case RequestStatus.open:
        return jk.status['open']!;
      case RequestStatus.matched:
        return jk.status['secured']!;
      case RequestStatus.draft:
        return jk.status['actionRequired']!;
      default:
        return jk.status['closed']!;
    }
  }
}

/// Active transaction card with the 5-segment progress (buyer home, lists).
class TransactionCard extends StatelessWidget {
  const TransactionCard({super.key, required this.transaction, this.onTap});

  final TransactionSummary transaction;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final tx = transaction;
    final total = tx.totalIdr;
    final gate = tx.purchaseGate;
    final showDoNotPurchase = !tx.isBuyer && TxStatus.prePurchase.contains(tx.status);
    return JkCard(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              ProductThumb(imageUrl: tx.imageUrl),
              const SizedBox(width: JkSpacing.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      tx.productName ?? tx.number,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: JkTypeScale.titleS.copyWith(color: jk.onSurface),
                    ),
                    if (tx.counterpartyName != null)
                      Text(
                        tx.isBuyer ? l10n.checkoutTraveler(tx.counterpartyName!) : l10n.requestBuyer(tx.counterpartyName!),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted),
                      ),
                    const SizedBox(height: 4),
                    StatusChip(label: Labels.txStatus(l10n, tx.status), tone: jk.statusTone(tx.status)),
                  ],
                ),
              ),
            ],
          ),
          if (showDoNotPurchase) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            _MiniGate(blocked: gate == null || !gate.canPurchase),
          ] else if (!tx.isBuyer && TxStatus.travelerMayPurchase(tx.status)) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            const _MiniGate(blocked: false),
          ],
          const SizedBox(height: JkSpacing.s3),
          CompactProgress(status: tx.status),
          const Divider(height: JkSpacing.s6),
          if (total == null)
            Text(tx.number, style: JkTypeScale.labelM.copyWith(color: jk.onSurfaceMuted))
          else
            LabeledAmount(
              label: Text(tx.number, style: JkTypeScale.labelM.copyWith(color: jk.onSurfaceMuted)),
              amount: MoneyText(total, semanticsPrefix: l10n.totalLabel),
            ),
        ],
      ),
    );
  }
}

/// Small solid SafePay strip for list rows (traveler: red "Jangan beli" / green "Boleh beli").
class _MiniGate extends StatelessWidget {
  const _MiniGate({required this.blocked});

  final bool blocked;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final bg = blocked ? jk.safepayBlocked : jk.safepaySecured;
    final fg = blocked ? jk.onSafepayBlocked : jk.onSafepaySecured;
    return DecoratedBox(
      decoration: BoxDecoration(color: bg, borderRadius: JkRadii.smAll),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: JkSpacing.s2, vertical: 6),
        child: Row(
          children: <Widget>[
            Icon(blocked ? Icons.dangerous_outlined : Icons.verified_user_outlined, color: fg, size: 18),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                blocked ? l10n.miniGateBlocked : l10n.miniGateApproved,
                style: JkTypeScale.labelM.copyWith(color: fg, fontWeight: FontWeight.w700),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Offer card (§5.13). Cheaper-but-low-trust offers are not highlighted as "best".
class OfferCard extends StatelessWidget {
  const OfferCard({super.key, required this.offer, this.onAccept, this.onDecline, this.accepting = false});

  final Offer offer;
  final VoidCallback? onAccept;
  final VoidCallback? onDecline;
  final bool accepting;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final locale = context.localeCode;
    final traveler = offer.traveler;
    final trip = offer.trip;
    final level = traveler?.kycLevel;
    final message = offer.message;
    final expires = offer.expiresAt;
    final rating = traveler?.ratingAverage;
    return JkCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              InitialsAvatar(name: traveler?.displayName ?? '?', verified: traveler?.identityVerified ?? false),
              const SizedBox(width: JkSpacing.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(traveler?.displayName ?? '', style: JkTypeScale.titleS.copyWith(color: jk.onSurface)),
                    if (trip != null)
                      RouteText(
                        from: trip.originCity,
                        to: trip.destinationCity,
                        suffix: ' · ${JkDates.calendarShort(trip.arrivalDate, locale)}',
                        style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted),
                      ),
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
              if (traveler?.trustScore != null) TrustScoreBadge(score: traveler!.trustScore!, tier: traveler.trustTier),
              if (level != null) KycLevelBadge(level: level),
              if (rating != null)
                StatusChip(
                  label: l10n.ratingShort(rating.toStringAsFixed(1), traveler?.ratingCount ?? 0),
                  tone: jk.status['open']!,
                  icon: Icons.star_rounded,
                ),
              if (trip?.verified ?? false) StatusChip(label: l10n.tripVerifiedBadge, tone: jk.status['secured']!, icon: Icons.verified_outlined),
            ],
          ),
          const SizedBox(height: JkSpacing.s3),
          LabeledAmount(
            label: Text(l10n.offerTravelerFee, style: JkTypeScale.bodyM.copyWith(color: jk.onSurfaceMuted)),
            amount: MoneyText(offer.travelerFeeIdr, size: MoneySize.m, semanticsPrefix: l10n.offerTravelerFee),
          ),
          if (message != null && message.isNotEmpty) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            Text('“$message”', style: JkTypeScale.bodyM.copyWith(color: jk.onSurface, fontStyle: FontStyle.italic)),
          ],
          if (expires != null && offer.status == 'PENDING') ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            CountdownChip(expiresAt: expires, label: l10n.offerExpiresIn, icon: Icons.schedule),
          ],
          if (offer.status != 'PENDING') ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            StatusChip(label: Labels.offerStatus(l10n, offer.status), tone: jk.status['closed']!),
          ],
          if (offer.canAccept || offer.canDecline) ...<Widget>[
            const SizedBox(height: JkSpacing.s3),
            if (offer.canAccept)
              JkButton(label: l10n.offerAccept, loading: accepting, onPressed: onAccept, icon: Icons.handshake_outlined),
            if (offer.canDecline)
              JkButton(label: l10n.offerDecline, variant: JkButtonVariant.tertiary, onPressed: accepting ? null : onDecline),
          ],
        ],
      ),
    );
  }
}

/// Traveler card (§5.14) for recommendations: avatar, name, route/date, rating, badges,
/// capacity, fee and the Indonesian matching reasons ("Rute persis · tiba 12 Okt · Trust 92").
class TravelerCard extends StatelessWidget {
  const TravelerCard({
    super.key,
    required this.recommendation,
    this.onTap,
    this.actionLabel,
    this.onAction,
    this.width,
    this.busy = false,
  });

  final RecommendedTrip recommendation;
  final VoidCallback? onTap;
  final String? actionLabel;
  final VoidCallback? onAction;
  final double? width;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final locale = context.localeCode;
    final trip = recommendation.trip;
    final traveler = trip.traveler;
    final level = traveler?.kycLevel;
    final rating = traveler?.ratingAverage;
    final action = actionLabel;
    final card = JkCard(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
            children: <Widget>[
              InitialsAvatar(name: traveler?.displayName ?? '?', size: 48, verified: traveler?.identityVerified ?? false),
              const SizedBox(width: JkSpacing.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      traveler?.displayName ?? '',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: JkTypeScale.titleS.copyWith(color: jk.onSurface),
                    ),
                    RouteText(
                      from: trip.originCity,
                      to: trip.destinationCity,
                      suffix: ' · ${JkDates.calendarShort(trip.arrivalDate, locale)}',
                      maxLines: 2,
                      style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: JkSpacing.s3),
          Wrap(
            spacing: JkSpacing.s2,
            runSpacing: JkSpacing.s2,
            children: <Widget>[
              if (traveler?.trustScore != null) TrustScoreBadge(score: traveler!.trustScore!, tier: traveler.trustTier),
              if (level != null) KycLevelBadge(level: level, full: level >= 5),
              if (trip.verified) StatusChip(label: l10n.tripVerifiedBadge, tone: jk.status['secured']!, icon: Icons.verified_outlined),
              if (rating != null)
                StatusChip(
                  label: l10n.ratingShort(rating.toStringAsFixed(1), traveler?.ratingCount ?? 0),
                  tone: jk.status['open']!,
                  icon: Icons.star_rounded,
                ),
            ],
          ),
          const SizedBox(height: JkSpacing.s3),
          Text(
            l10n.tripCapacityRemaining(trip.remainingKg.toStringAsFixed(1)),
            style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted),
          ),
          if (recommendation.estimatedTravelerFeeIdr > 0)
            LabeledAmount(
              label: Text(l10n.estimatedTravelerFee, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
              amount: MoneyText(recommendation.estimatedTravelerFeeIdr, semanticsPrefix: l10n.estimatedTravelerFee),
            )
          else if (trip.fee.label.isNotEmpty)
            Text(trip.fee.label, style: JkTypeScale.bodyS.copyWith(color: jk.onSurface)),
          if (recommendation.reasons.isNotEmpty) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            Text(
              recommendation.reasons.join(' · '),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: JkTypeScale.labelM.copyWith(color: jk.infoText),
            ),
          ],
          if (action != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s3),
            JkButton(label: action, variant: JkButtonVariant.tonal, loading: busy, onPressed: onAction),
          ],
        ],
      ),
    );
    final w = width;
    return w == null ? card : SizedBox(width: w, child: card);
  }
}
