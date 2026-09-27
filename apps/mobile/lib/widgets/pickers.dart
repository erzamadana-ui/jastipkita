import 'package:flutter/material.dart';

import '../core/design/theme.dart';
import '../core/design/tokens.g.dart';
import '../core/l10n/l10n.dart';
import 'jk_text_field.dart';
import 'sheets_and_glass.dart';

class PickerOption<T> {
  const PickerOption(this.value, this.label, {this.subtitle});

  final T value;
  final String label;
  final String? subtitle;
}

/// Labelled select field that opens an opaque bottom sheet list — used instead of dropdowns so
/// long lists (countries, categories) stay searchable-by-scroll and readable at 200 % text.
class PickerField<T> extends StatelessWidget {
  const PickerField({
    super.key,
    required this.label,
    required this.options,
    required this.onChanged,
    this.value,
    this.hint,
    this.errorText,
    this.enabled = true,
  });

  final String label;
  final List<PickerOption<T>> options;
  final ValueChanged<T> onChanged;
  final T? value;
  final String? hint;
  final String? errorText;
  final bool enabled;

  String? get _selectedLabel {
    for (final o in options) {
      if (o.value == value) return o.label;
    }
    return null;
  }

  Future<void> _open(BuildContext context) async {
    final picked = await showJkBottomSheet<T>(
      context,
      title: label,
      builder: (BuildContext sheetContext) {
        final jk = sheetContext.jk;
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            for (final o in options)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(o.label),
                subtitle: o.subtitle == null ? null : Text(o.subtitle!),
                trailing: o.value == value ? Icon(Icons.check, color: jk.secondary) : null,
                selected: o.value == value,
                onTap: () => Navigator.of(sheetContext).pop(o.value),
              ),
          ],
        );
      },
    );
    if (picked != null) onChanged(picked);
  }

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final selected = _selectedLabel;
    return MergeSemantics(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(label, style: JkTypeScale.labelL.copyWith(color: jk.onSurface)),
          const SizedBox(height: 6),
          InkWell(
            borderRadius: JkRadii.mdAll,
            onTap: enabled ? () => _open(context) : null,
            child: InputDecorator(
              isEmpty: selected == null,
              decoration: jkInputDecoration(
                context,
                hint: hint ?? context.l10n.pickerChoose,
                errorText: errorText,
                suffixIcon: const Icon(Icons.expand_more),
              ),
              child: selected == null
                  ? null
                  : Text(selected, style: JkTypeScale.bodyL.copyWith(color: enabled ? jk.onSurface : jk.disabledContent)),
            ),
          ),
        ],
      ),
    );
  }
}

/// Labelled date field (calendar date, shown as "12 Okt 2026").
class DatePickerField extends StatelessWidget {
  const DatePickerField({
    super.key,
    required this.label,
    required this.value,
    required this.onChanged,
    required this.display,
    this.firstDate,
    this.lastDate,
    this.errorText,
    this.helper,
  });

  final String label;
  final DateTime? value;
  final ValueChanged<DateTime> onChanged;
  final String Function(DateTime) display;
  final DateTime? firstDate;
  final DateTime? lastDate;
  final String? errorText;
  final String? helper;

  Future<void> _open(BuildContext context) async {
    final now = DateTime.now();
    final first = firstDate ?? DateTime(now.year, now.month, now.day);
    final last = lastDate ?? DateTime(now.year + 2, now.month, now.day);
    var initial = value ?? first;
    if (initial.isBefore(first)) initial = first;
    if (initial.isAfter(last)) initial = last;
    final picked = await showDatePicker(context: context, initialDate: initial, firstDate: first, lastDate: last);
    if (picked != null) onChanged(picked);
  }

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final current = value;
    return MergeSemantics(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(label, style: JkTypeScale.labelL.copyWith(color: jk.onSurface)),
          const SizedBox(height: 6),
          InkWell(
            borderRadius: JkRadii.mdAll,
            onTap: () => _open(context),
            child: InputDecorator(
              isEmpty: current == null,
              decoration: jkInputDecoration(
                context,
                hint: context.l10n.pickerChooseDate,
                errorText: errorText,
                helperText: helper,
                suffixIcon: const Icon(Icons.calendar_today_outlined),
              ),
              child: current == null ? null : Text(display(current), style: JkTypeScale.bodyL.copyWith(color: jk.onSurface)),
            ),
          ),
        ],
      ),
    );
  }
}

/// Quantity stepper (min 1).
class QuantityStepper extends StatelessWidget {
  const QuantityStepper({super.key, required this.label, required this.value, required this.onChanged, this.max = 99});

  final String label;
  final int value;
  final ValueChanged<int> onChanged;
  final int max;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(label, style: JkTypeScale.labelL.copyWith(color: jk.onSurface)),
        const SizedBox(height: 6),
        Row(
          children: <Widget>[
            IconButton.outlined(
              tooltip: l10n.quantityDecrease,
              onPressed: value > 1 ? () => onChanged(value - 1) : null,
              icon: const Icon(Icons.remove),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: JkSpacing.s4),
              child: Semantics(
                liveRegion: true,
                child: Text('$value', style: JkTypeScale.titleL.copyWith(color: jk.onSurface)),
              ),
            ),
            IconButton.outlined(
              tooltip: l10n.quantityIncrease,
              onPressed: value < max ? () => onChanged(value + 1) : null,
              icon: const Icon(Icons.add),
            ),
          ],
        ),
      ],
    );
  }
}
