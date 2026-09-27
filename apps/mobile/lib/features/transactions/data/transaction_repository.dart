import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/engagement.dart';
import '../../../core/models/json.dart';
import '../../../core/models/transaction.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/idempotency.dart';

/// Money API — docs/api/money.md. Every money mutation goes through [FinancialCaller] so a retry
/// (automatic or "Coba lagi") reuses the same Idempotency-Key.
class TransactionRepository {
  TransactionRepository(this._api, this._financial);

  final ApiClient _api;
  final FinancialCaller _financial;

  static const int pageSize = 20;

  Future<Paged<TransactionSummary>> list({String? role, String? status, String? cursor}) async => Paged.parse(
        await _api.get('/transactions', query: <String, Object?>{'role': role, 'status': status, 'cursor': cursor, 'limit': pageSize}),
        TransactionSummary.fromJson,
      );

  Future<TransactionDetail> detail(String id) async => TransactionDetail.fromJson(await _api.get('/transactions/$id'));

  Future<List<TimelineEvent>> timeline(String id) async =>
      readList(await _api.get('/transactions/$id/timeline'), 'events').map(TimelineEvent.fromJson).toList();

  /// Transparent landed-cost quote (FX lock, customs estimate, restricted check, promo, credit).
  Future<Quote> quote(String id, {String? channel, String? promoCode, bool? useCredit}) async => Quote.fromJson(
        await _api.post(
          '/transactions/$id/quote',
          body: <String, dynamic>{
            if (channel != null) 'channel': channel,
            if (promoCode != null && promoCode.isNotEmpty) 'promoCode': promoCode,
            if (useCredit != null) 'useCredit': useCredit,
          },
        ),
      );

  Future<PromotionValidation> validatePromo(String transactionId, String code) async => PromotionValidation.fromJson(
        await _api.post('/promotions/validate', body: <String, dynamic>{'transactionId': transactionId, 'code': code}),
      );

  /// 💰 Start SafePay checkout for [quoteId]. Scope = quote, so every retry of this quote's
  /// checkout carries the same key and can never create a second payment.
  Future<CheckoutResult> checkout(String id, {required String quoteId, String? channel, bool acknowledgeRestricted = false}) =>
      _financial.run<CheckoutResult>('checkout:$id:$quoteId', (String key) async {
        final json = await _api.post(
          '/transactions/$id/checkout',
          idempotencyKey: key,
          body: <String, dynamic>{
            'quoteId': quoteId,
            if (channel != null) 'channel': channel,
            'acknowledgeRestricted': acknowledgeRestricted,
          },
        );
        return CheckoutResult.fromJson(json);
      });

  Future<(List<Payment>, Payment?)> payments(String id) async {
    final json = await _api.get('/transactions/$id/payment');
    final current = readObjectOrNull(json, 'current');
    return (readList(json, 'data').map(Payment.fromJson).toList(), current == null ? null : Payment.fromJson(current));
  }

  /// Traveler reports the actual shelf price (PAYMENT_SECURED only).
  Future<MoneyActionResult> priceCheck(
    String id, {
    required int actualUnitPriceMinor,
    required String currency,
    String? receiptFileId,
    String? photoFileId,
    String? notes,
  }) async =>
      MoneyActionResult(
        await _api.post(
          '/transactions/$id/price-check',
          body: <String, dynamic>{
            'actualUnitPriceMinor': actualUnitPriceMinor,
            'currency': currency,
            if (receiptFileId != null) 'receiptFileId': receiptFileId,
            if (photoFileId != null) 'photoFileId': photoFileId,
            if (notes != null && notes.isNotEmpty) 'notes': notes,
          },
        ),
      );

  /// 💰 Buyer: APPROVE / REJECT (no-fault full refund) / CLARIFY.
  Future<MoneyActionResult> respondPriceConfirmation(String id, String pcId, {required String action, String? note}) =>
      _financial.run<MoneyActionResult>('pc:$pcId:$action', (String key) async {
        final json = await _api.post(
          '/transactions/$id/price-confirmations/$pcId/respond',
          idempotencyKey: key,
          body: <String, dynamic>{'action': action, if (note != null && note.isNotEmpty) 'note': note},
        );
        return MoneyActionResult(json);
      });

  Future<MoneyActionResult> clarifyPrice(String id, String pcId, {required String note, int? actualUnitPriceMinor, String? receiptFileId}) async =>
      MoneyActionResult(
        await _api.post(
          '/transactions/$id/price-confirmations/$pcId/clarify',
          body: <String, dynamic>{
            'note': note,
            if (actualUnitPriceMinor != null) 'actualUnitPriceMinor': actualUnitPriceMinor,
            if (receiptFileId != null) 'receiptFileId': receiptFileId,
          },
        ),
      );

  /// Purchase proof — only accepted in PURCHASE_APPROVED (the server re-checks the golden rule).
  Future<MoneyActionResult> submitPurchaseProof(
    String id, {
    required String receiptFileId,
    required List<String> productPhotoFileIds,
    required String merchantName,
    required int actualPriceMinor,
    required String currency,
    required DateTime purchasedAt,
    String? videoFileId,
    String? serialNumber,
    String? receiptNumber,
  }) async =>
      MoneyActionResult(
        await _api.post(
          '/transactions/$id/purchase-proof',
          body: <String, dynamic>{
            'receiptFileId': receiptFileId,
            'productPhotoFileIds': productPhotoFileIds,
            'merchantName': merchantName,
            'actualPriceMinor': actualPriceMinor,
            'currency': currency,
            'purchasedAt': purchasedAt.toUtc().toIso8601String(),
            if (videoFileId != null) 'videoFileId': videoFileId,
            if (serialNumber != null && serialNumber.isNotEmpty) 'serialNumber': serialNumber,
            if (receiptNumber != null && receiptNumber.isNotEmpty) 'receiptNumber': receiptNumber,
          },
        ),
      );

  Future<MoneyActionResult> updateTravelStatus(String id, String to, {String? note}) async => MoneyActionResult(
        await _api.post('/transactions/$id/status', body: <String, dynamic>{'to': to, if (note != null && note.isNotEmpty) 'note': note}),
      );

  Future<MoneyActionResult> customsDeclaration(
    String id, {
    required int dutyPaidIdr,
    required int vatPaidIdr,
    required int incomeTaxPaidIdr,
    int? luxuryTaxPaidIdr,
    String? declarationRef,
    String? receiptFileId,
    String? notes,
  }) async =>
      MoneyActionResult(
        await _api.post(
          '/transactions/$id/customs-declaration',
          body: <String, dynamic>{
            'dutyPaidIdr': dutyPaidIdr,
            'vatPaidIdr': vatPaidIdr,
            'incomeTaxPaidIdr': incomeTaxPaidIdr,
            if (luxuryTaxPaidIdr != null) 'luxuryTaxPaidIdr': luxuryTaxPaidIdr,
            if (declarationRef != null && declarationRef.isNotEmpty) 'declarationRef': declarationRef,
            if (receiptFileId != null) 'receiptFileId': receiptFileId,
            if (notes != null && notes.isNotEmpty) 'notes': notes,
          },
        ),
      );

  Future<MoneyActionResult> setDelivery(
    String id, {
    required String method,
    String? meetupPoint,
    String? courierName,
    String? trackingNumber,
    String? addressCity,
    DateTime? scheduledAt,
  }) async =>
      MoneyActionResult(
        await _api.post(
          '/transactions/$id/delivery',
          body: <String, dynamic>{
            'method': method,
            if (meetupPoint != null && meetupPoint.isNotEmpty) 'meetupPoint': meetupPoint,
            if (courierName != null && courierName.isNotEmpty) 'courierName': courierName,
            if (trackingNumber != null && trackingNumber.isNotEmpty) 'trackingNumber': trackingNumber,
            if (addressCity != null && addressCity.isNotEmpty) 'addressCity': addressCity,
            if (scheduledAt != null) 'scheduledAt': scheduledAt.toUtc().toIso8601String(),
          },
        ),
      );

  /// Buyer only; the PIN rotates on every reveal and is never cached by the app.
  Future<HandoverPin> revealPin(String id) async => HandoverPin.fromJson(await _api.get('/transactions/$id/delivery/pin'));

  Future<MoneyActionResult> verifyHandover(String id, {String? pin, String? qrToken}) async => MoneyActionResult(
        await _api.post(
          '/transactions/$id/delivery/verify',
          body: <String, dynamic>{if (pin != null) 'pin': pin, if (qrToken != null) 'qrToken': qrToken},
        ),
      );

  Future<MoneyActionResult> markShipped(String id, {required String trackingNumber, String? courierName}) async => MoneyActionResult(
        await _api.post(
          '/transactions/$id/delivery/shipped',
          body: <String, dynamic>{'trackingNumber': trackingNumber, if (courierName != null && courierName.isNotEmpty) 'courierName': courierName},
        ),
      );

  Future<MoneyActionResult> markDelivered(String id, {required List<String> proofFileIds}) async => MoneyActionResult(
        await _api.post('/transactions/$id/delivery/delivered', body: <String, dynamic>{'proofFileIds': proofFileIds}),
      );

  /// 💰 Buyer confirms receipt → release + payout.
  Future<MoneyActionResult> confirmReceipt(String id) => _financial.run<MoneyActionResult>(
        'confirm-receipt:$id',
        (String key) async => MoneyActionResult(await _api.post('/transactions/$id/confirm-receipt', idempotencyKey: key)),
      );

  /// 💰 Cancel per the cancellation matrix.
  /// Exact outcome of cancelling now (same evaluation as `POST /cancel`, no side effects).
  Future<CancellationPreview> cancelPreview(String id, {String? cause}) async => CancellationPreview.fromJson(
        await _api.get('/transactions/$id/cancel/preview', query: <String, Object?>{'cause': cause}),
      );

  Future<MoneyActionResult> cancel(String id, {required String reason, String? cause}) => _financial.run<MoneyActionResult>(
        'cancel:$id',
        (String key) async => MoneyActionResult(
          await _api.post(
            '/transactions/$id/cancel',
            idempotencyKey: key,
            body: <String, dynamic>{'reason': reason, if (cause != null) 'cause': cause},
          ),
        ),
      );

  Future<List<RefundInfo>> refunds(String id) async =>
      readList(await _api.get('/transactions/$id/refunds'), 'data').map(RefundInfo.fromJson).toList();

  Future<MoneyActionResult> setRefundDestination(
    String refundId, {
    required String bankCode,
    required String accountNumber,
    required String accountHolderName,
  }) async =>
      MoneyActionResult(
        await _api.post(
          '/refunds/$refundId/destination',
          body: <String, dynamic>{'bankCode': bankCode, 'accountNumber': accountNumber, 'accountHolderName': accountHolderName},
        ),
      );

  Future<void> rate(String id, {required int overall, int? communication, int? accuracy, int? timeliness, String? comment}) async {
    await _api.post(
      '/transactions/$id/ratings',
      body: <String, dynamic>{
        'overall': overall,
        if (communication != null) 'communication': communication,
        if (accuracy != null) 'accuracy': accuracy,
        if (timeliness != null) 'timeliness': timeliness,
        if (comment != null && comment.isNotEmpty) 'comment': comment,
      },
    );
  }

  Future<PayoutPage> payouts({String? cursor}) async =>
      PayoutPage.fromJson(await _api.get('/payouts/mine', query: <String, Object?>{'cursor': cursor, 'limit': pageSize}));
}

final transactionRepositoryProvider = Provider<TransactionRepository>(
  (ref) => TransactionRepository(ref.watch(apiClientProvider), ref.watch(financialCallerProvider)),
);

final transactionDetailProvider = FutureProvider.autoDispose.family<TransactionDetail, String>(
  (ref, id) => ref.watch(transactionRepositoryProvider).detail(id),
);

final transactionTimelineProvider = FutureProvider.autoDispose.family<List<TimelineEvent>, String>(
  (ref, id) => ref.watch(transactionRepositoryProvider).timeline(id),
);

/// Active (non-terminal) transactions for the home screens.
final activeTransactionsProvider = FutureProvider.autoDispose.family<List<TransactionSummary>, String>((ref, role) async {
  final page = await ref.watch(transactionRepositoryProvider).list(role: role);
  const closed = <String>{'COMPLETED', 'CANCELLED', 'REFUNDED'};
  return page.items.where((TransactionSummary t) => !closed.contains(t.status)).toList();
});
