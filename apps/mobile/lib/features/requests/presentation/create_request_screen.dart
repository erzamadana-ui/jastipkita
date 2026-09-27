import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/format/dates.dart';
import '../../../core/format/money.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/catalog.dart';
import '../../../core/models/marketplace.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../../widgets/money_text.dart';
import '../../../widgets/pickers.dart';
import '../../../widgets/restricted_item_warning.dart';
import '../../../widgets/states.dart';
import '../../catalog/data/catalog_repository.dart';
import '../../engagement/data/engagement_repository.dart';
import '../../files/data/file_upload_service.dart';
import '../data/request_repository.dart';

enum _Source { url, photo, search, manual }

_Source _sourceFrom(String? tab) => switch (tab) {
      'photo' => _Source.photo,
      'search' => _Source.search,
      'manual' => _Source.manual,
      _ => _Source.url,
    };

/// Create a request (titipan): URL / Photo / Search / Manual → editable form → restricted-item
/// check (+ acknowledgement) → customs estimate preview → save draft or publish (§6.3).
class CreateRequestScreen extends ConsumerStatefulWidget {
  const CreateRequestScreen({super.key, this.initialTab, this.initialUrl, this.initialQuery, this.initialCountry});

  final String? initialTab;
  final String? initialUrl;
  final String? initialQuery;
  final String? initialCountry;

  @override
  ConsumerState<CreateRequestScreen> createState() => _CreateRequestScreenState();
}

class _CreateRequestScreenState extends ConsumerState<CreateRequestScreen> {
  late _Source _source = _sourceFrom(widget.initialTab);
  late final TextEditingController _url = TextEditingController(text: widget.initialUrl ?? '');
  late final TextEditingController _query = TextEditingController(text: widget.initialQuery ?? '');
  final TextEditingController _name = TextEditingController();
  final TextEditingController _merchant = TextEditingController();
  final TextEditingController _variant = TextEditingController();
  final TextEditingController _price = TextEditingController();
  final TextEditingController _notes = TextEditingController();
  final TextEditingController _budget = TextEditingController();
  final TextEditingController _city = TextEditingController();

  bool _extracting = false;
  ExtractionResult? _extraction;
  List<ExtractionDraft> _searchResults = const <ExtractionDraft>[];
  bool _showForm = false;
  String? _productUrl;
  String? _imageUrl;
  final List<String> _imageFileIds = <String>[];
  late String? _country = widget.initialCountry;
  String? _category;
  String? _currency;
  int _quantity = 1;
  DateTime? _neededBy;
  String _delivery = 'ANY';

  bool _checking = false;
  RestrictedCheck? _check;
  CustomsEstimate? _estimate;
  Object? _checkError;
  bool _ack = false;
  bool _submitting = false;
  final Map<String, String> _errors = <String, String>{};

  @override
  void initState() {
    super.initState();
    _showForm = _source == _Source.manual;
    trackEvent(ref, 'request_started', <String, Object?>{'source': _source.name});
    WidgetsBinding.instance.addPostFrameCallback((Duration _) {
      if (!mounted) return;
      if (_source == _Source.url && _url.text.isNotEmpty) _extractUrl();
      if (_source == _Source.search && _query.text.isNotEmpty) _search();
    });
  }

  @override
  void dispose() {
    for (final c in <TextEditingController>[_url, _query, _name, _merchant, _variant, _price, _notes, _budget, _city]) {
      c.dispose();
    }
    super.dispose();
  }

  void _invalidateCheck() {
    if (_check != null || _estimate != null) {
      setState(() {
        _check = null;
        _estimate = null;
        _ack = false;
      });
    }
  }

  void _applyDraft(ExtractionDraft draft, Catalog? catalog) {
    setState(() {
      _name.text = draft.productName ?? _name.text;
      _merchant.text = draft.merchantName ?? _merchant.text;
      _variant.text = draft.variant ?? _variant.text;
      _productUrl = draft.productUrl ?? _productUrl;
      _imageUrl = draft.imageUrl ?? _imageUrl;
      _country = draft.merchantCountry ?? _country;
      _category = draft.categoryCode ?? _category;
      _currency = draft.priceCurrency ?? _currency ?? catalog?.country(_country)?.currencyCode;
      final price = draft.unitPriceMinor;
      final currency = _currency;
      if (price != null && currency != null) {
        _price.text = Money.minor(price, currency, minorUnits: catalog?.minorUnits(currency)).replaceAll(RegExp(r'[^0-9.,]'), '');
      }
      _showForm = true;
      _check = null;
      _estimate = null;
      _ack = false;
    });
  }

  Future<void> _runExtraction(Future<ExtractionResult> Function() call) async {
    setState(() {
      _extracting = true;
      _searchResults = const <ExtractionDraft>[];
    });
    final catalog = ref.read(catalogProvider).valueOrNull;
    try {
      final result = await call();
      if (!mounted) return;
      setState(() => _extraction = result);
      if (_source == _Source.search && result.drafts.length > 1) {
        setState(() => _searchResults = result.drafts);
      } else if (result.drafts.isNotEmpty) {
        _applyDraft(result.drafts.first, catalog);
      } else {
        setState(() => _showForm = true);
      }
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
      setState(() => _showForm = true);
    } finally {
      if (mounted) setState(() => _extracting = false);
    }
  }

  Future<void> _extractUrl() async {
    final url = _url.text.trim();
    if (url.isEmpty) return;
    _productUrl = url;
    await _runExtraction(() => ref.read(requestRepositoryProvider).extract(url: url, country: _country));
  }

  Future<void> _search() async {
    final q = _query.text.trim();
    if (q.isEmpty) return;
    await _runExtraction(() => ref.read(requestRepositoryProvider).extract(query: q, country: _country));
  }

  Future<void> _photo(bool camera) async {
    final picked = await ref.read(mediaPickerProvider).image(camera: camera);
    if (picked == null || !mounted) return;
    await _runExtraction(() async {
      final fileId = await ref.read(fileUploadServiceProvider).upload(picked, purpose: FilePurpose.productPhoto);
      _imageFileIds
        ..clear()
        ..add(fileId);
      return ref.read(requestRepositoryProvider).extract(fileId: fileId, country: _country);
    });
  }

  int? _priceMinor(Catalog? catalog) {
    final currency = _currency;
    if (currency == null) return null;
    return Money.parseMinor(_price.text, currency, minorUnits: catalog?.minorUnits(currency));
  }

  bool _validate(Catalog? catalog) {
    final l10n = context.l10n;
    _errors.clear();
    if (_name.text.trim().length < 2) _errors['name'] = l10n.validationRequired;
    if (_country == null) _errors['country'] = l10n.validationRequired;
    if (_category == null) _errors['category'] = l10n.validationRequired;
    if (_currency == null) _errors['currency'] = l10n.validationRequired;
    final price = _priceMinor(catalog);
    if (price == null || price <= 0) _errors['price'] = l10n.validationAmount;
    setState(() {});
    return _errors.isEmpty;
  }

  Future<void> _runCheck() async {
    final catalog = ref.read(catalogProvider).valueOrNull;
    if (!_validate(catalog)) return;
    final repo = ref.read(catalogRepositoryProvider);
    final price = _priceMinor(catalog)!;
    final country = _country!;
    final category = _category!;
    final currency = _currency!;
    final locale = context.localeCode;
    setState(() {
      _checking = true;
      _checkError = null;
    });
    try {
      final results = await Future.wait<Object>(<Future<Object>>[
        repo.restrictedCheck(
          originCountry: country,
          categoryCode: category,
          productName: _name.text.trim(),
          quantity: _quantity,
          unitPriceMinor: price,
          currency: currency,
          locale: locale,
        ),
        repo.customsEstimate(
          originCountry: country,
          categoryCode: category,
          unitPriceMinor: price,
          currency: currency,
          quantity: _quantity,
        ),
      ]);
      if (!mounted) return;
      setState(() {
        _check = results[0] as RestrictedCheck;
        _estimate = results[1] as CustomsEstimate;
        _ack = false;
      });
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _checkError = e);
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  Future<void> _submit({required bool publish}) async {
    final catalog = ref.read(catalogProvider).valueOrNull;
    if (!_validate(catalog)) return;
    final budget = int.tryParse(_budget.text.replaceAll(RegExp(r'[^0-9]'), ''));
    final extraction = _extraction;
    final body = <String, dynamic>{
      'sourceType': _source == _Source.manual ? 'MANUAL' : _source.name.toUpperCase(),
      if (_productUrl != null) 'productUrl': _productUrl,
      'productName': _name.text.trim(),
      if (_merchant.text.trim().isNotEmpty) 'merchantName': _merchant.text.trim(),
      'merchantCountry': _country,
      'categoryCode': _category,
      'quantity': _quantity,
      if (_variant.text.trim().isNotEmpty) 'variant': _variant.text.trim(),
      'unitPriceMinor': _priceMinor(catalog),
      'priceCurrency': _currency,
      if (_notes.text.trim().isNotEmpty) 'notes': _notes.text.trim(),
      if (budget != null && budget > 0) 'maxBudgetIdr': budget,
      if (_neededBy != null) 'neededBy': JkDates.toYmd(_neededBy!),
      'destinationCountry': 'ID',
      if (_city.text.trim().isNotEmpty) 'destinationCity': _city.text.trim(),
      'deliveryPreference': _delivery,
      if (_imageUrl != null) 'imageUrls': <String>[_imageUrl!],
      if (_imageFileIds.isNotEmpty) 'imageFileIds': List<String>.of(_imageFileIds),
      if (extraction != null) 'extraction': <String, dynamic>{'mode': extraction.mode, 'confidence': extraction.confidence},
      'acknowledgeRestriction': _ack,
      'publish': publish,
    };
    setState(() => _submitting = true);
    try {
      final created = await ref.read(requestRepositoryProvider).create(body);
      if (!mounted) return;
      showJkSnack(context, publish ? context.l10n.requestPublished : context.l10n.requestSavedDraft);
      context.pushReplacement(Routes.request(created.id));
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final catalogValue = ref.watch(catalogProvider);
    final catalog = catalogValue.valueOrNull;
    final extraction = _extraction;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.createRequestTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s12),
          children: <Widget>[
            Wrap(
              spacing: JkSpacing.s2,
              runSpacing: JkSpacing.s2,
              children: <Widget>[
                for (final s in _Source.values)
                  ChoiceChip(
                    label: Text(_sourceLabel(l10n, s)),
                    selected: _source == s,
                    onSelected: (bool v) => setState(() {
                      _source = s;
                      if (s == _Source.manual) _showForm = true;
                    }),
                  ),
              ],
            ),
            const SizedBox(height: JkSpacing.s4),
            ..._sourceSection(l10n),
            if (_extracting) ...<Widget>[
              const SizedBox(height: JkSpacing.s4),
              Center(child: Semantics(label: l10n.loading, child: const CircularProgressIndicator())),
            ],
            if (extraction != null) ...<Widget>[
              const SizedBox(height: JkSpacing.s3),
              Wrap(
                spacing: JkSpacing.s2,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: <Widget>[
                  if (extraction.mode != 'LIVE') const SandboxBadge(),
                  Text(
                    l10n.extractionConfidence((extraction.confidence * 100).round()),
                    style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted),
                  ),
                ],
              ),
              if (extraction.needsManualInput)
                Padding(
                  padding: const EdgeInsets.only(top: JkSpacing.s2),
                  child: NoticeBox(tone: NoticeTone.warning, message: l10n.extractionNeedsManual),
                ),
            ],
            if (_searchResults.isNotEmpty) ...<Widget>[
              SectionHeader(title: l10n.searchResults),
              for (final d in _searchResults)
                Padding(
                  padding: const EdgeInsets.only(bottom: JkSpacing.s2),
                  child: JkCard(
                    onTap: () => _applyDraft(d, catalog),
                    child: Row(
                      children: <Widget>[
                        ProductThumb(imageUrl: d.imageUrl, size: 48),
                        const SizedBox(width: JkSpacing.s3),
                        Expanded(child: Text(d.productName ?? '-', style: JkTypeScale.bodyL.copyWith(color: jk.onSurface))),
                        const Icon(Icons.chevron_right),
                      ],
                    ),
                  ),
                ),
            ],
            if (_showForm) ...<Widget>[
              const SizedBox(height: JkSpacing.s4),
              if (catalogValue.hasError && catalog == null)
                ErrorView(error: catalogValue.error!, compact: true, onRetry: () => ref.invalidate(catalogProvider))
              else
                ..._form(l10n, catalog),
            ],
          ],
        ),
      ),
    );
  }

  String _sourceLabel(AppLocalizations l10n, _Source s) => switch (s) {
        _Source.url => l10n.sourceUrl,
        _Source.photo => l10n.sourcePhoto,
        _Source.search => l10n.sourceSearch,
        _Source.manual => l10n.sourceManual,
      };

  List<Widget> _sourceSection(AppLocalizations l10n) => switch (_source) {
        _Source.url => <Widget>[
            JkTextField(
              label: l10n.urlLabel,
              controller: _url,
              hint: l10n.urlHint,
              keyboardType: TextInputType.url,
              prefixIcon: const Icon(Icons.link),
              textInputAction: TextInputAction.go,
              onSubmitted: (String _) => _extractUrl(),
            ),
            const SizedBox(height: JkSpacing.s3),
            JkButton(label: l10n.urlExtract, icon: Icons.auto_awesome_outlined, loading: _extracting, onPressed: _extractUrl),
          ],
        _Source.photo => <Widget>[
            Text(l10n.photoIntro, style: JkTypeScale.bodyM.copyWith(color: context.jk.onBackgroundMuted)),
            const SizedBox(height: JkSpacing.s3),
            Row(
              children: <Widget>[
                Expanded(
                  child: JkButton(
                    label: l10n.photoCamera,
                    icon: Icons.photo_camera_outlined,
                    variant: JkButtonVariant.secondary,
                    onPressed: _extracting ? null : () => _photo(true),
                  ),
                ),
                const SizedBox(width: JkSpacing.s3),
                Expanded(
                  child: JkButton(
                    label: l10n.photoGallery,
                    icon: Icons.photo_library_outlined,
                    variant: JkButtonVariant.secondary,
                    onPressed: _extracting ? null : () => _photo(false),
                  ),
                ),
              ],
            ),
          ],
        _Source.search => <Widget>[
            JkTextField(
              label: l10n.searchLabel,
              controller: _query,
              hint: l10n.searchHint,
              prefixIcon: const Icon(Icons.search),
              textInputAction: TextInputAction.search,
              onSubmitted: (String _) => _search(),
            ),
            const SizedBox(height: JkSpacing.s3),
            JkButton(label: l10n.searchAction, icon: Icons.search, loading: _extracting, onPressed: _search),
          ],
        _Source.manual => <Widget>[
            Text(l10n.manualIntro, style: JkTypeScale.bodyM.copyWith(color: context.jk.onBackgroundMuted)),
          ],
      };

  List<Widget> _form(AppLocalizations l10n, Catalog? catalog) {
    final locale = context.localeCode;
    final jk = context.jk;
    final check = _check;
    final estimate = _estimate;
    final checkError = _checkError;
    final classification = check?.classification;
    final prohibited = Restriction.blocksCheckout(classification);
    final needsAck = check?.requiresAcknowledgement ?? Restriction.needsAcknowledgement(classification);
    final canPublish = check != null && !prohibited && (!needsAck || _ack);
    const gap = SizedBox(height: JkSpacing.s4);
    final currencies = <String>{
      ...?catalog?.currencies.map((CurrencyInfo c) => c.code),
      if (_currency != null) _currency!,
    }.toList()
      ..sort();
    return <Widget>[
      SectionHeader(title: l10n.requestFormTitle),
      JkTextField(
        label: l10n.fieldProductName,
        controller: _name,
        errorText: _errors['name'],
        textCapitalization: TextCapitalization.sentences,
        onChanged: (String _) => _invalidateCheck(),
      ),
      gap,
      JkTextField(label: l10n.fieldMerchant, controller: _merchant, hint: l10n.fieldMerchantHint),
      gap,
      PickerField<String>(
        label: l10n.fieldCountry,
        value: _country,
        errorText: _errors['country'],
        options: <PickerOption<String>>[
          for (final c in catalog?.origins ?? const <Country>[])
            PickerOption<String>(c.code, '${PopularOrigins.flag(c.code)} ${c.name(locale)}'),
        ],
        onChanged: (String v) {
          setState(() {
            _country = v;
            _currency ??= catalog?.country(v)?.currencyCode;
          });
          _invalidateCheck();
        },
      ),
      gap,
      PickerField<String>(
        label: l10n.fieldCategory,
        value: _category,
        errorText: _errors['category'],
        options: <PickerOption<String>>[
          for (final c in catalog?.categories ?? const <ProductCategory>[]) PickerOption<String>(c.code, c.name(locale)),
        ],
        onChanged: (String v) {
          setState(() => _category = v);
          _invalidateCheck();
        },
      ),
      gap,
      QuantityStepper(
        label: l10n.fieldQuantity,
        value: _quantity,
        onChanged: (int v) {
          setState(() => _quantity = v);
          _invalidateCheck();
        },
      ),
      gap,
      JkTextField(label: l10n.fieldVariant, controller: _variant, hint: l10n.fieldVariantHint),
      gap,
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            flex: 3,
            child: JkTextField(
              label: l10n.fieldPrice,
              controller: _price,
              errorText: _errors['price'],
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: JkTextField.moneyFormatters,
              onChanged: (String _) => _invalidateCheck(),
            ),
          ),
          const SizedBox(width: JkSpacing.s3),
          Expanded(
            flex: 2,
            child: PickerField<String>(
              label: l10n.fieldCurrency,
              value: _currency,
              errorText: _errors['currency'],
              options: <PickerOption<String>>[for (final c in currencies) PickerOption<String>(c, c)],
              onChanged: (String v) {
                setState(() => _currency = v);
                _invalidateCheck();
              },
            ),
          ),
        ],
      ),
      gap,
      JkTextField(
        label: l10n.fieldMaxBudget,
        controller: _budget,
        hint: l10n.fieldMaxBudgetHint,
        prefixText: 'Rp ',
        keyboardType: TextInputType.number,
        inputFormatters: JkTextField.digitsOnly,
      ),
      gap,
      DatePickerField(
        label: l10n.fieldNeededBy,
        value: _neededBy,
        display: (DateTime d) => JkDates.calendar(JkDates.toYmd(d), locale),
        onChanged: (DateTime d) => setState(() => _neededBy = d),
      ),
      gap,
      JkTextField(label: l10n.fieldDestinationCity, controller: _city, hint: l10n.fieldDestinationCityHint),
      gap,
      Text(l10n.fieldDeliveryPreference, style: JkTypeScale.labelL.copyWith(color: jk.onSurface)),
      const SizedBox(height: 6),
      Wrap(
        spacing: JkSpacing.s2,
        runSpacing: JkSpacing.s2,
        children: <Widget>[
          for (final m in <String>['ANY', ...DeliveryMethod.all])
            ChoiceChip(
              label: Text(m == 'ANY' ? l10n.deliveryAny : Labels.deliveryMethod(l10n, m)),
              selected: _delivery == m,
              onSelected: (bool v) => setState(() => _delivery = m),
            ),
        ],
      ),
      gap,
      JkTextField(label: l10n.fieldNotes, controller: _notes, maxLines: 4, minLines: 2, hint: l10n.fieldNotesHint),
      const SizedBox(height: JkSpacing.s5),
      JkButton(
        label: l10n.requestCheckRules,
        icon: Icons.fact_check_outlined,
        variant: JkButtonVariant.tonal,
        loading: _checking,
        onPressed: _runCheck,
      ),
      if (checkError != null) ErrorView(error: checkError, compact: true, onRetry: _runCheck),
      if (check != null) ...<Widget>[
        const SizedBox(height: JkSpacing.s4),
        RestrictedItemWarning(
          classification: check.classification,
          messages: check.messages,
          permitAuthorities: check.permitAuthorities,
          ruleRef: check.ruleRef,
          disclaimer: check.disclaimer,
          acknowledged: _ack,
          showAllowed: true,
          onAcknowledgedChanged: (bool v) => setState(() => _ack = v),
        ),
      ],
      if (estimate != null) ...<Widget>[
        const SizedBox(height: JkSpacing.s4),
        _CustomsEstimateCard(estimate: estimate),
      ],
      const SizedBox(height: JkSpacing.s5),
      JkButton(
        label: l10n.requestPublish,
        icon: Icons.send_outlined,
        loading: _submitting,
        onPressed: canPublish ? () => _submit(publish: true) : null,
        disabledReason: check == null
            ? l10n.requestPublishNeedsCheck
            : prohibited
                ? l10n.restrictionProhibitedTitle
                : (needsAck && !_ack ? l10n.requestPublishNeedsAck : null),
      ),
      const SizedBox(height: JkSpacing.s2),
      JkButton(
        label: l10n.requestSaveDraft,
        variant: JkButtonVariant.secondary,
        onPressed: _submitting ? null : () => _submit(publish: false),
      ),
    ];
  }
}

class _CustomsEstimateCard extends StatelessWidget {
  const _CustomsEstimateCard({required this.estimate});

  final CustomsEstimate estimate;

  @override
  Widget build(BuildContext context) {
    final jk = context.jk;
    final l10n = context.l10n;
    final disclaimer = estimate.disclaimer;
    return JkCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Wrap(
            spacing: JkSpacing.s2,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: <Widget>[
              Text(l10n.customsEstimateTitle, style: JkTypeScale.titleS.copyWith(color: jk.onSurface)),
              const EstimateBadge(),
            ],
          ),
          const SizedBox(height: JkSpacing.s2),
          _row(context, l10n.priceLineCustomsDuty, estimate.dutyIdr),
          _row(context, l10n.priceLineImportTax, estimate.importTaxIdr),
          const Divider(height: JkSpacing.s5),
          _row(context, l10n.customsEstimateTotal, estimate.totalIdr, bold: true),
          const SizedBox(height: JkSpacing.s2),
          Text(
            estimate.treatmentExplanation ?? l10n.customsTreatmentNote,
            style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted),
          ),
          for (final w in estimate.warnings) Text('• $w', style: JkTypeScale.bodyS.copyWith(color: jk.warningText)),
          if (disclaimer != null) ...<Widget>[
            const SizedBox(height: JkSpacing.s2),
            Text(disclaimer, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
          ],
        ],
      ),
    );
  }

  Widget _row(BuildContext context, String label, int amount, {bool bold = false}) {
    final jk = context.jk;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: LabeledAmount(
        label: Text(
          label,
          style: (bold ? JkTypeScale.titleS : JkTypeScale.bodyM).copyWith(color: jk.onSurface),
        ),
        amount: MoneyText(amount, emphasized: bold, semanticsPrefix: l10nPrefix(context, label)),
      ),
    );
  }

  static String l10nPrefix(BuildContext context, String label) => context.l10n.estimateSemanticsPrefix(label);
}
