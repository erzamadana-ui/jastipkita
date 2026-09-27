import 'package:flutter/material.dart';

import '../core/design/haptics.dart';
import '../core/design/theme.dart';
import '../core/design/tokens.g.dart';
import '../core/domain/domain.dart';
import '../core/l10n/l10n.dart';
import '../core/models/transaction.dart';
import 'countdown_chip.dart';
import 'jk_button.dart';

enum SafePayVariant { secured, approved, blocked, pending, closed }

/// SafePay status banner (§5.6 ★) — solid, opaque, cannot be dismissed, never glass.
///
/// Traveler: every status before PURCHASE_APPROVED is `blocked` (red DO NOT PURCHASE), including
/// PAYMENT_SECURED; only PURCHASE_APPROVED is `approved`. Buyer: AWAITING_PAYMENT is `pending`,
/// funds held by SafePay is `secured`.
class SafePayStatusBanner extends StatefulWidget {
  const SafePayStatusBanner({
    super.key,
    required this.variant,
    this.forTraveler = false,
    this.reason,
    this.approvedCeiling,
    this.expiresAt,
    this.haptics = false,
  });

  /// Banner for the traveler view of a transaction in [status].
  factory SafePayStatusBanner.forTraveler({
    Key? key,
    required String status,
    String? approvedCeiling,
    bool haptics = false,
  }) =>
      SafePayStatusBanner(
        key: key,
        variant: travelerVariant(status),
        forTraveler: true,
        approvedCeiling: approvedCeiling,
        haptics: haptics,
        reason: status,
      );

  final SafePayVariant variant;
  final bool forTraveler;

  /// For `blocked`: the transaction status, used to pick the specific reason.
  final String? reason;

  /// For `approved`: formatted maximum purchase price.
  final String? approvedCeiling;

  /// For `pending`: invoice expiry.
  final DateTime? expiresAt;
  final bool haptics;

  static SafePayVariant travelerVariant(String status) {
    if (TxStatus.travelerMayPurchase(status)) return SafePayVariant.approved;
    if (TxStatus.prePurchase.contains(status)) return SafePayVariant.blocked;
    if (TxStatus.isTerminal(status) || status == TxStatus.refundPending) return SafePayVariant.closed;
    return SafePayVariant.secured;
  }

  static SafePayVariant? buyerVariant(String status) {
    if (status == TxStatus.awaitingPayment) return SafePayVariant.pending;
    if (TxStatus.fundsSecured.contains(status)) return SafePayVariant.secured;
    return null;
  }

  @override
  State<SafePayStatusBanner> createState() => _SafePayStatusBannerState();
}

class _SafePayStatusBannerState extends State<SafePayStatusBanner> {
  @override
  void initState() {
    super.initState();
    _haptic();
  }

  @override
  void didUpdateWidget(covariant SafePayStatusBanner oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.variant != widget.variant) _haptic();
  }

  void _haptic() {
    if (widget.variant == SafePayVariant.blocked) JkHaptics.error(widget.haptics);
    if (widget.variant == SafePayVariant.approved) JkHaptics.success(widget.haptics);
  }

  String _blockedReason(AppLocalizations l10n) {
    switch (widget.reason) {
      case TxStatus.paymentSecured:
        return l10n.safepayBlockedConfirmPrice;
      case TxStatus.priceChangePending:
        return l10n.safepayBlockedAwaitingBuyer;
      default:
        return l10n.safepayBlockedNotPaid;
    }
  }

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final ceiling = widget.approvedCeiling;
    final (Color bg, Color fg, IconData icon, String overline, String title, String body, String? rule) =
        switch (widget.variant) {
      SafePayVariant.blocked => (
          jk.safepayBlocked,
          jk.onSafepayBlocked,
          Icons.dangerous_outlined,
          l10n.safepayBlockedOverline,
          l10n.safepayBlockedTitle,
          _blockedReason(l10n),
          l10n.safepayBlockedRule,
        ),
      SafePayVariant.approved => (
          jk.safepaySecured,
          jk.onSafepaySecured,
          Icons.verified_user_outlined,
          l10n.safepayApprovedOverline,
          l10n.safepayApprovedTitle,
          ceiling == null ? l10n.safepayApprovedBody : l10n.safepayApprovedBodyWithMax(ceiling),
          null,
        ),
      SafePayVariant.secured => (
          jk.safepaySecured,
          jk.onSafepaySecured,
          Icons.shield_outlined,
          l10n.safepaySecuredOverline,
          l10n.safepaySecuredTitle,
          widget.forTraveler ? l10n.safepaySecuredBodyTraveler : l10n.safepaySecuredBody,
          null,
        ),
      SafePayVariant.pending => (
          jk.safepayPending,
          jk.onSafepayPending,
          Icons.schedule,
          l10n.safepayPendingOverline,
          l10n.safepayPendingTitle,
          l10n.safepayPendingBody,
          null,
        ),
      SafePayVariant.closed => (
          jk.surfaceMuted,
          jk.onSurface,
          Icons.block,
          l10n.safepayClosedOverline,
          l10n.safepayClosedTitle,
          widget.forTraveler ? l10n.safepayClosedBodyTraveler : l10n.safepayClosedBody,
          null,
        ),
    };
    final expires = widget.expiresAt;
    final ruleText = rule;
    final isAlert = widget.variant == SafePayVariant.blocked;
    return Semantics(
      container: true,
      liveRegion: isAlert,
      label: '$overline. $title. $body${ruleText == null ? '' : ' $ruleText'}',
      excludeSemantics: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: bg,
          borderRadius: JkRadii.lgAll,
          border: widget.variant == SafePayVariant.closed ? Border.all(color: jk.outline) : null,
        ),
        child: Padding(
          padding: const EdgeInsets.all(JkSpacing.s4),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              DecoratedBox(
                decoration: BoxDecoration(color: fg.withValues(alpha: 0.16), borderRadius: JkRadii.mdAll),
                child: Padding(padding: const EdgeInsets.all(JkSpacing.s2), child: Icon(icon, color: fg, size: 28)),
              ),
              const SizedBox(width: JkSpacing.s3),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(overline, style: JkTypeScale.labelM.copyWith(color: fg, letterSpacing: 1.6, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 2),
                    Text(title, style: JkTypeScale.titleL.copyWith(color: fg, fontWeight: FontWeight.w700)),
                    const SizedBox(height: JkSpacing.s1),
                    Text(body, style: JkTypeScale.bodyM.copyWith(color: fg)),
                    if (expires != null && widget.variant == SafePayVariant.pending) ...<Widget>[
                      const SizedBox(height: JkSpacing.s2),
                      CountdownChip(expiresAt: expires, label: l10n.invoiceCountdownLabel, icon: Icons.schedule),
                    ],
                    if (ruleText != null) ...<Widget>[
                      const SizedBox(height: JkSpacing.s3),
                      Divider(color: fg.withValues(alpha: 0.3), height: 1),
                      const SizedBox(height: JkSpacing.s3),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Icon(Icons.lock_outline, color: fg, size: 18),
                          const SizedBox(width: JkSpacing.s2),
                          Expanded(
                            child: Text(ruleText, style: JkTypeScale.labelM.copyWith(color: fg, fontWeight: FontWeight.w600)),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Traveler's purchase action. Enabled ONLY in PURCHASE_APPROVED (golden rule) and only when the
/// server gate agrees; otherwise disabled with the reason underneath.
class PurchaseGateButton extends StatelessWidget {
  const PurchaseGateButton({super.key, required this.status, required this.onUploadProof, this.gate});

  final String status;
  final PurchaseGate? gate;
  final VoidCallback onUploadProof;

  static bool allowed(String status, PurchaseGate? gate) =>
      TxStatus.travelerMayPurchase(status) && (gate == null || gate.canPurchase);

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final ok = allowed(status, gate);
    return JkButton(
      label: l10n.uploadPurchaseProof,
      icon: ok ? Icons.receipt_long_outlined : Icons.lock_outline,
      onPressed: ok ? onUploadProof : null,
      disabledReason: ok ? null : l10n.purchaseGateDisabledReason,
    );
  }
}
