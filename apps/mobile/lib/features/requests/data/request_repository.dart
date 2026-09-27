import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/json.dart';
import '../../../core/models/marketplace.dart';
import '../../../core/network/api_client.dart';

/// Requests (titipan), matching and offers — docs/api/marketplace.md §2.2–2.3.
class RequestRepository {
  RequestRepository(this._api);

  final ApiClient _api;

  static const int pageSize = 20;

  /// `POST /requests/extract` — drafts from a URL, an uploaded photo or a search query.
  Future<ExtractionResult> extract({String? url, String? fileId, String? query, String? country}) async {
    final json = await _api.post(
      '/requests/extract',
      body: <String, dynamic>{
        if (url != null) 'url': url,
        if (fileId != null) 'fileId': fileId,
        if (query != null) 'query': query,
        if (country != null) 'country': country,
      },
    );
    return ExtractionResult.fromJson(json);
  }

  Future<RequestItem> create(Json body) async => RequestItem.fromJson(await _api.post('/requests', body: body));

  Future<RequestItem> update(String id, Json body) async => RequestItem.fromJson(await _api.patch('/requests/$id', body: body));

  Future<RequestItem> publish(String id, {required bool acknowledgeRestriction}) async => RequestItem.fromJson(
        await _api.post('/requests/$id/publish', body: <String, dynamic>{'acknowledgeRestriction': acknowledgeRestriction}),
      );

  Future<RequestItem> cancel(String id, {String? reason}) async => RequestItem.fromJson(
        await _api.post('/requests/$id/cancel', body: <String, dynamic>{if (reason != null) 'reason': reason}),
      );

  Future<Paged<RequestItem>> mine({String? cursor, String? status}) async => Paged.parse(
        await _api.get('/requests/mine', query: <String, Object?>{'limit': pageSize, 'cursor': cursor, 'status': status}),
        RequestItem.fromJson,
      );

  /// Traveler view: OPEN requests matching my ACTIVE trips.
  Future<Paged<RequestItem>> open({String? cursor, String? tripId}) async => Paged.parse(
        await _api.get('/requests/open', query: <String, Object?>{'limit': pageSize, 'cursor': cursor, 'tripId': tripId}),
        RequestItem.fromJson,
      );

  Future<RequestItem> get(String id) async => RequestItem.fromJson(readObject(await _api.get('/requests/$id'), 'request'));

  Future<List<RecommendedTrip>> recommendedTravelers(String requestId, {int limit = 10}) async => readList(
        await _api.get('/requests/$requestId/recommended-travelers', query: <String, Object?>{'limit': limit}),
        'data',
      ).map(RecommendedTrip.fromJson).toList();

  Future<List<Offer>> offersFor(String requestId) async =>
      readList(await _api.get('/requests/$requestId/offers'), 'data').map(Offer.fromJson).toList();

  Future<Offer> sendOffer({required String requestId, required String tripId, int? travelerFeeIdr, String? message}) async =>
      Offer.fromJson(
        await _api.post(
          '/requests/$requestId/offers',
          body: <String, dynamic>{
            'tripId': tripId,
            if (travelerFeeIdr != null) 'travelerFeeIdr': travelerFeeIdr,
            if (message != null && message.isNotEmpty) 'message': message,
          },
        ),
      );

  /// Buyer invites a traveler's ACTIVE trip for an OPEN request.
  Future<Offer> invite({required String tripId, required String requestId, String? message}) async => Offer.fromJson(
        await _api.post(
          '/trips/$tripId/invites',
          body: <String, dynamic>{'requestId': requestId, if (message != null && message.isNotEmpty) 'message': message},
        ),
      );

  Future<Paged<Offer>> offersMine({required String role, String? status, String? cursor}) async => Paged.parse(
        await _api.get('/offers/mine', query: <String, Object?>{'role': role, 'status': status, 'cursor': cursor, 'limit': pageSize}),
        Offer.fromJson,
      );

  /// Accept → creates the transaction (MATCHED). Returns the transaction id.
  Future<String> accept(String offerId) async {
    final json = await _api.post('/offers/$offerId/accept');
    return readString(readObject(json, 'transaction'), 'id');
  }

  Future<Offer> decline(String offerId, {String? reason}) async => Offer.fromJson(
        await _api.post('/offers/$offerId/decline', body: <String, dynamic>{if (reason != null) 'reason': reason}),
      );

  Future<Offer> withdraw(String offerId) async => Offer.fromJson(await _api.post('/offers/$offerId/withdraw'));
}

final requestRepositoryProvider = Provider<RequestRepository>((ref) => RequestRepository(ref.watch(apiClientProvider)));

final requestDetailProvider = FutureProvider.autoDispose.family<RequestItem, String>(
  (ref, id) => ref.watch(requestRepositoryProvider).get(id),
);

final requestOffersProvider = FutureProvider.autoDispose.family<List<Offer>, String>(
  (ref, id) => ref.watch(requestRepositoryProvider).offersFor(id),
);

final recommendedTravelersProvider = FutureProvider.autoDispose.family<List<RecommendedTrip>, String>(
  (ref, id) => ref.watch(requestRepositoryProvider).recommendedTravelers(id),
);
