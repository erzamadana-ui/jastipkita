import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/config/app_config.dart';
import '../../../core/design/haptics.dart';
import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/format/money.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/transaction.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/router/deep_links.dart';
import '../../../core/storage/settings.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../../widgets/money_text.dart';
import '../../../widgets/price_breakdown_card.dart';
import '../../../widgets/restricted_item_warning.dart';
import '../../../widgets/sheets_and_glass.dart';
import '../../../widgets/states.dart';
import '../../auth/application/session_controller.dart';
import '../../catalog/data/catalog_repository.dart';
import '../../engagement/data/engagement_repository.dart';
import '../../kyc/presentation/phone_verification.dart';
import '../data/transaction_repository.dart';
import 'transaction_detail_screen.dart';

/// Checkout with the transparent breakdown (§6.5 ★): FX rate + "kurs dikunci" countdown, the
/// 11-line PriceBreakdownCard, restricted acknowledgement, payment channel (fee shown), promo,
/// JastipKita Credit, then SafePay checkout with an Idempotency-Key and the provider page.
class CheckoutScreen extends ConsumerStatefulWidget {
  const CheckoutScreen({super.key, required this.transactionId});

  final String transactionId;

  @override
  ConsumerState<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends ConsumerState<CheckoutScreen> {
  Quote? _quote;
  bool _quoting = false;
  Object? _quoteError;
  bool _expired = false;
  String _channel = PaymentChannel.va;
  String? _promo;
  bool _useCredit = false;
  bool _ack = false;
  bool _paying = false;
  final TextEditingController _promoController = TextEditingController();
  String? _promoMessage;
  bool _promoBusy = false;

  @override
  void initState() {
    super.initState();
    trackEvent(ref, 'checkout_started', <String, Object?>{'transactionId': widget.transactionId});
    WidgetsBinding.instance.addPostFrameCallback((Duration _) => _requote());
  }

  @override
  void dispose() {
    _promoController.dispose();
    super.dispose();
  }

  Future<void> _requote() async {
    if (!mounted) return;
    setState(() {
      _quoting = true;
      _quoteError = null;
    });
    try {
      final quote = await ref.read(transactionRepositoryProvider).quote(
            widget.transactionId,
            channel: _channel,
            promoCode: _promo,
            useCredit: _useCredit,
          );
      if (!mounted) return;
      setState(() {
        _quote = quote;
        _expired = !quote.isUsable(DateTime.now().toUtc());
        _ack = false;
      });
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _quoteError = e);
    } finally {
      if (mounted) setState(() => _quoting = false);
    }
  }

  Future<void> _applyPromo() async {
    final code = _promoController.text.trim().toUpperCase();
    if (code.isEmpty) return;
    setState(() {
      _promoBusy = true;
      _promoMessage = null;
    });
    try {
      final result = await ref.read(transactionRepositoryProvider).validatePromo(widget.transactionId, code);
      if (!mounted) return;
      setState(() {
        _promoMessage = result.message;
        if (result.valid) _promo = code;
      });
      if (result.valid) await _requote();
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _promoMessage = errorMessage(context.l10n, e));
    } finally {
      if (mounted) setState(() => _promoBusy = false);
    }
  }

  Future<void> _pickChannel() async {
    final l10n = context.l10n;
    final current = _quote?.line(PriceLineType.paymentFee)?.amountIdr;
    final picked = await showJkBottomSheet<String>(
      context,
      title: l10n.channelTitle,
      builder: (BuildContext sheetContext) {
        final locale = sheetContext.localeCode;
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            for (final c in PaymentChannel.all)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(_channelIcon(c)),
                title: Text(Labels.paymentChannel(l10n, c)),
                subtitle: Text(
                  c == _channel && current != null ? l10n.channelFee(Money.idr(current, locale: locale)) : l10n.channelFeeOnSelect,
                ),
                trailing: c == _channel ? Icon(Icons.check_circle, color: sheetContext.jk.secondary) : null,
                selected: c == _channel,
                onTap: () => Navigator.of(sheetContext).pop(c),
              ),
            const SizedBox(height: JkSpacing.s2),
            Text(l10n.channelNote, style: JkTypeScale.bodyS.copyWith(color: sheetContext.jk.onSurfaceMuted)),
          ],
        );
      },
    );
    if (picked == null || picked == _channel || !mounted) return;
    JkHaptics.selection(ref.read(settingsProvider).haptics);
    setState(() => _channel = picked);
    await _requote();
  }

  static IconData _channelIcon(String channel) => switch (channel) {
        PaymentChannel.qris => Icons.qr_code_2,
        PaymentChannel.ewallet => Icons.account_balance_wallet_outlined,
        PaymentChannel.card => Icons.credit_card,
        _ => Icons.account_balance_outlined,
      };

  Future<void> _pay(Quote quote) async {
    final l10n = context.l10n;
    setState(() => _paying = true);
    try {
      final result = await ref.read(transactionRepositoryProvider).checkout(
            widget.transactionId,
            quoteId: quote.quoteId,
            channel: _channel,
            acknowledgeRestricted: _ack,
          );
      ref.invalidate(transactionDetailProvider(widget.transactionId));
      final url = result.checkoutUrl;
      if (url != null && url.isNotEmpty) {
        await launchUrl(Uri.parse(AppConfig.rewriteLoopbackUrl(url)), mode: LaunchMode.externalApplication);
      }
      if (!mounted) return;
      context.pushReplacement(Routes.payment(widget.transactionId));
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(l10n, e), error: true);
      final stale = e is ApiException && (e.code.startsWith('QUOTE_') || e.code.startsWith('FX_'));
      if (stale) await _requote();
    } finally {
      if (mounted) setState(() => _paying = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final locale = context.localeCode;
    final quote = _quote;
    final detail = ref.watch(transactionDetailProvider(widget.transactionId)).valueOrNull;
    final profile = ref.watch(currentProfileProvider);
    final kycOk = (profile?.kycLevel ?? 1) >= KycLevel.phoneVerified;
    final catalog = ref.watch(catalogProvider).valueOrNull;
    final restricted = quote?.restrictedClassification;
    final needsAck = quote?.restrictedRequiresAck ?? false;
    final prohibited = Restriction.blocksCheckout(restricted);
    final fx = quote?.fx;
    final quoteError = _quoteError;
    final unit = quote?.itemUnitPriceMinor;
    final currency = quote?.itemCurrency;
    final itemSub = unit != null && currency != null
        ? '${quote?.itemQuantity ?? 1} × ${Money.minor(unit, currency, locale: locale, minorUnits: catalog?.minorUnits(currency))}'
        : null;
    final canPay = quote != null && !_expired && !_quoting && kycOk && !prohibited && (!needsAck || _ack);
    final String? disabledReason = quote == null
        ? null
        : _expired
            ? l10n.checkoutExpiredReason
            : !kycOk
                ? l10n.checkoutKycReason
                : prohibited
                    ? l10n.restrictionProhibitedTitle
                    : (needsAck && !_ack ? l10n.checkoutAckReason : null);

    return Scaffold(
      appBar: AppBar(
        title: FittedBox(
          fit: BoxFit.scaleDown,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: context.isCupertino ? CrossAxisAlignment.center : CrossAxisAlignment.start,
            children: <Widget>[
              Text(l10n.checkoutTitle),
              Text(l10n.checkoutStep, style: JkTypeScale.labelM.copyWith(color: jk.onSurfaceMuted)),
            ],
          ),
        ),
      ),
      body: quoteError != null && quote == null
          ? ListView(children: <Widget>[ErrorView(error: quoteError, onRetry: _requote)])
          : ListView(
              padding: const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s8),
              children: <Widget>[
                JkCard(
                  child: Row(
                    children: <Widget>[
                      const ProductThumb(icon: Icons.work_outline),
                      const SizedBox(width: JkSpacing.s3),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(detail?.item?.productName ?? '', style: JkTypeScale.titleS.copyWith(color: jk.onSurface)),
                            if (detail?.traveler != null)
                              Text(
                                l10n.checkoutTraveler(detail!.traveler!.displayName),
                                style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted),
                              ),
                          ],
                        ),
                      ),
                      if (itemSub != null) Text(itemSub, style: JkTypeScale.moneyS.copyWith(color: jk.onSurface)),
                    ],
                  ),
                ),
                const SizedBox(height: JkSpacing.s4),
                if (fx != null) ...<Widget>[
                  FxLockRow(
                    fx: fx,
                    lockedUntil: quote?.lockedUntil,
                    onExpired: () => setState(() => _expired = true),
                    onRenew: _requote,
                    onFinalMinute: () => JkHaptics.warning(ref.read(settingsProvider).haptics),
                  ),
                  const SizedBox(height: JkSpacing.s3),
                ],
                PriceBreakdownCard(
                  lines: quote?.lines ?? const <PriceLine>[],
                  loading: quote == null,
                  expired: _expired,
                  onRefresh: _requote,
                  itemSubLabel: itemSub,
                  channelLabel: Labels.paymentChannel(l10n, quote?.paymentChannel ?? _channel),
                  promoCode: _promo,
                ),
                if (quote?.customsDisclaimer != null) ...<Widget>[
                  const SizedBox(height: JkSpacing.s2),
                  Text(quote!.customsDisclaimer!, style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted)),
                ],
                if (restricted != null && restricted != Restriction.allowed) ...<Widget>[
                  const SizedBox(height: JkSpacing.s4),
                  RestrictedItemWarning(
                    classification: restricted,
                    acknowledged: _ack,
                    onAcknowledgedChanged: needsAck ? (bool v) => setState(() => _ack = v) : null,
                  ),
                ],
                SectionHeader(title: l10n.channelTitle),
                JkCard(
                  onTap: _quoting || _paying ? null : _pickChannel,
                  child: Row(
                    children: <Widget>[
                      Icon(_channelIcon(_channel), color: jk.secondary),
                      const SizedBox(width: JkSpacing.s3),
                      Expanded(child: Text(Labels.paymentChannel(l10n, _channel), style: JkTypeScale.bodyL.copyWith(color: jk.onSurface))),
                      Text(l10n.actionChange, style: JkTypeScale.labelL.copyWith(color: jk.link)),
                      const Icon(Icons.chevron_right),
                    ],
                  ),
                ),
                SectionHeader(title: l10n.promoTitle),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Expanded(
                      child: JkTextField(
                        label: l10n.promoLabel,
                        controller: _promoController,
                        textCapitalization: TextCapitalization.characters,
                        helper: _promoMessage,
                      ),
                    ),
                    const SizedBox(width: JkSpacing.s2),
                    Padding(
                      padding: const EdgeInsets.only(top: 26),
                      child: JkButton(
                        label: l10n.promoApply,
                        expand: false,
                        variant: JkButtonVariant.secondary,
                        loading: _promoBusy,
                        onPressed: _quoting ? null : _applyPromo,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: JkSpacing.s3),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _useCredit,
                  onChanged: _quoting
                      ? null
                      : (bool v) {
                          setState(() => _useCredit = v);
                          _requote();
                        },
                  title: Text(l10n.creditUse),
                  subtitle: Text(
                    quote == null
                        ? l10n.creditNotWithdrawable
                        : l10n.creditAvailable(Money.idr(quote.creditAvailableIdr, locale: locale)),
                  ),
                ),
                if (!kycOk) ...<Widget>[
                  const SizedBox(height: JkSpacing.s3),
                  NoticeBox(tone: NoticeTone.warning, title: l10n.checkoutKycTitle, message: l10n.checkoutKycBody),
                  const SizedBox(height: JkSpacing.s2),
                  JkButton(
                    label: l10n.verifyPhone,
                    variant: JkButtonVariant.tonal,
                    onPressed: () => startPhoneVerification(context, ref),
                  ),
                ],
                const SizedBox(height: JkSpacing.s4),
                NoticeBox(tone: NoticeTone.success, icon: Icons.shield_outlined, message: l10n.checkoutSafepayNote),
              ],
            ),
      bottomNavigationBar: quote == null
          ? null
          : OpaqueActionBar(
              children: <Widget>[
                LabeledAmount(
                  label: Text(l10n.totalToPay, style: JkTypeScale.bodyM.copyWith(color: jk.onSurfaceMuted)),
                  amount: MoneyText(quote.totalIdr, size: MoneySize.l, emphasized: true, semanticsPrefix: l10n.totalToPay),
                ),
                const SizedBox(height: JkSpacing.s2),
                JkButton(
                  label: l10n.payWithSafepay(Money.idr(quote.totalIdr, locale: locale)),
                  icon: Icons.shield_outlined,
                  loading: _paying,
                  onPressed: canPay && !_paying ? () => _pay(quote) : null,
                  disabledReason: disabledReason,
                ),
              ],
            ),
    );
  }
}
