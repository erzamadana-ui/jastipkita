import 'package:flutter/material.dart';

import '../core/design/theme.dart';
import '../core/design/tokens.g.dart';
import '../core/format/money.dart';
import '../core/l10n/l10n.dart';

enum MoneySize { s, m, l }

/// Money display (§5.4): integer minor units → `Rp1.250.000` with tabular figures. Screen
/// readers hear the full sentence ("sebelas juta … rupiah"), never a spelled-out string.
class MoneyText extends StatelessWidget {
  const MoneyText(
    this.amount, {
    super.key,
    this.currency = 'IDR',
    this.size = MoneySize.s,
    this.color,
    this.emphasized = false,
    this.minorUnits,
    this.semanticsPrefix,
    this.textAlign,
  });

  final int amount;
  final String currency;
  final MoneySize size;
  final Color? color;
  final bool emphasized;
  final int? minorUnits;
  final String? semanticsPrefix;
  final TextAlign? textAlign;

  static TextStyle styleFor(MoneySize size) => switch (size) {
        MoneySize.s => JkTypeScale.moneyS,
        MoneySize.m => JkTypeScale.moneyM,
        MoneySize.l => JkTypeScale.moneyL,
      };

  @override
  Widget build(BuildContext context) {
    final locale = context.localeCode;
    final text = Money.minor(amount, currency, locale: locale, minorUnits: minorUnits);
    final spoken = currency.toUpperCase() == 'IDR' ? Money.spokenIdr(amount, locale: locale) : text;
    final prefix = semanticsPrefix;
    final base = styleFor(size).copyWith(color: color ?? context.jk.onSurface);
    return Semantics(
      label: prefix == null ? spoken : '$prefix, $spoken',
      excludeSemantics: true,
      child: Text(
        text,
        textAlign: textAlign,
        style: emphasized ? base.copyWith(fontWeight: FontWeight.w700) : base,
      ),
    );
  }
}

/// "Label ……… Rp1.250.000" row that never overflows: side by side normally, stacked (amount
/// right-aligned under the label) when the user's text scale is large.
class LabeledAmount extends StatelessWidget {
  const LabeledAmount({super.key, required this.label, required this.amount});

  final Widget label;
  final Widget amount;

  @override
  Widget build(BuildContext context) {
    final large = MediaQuery.textScalerOf(context).scale(14) / 14 > 1.3;
    if (large) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[label, Align(alignment: Alignment.centerRight, child: amount)],
      );
    }
    return Row(
      children: <Widget>[
        Expanded(child: label),
        const SizedBox(width: JkSpacing.s3),
        amount,
      ],
    );
  }
}

/// "ESTIMASI" badge (§5.5) for customs duty / import tax and any estimated line.
class EstimateBadge extends StatelessWidget {
  const EstimateBadge({super.key});

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    return Semantics(
      label: context.l10n.estimateBadgeSemantics,
      excludeSemantics: true,
      child: DecoratedBox(
        decoration: BoxDecoration(color: jk.estimateBadge, borderRadius: JkRadii.xsAll),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
          child: Text(
            context.l10n.estimateBadge,
            style: JkTypeScale.labelS.copyWith(color: jk.onEstimateBadge, fontWeight: FontWeight.w700, letterSpacing: 0.8),
          ),
        ),
      ),
    );
  }
}

/// "SANDBOX" badge — every mock/sandbox integration is labelled (CONVENTIONS.md).
class SandboxBadge extends StatelessWidget {
  const SandboxBadge({super.key});

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    return DecoratedBox(
      decoration: BoxDecoration(color: jk.warningContainer, borderRadius: JkRadii.xsAll, border: Border.all(color: jk.warning)),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
        child: Text(
          context.l10n.sandboxBadge,
          style: JkTypeScale.labelS.copyWith(color: jk.onWarningContainer, fontWeight: FontWeight.w700, letterSpacing: 0.8),
        ),
      ),
    );
  }
}
