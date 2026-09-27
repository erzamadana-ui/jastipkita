import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/format/dates.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/catalog.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../../widgets/pickers.dart';
import '../../../widgets/states.dart';
import '../../catalog/data/catalog_repository.dart';
import '../data/trip_repository.dart';

/// Create a trip (DRAFT): route, dates, capacity, fee preference, excluded categories. The
/// travel document is uploaded on the trip detail screen right after (§6.8).
class CreateTripScreen extends ConsumerStatefulWidget {
  const CreateTripScreen({super.key});

  @override
  ConsumerState<CreateTripScreen> createState() => _CreateTripScreenState();
}

class _CreateTripScreenState extends ConsumerState<CreateTripScreen> {
  final TextEditingController _originCity = TextEditingController();
  final TextEditingController _destinationCity = TextEditingController(text: 'Jakarta');
  final TextEditingController _capacity = TextEditingController();
  final TextEditingController _maxItems = TextEditingController();
  final TextEditingController _feeValue = TextEditingController();
  final TextEditingController _notes = TextEditingController();
  String? _originCountry;
  DateTime? _departure;
  DateTime? _arrival;
  DateTime? _return;
  String _feeType = 'FIXED';
  final Set<String> _excluded = <String>{};
  final Map<String, String> _errors = <String, String>{};
  bool _saving = false;

  @override
  void dispose() {
    for (final c in <TextEditingController>[_originCity, _destinationCity, _capacity, _maxItems, _feeValue, _notes]) {
      c.dispose();
    }
    super.dispose();
  }

  /// Fee as the API expects: FIXED/PER_KG → IDR, PERCENT → basis points.
  int? _feeInt() {
    final raw = _feeValue.text.trim().replaceAll(',', '.');
    if (_feeType == 'PERCENT') {
      final pct = double.tryParse(raw);
      return pct == null ? null : (pct * 100).round();
    }
    return int.tryParse(raw.replaceAll(RegExp(r'[^0-9]'), ''));
  }

  bool _validate() {
    final l10n = context.l10n;
    _errors.clear();
    if (_originCountry == null) _errors['originCountry'] = l10n.validationRequired;
    if (_originCity.text.trim().isEmpty) _errors['originCity'] = l10n.validationRequired;
    if (_destinationCity.text.trim().isEmpty) _errors['destinationCity'] = l10n.validationRequired;
    if (_departure == null) _errors['departure'] = l10n.validationRequired;
    if (_arrival == null) _errors['arrival'] = l10n.validationRequired;
    final departure = _departure;
    final arrival = _arrival;
    if (departure != null && arrival != null && arrival.isBefore(departure)) _errors['arrival'] = l10n.tripArrivalBeforeDeparture;
    final capacity = double.tryParse(_capacity.text.trim().replaceAll(',', '.'));
    if (capacity == null || capacity <= 0) _errors['capacity'] = l10n.validationAmount;
    final fee = _feeInt();
    if (fee == null || fee < 0) _errors['fee'] = l10n.validationAmount;
    setState(() {});
    return _errors.isEmpty;
  }

  Future<void> _save() async {
    if (!_validate()) return;
    final maxItems = int.tryParse(_maxItems.text.trim());
    final returnDate = _return;
    final body = <String, dynamic>{
      'originCountry': _originCountry,
      'originCity': _originCity.text.trim(),
      'destinationCountry': 'ID',
      'destinationCity': _destinationCity.text.trim(),
      'departureDate': JkDates.toYmd(_departure!),
      'arrivalDate': JkDates.toYmd(_arrival!),
      if (returnDate != null) 'returnDate': JkDates.toYmd(returnDate),
      'capacityKg': double.parse(_capacity.text.trim().replaceAll(',', '.')),
      if (maxItems != null && maxItems > 0) 'maxItems': maxItems,
      'fee': <String, dynamic>{'type': _feeType, 'value': _feeInt()},
      'excludedCategories': _excluded.toList(),
      if (_notes.text.trim().isNotEmpty) 'notes': _notes.text.trim(),
    };
    setState(() => _saving = true);
    try {
      final trip = await ref.read(tripRepositoryProvider).create(body);
      if (!mounted) return;
      ref.invalidate(myActiveTripsProvider);
      ref.invalidate(myTripsProvider);
      showJkSnack(context, context.l10n.tripCreated);
      context.pushReplacement(Routes.trip(trip.id));
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final locale = context.localeCode;
    final catalogValue = ref.watch(catalogProvider);
    final catalog = catalogValue.valueOrNull;
    String show(DateTime d) => JkDates.calendar(JkDates.toYmd(d), locale);
    const gap = SizedBox(height: JkSpacing.s4);
    final today = DateTime.now();
    final departure = _departure;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.tripCreate)),
      body: SafeArea(
        child: catalog == null && catalogValue.hasError
            ? ErrorView(error: catalogValue.error!, onRetry: () => ref.invalidate(catalogProvider))
            : ListView(
                padding: const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s12),
                children: <Widget>[
                  NoticeBox(message: l10n.tripCreateIntro),
                  SectionHeader(title: l10n.tripSectionRoute),
                  PickerField<String>(
                    label: l10n.tripOriginCountry,
                    value: _originCountry,
                    errorText: _errors['originCountry'],
                    options: <PickerOption<String>>[
                      for (final c in catalog?.origins ?? const <Country>[])
                        PickerOption<String>(c.code, '${PopularOrigins.flag(c.code)} ${c.name(locale)}'),
                    ],
                    onChanged: (String v) => setState(() => _originCountry = v),
                  ),
                  gap,
                  JkTextField(label: l10n.tripOriginCity, controller: _originCity, errorText: _errors['originCity'], hint: l10n.tripOriginCityHint),
                  gap,
                  JkTextField(label: l10n.tripDestinationCity, controller: _destinationCity, errorText: _errors['destinationCity']),
                  SectionHeader(title: l10n.tripSectionDates),
                  DatePickerField(
                    label: l10n.tripDeparture,
                    value: _departure,
                    display: show,
                    errorText: _errors['departure'],
                    firstDate: DateTime(today.year, today.month, today.day),
                    onChanged: (DateTime d) => setState(() => _departure = d),
                  ),
                  gap,
                  DatePickerField(
                    label: l10n.tripArrival,
                    value: _arrival,
                    display: show,
                    errorText: _errors['arrival'],
                    firstDate: departure ?? DateTime(today.year, today.month, today.day),
                    helper: l10n.tripDatesWibNote,
                    onChanged: (DateTime d) => setState(() => _arrival = d),
                  ),
                  gap,
                  DatePickerField(
                    label: l10n.tripReturn,
                    value: _return,
                    display: show,
                    firstDate: departure ?? DateTime(today.year, today.month, today.day),
                    onChanged: (DateTime d) => setState(() => _return = d),
                  ),
                  SectionHeader(title: l10n.tripSectionCapacity),
                  JkTextField(
                    label: l10n.tripCapacityKg,
                    controller: _capacity,
                    errorText: _errors['capacity'],
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: JkTextField.moneyFormatters,
                  ),
                  gap,
                  JkTextField(
                    label: l10n.tripMaxItems,
                    controller: _maxItems,
                    keyboardType: TextInputType.number,
                    inputFormatters: JkTextField.digitsOnly,
                    hint: l10n.optional,
                  ),
                  SectionHeader(title: l10n.tripSectionFee),
                  Wrap(
                    spacing: JkSpacing.s2,
                    runSpacing: JkSpacing.s2,
                    children: <Widget>[
                      for (final t in <String>['FIXED', 'PERCENT', 'PER_KG'])
                        ChoiceChip(
                          label: Text(Labels.feeType(l10n, t)),
                          selected: _feeType == t,
                          onSelected: (bool v) => setState(() => _feeType = t),
                        ),
                    ],
                  ),
                  gap,
                  JkTextField(
                    label: _feeType == 'PERCENT' ? l10n.tripFeePercent : l10n.tripFeeAmount,
                    controller: _feeValue,
                    errorText: _errors['fee'],
                    prefixText: _feeType == 'PERCENT' ? null : 'Rp ',
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: JkTextField.moneyFormatters,
                    helper: _feeType == 'PER_KG' ? l10n.tripFeePerKgHelp : null,
                  ),
                  SectionHeader(title: l10n.tripSectionExcluded),
                  Text(l10n.tripExcludedHelp, style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted)),
                  const SizedBox(height: JkSpacing.s2),
                  Wrap(
                    spacing: JkSpacing.s2,
                    runSpacing: JkSpacing.s2,
                    children: <Widget>[
                      for (final c in catalog?.categories ?? const <ProductCategory>[])
                        FilterChip(
                          label: Text(c.name(locale)),
                          selected: _excluded.contains(c.code),
                          onSelected: (bool v) => setState(() {
                            if (v) {
                              _excluded.add(c.code);
                            } else {
                              _excluded.remove(c.code);
                            }
                          }),
                        ),
                    ],
                  ),
                  gap,
                  JkTextField(label: l10n.fieldNotes, controller: _notes, maxLines: 3, minLines: 2),
                  const SizedBox(height: JkSpacing.s6),
                  JkButton(label: l10n.tripSaveDraft, icon: Icons.save_outlined, loading: _saving, onPressed: _save),
                ],
              ),
      ),
    );
  }
}
