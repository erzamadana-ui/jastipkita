import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/theme.dart';
import '../../../core/design/tokens.g.dart';
import '../../../core/domain/domain.dart';
import '../../../core/format/dates.dart';
import '../../../core/l10n/l10n.dart';
import '../../../core/l10n/labels.dart';
import '../../../core/models/marketplace.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/router/deep_links.dart';
import '../../../widgets/cards.dart';
import '../../../widgets/common.dart';
import '../../../widgets/jk_button.dart';
import '../../../widgets/jk_text_field.dart';
import '../../../widgets/pickers.dart';
import '../../../widgets/sheets_and_glass.dart';
import '../../../widgets/states.dart';
import '../../auth/application/session_controller.dart';
import '../../catalog/data/catalog_repository.dart';
import '../../files/data/file_upload_service.dart';
import '../../requests/data/request_repository.dart';
import '../data/trip_repository.dart';

final _tripMatchesProvider = FutureProvider.autoDispose.family<List<RecommendedRequest>, String>(
  (ref, tripId) => ref.watch(tripRepositoryProvider).recommendedRequests(tripId),
);

/// Trip detail — owner: verification upload, publish (KYC ≥ 3), depart/complete/cancel and
/// matching requests. Others: public trip + "Titip ke trip ini" (invite with an OPEN request).
class TripDetailScreen extends ConsumerStatefulWidget {
  const TripDetailScreen({super.key, required this.tripId});

  final String tripId;

  @override
  ConsumerState<TripDetailScreen> createState() => _TripDetailScreenState();
}

class _TripDetailScreenState extends ConsumerState<TripDetailScreen> {
  String? _busy;

  void _reload() {
    ref.invalidate(tripDetailProvider(widget.tripId));
    ref.invalidate(_tripMatchesProvider(widget.tripId));
    ref.invalidate(myActiveTripsProvider);
  }

  Future<void> _act(String key, Future<Object?> Function() action, String success) async {
    if (_busy != null) return;
    setState(() => _busy = key);
    try {
      await action();
      if (!mounted) return;
      showJkSnack(context, success);
      _reload();
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.code != 'TRIP_HAS_PURCHASED_TRANSACTIONS') {
        showJkSnack(context, errorMessage(context.l10n, e), error: true);
        return;
      }
      await _showPurchasedBlock(e);
    } on Object catch (e) {
      if (!mounted) return;
      showJkSnack(context, errorMessage(context.l10n, e), error: true);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  /// `409 TRIP_HAS_PURCHASED_TRANSACTIONS {transactionIds}`: goods were already bought on this trip,
  /// so it can no longer be cancelled — the traveler must deliver them (or contact support).
  Future<void> _showPurchasedBlock(ApiException e) async {
    final l10n = context.l10n;
    final raw = e.details['transactionIds'];
    final ids = raw is List ? raw.map((Object? id) => '$id').where((String id) => id.isNotEmpty).toList() : const <String>[];
    final open = await showJkConfirm(
      context,
      title: l10n.tripHasPurchasedTitle,
      message: errorMessage(l10n, e),
      confirmLabel: l10n.tripHasPurchasedAction,
      cancelLabel: l10n.actionClose,
    );
    if (!open || !mounted) return;
    if (ids.length == 1) {
      context.push(Routes.transaction(ids.first));
    } else {
      context.go(Routes.orders);
    }
  }

  Future<void> _cancel() async {
    final l10n = context.l10n;
    final reason = TextEditingController();
    final ok = await showJkConfirm(
      context,
      title: l10n.tripCancelTitle,
      message: l10n.tripCancelBody,
      confirmLabel: l10n.tripCancelConfirm,
      destructive: true,
      extra: JkTextField(label: l10n.cancelReasonLabel, controller: reason, maxLines: 2),
    );
    final text = reason.text.trim();
    reason.dispose();
    if (!ok) return;
    await _act('cancel', () => ref.read(tripRepositoryProvider).cancel(widget.tripId, text.isEmpty ? l10n.cancelReasonDefault : text), l10n.tripCancelled);
  }

  Future<void> _depart() async {
    final l10n = context.l10n;
    final ok = await showJkConfirm(context, title: l10n.tripDepartTitle, message: l10n.tripDepartBody, confirmLabel: l10n.tripDepart);
    if (!ok) return;
    await _act('depart', () => ref.read(tripRepositoryProvider).depart(widget.tripId), l10n.tripDeparted);
  }

  Future<void> _uploadDocument() async {
    final l10n = context.l10n;
    final done = await showJkBottomSheet<bool>(
      context,
      title: l10n.tripUploadDoc,
      builder: (BuildContext sheetContext) => _TripDocumentForm(tripId: widget.tripId),
    );
    if (done != true) return;
    if (!mounted) return;
    showJkSnack(context, l10n.tripDocSubmitted);
    _reload();
  }

  Future<void> _invite(Trip trip) async {
    final l10n = context.l10n;
    final sent = await showJkBottomSheet<bool>(
      context,
      title: l10n.tripInviteTitle,
      builder: (BuildContext sheetContext) => _InviteForm(tripId: trip.id),
    );
    if (sent != true) return;
    if (!mounted) return;
    showJkSnack(context, l10n.inviteSent);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final value = ref.watch(tripDetailProvider(widget.tripId));
    return Scaffold(
      appBar: AppBar(title: Text(l10n.tripDetailTitle)),
      body: AsyncValueView<Trip>(
        value: value,
        onRetry: _reload,
        data: (Trip trip) => JkRefresh(
          onRefresh: () => refreshSafely(() async {
            _reload();
            return ref.read(tripDetailProvider(widget.tripId).future);
          }),
          child: trip.isOwnerView ? _ownerView(trip) : _publicView(trip),
        ),
      ),
    );
  }

  String _statusNote(AppLocalizations l10n, String status) {
    switch (status) {
      case TripStatus.draft:
        return l10n.tripNoteDraft;
      case TripStatus.verificationPending:
        return l10n.tripNotePending;
      case TripStatus.verified:
        return l10n.tripNoteVerified;
      case TripStatus.active:
        return l10n.tripNoteActive;
      case TripStatus.full:
        return l10n.tripNoteFull;
      case TripStatus.traveling:
        return l10n.tripNoteTraveling;
      default:
        return l10n.tripNoteClosed;
    }
  }

  Widget _ownerView(Trip trip) {
    final l10n = context.l10n;
    final jk = context.jk;
    final locale = context.localeCode;
    final kycLevel = ref.watch(currentProfileProvider)?.kycLevel ?? 1;
    final canPublish = trip.allowedActions.contains('PUBLISH');
    final kycBlocked = kycLevel < KycLevel.identityVerified;
    final matchable = trip.status == TripStatus.active || trip.status == TripStatus.full;
    final catalog = ref.watch(catalogProvider).valueOrNull;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s12),
      children: <Widget>[
        TripCard(trip: trip),
        const SizedBox(height: JkSpacing.s3),
        NoticeBox(message: _statusNote(l10n, trip.status)),
        if (trip.excludedCategories.isNotEmpty) ...<Widget>[
          const SizedBox(height: JkSpacing.s3),
          Text(
            l10n.tripExcludedList(trip.excludedCategories.map((String c) => catalog?.categoryName(c, locale) ?? c).join(', ')),
            style: JkTypeScale.bodyS.copyWith(color: jk.onBackgroundMuted),
          ),
        ],
        SectionHeader(title: l10n.tripDocsTitle),
        if (trip.verifications.isEmpty)
          Text(l10n.tripDocsEmpty, style: JkTypeScale.bodyM.copyWith(color: jk.onBackgroundMuted))
        else
          for (final v in trip.verifications)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(Icons.description_outlined, color: jk.secondary),
              title: Text(Labels.docType(l10n, v.docType)),
              subtitle: Text(
                <String>[
                  v.status,
                  if (v.flightNumber != null) v.flightNumber!,
                  if (v.createdAt != null) JkDates.date(v.createdAt!, locale),
                ].join(' · '),
              ),
            ),
        if (trip.allowedActions.contains('UPLOAD_VERIFICATION')) ...<Widget>[
          const SizedBox(height: JkSpacing.s2),
          JkButton(
            label: l10n.tripUploadDoc,
            icon: Icons.upload_file_outlined,
            variant: JkButtonVariant.tonal,
            onPressed: _busy == null ? _uploadDocument : null,
          ),
        ],
        const SizedBox(height: JkSpacing.s5),
        if (canPublish)
          JkButton(
            label: l10n.tripPublish,
            icon: Icons.public,
            loading: _busy == 'publish',
            onPressed: kycBlocked || _busy != null
                ? null
                : () => _act('publish', () => ref.read(tripRepositoryProvider).publish(trip.id), l10n.tripPublished),
            disabledReason: kycBlocked ? l10n.tripPublishNeedsKyc : null,
          ),
        if (canPublish && kycBlocked)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(onPressed: () => context.push(Routes.kyc), child: Text(l10n.travelerKycCardCta)),
          ),
        if (trip.allowedActions.contains('DEPART')) ...<Widget>[
          const SizedBox(height: JkSpacing.s3),
          JkButton(label: l10n.tripDepart, icon: Icons.flight_takeoff, loading: _busy == 'depart', onPressed: _busy == null ? _depart : null),
        ],
        if (trip.allowedActions.contains('COMPLETE')) ...<Widget>[
          const SizedBox(height: JkSpacing.s3),
          JkButton(
            label: l10n.tripComplete,
            icon: Icons.flag_outlined,
            loading: _busy == 'complete',
            onPressed: _busy == null ? () => _act('complete', () => ref.read(tripRepositoryProvider).complete(trip.id), l10n.tripCompleted) : null,
          ),
        ],
        if (trip.allowedActions.contains('CANCEL')) ...<Widget>[
          const SizedBox(height: JkSpacing.s3),
          JkButton(
            label: l10n.tripCancelTitle,
            variant: JkButtonVariant.tertiary,
            loading: _busy == 'cancel',
            onPressed: _busy == null ? _cancel : null,
          ),
        ],
        if (matchable) ...<Widget>[
          SectionHeader(
            title: l10n.travelerMatchingRequests,
            actionLabel: l10n.actionSeeAll,
            onAction: () => context.push('${Routes.openRequests}?tripId=${trip.id}'),
          ),
          _TripMatches(tripId: trip.id),
        ],
      ],
    );
  }

  Widget _publicView(Trip trip) {
    final l10n = context.l10n;
    final isBuyer = !(ref.watch(currentProfileProvider)?.isTraveler ?? false);
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(JkSpacing.s5, JkSpacing.s4, JkSpacing.s5, JkSpacing.s12),
      children: <Widget>[
        TravelerCard(recommendation: RecommendedTrip(trip: trip, score: 0, reasons: const <String>[], estimatedTravelerFeeIdr: 0)),
        const SizedBox(height: JkSpacing.s3),
        TripCard(trip: trip),
        const SizedBox(height: JkSpacing.s4),
        NoticeBox(tone: NoticeTone.success, icon: Icons.shield_outlined, message: l10n.homeSafepayStrip),
        if (isBuyer && trip.status == TripStatus.active) ...<Widget>[
          const SizedBox(height: JkSpacing.s4),
          JkButton(label: l10n.tripTitipHere, icon: Icons.add_shopping_cart_outlined, onPressed: () => _invite(trip)),
        ],
      ],
    );
  }
}

class _TripMatches extends ConsumerWidget {
  const _TripMatches({required this.tripId});

  final String tripId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final jk = context.jk;
    final value = ref.watch(_tripMatchesProvider(tripId));
    return value.when(
      data: (List<RecommendedRequest> list) {
        if (list.isEmpty) return Text(l10n.travelerNoMatchingRequests, style: JkTypeScale.bodyM.copyWith(color: jk.onBackgroundMuted));
        return Column(
          children: <Widget>[
            for (final m in list.take(5))
              Padding(
                padding: const EdgeInsets.only(bottom: JkSpacing.s3),
                child: RequestCard(
                  request: m.request,
                  onTap: () => context.push(Routes.openRequest(m.request.id, tripId: tripId)),
                  trailing: m.reasons.isEmpty
                      ? null
                      : Text(m.reasons.join(' · '), style: JkTypeScale.labelM.copyWith(color: jk.infoText)),
                ),
              ),
          ],
        );
      },
      loading: () => const Skeleton(height: 120, radius: JkRadii.lg),
      error: (Object e, StackTrace s) => ErrorView(error: e, compact: true, onRetry: () => ref.invalidate(_tripMatchesProvider(tripId))),
    );
  }
}

class _TripDocumentForm extends ConsumerStatefulWidget {
  const _TripDocumentForm({required this.tripId});

  final String tripId;

  @override
  ConsumerState<_TripDocumentForm> createState() => _TripDocumentFormState();
}

class _TripDocumentFormState extends ConsumerState<_TripDocumentForm> {
  String _docType = 'ETICKET';
  final TextEditingController _flight = TextEditingController();
  DateTime? _flightDate;
  PickedUpload? _file;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _flight.dispose();
    super.dispose();
  }

  Future<void> _pick(bool document) async {
    final picker = ref.read(mediaPickerProvider);
    final file = document ? await picker.document() : await picker.image(camera: true);
    if (file == null || !mounted) return;
    setState(() => _file = file);
  }

  Future<void> _submit() async {
    final file = _file;
    if (file == null) {
      setState(() => _error = context.l10n.tripDocRequired);
      return;
    }
    final flightDate = _flightDate;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final fileId = await ref.read(fileUploadServiceProvider).upload(file, purpose: FilePurpose.tripDoc);
      await ref.read(tripRepositoryProvider).submitDocument(
            widget.tripId,
            docType: _docType,
            fileId: fileId,
            flightNumber: _flight.text.trim(),
            flightDate: flightDate == null ? null : JkDates.toYmd(flightDate),
          );
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = errorMessage(context.l10n, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final jk = context.jk;
    final locale = context.localeCode;
    final file = _file;
    final error = _error;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(l10n.tripDocIntro, style: JkTypeScale.bodyM.copyWith(color: jk.onSurface)),
        const SizedBox(height: JkSpacing.s3),
        Wrap(
          spacing: JkSpacing.s2,
          children: <Widget>[
            for (final t in <String>['ETICKET', 'ITINERARY', 'BOARDING_PASS'])
              ChoiceChip(
                label: Text(Labels.docType(l10n, t)),
                selected: _docType == t,
                onSelected: (bool v) => setState(() => _docType = t),
              ),
          ],
        ),
        const SizedBox(height: JkSpacing.s3),
        JkTextField(label: l10n.tripFlightNumber, controller: _flight, hint: l10n.optional, textCapitalization: TextCapitalization.characters),
        const SizedBox(height: JkSpacing.s3),
        DatePickerField(
          label: l10n.tripFlightDate,
          value: _flightDate,
          display: (DateTime d) => JkDates.calendar(JkDates.toYmd(d), locale),
          onChanged: (DateTime d) => setState(() => _flightDate = d),
        ),
        const SizedBox(height: JkSpacing.s3),
        Row(
          children: <Widget>[
            Expanded(
              child: JkButton(
                label: l10n.pickDocument,
                icon: Icons.picture_as_pdf_outlined,
                variant: JkButtonVariant.secondary,
                onPressed: _busy ? null : () => _pick(true),
              ),
            ),
            const SizedBox(width: JkSpacing.s2),
            Expanded(
              child: JkButton(
                label: l10n.photoCamera,
                icon: Icons.photo_camera_outlined,
                variant: JkButtonVariant.secondary,
                onPressed: _busy ? null : () => _pick(false),
              ),
            ),
          ],
        ),
        if (file != null)
          Padding(
            padding: const EdgeInsets.only(top: JkSpacing.s2),
            child: Text(l10n.fileSelected(file.name), style: JkTypeScale.bodyS.copyWith(color: jk.successText)),
          ),
        const SizedBox(height: JkSpacing.s2),
        Text(l10n.tripDocPrivacy, style: JkTypeScale.bodyS.copyWith(color: jk.onSurfaceMuted)),
        if (error != null) ...<Widget>[
          const SizedBox(height: JkSpacing.s2),
          NoticeBox(tone: NoticeTone.error, message: error),
        ],
        const SizedBox(height: JkSpacing.s4),
        JkButton(label: l10n.tripDocSubmit, loading: _busy, onPressed: _submit),
      ],
    );
  }
}

final _myOpenRequestsProvider = FutureProvider.autoDispose<List<RequestItem>>((ref) async {
  final page = await ref.watch(requestRepositoryProvider).mine(status: RequestStatus.open);
  return page.items;
});

class _InviteForm extends ConsumerStatefulWidget {
  const _InviteForm({required this.tripId});

  final String tripId;

  @override
  ConsumerState<_InviteForm> createState() => _InviteFormState();
}

class _InviteFormState extends ConsumerState<_InviteForm> {
  String? _requestId;
  bool _busy = false;
  String? _error;

  Future<void> _send() async {
    final requestId = _requestId;
    if (requestId == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(requestRepositoryProvider).invite(tripId: widget.tripId, requestId: requestId);
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _error = errorMessage(context.l10n, e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final value = ref.watch(_myOpenRequestsProvider);
    final error = _error;
    return value.when(
      data: (List<RequestItem> list) {
        if (list.isEmpty) {
          return EmptyState(
            icon: Icons.inventory_2_outlined,
            title: l10n.inviteNoOpenRequests,
            actionLabel: l10n.homeCreateRequest,
            onAction: () {
              final router = GoRouter.of(context);
              Navigator.of(context).pop(false);
              router.push(Routes.newRequest);
            },
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            PickerField<String>(
              label: l10n.inviteChooseRequest,
              value: _requestId,
              options: <PickerOption<String>>[for (final r in list) PickerOption<String>(r.id, r.productName)],
              onChanged: (String v) => setState(() => _requestId = v),
            ),
            if (error != null) ...<Widget>[
              const SizedBox(height: JkSpacing.s2),
              NoticeBox(tone: NoticeTone.error, message: error),
            ],
            const SizedBox(height: JkSpacing.s4),
            JkButton(label: l10n.inviteTraveler, loading: _busy, onPressed: _requestId == null ? null : _send),
          ],
        );
      },
      loading: () => const Padding(padding: EdgeInsets.all(JkSpacing.s6), child: Center(child: CircularProgressIndicator())),
      error: (Object e, StackTrace s) => ErrorView(error: e, onRetry: () => ref.invalidate(_myOpenRequestsProvider)),
    );
  }
}
