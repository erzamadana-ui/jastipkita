import 'package:flutter/material.dart';

import '../core/design/theme.dart';
import '../core/design/tokens.g.dart';

enum JkButtonVariant { primary, secondary, tertiary, tonal, destructive }

/// Design-system button (§5.2): pill, 52dp high, one primary per screen. While [loading] the
/// button keeps its label, shows a spinner and ignores taps (the UI locks money actions after the
/// first tap; the API is idempotent as well). A disabled button tied to a rule shows
/// [disabledReason] underneath.
class JkButton extends StatelessWidget {
  const JkButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.variant = JkButtonVariant.primary,
    this.icon,
    this.loading = false,
    this.expand = true,
    this.semanticsLabel,
    this.disabledReason,
  });

  final String label;
  final VoidCallback? onPressed;
  final JkButtonVariant variant;
  final IconData? icon;
  final bool loading;
  final bool expand;
  final String? semanticsLabel;
  final String? disabledReason;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final VoidCallback? handler = loading ? null : onPressed;
    final Widget button = switch (variant) {
      JkButtonVariant.primary => FilledButton(
          onPressed: handler,
          style: loading ? FilledButton.styleFrom(disabledBackgroundColor: jk.cta, disabledForegroundColor: jk.onCta) : null,
          child: _content(jk.onCta),
        ),
      JkButtonVariant.secondary => OutlinedButton(onPressed: handler, child: _content(jk.onSurface)),
      JkButtonVariant.tertiary => TextButton(onPressed: handler, child: _content(jk.link)),
      JkButtonVariant.tonal => FilledButton(
          onPressed: handler,
          style: FilledButton.styleFrom(
            backgroundColor: jk.secondaryContainer,
            foregroundColor: jk.onSecondaryContainer,
            disabledBackgroundColor: loading ? jk.secondaryContainer : jk.disabledContainer,
            disabledForegroundColor: loading ? jk.onSecondaryContainer : jk.disabledContent,
          ),
          child: _content(jk.onSecondaryContainer),
        ),
      JkButtonVariant.destructive => FilledButton(
          onPressed: handler,
          style: FilledButton.styleFrom(
            backgroundColor: jk.error,
            foregroundColor: jk.onError,
            disabledBackgroundColor: loading ? jk.error : jk.disabledContainer,
            disabledForegroundColor: loading ? jk.onError : jk.disabledContent,
          ),
          child: _content(jk.onError),
        ),
    };

    Widget result = expand ? SizedBox(width: double.infinity, child: button) : button;
    final customLabel = semanticsLabel;
    if (customLabel != null) result = Semantics(label: customLabel, child: result);

    final reason = disabledReason;
    if (onPressed == null && reason != null && reason.isNotEmpty) {
      result = Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          result,
          const SizedBox(height: JkSpacing.s2),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Icon(Icons.info_outline, size: 16, color: jk.onSurfaceMuted),
              ),
              const SizedBox(width: JkSpacing.s2),
              Expanded(child: Text(reason, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted))),
            ],
          ),
        ],
      );
    }
    return result;
  }

  Widget _content(Color spinnerColor) {
    final children = <Widget>[];
    if (loading) {
      children.add(SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2, color: spinnerColor)));
    } else if (icon != null) {
      children.add(Icon(icon, size: 20));
    }
    if (children.isNotEmpty) children.add(const SizedBox(width: JkSpacing.s2));
    children.add(
      Flexible(child: Text(label, textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis)),
    );
    return Row(mainAxisSize: MainAxisSize.min, mainAxisAlignment: MainAxisAlignment.center, children: children);
  }
}
