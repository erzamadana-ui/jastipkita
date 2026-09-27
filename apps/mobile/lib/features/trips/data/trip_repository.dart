import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/json.dart';
import '../../../core/models/marketplace.dart';
import '../../../core/network/api_client.dart';

/// Trips — docs/api/marketplace.md §2.1 (DRAFT → VERIFICATION_PENDING → VERIFIED → ACTIVE …).
class TripRepository {
  TripRepository(this._api);

  final ApiClient _api;

  static const int pageSize = 20;

  Future<Paged<Trip>> mine({String? cursor, String? status}) async => Paged.parse(
        await _api.get('/trips/mine', query: <String, Object?>{'limit': pageSize, 'cursor': cursor, 'status': status}),
        Trip.fromJson,
      );

  /// Public discovery (ACTIVE trips, no PII).
  Future<Paged<Trip>> discover({
    String? cursor,
    String? originCountry,
    String? destinationCity,
    bool verifiedOnly = false,
    int limit = pageSize,
  }) async =>
      Paged.parse(
        await _api.get(
          '/trips',
          query: <String, Object?>{
            'limit': limit,
            'cursor': cursor,
            'originCountry': originCountry,
            'destinationCity': destinationCity,
            if (verifiedOnly) 'verifiedOnly': 'true',
          },
        ),
        Trip.fromJson,
      );

  Future<Trip> get(String id) async => Trip.fromJson(readObject(await _api.get('/trips/$id'), 'trip'));

  Future<Trip> create(Json body) async => Trip.fromJson(await _api.post('/trips', body: body));

  Future<Trip> update(String id, Json body) async => Trip.fromJson(await _api.patch('/trips/$id', body: body));

  /// Submit an e-ticket / itinerary / boarding pass (TRIP_DOC file) → VERIFICATION_PENDING.
  Future<Trip> submitDocument(
    String id, {
    required String docType,
    required String fileId,
    String? flightNumber,
    String? flightDate,
  }) async =>
      Trip.fromJson(
        await _api.post(
          '/trips/$id/verification',
          body: <String, dynamic>{
            'docType': docType,
            'fileId': fileId,
            if (flightNumber != null && flightNumber.isNotEmpty) 'flightNumber': flightNumber,
            if (flightDate != null && flightDate.isNotEmpty) 'flightDate': flightDate,
          },
        ),
      );

  Future<Trip> publish(String id) async => Trip.fromJson(await _api.post('/trips/$id/publish'));

  Future<Trip> depart(String id) async => Trip.fromJson(await _api.post('/trips/$id/depart'));

  Future<Trip> complete(String id) async => Trip.fromJson(await _api.post('/trips/$id/complete'));

  Future<Trip> cancel(String id, String reason) async =>
      Trip.fromJson(await _api.post('/trips/$id/cancel', body: <String, dynamic>{'reason': reason}));

  Future<List<RecommendedRequest>> recommendedRequests(String tripId, {int limit = 20}) async => readList(
        await _api.get('/trips/$tripId/recommended-requests', query: <String, Object?>{'limit': limit}),
        'data',
      ).map(RecommendedRequest.fromJson).toList();
}

final tripRepositoryProvider = Provider<TripRepository>((ref) => TripRepository(ref.watch(apiClientProvider)));

final tripDetailProvider = FutureProvider.autoDispose.family<Trip, String>(
  (ref, id) => ref.watch(tripRepositoryProvider).get(id),
);

/// Traveler's active trips (for the home screen and the offer sheet).
final myActiveTripsProvider = FutureProvider.autoDispose<List<Trip>>((ref) async {
  final page = await ref.watch(tripRepositoryProvider).mine();
  return page.items.where((Trip t) => t.status == 'ACTIVE' || t.status == 'FULL').toList();
});

final myTripsProvider = FutureProvider.autoDispose<List<Trip>>((ref) async {
  final page = await ref.watch(tripRepositoryProvider).mine();
  return page.items;
});
