import 'package:flutter/material.dart';

import '../core/design/theme.dart';
import '../core/design/tokens.g.dart';
import '../core/domain/domain.dart';
import '../core/format/money.dart';
import '../core/l10n/l10n.dart';
import '../core/l10n/labels.dart';
import '../core/models/transaction.dart';
import 'countdown_chip.dart';
import 'money_text.dart';
import 'sheets_and_glass.dart';
import 'states.dart';

/// Transparent landed-cost breakdown (§5.5 ★). Opaque card, never glass. Lines are always shown
/// in the fixed domain order (§10) regardless of API order: goods & duties (1–4) · JastipKita
/// services (5–8) · reductions (9–10, only when non-zero) · total. Lines 1–8 are shown even at
/// Rp0 ("dibebaskan"): no fee is ever hidden.
class PriceBreakdownCard extends StatelessWidget {
  const PriceBreakdownCard({
    super.key,
    required this.lines,
    this.itemSubLabel,
    this.channelLabel,
    this.promoCode,
    this.loading = false,
    this.expired = false,
    this.onRefresh,
    this.compact = false,
    this.onExpand,
  });

  final List<PriceLine> lines;

  /// e.g. "1 × ¥88.000".
  final String? itemSubLabel;
  final String? channelLabel;
  final String? promoCode;
  final bool loading;

  /// Quote / FX lock expired: overlay + "Perbarui kurs"; the pay CTA must be disabled.
  final bool expired;
  final VoidCallback? onRefresh;

  /// Collapsed: total + "Rincian 11 baris ›".
  final bool compact;
  final VoidCallback? onExpand;

  static const Set<String> _groupGoods = <String>{
    PriceLineType.itemPrice,
    PriceLineType.travelerFee,
    PriceLineType.customsDuty,
    PriceLineType.importTax,
  };
  static const Set<String> _groupServices = <String>{
    PriceLineType.protectionFee,
    PriceLineType.platformFee,
    PriceLineType.serviceTax,
    PriceLineType.paymentFee,
  };

  /// Lines to render in domain order (reductions dropped when zero, total kept last).
  static List<PriceLine> visibleLines(List<PriceLine> lines) {
    final byType = <String, PriceLine>{for (final l in lines) l.type: l};
    final out = <PriceLine>[];
    for (final type in PriceLineType.order) {
      final line = byType[type];
      if (line == null) continue;
      if (PriceLineType.reductions.contains(type) && line.amountIdr == 0) continue;
      out.add(line);
    }
    if (byType[PriceLineType.total] == null) {
      var sum = 0;
      for (final l in out) {
        sum += PriceLineType.reductions.contains(l.type) ? -l.amountIdr.abs() : l.amountIdr;
      }
      out.add(PriceLine(type: PriceLineType.total, amountIdr: sum));
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final Widget body;
    if (loading) {
      body = Column(
        children: <Widget>[
          for (var i = 0; i < 11; i++)
            const Padding(padding: EdgeInsets.symmetric(vertical: 6), child: Skeleton(height: 18)),
        ],
      );
    } else if (compact) {
      body = _compact(context);
    } else {
      body = _full(context);
    }
    final card = DecoratedBox(
      decoration: BoxDecoration(
        color: jk.surface,
        borderRadius: JkRadii.lgAll,
        border: Border.all(color: jk.border),
        boxShadow: context.elevation(1),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(JkSpacing.s4, JkSpacing.s4, JkSpacing.s4, JkSpacing.s3),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Wrap(
              alignment: WrapAlignment.spaceBetween,
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: JkSpacing.s2,
              children: <Widget>[
                Semantics(
                  header: true,
                  child: Text(l10n.breakdownTitle, style: JkTypeScale.titleM.copyWith(color: jk.onSurface)),
                ),
                Text(l10n.breakdownAllFeesShown, style: JkTypeScale.labelM.copyWith(color: jk.onSurfaceMuted)),
              ],
            ),
            const SizedBox(height: JkSpacing.s2),
            body,
          ],
        ),
      ),
    );
    if (!expired) return card;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Semantics(
          liveRegion: true,
          child: DecoratedBox(
            decoration: BoxDecoration(color: jk.warningContainer, borderRadius: JkRadii.lgAll, border: Border.all(color: jk.warning)),
            child: Padding(
              padding: const EdgeInsets.all(JkSpacing.s3),
              child: Row(
                children: <Widget>[
                  Icon(Icons.update, color: jk.onWarningContainer),
                  const SizedBox(width: JkSpacing.s2),
                  Expanded(
                    child: Text(l10n.breakdownExpired, style: JkTypeScale.bodyM.copyWith(color: jk.onWarningContainer)),
                  ),
                  if (onRefresh != null) TextButton(onPressed: onRefresh, child: Text(l10n.breakdownRefreshRate)),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(height: JkSpacing.s2),
        Opacity(opacity: 0.55, child: card),
      ],
    );
  }

  Widget _compact(BuildContext context) {
    final l10n = context.l10n;
    final visible = visibleLines(lines);
    final total = visible.last;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _LineRow(line: total, label: Labels.priceLine(l10n, total.type, fallback: total.labelId), isTotal: true),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton.icon(
            onPressed: onExpand,
            icon: const Icon(Icons.chevron_right),
            label: Text(l10n.breakdownShowLines(visible.length)),
          ),
        ),
      ],
    );
  }

  Widget _full(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final visible = visibleLines(lines);
    final children = <Widget>[];
    String? previousGroup;
    for (final line in visible) {
      final group = _groupGoods.contains(line.type)
          ? 'goods'
          : _groupServices.contains(line.type)
              ? 'services'
              : PriceLineType.reductions.contains(line.type)
                  ? 'reductions'
                  : 'total';
      if (previousGroup != null && group != previousGroup) {
        if (group == 'total') {
          children.add(Padding(padding: const EdgeInsets.symmetric(vertical: JkSpacing.s2), child: _DashedDivider(color: jk.outline)));
        } else {
          children.add(const Padding(padding: EdgeInsets.symmetric(vertical: JkSpacing.s1), child: Divider()));
        }
      }
      previousGroup = group;
      children.add(
        _LineRow(
          line: line,
          label: Labels.priceLine(l10n, line.type, fallback: context.localeCode == 'en' ? line.labelEn : line.labelId),
          subLabel: _subLabel(l10n, line),
          isTotal: line.type == PriceLineType.total,
        ),
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children);
  }

  String? _subLabel(AppLocalizations l10n, PriceLine line) {
    final isReduction = PriceLineType.reductions.contains(line.type);
    if (line.amountIdr == 0 && !isReduction && line.type != PriceLineType.total) return l10n.priceLineWaived;
    switch (line.type) {
      case PriceLineType.itemPrice:
        return itemSubLabel;
      case PriceLineType.importTax:
        return l10n.priceLineImportTaxSub;
      case PriceLineType.paymentFee:
        return channelLabel;
      case PriceLineType.discount:
        return promoCode;
      default:
        return null;
    }
  }
}

class _LineRow extends StatelessWidget {
  const _LineRow({required this.line, required this.label, this.subLabel, this.isTotal = false});

  final PriceLine line;
  final String label;
  final String? subLabel;
  final bool isTotal;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final isReduction = PriceLineType.reductions.contains(line.type);
    final amount = isReduction ? -line.amountIdr.abs() : line.amountIdr;
    final stacked = MediaQuery.textScalerOf(context).scale(14) / 14 > 1.3;
    final sub = subLabel;
    final ruleRef = line.ruleRef;

    final labelParts = <Widget>[
      Text(
        label,
        style: isTotal
            ? JkTypeScale.titleS.copyWith(color: jk.onSurface)
            : JkTypeScale.bodyL.copyWith(color: jk.onSurface),
      ),
      if (sub != null && sub.isNotEmpty) Text(sub, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
      if (line.isEstimate) const EstimateBadge(),
      if (line.isEstimate || ruleRef != null)
        IconButton(
          iconSize: 18,
          tooltip: l10n.ruleInfoFor(label),
          icon: Icon(Icons.info_outline, color: jk.onSurfaceMuted),
          onPressed: () => _showRule(context, label, ruleRef, line.isEstimate),
        ),
    ];
    final labelWrap = Wrap(
      spacing: JkSpacing.s2,
      runSpacing: 2,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: labelParts,
    );
    final money = MoneyText(
      amount,
      size: isTotal ? MoneySize.l : MoneySize.s,
      emphasized: isTotal,
      color: isReduction ? jk.successText : jk.onSurface,
      semanticsPrefix: line.isEstimate ? l10n.estimateSemanticsPrefix(label) : label,
    );
    final Widget content = stacked
        ? Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[labelWrap, Align(alignment: Alignment.centerRight, child: money)],
          )
        : Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: <Widget>[
              Expanded(child: labelWrap),
              const SizedBox(width: JkSpacing.s3),
              money,
            ],
          );
    final highlighted = line.changed;
    return DecoratedBox(
      key: ValueKey<String>('price-line-${line.type}'),
      decoration: BoxDecoration(
        color: highlighted ? jk.warningContainer : null,
        borderRadius: JkRadii.smAll,
      ),
      child: Padding(
        padding: EdgeInsets.symmetric(vertical: isTotal ? JkSpacing.s2 : 5, horizontal: highlighted ? JkSpacing.s1 : 0),
        child: content,
      ),
    );
  }

  static void _showRule(BuildContext context, String label, String? ruleRef, bool estimate) {
    final l10n = context.l10n;
    showJkBottomSheet<void>(
      context,
      title: label,
      builder: (BuildContext sheetContext) {
        final jk = sheetContext.jk;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            if (ruleRef != null) ...<Widget>[
              Text(l10n.ruleSource, style: JkTypeScale.labelL.copyWith(color: jk.onSurfaceMuted)),
              const SizedBox(height: 4),
              SelectableText(ruleRef, style: JkTypeScale.bodyM.copyWith(color: jk.onSurface)),
              const SizedBox(height: JkSpacing.s4),
            ],
            Text(
              estimate ? l10n.ruleEstimateNote : l10n.ruleFixedNote,
              style: JkTypeScale.bodyM.copyWith(color: jk.onSurface),
            ),
          ],
        );
      },
    );
  }
}

class _DashedDivider extends StatelessWidget {
  const _DashedDivider({required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        const dash = 5.0;
        const gap = 4.0;
        final count = (constraints.maxWidth / (dash + gap)).floor();
        return Row(
          children: <Widget>[
            for (var i = 0; i < count; i++) ...<Widget>[
              SizedBox(width: dash, height: 1, child: ColoredBox(color: color)),
              if (i < count - 1) const SizedBox(width: gap),
            ],
          ],
        );
      },
    );
  }
}

/// "Kurs dikunci ¥1 = Rp108,42" + FX-lock countdown (sits above the breakdown card).
class FxLockRow extends StatelessWidget {
  const FxLockRow({super.key, required this.fx, this.lockedUntil, this.onExpired, this.onRenew, this.onFinalMinute});

  final FxLockInfo fx;
  final DateTime? lockedUntil;
  final VoidCallback? onExpired;
  final VoidCallback? onRenew;
  final VoidCallback? onFinalMinute;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final locale = context.localeCode;
    final base = Money.symbols[fx.base] ?? fx.base;
    final rateText = '${base}1 = ${Money.rate(fx.lockedRate, locale: locale)}';
    final until = lockedUntil ?? fx.expiresAt;
    return Wrap(
      alignment: WrapAlignment.spaceBetween,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: JkSpacing.s2,
      runSpacing: JkSpacing.s2,
      children: <Widget>[
        Text.rich(
          TextSpan(
            text: '${l10n.fxLocked} ',
            style: JkTypeScale.bodyM.copyWith(color: jk.onBackgroundMuted),
            children: <InlineSpan>[
              TextSpan(text: rateText, style: JkTypeScale.moneyS.copyWith(color: jk.onBackground, fontWeight: FontWeight.w600)),
            ],
          ),
        ),
        if (until != null)
          CountdownChip(
            expiresAt: until,
            label: l10n.fxCountdownLabel,
            onExpired: onExpired,
            onRenew: onRenew,
            onFinalMinute: onFinalMinute,
          ),
      ],
    );
  }
}
