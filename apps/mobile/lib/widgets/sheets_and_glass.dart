import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/design/theme.dart';
import '../core/design/tokens.g.dart';

/// Bottom sheet (§5.21): `surfaceElevated`, radius xl on top, drag handle, keyboard-aware.
/// Content is always opaque — sheets with money never get a glass header.
Future<T?> showJkBottomSheet<T>(
  BuildContext context, {
  required WidgetBuilder builder,
  String? title,
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (BuildContext sheetContext) => JkSheetBody(title: title, child: builder(sheetContext)),
  );
}

class JkSheetBody extends StatelessWidget {
  const JkSheetBody({super.key, required this.child, this.title});

  final Widget child;
  final String? title;

  @override
  Widget build(BuildContext context) {
    final heading = title;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(JkSpacing.s5, 0, JkSpacing.s5, JkSpacing.s6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            if (heading != null)
              Padding(
                padding: const EdgeInsets.only(bottom: JkSpacing.s4),
                child: Semantics(
                  header: true,
                  child: Text(heading, style: JkTypeScale.titleL.copyWith(color: context.jk.onSurface)),
                ),
              ),
            child,
          ],
        ),
      ),
    );
  }
}

/// Liquid-Glass-style material (§2.1): blur σ20 + saturation 1.8 over `surfaceGlass`.
///
/// ONLY for the navigation/control layer (tab bar, floating scanner controls). Never wrap
/// price breakdowns, SafePay banners, payment status, receipts, forms or dialogs in it. With
/// "Increase contrast" on, it falls back to an opaque elevated surface.
class GlassSurface extends StatelessWidget {
  const GlassSurface({super.key, required this.child, this.borderRadius = JkRadii.pillAll});

  final Widget child;
  final BorderRadius borderRadius;

  static final List<double> _saturation = _saturationMatrix(JkGlass.saturation);

  static List<double> _saturationMatrix(double s) {
    const r = 0.2126;
    const g = 0.7152;
    const b = 0.0722;
    final inv = 1 - s;
    return <double>[
      r * inv + s, g * inv, b * inv, 0, 0, //
      r * inv, g * inv + s, b * inv, 0, 0, //
      r * inv, g * inv, b * inv + s, 0, 0, //
      0, 0, 0, 1, 0, //
    ];
  }

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    if (MediaQuery.highContrastOf(context)) {
      return DecoratedBox(
        decoration: BoxDecoration(
          color: jk.surfaceElevated,
          borderRadius: borderRadius,
          border: Border.all(color: jk.outline),
          boxShadow: context.elevation(3),
        ),
        child: child,
      );
    }
    return DecoratedBox(
      decoration: BoxDecoration(borderRadius: borderRadius, boxShadow: context.elevation(3)),
      child: ClipRRect(
        borderRadius: borderRadius,
        child: BackdropFilter(
          filter: ui.ImageFilter.compose(
            outer: ui.ColorFilter.matrix(_saturation),
            inner: ui.ImageFilter.blur(sigmaX: JkGlass.blurSigma, sigmaY: JkGlass.blurSigma),
          ),
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: jk.surfaceGlass,
              borderRadius: borderRadius,
              border: Border.all(color: jk.glassBorder, width: JkGlass.borderWidth),
            ),
            child: child,
          ),
        ),
      ),
    );
  }
}

/// 6-box OTP input backed by one text field (SMS autofill via `oneTimeCode`).
class OtpField extends StatefulWidget {
  const OtpField({
    super.key,
    required this.onCompleted,
    required this.semanticsLabel,
    this.length = 6,
    this.controller,
    this.errorText,
    this.autofocus = true,
    this.enabled = true,
  });

  final ValueChanged<String> onCompleted;
  final String semanticsLabel;
  final int length;
  final TextEditingController? controller;
  final String? errorText;
  final bool autofocus;
  final bool enabled;

  @override
  State<OtpField> createState() => _OtpFieldState();
}

class _OtpFieldState extends State<OtpField> {
  late final TextEditingController _controller = widget.controller ?? TextEditingController();
  final FocusNode _focus = FocusNode();

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onChanged);
    _focus.addListener(_onFocus);
  }

  @override
  void dispose() {
    _controller.removeListener(_onChanged);
    _focus.removeListener(_onFocus);
    if (widget.controller == null) _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _onFocus() => setState(() {});

  void _onChanged() {
    setState(() {});
    final value = _controller.text;
    if (value.length == widget.length) widget.onCompleted(value);
  }

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final text = _controller.text;
    final error = widget.errorText;
    final boxes = <Widget>[];
    for (var i = 0; i < widget.length; i++) {
      final filled = i < text.length;
      final active = _focus.hasFocus && (i == text.length || (i == widget.length - 1 && text.length == widget.length));
      final borderColor = error != null ? jk.error : (active ? jk.focusRing : jk.outline);
      if (i > 0) boxes.add(const SizedBox(width: JkSpacing.s2));
      boxes.add(
        Expanded(
          child: Container(
            height: 56,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: jk.surface,
              borderRadius: JkRadii.mdAll,
              border: Border.all(color: borderColor, width: active ? 2 : 1),
            ),
            child: FittedBox(
              child: Text(filled ? text[i] : '', style: JkTypeScale.moneyL.copyWith(color: jk.onSurface)),
            ),
          ),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Stack(
          children: <Widget>[
            ExcludeSemantics(child: Row(children: boxes)),
            Positioned.fill(
              child: Opacity(
                opacity: 0,
                alwaysIncludeSemantics: true,
                child: Semantics(
                  label: widget.semanticsLabel,
                  child: TextField(
                    controller: _controller,
                    focusNode: _focus,
                    autofocus: widget.autofocus,
                    enabled: widget.enabled,
                    keyboardType: TextInputType.number,
                    autofillHints: const <String>[AutofillHints.oneTimeCode],
                    maxLength: widget.length,
                    showCursor: false,
                    enableInteractiveSelection: false,
                    inputFormatters: <TextInputFormatter>[FilteringTextInputFormatter.digitsOnly],
                    decoration: const InputDecoration(counterText: '', border: InputBorder.none),
                  ),
                ),
              ),
            ),
          ],
        ),
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(top: JkSpacing.s2),
            child: Semantics(
              liveRegion: true,
              child: Text(error, style: JkTypeScale.bodyS.copyWith(color: jk.errorText)),
            ),
          ),
      ],
    );
  }
}
