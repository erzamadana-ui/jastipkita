import 'package:flutter/material.dart';

import '../core/design/theme.dart';
import '../core/design/tokens.g.dart';
import '../core/domain/domain.dart';
import '../core/l10n/l10n.dart';
import '../core/l10n/labels.dart';
import 'sheets_and_glass.dart';

/// Restricted-item warning (§5.15) for the 5 classifications:
/// ALLOWED (optional chip) · RESTRICTED (warning + ack) · DECLARATION_REQUIRED (info + ack) ·
/// PERMIT_REQUIRED (warning, thick border + ack) · PROHIBITED (solid error, blocks checkout).
class RestrictedItemWarning extends StatelessWidget {
  const RestrictedItemWarning({
    super.key,
    required this.classification,
    this.messages = const <String>[],
    this.permitAuthorities = const <String>[],
    this.ruleRef,
    this.disclaimer,
    this.acknowledged = false,
    this.onAcknowledgedChanged,
    this.compact = false,
    this.showAllowed = false,
  });

  final String classification;
  final List<String> messages;
  final List<String> permitAuthorities;
  final String? ruleRef;
  final String? disclaimer;
  final bool acknowledged;

  /// When set and the class needs acknowledgement, a checkbox is shown (recorded by the API).
  final ValueChanged<bool>? onAcknowledgedChanged;
  final bool compact;
  final bool showAllowed;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    if (classification == Restriction.allowed || !Restriction.all.contains(classification)) {
      if (!showAllowed) return const SizedBox.shrink();
      return Align(
        alignment: Alignment.centerLeft,
        child: DecoratedBox(
          decoration: BoxDecoration(color: jk.successContainer, borderRadius: JkRadii.pillAll),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(Icons.check_circle_outline, size: 16, color: jk.onSuccessContainer),
                const SizedBox(width: 4),
                Flexible(
                  child: Text(l10n.restrictionAllowedTitle, style: JkTypeScale.labelM.copyWith(color: jk.onSuccessContainer)),
                ),
              ],
            ),
          ),
        ),
      );
    }
    final (Color bg, Color fg, Color border, double borderWidth, IconData icon) = switch (classification) {
      Restriction.prohibited => (jk.error, jk.onError, jk.error, 1.0, Icons.block),
      Restriction.declarationRequired => (jk.infoContainer, jk.onInfoContainer, jk.info, 1.0, Icons.description_outlined),
      Restriction.permitRequired => (jk.warningContainer, jk.onWarningContainer, jk.warning, 2.5, Icons.approval_outlined),
      _ => (jk.warningContainer, jk.onWarningContainer, jk.warning, 1.0, Icons.warning_amber_rounded),
    };
    final title = Labels.restrictionTitle(l10n, classification);
    if (compact) {
      return Semantics(
        label: title,
        excludeSemantics: true,
        child: DecoratedBox(
          decoration: BoxDecoration(color: bg, borderRadius: JkRadii.smAll, border: Border.all(color: border, width: borderWidth)),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: JkSpacing.s2, vertical: JkSpacing.s1),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Icon(icon, size: 16, color: fg),
                const SizedBox(width: 6),
                Flexible(child: Text(title, style: JkTypeScale.labelM.copyWith(color: fg, fontWeight: FontWeight.w600))),
              ],
            ),
          ),
        ),
      );
    }
    final needsAck = Restriction.needsAcknowledgement(classification);
    final onAck = onAcknowledgedChanged;
    final lines = messages.isEmpty ? <String>[Labels.restrictionBody(l10n, classification)] : messages;
    return Semantics(
      container: true,
      liveRegion: classification == Restriction.prohibited,
      child: DecoratedBox(
        decoration: BoxDecoration(color: bg, borderRadius: JkRadii.lgAll, border: Border.all(color: border, width: borderWidth)),
        child: Padding(
          padding: const EdgeInsets.all(JkSpacing.s4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Icon(icon, color: fg),
                  const SizedBox(width: JkSpacing.s3),
                  Expanded(
                    child: Text(title, style: JkTypeScale.titleS.copyWith(color: fg)),
                  ),
                ],
              ),
              const SizedBox(height: JkSpacing.s2),
              for (final m in lines)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text(m, style: JkTypeScale.bodyM.copyWith(color: fg)),
                ),
              if (permitAuthorities.isNotEmpty)
                Text(l10n.restrictionPermitAuthorities(permitAuthorities.join(', ')), style: JkTypeScale.bodyS.copyWith(color: fg)),
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  style: TextButton.styleFrom(foregroundColor: fg),
                  onPressed: () => _showWhy(context, title),
                  child: Text(l10n.restrictionWhy),
                ),
              ),
              if (needsAck && onAck != null)
                // Own transparent Material so the tile's ink/background is not hidden by the
                // coloured DecoratedBox above (Flutter asserts on this in debug).
                Material(
                  type: MaterialType.transparency,
                  child: CheckboxListTile(
                    value: acknowledged,
                    onChanged: (bool? v) => onAck(v ?? false),
                    contentPadding: EdgeInsets.zero,
                    controlAffinity: ListTileControlAffinity.leading,
                    title: Text(l10n.restrictionAcknowledge, style: JkTypeScale.bodyM.copyWith(color: fg)),
                  ),
                ),
              if (classification == Restriction.prohibited)
                Text(l10n.restrictionProhibitedAlternative, style: JkTypeScale.bodyS.copyWith(color: fg)),
            ],
          ),
        ),
      ),
    );
  }

  void _showWhy(BuildContext context, String title) {
    final l10n = context.l10n;
    final rule = ruleRef;
    final note = disclaimer;
    showJkBottomSheet<void>(
      context,
      title: title,
      builder: (BuildContext sheetContext) {
        final jk = sheetContext.jk;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(Labels.restrictionBody(l10n, classification), style: JkTypeScale.bodyM.copyWith(color: jk.onSurface)),
            const SizedBox(height: JkSpacing.s3),
            if (rule != null) ...<Widget>[
              Text(l10n.ruleSource, style: JkTypeScale.labelL.copyWith(color: jk.onSurfaceMuted)),
              SelectableText(rule, style: JkTypeScale.bodyM.copyWith(color: jk.onSurface)),
              const SizedBox(height: JkSpacing.s3),
            ],
            Text(note ?? l10n.restrictionDisclaimer, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
          ],
        );
      },
    );
  }
}
