import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/design/theme.dart';
import '../core/design/tokens.g.dart';

/// Input decoration from tokens (§5.3): 52dp, radius md, 1px outline, 2px focus ring.
InputDecoration jkInputDecoration(
  BuildContext context, {
  String? hint,
  Widget? prefixIcon,
  String? prefixText,
  Widget? suffixIcon,
  String? errorText,
  String? helperText,
  String? counterText,
}) {
  final jk = context.jk;
  OutlineInputBorder border(Color color, [double width = 1]) =>
      OutlineInputBorder(borderRadius: JkRadii.mdAll, borderSide: BorderSide(color: color, width: width));
  return InputDecoration(
    hintText: hint,
    prefixIcon: prefixIcon,
    prefixText: prefixText,
    suffixIcon: suffixIcon,
    errorText: errorText,
    helperText: helperText,
    counterText: counterText,
    filled: true,
    fillColor: jk.surface,
    contentPadding: const EdgeInsets.symmetric(horizontal: JkSpacing.s4, vertical: JkSpacing.s4),
    hintStyle: JkTypeScale.bodyL.copyWith(color: jk.onSurfaceMuted),
    prefixStyle: JkTypeScale.bodyL.copyWith(color: jk.onSurfaceMuted),
    helperStyle: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted),
    helperMaxLines: 3,
    errorStyle: JkTypeScale.bodyS.copyWith(color: jk.errorText),
    errorMaxLines: 3,
    border: border(jk.outline),
    enabledBorder: border(jk.outline),
    disabledBorder: border(jk.border),
    focusedBorder: border(jk.focusRing, 2),
    errorBorder: border(jk.error),
    focusedErrorBorder: border(jk.error, 2),
  );
}

/// Labelled text field: the label is always visible above the field (never placeholder-only),
/// errors render below with text, and label + field are merged for screen readers.
class JkTextField extends StatelessWidget {
  const JkTextField({
    super.key,
    required this.label,
    this.controller,
    this.initialValue,
    this.hint,
    this.helper,
    this.errorText,
    this.keyboardType,
    this.textInputAction,
    this.onChanged,
    this.onSubmitted,
    this.validator,
    this.obscure = false,
    this.maxLines = 1,
    this.minLines,
    this.maxLength,
    this.prefixIcon,
    this.prefixText,
    this.suffixIcon,
    this.inputFormatters,
    this.autofillHints,
    this.enabled = true,
    this.readOnly = false,
    this.onTap,
    this.focusNode,
    this.textCapitalization = TextCapitalization.none,
  });

  /// Money input: digits and separators only, numeric keyboard.
  static final List<TextInputFormatter> moneyFormatters = <TextInputFormatter>[
    FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]')),
  ];

  static final List<TextInputFormatter> digitsOnly = <TextInputFormatter>[FilteringTextInputFormatter.digitsOnly];

  final String label;
  final TextEditingController? controller;
  final String? initialValue;
  final String? hint;
  final String? helper;
  final String? errorText;
  final TextInputType? keyboardType;
  final TextInputAction? textInputAction;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final FormFieldValidator<String>? validator;
  final bool obscure;
  final int? maxLines;
  final int? minLines;
  final int? maxLength;
  final Widget? prefixIcon;
  final String? prefixText;
  final Widget? suffixIcon;
  final List<TextInputFormatter>? inputFormatters;
  final Iterable<String>? autofillHints;
  final bool enabled;
  final bool readOnly;
  final VoidCallback? onTap;
  final FocusNode? focusNode;
  final TextCapitalization textCapitalization;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    return MergeSemantics(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(label, style: JkTypeScale.labelL.copyWith(color: jk.onSurface)),
          const SizedBox(height: 6),
          TextFormField(
            controller: controller,
            initialValue: controller == null ? initialValue : null,
            focusNode: focusNode,
            keyboardType: keyboardType,
            textInputAction: textInputAction,
            textCapitalization: textCapitalization,
            onChanged: onChanged,
            onFieldSubmitted: onSubmitted,
            validator: validator,
            obscureText: obscure,
            maxLines: obscure ? 1 : maxLines,
            minLines: minLines,
            maxLength: maxLength,
            inputFormatters: inputFormatters,
            autofillHints: autofillHints,
            enabled: enabled,
            readOnly: readOnly,
            onTap: onTap,
            style: JkTypeScale.bodyL.copyWith(color: enabled ? jk.onSurface : jk.disabledContent),
            decoration: jkInputDecoration(
              context,
              hint: hint,
              helperText: helper,
              errorText: errorText,
              prefixIcon: prefixIcon,
              prefixText: prefixText,
              suffixIcon: suffixIcon,
            ),
          ),
        ],
      ),
    );
  }
}
