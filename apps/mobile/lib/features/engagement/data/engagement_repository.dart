import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/engagement.dart';
import '../../../core/models/json.dart';
import '../../../core/network/api_client.dart';

/// Chat, notifications, disputes, referrals & credit, support — docs/api/engagement.md.
class EngagementRepository {
  EngagementRepository(this._api);

  final ApiClient _api;

  static const int pageSize = 20;

  // ---------------------------------------------------------------- chat
  Future<Paged<Conversation>> conversations({String? cursor}) async => Paged.parse(
        await _api.get('/conversations', query: <String, Object?>{'cursor': cursor, 'limit': pageSize}),
        Conversation.fromJson,
      );

  /// Newest first (cursor pagination).
  Future<Paged<ChatMessage>> messages(String conversationId, {String? cursor}) async => Paged.parse(
        await _api.get('/conversations/$conversationId/messages', query: <String, Object?>{'cursor': cursor, 'limit': 30}),
        ChatMessage.fromJson,
      );

  Future<ChatMessage> sendMessage(String conversationId, {required String type, String? body, List<String>? fileIds}) async =>
      ChatMessage.fromJson(
        await _api.post(
          '/conversations/$conversationId/messages',
          body: <String, dynamic>{
            'type': type,
            if (body != null && body.isNotEmpty) 'body': body,
            if (fileIds != null && fileIds.isNotEmpty) 'fileIds': fileIds,
          },
        ),
      );

  Future<void> markConversationRead(String conversationId, {String? messageId}) async {
    await _api.post('/conversations/$conversationId/read', body: <String, dynamic>{if (messageId != null) 'messageId': messageId});
  }

  /// Conversation of a transaction (one per transaction, created at MATCHED).
  Future<Conversation?> conversationForTransaction(String transactionId) async {
    String? cursor;
    for (var page = 0; page < 5; page++) {
      final result = await conversations(cursor: cursor);
      for (final c in result.items) {
        if (c.transactionId == transactionId) return c;
      }
      if (!result.hasMore) return null;
      cursor = result.nextCursor;
    }
    return null;
  }

  // ---------------------------------------------------------------- notifications
  Future<Paged<AppNotification>> notifications({String? cursor, bool unreadOnly = false}) async => Paged.parse(
        await _api.get(
          '/notifications',
          query: <String, Object?>{'cursor': cursor, 'limit': pageSize, if (unreadOnly) 'unreadOnly': 'true'},
        ),
        AppNotification.fromJson,
      );

  Future<int> unreadCount() async => readInt(await _api.get('/notifications/unread-count'), 'count');

  Future<void> markNotificationRead(String id) async {
    await _api.post('/notifications/$id/read');
  }

  Future<void> markAllNotificationsRead() async {
    await _api.post('/notifications/read-all');
  }

  Future<NotificationPreferences> notificationPreferences() async =>
      NotificationPreferences.fromJson(await _api.get('/notifications/preferences'));

  Future<NotificationPreferences> updateNotificationPreference({
    required String group,
    required String channel,
    required bool enabled,
  }) async =>
      NotificationPreferences.fromJson(
        await _api.put(
          '/notifications/preferences',
          body: <String, dynamic>{
            'preferences': <Json>[
              <String, dynamic>{'group': group, 'channel': channel, 'enabled': enabled},
            ],
          },
        ),
      );

  // ---------------------------------------------------------------- disputes
  Future<Dispute> openDispute(String transactionId, {required String type, required String description, String? requestedResolution}) async =>
      Dispute.fromJson(
        await _api.post(
          '/transactions/$transactionId/disputes',
          body: <String, dynamic>{
            'type': type,
            'description': description,
            if (requestedResolution != null) 'requestedResolution': requestedResolution,
          },
        ),
      );

  Future<Paged<Dispute>> disputes({String? cursor}) async => Paged.parse(
        await _api.get('/disputes/mine', query: <String, Object?>{'cursor': cursor, 'limit': pageSize}),
        Dispute.fromJson,
      );

  Future<Dispute> dispute(String id) async => Dispute.fromJson(await _api.get('/disputes/$id'));

  Future<void> addEvidence(String disputeId, {required String type, String? fileId, String? note}) async {
    await _api.post(
      '/disputes/$disputeId/evidence',
      body: <String, dynamic>{
        'type': type,
        if (fileId != null) 'fileId': fileId,
        if (note != null && note.isNotEmpty) 'note': note,
      },
    );
  }

  Future<Dispute> appeal(String disputeId, String reason) async =>
      Dispute.fromJson(await _api.post('/disputes/$disputeId/appeal', body: <String, dynamic>{'reason': reason}));

  Future<Dispute> withdrawDispute(String disputeId, {String? reason}) async => Dispute.fromJson(
        await _api.post('/disputes/$disputeId/withdraw', body: <String, dynamic>{if (reason != null) 'reason': reason}),
      );

  // ---------------------------------------------------------------- referrals & credit
  Future<MyReferrals> referrals() async => MyReferrals.fromJson(await _api.get('/referrals/me'));

  Future<String> applyReferral(String code) async =>
      readString(await _api.post('/referrals/apply', body: <String, dynamic>{'code': code}), 'message');

  Future<Credits> credits({String? cursor}) async =>
      Credits.fromJson(await _api.get('/credits', query: <String, Object?>{'cursor': cursor, 'limit': pageSize}));

  // ---------------------------------------------------------------- ratings
  Future<RatingSummary> ratingSummary(String userId) async => RatingSummary.fromJson(await _api.get('/users/$userId/rating-summary'));

  // ---------------------------------------------------------------- support
  Future<List<FaqItem>> faq({String? query, String? category, String locale = 'id'}) async => readList(
        await _api.get('/support/faq', query: <String, Object?>{'q': query, 'category': category, 'locale': locale, 'limit': 30}),
        'data',
      ).map(FaqItem.fromJson).toList();

  Future<FaqArticle> faqArticle(String slug, {String locale = 'id'}) async =>
      FaqArticle.fromJson(await _api.get('/support/faq/$slug', query: <String, Object?>{'locale': locale}));

  Future<Paged<SupportTicket>> tickets({String? cursor}) async => Paged.parse(
        await _api.get('/support/tickets', query: <String, Object?>{'cursor': cursor, 'limit': pageSize}),
        SupportTicket.fromJson,
      );

  Future<SupportTicket> ticket(String id) async => SupportTicket.fromJson(await _api.get('/support/tickets/$id'));

  Future<SupportTicket> createTicket({
    required String category,
    required String subject,
    required String message,
    String? transactionId,
    String? disputeId,
  }) async =>
      SupportTicket.fromJson(
        await _api.post(
          '/support/tickets',
          body: <String, dynamic>{
            'category': category,
            'subject': subject,
            'message': message,
            if (transactionId != null) 'transactionId': transactionId,
            if (disputeId != null) 'disputeId': disputeId,
          },
        ),
      );

  Future<SupportTicket> replyTicket(String id, String body) async =>
      SupportTicket.fromJson(await _api.post('/support/tickets/$id/messages', body: <String, dynamic>{'body': body}));

  // ---------------------------------------------------------------- analytics (best effort)
  Future<void> track(String name, {Map<String, Object?> properties = const <String, Object?>{}, required String platform}) async {
    try {
      await _api.post(
        '/analytics/events',
        body: <String, dynamic>{
          'platform': platform,
          'events': <Json>[
            <String, dynamic>{'name': name, 'occurredAt': DateTime.now().toUtc().toIso8601String(), 'properties': properties},
          ],
        },
      );
    } on Object {
      // Analytics never blocks a user flow.
    }
  }
}

final engagementRepositoryProvider = Provider<EngagementRepository>((ref) => EngagementRepository(ref.watch(apiClientProvider)));

/// Notification badge. Push is optional, so the count is also refreshed every minute while it is
/// on screen (and immediately after reading notifications or chats).
final unreadCountProvider = FutureProvider.autoDispose<int>((ref) {
  final timer = Timer(const Duration(minutes: 1), ref.invalidateSelf);
  ref.onDispose(timer.cancel);
  return ref.watch(engagementRepositoryProvider).unreadCount();
});

final disputeDetailProvider = FutureProvider.autoDispose.family<Dispute, String>(
  (ref, id) => ref.watch(engagementRepositoryProvider).dispute(id),
);

final ticketDetailProvider = FutureProvider.autoDispose.family<SupportTicket, String>(
  (ref, id) => ref.watch(engagementRepositoryProvider).ticket(id),
);

final referralsProvider = FutureProvider.autoDispose<MyReferrals>((ref) => ref.watch(engagementRepositoryProvider).referrals());

final creditsProvider = FutureProvider.autoDispose<Credits>((ref) => ref.watch(engagementRepositoryProvider).credits());

final notificationPreferencesProvider = FutureProvider.autoDispose<NotificationPreferences>(
  (ref) => ref.watch(engagementRepositoryProvider).notificationPreferences(),
);

String _platformCode() {
  if (kIsWeb) return 'WEB';
  return defaultTargetPlatform == TargetPlatform.iOS ? 'IOS' : 'ANDROID';
}

/// Fire-and-forget product analytics (allow-listed events; the API strips PII).
void trackEvent(WidgetRef ref, String name, [Map<String, Object?> properties = const <String, Object?>{}]) {
  ref.read(engagementRepositoryProvider).track(name, properties: properties, platform: _platformCode());
}
