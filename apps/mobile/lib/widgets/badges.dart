import 'package:flutter/material.dart';

import '../core/design/theme.dart';
import '../core/design/tokens.g.dart';
import '../core/domain/domain.dart';
import '../core/l10n/l10n.dart';
import '../core/l10n/labels.dart';
import 'sheets_and_glass.dart';

/// Trust Score chip (§5.9): shield + number, tier tone; tap explains how it is computed.
class TrustScoreBadge extends StatelessWidget {
  const TrustScoreBadge({super.key, required this.score, this.tier, this.full = false, this.interactive = true});

  final int score;

  /// Server band (`trustTier.tier`: EXCELLENT|GOOD|FAIR|LOW); null → derived from the score.
  final String? tier;
  final bool full;
  final bool interactive;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final band = tier;
    final tone = band == null ? jk.trustTone(score) : (jk.trust[band.toLowerCase()] ?? jk.trustTone(score));
    final tierLabel = Labels.trustTier(l10n, score, tier: band);
    final text = full ? l10n.trustScoreFull(score, tierLabel) : l10n.trustScoreShort(score);
    final chip = DecoratedBox(
      decoration: BoxDecoration(color: tone.bg, borderRadius: JkRadii.pillAll),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.verified_user_outlined, size: 16, color: tone.fg),
            const SizedBox(width: 4),
            Flexible(
              child: Text(
                text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: JkTypeScale.labelM.copyWith(color: tone.fg, fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
      ),
    );
    return Semantics(
      label: l10n.trustScoreSemantics(score, tierLabel),
      button: interactive,
      excludeSemantics: true,
      child: interactive
          ? InkWell(borderRadius: JkRadii.pillAll, onTap: () => showTrustScoreExplainer(context), child: chip)
          : chip,
    );
  }
}

void showTrustScoreExplainer(BuildContext context) {
  final l10n = context.l10n;
  showJkBottomSheet<void>(
    context,
    title: l10n.trustExplainTitle,
    builder: (BuildContext sheetContext) {
      final jk = sheetContext.jk;
      final factors = <String>[
        l10n.trustFactorKyc,
        l10n.trustFactorCompleted,
        l10n.trustFactorOnTime,
        l10n.trustFactorRating,
        l10n.trustFactorDisputes,
        l10n.trustFactorCancellations,
        l10n.trustFactorAccountAge,
      ];
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(l10n.trustExplainBody, style: JkTypeScale.bodyM.copyWith(color: jk.onSurface)),
          const SizedBox(height: JkSpacing.s3),
          for (final f in factors)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Icon(Icons.check_circle_outline, size: 18, color: jk.successText),
                  const SizedBox(width: JkSpacing.s2),
                  Expanded(child: Text(f, style: JkTypeScale.bodyM.copyWith(color: jk.onSurface))),
                ],
              ),
            ),
          const SizedBox(height: JkSpacing.s3),
          Text(l10n.trustExplainPrivacy, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
        ],
      );
    },
  );
}

/// KYC level badge (§5.10): slate → sky → cobalt → navy → amber ("gold", award icon).
class KycLevelBadge extends StatelessWidget {
  const KycLevelBadge({super.key, required this.level, this.full = false});

  final int level;
  final bool full;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final clamped = level < 1 ? 1 : (level > 5 ? 5 : level);
    final tone = jk.kycTone(clamped);
    final name = Labels.kycLevel(l10n, clamped);
    final text = full ? name : l10n.kycLevelShort(clamped);
    return Semantics(
      label: l10n.kycLevelSemantics(clamped, name),
      excludeSemantics: true,
      child: DecoratedBox(
        decoration: BoxDecoration(color: tone.bg, borderRadius: JkRadii.pillAll),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(clamped >= 5 ? Icons.workspace_premium_outlined : Icons.badge_outlined, size: 16, color: tone.fg),
              const SizedBox(width: 4),
              Flexible(
                child: Text(
                  text,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: JkTypeScale.labelM.copyWith(color: tone.fg, fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// KYC ladder L1–L5 with the current level and what the next one unlocks (§6.13).
class KycLadder extends StatelessWidget {
  const KycLadder({super.key, required this.currentLevel});

  final int currentLevel;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final rows = <Widget>[];
    for (final level in KycLevel.all) {
      final achieved = level <= currentLevel;
      final next = level == currentLevel + 1;
      final tone = jk.kycTone(level);
      final stateText = achieved ? l10n.kycLadderAchieved : (next ? l10n.kycLadderNext : l10n.kycLadderLocked);
      rows.add(
        Semantics(
          container: true,
          label: l10n.kycLadderSemantics(level, Labels.kycLevel(l10n, level), stateText),
          excludeSemantics: true,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: JkSpacing.s2),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Container(
                  width: 32,
                  height: 32,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: achieved ? tone.dot : jk.surface,
                    shape: BoxShape.circle,
                    border: Border.all(color: achieved ? tone.dot : (next ? jk.warning : jk.outline), width: 2),
                  ),
                  child: achieved
                      ? Icon(Icons.check, size: 18, color: jk.surface)
                      : Text('$level', style: JkTypeScale.labelL.copyWith(color: next ? jk.warningText : jk.onSurfaceMuted)),
                ),
                const SizedBox(width: JkSpacing.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Wrap(
                        spacing: JkSpacing.s2,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: <Widget>[
                          Text(
                            Labels.kycLevel(l10n, level),
                            style: JkTypeScale.titleS.copyWith(color: achieved || next ? jk.onSurface : jk.onSurfaceMuted),
                          ),
                          Text(stateText, style: JkTypeScale.labelM.copyWith(color: next ? jk.warningText : jk.onSurfaceMuted)),
                        ],
                      ),
                      Text(Labels.kycBenefit(l10n, level), style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows);
  }
}
