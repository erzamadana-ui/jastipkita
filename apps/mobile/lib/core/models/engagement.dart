import 'json.dart';

class Conversation {
  const Conversation({
    required this.id,
    required this.status,
    required this.myRole,
    required this.counterpartName,
    required this.unreadCount,
    this.transactionId,
    this.transactionNumber,
    this.transactionStatus,
    this.productName,
    this.lastMessagePreview,
    this.lastMessageAt,
  });

  factory Conversation.fromJson(Json json) {
    final counterpart = readObject(json, 'counterpart');
    final tx = readObjectOrNull(json, 'transaction');
    final last = readObjectOrNull(json, 'lastMessage');
    return Conversation(
      id: readString(json, 'id'),
      status: readString(json, 'status', 'OPEN'),
      myRole: readString(json, 'myRole', 'BUYER'),
      counterpartName: readString(counterpart, 'name'),
      unreadCount: readInt(json, 'unreadCount'),
      transactionId: tx == null ? null : readStringOrNull(tx, 'id'),
      transactionNumber: tx == null ? null : readStringOrNull(tx, 'number'),
      transactionStatus: tx == null ? null : readStringOrNull(tx, 'status'),
      productName: tx == null ? null : readStringOrNull(tx, 'productName'),
      lastMessagePreview: last == null ? null : readStringOrNull(last, 'preview'),
      lastMessageAt: readDate(json, 'lastMessageAt'),
    );
  }

  final String id;
  final String status;
  final String myRole;
  final String counterpartName;
  final int unreadCount;
  final String? transactionId;
  final String? transactionNumber;
  final String? transactionStatus;
  final String? productName;
  final String? lastMessagePreview;
  final DateTime? lastMessageAt;

  bool get isLocked => status != 'OPEN';
}

class ChatAttachment {
  const ChatAttachment({required this.fileId, required this.mime, this.contentUrl});

  factory ChatAttachment.fromJson(Json json) => ChatAttachment(
        fileId: readString(json, 'fileId'),
        mime: readString(json, 'mime'),
        contentUrl: readStringOrNull(json, 'contentUrl'),
      );

  final String fileId;
  final String mime;

  /// Absolute URL served by the API (bearer required).
  final String? contentUrl;
}

class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.type,
    required this.mine,
    this.body,
    this.attachments = const <ChatAttachment>[],
    this.meta = const <String, dynamic>{},
    this.moderationStatus = 'CLEAN',
    this.moderationReasons = const <String>[],
    this.createdAt,
    this.pending = false,
  });

  factory ChatMessage.fromJson(Json json) {
    final moderation = readObject(json, 'moderation');
    return ChatMessage(
      id: readString(json, 'id'),
      type: readString(json, 'type', 'TEXT'),
      mine: readBool(json, 'mine'),
      body: readStringOrNull(json, 'body'),
      attachments: readList(json, 'attachments').map(ChatAttachment.fromJson).toList(),
      meta: readObject(json, 'meta'),
      moderationStatus: readString(moderation, 'status', 'CLEAN'),
      moderationReasons: readStringList(moderation, 'reasons'),
      createdAt: readDate(json, 'createdAt'),
    );
  }

  final String id;
  final String type;
  final bool mine;
  final String? body;
  final List<ChatAttachment> attachments;
  final Json meta;
  final String moderationStatus;
  final List<String> moderationReasons;
  final DateTime? createdAt;

  /// Optimistic local message not yet acknowledged by the server.
  final bool pending;

  bool get isFlagged => moderationStatus == 'FLAGGED';
  bool get isHidden => moderationStatus == 'HIDDEN';
  bool get isSystem => type == 'SYSTEM' || type == 'STATUS';

  /// Flagged messages are shown masked (`[disembunyikan]`) to both parties.
  String get displayBody => readStringOrNull(meta, 'maskedBody') ?? body ?? '';
}

class AppNotification {
  const AppNotification({
    required this.id,
    required this.type,
    required this.category,
    required this.title,
    required this.body,
    required this.data,
    this.readAt,
    this.createdAt,
  });

  factory AppNotification.fromJson(Json json) => AppNotification(
        id: readString(json, 'id'),
        type: readString(json, 'type'),
        category: readString(json, 'category'),
        title: readString(json, 'title'),
        body: readString(json, 'body'),
        data: readObject(json, 'data'),
        readAt: readDate(json, 'readAt'),
        createdAt: readDate(json, 'createdAt'),
      );

  final String id;
  final String type;
  final String category;
  final String title;
  final String body;
  final Json data;
  final DateTime? readAt;
  final DateTime? createdAt;

  bool get isUnread => readAt == null;

  /// `jastipkita://transactions/{id}` etc. — routed through the deep-link normaliser.
  String? get deepLink => readStringOrNull(data, 'deepLink');

  AppNotification markRead(DateTime at) => AppNotification(
        id: id,
        type: type,
        category: category,
        title: title,
        body: body,
        data: data,
        readAt: at,
        createdAt: createdAt,
      );
}

class NotificationChannelPref {
  const NotificationChannelPref({required this.channel, required this.enabled, required this.locked});

  factory NotificationChannelPref.fromJson(Json json) => NotificationChannelPref(
        channel: readString(json, 'channel'),
        enabled: readBool(json, 'enabled'),
        locked: readBool(json, 'locked'),
      );

  final String channel;
  final bool enabled;
  final bool locked;
}

class NotificationGroupPref {
  const NotificationGroupPref({required this.group, required this.label, required this.channels});

  factory NotificationGroupPref.fromJson(Json json) => NotificationGroupPref(
        group: readString(json, 'group'),
        label: readString(json, 'label'),
        channels: readList(json, 'channels').map(NotificationChannelPref.fromJson).toList(),
      );

  final String group;
  final String label;
  final List<NotificationChannelPref> channels;
}

class NotificationPreferences {
  const NotificationPreferences({required this.groups, this.criticalNotice = ''});

  factory NotificationPreferences.fromJson(Json json) => NotificationPreferences(
        groups: readList(json, 'groups').map(NotificationGroupPref.fromJson).toList(),
        criticalNotice: readString(json, 'criticalNotice'),
      );

  final List<NotificationGroupPref> groups;
  final String criticalNotice;
}

class DisputeEvidence {
  const DisputeEvidence({required this.id, required this.party, required this.type, this.fileId, this.note, this.mine = false, this.createdAt});

  factory DisputeEvidence.fromJson(Json json) => DisputeEvidence(
        id: readString(json, 'id'),
        party: readString(json, 'party'),
        type: readString(json, 'type'),
        fileId: readStringOrNull(json, 'fileId'),
        note: readStringOrNull(json, 'note'),
        mine: readBool(json, 'mine'),
        createdAt: readDate(json, 'createdAt'),
      );

  final String id;
  final String party;
  final String type;
  final String? fileId;
  final String? note;
  final bool mine;
  final DateTime? createdAt;
}

class DisputeTimelineEntry {
  const DisputeTimelineEntry({required this.to, this.from, this.actorType, this.at});

  factory DisputeTimelineEntry.fromJson(Json json) => DisputeTimelineEntry(
        to: readString(json, 'to'),
        from: readStringOrNull(json, 'from'),
        actorType: readStringOrNull(json, 'actorType'),
        at: readDate(json, 'at'),
      );

  final String to;
  final String? from;
  final String? actorType;
  final DateTime? at;
}

class Dispute {
  const Dispute({
    required this.id,
    required this.number,
    required this.transactionId,
    required this.transactionNumber,
    required this.type,
    required this.status,
    required this.description,
    required this.myRole,
    this.transactionStatus,
    this.requestedResolution,
    this.resolution,
    this.resolutionAmountIdr,
    this.resolutionNote,
    this.openedByMe = false,
    this.evidenceDueAt,
    this.slaDueAt,
    this.appealDeadline,
    this.allowedActions = const <String>[],
    this.evidence = const <DisputeEvidence>[],
    this.timeline = const <DisputeTimelineEntry>[],
    this.createdAt,
  });

  factory Dispute.fromJson(Json json) => Dispute(
        id: readString(json, 'id'),
        number: readString(json, 'number'),
        transactionId: readString(json, 'transactionId'),
        transactionNumber: readString(json, 'transactionNumber'),
        transactionStatus: readStringOrNull(json, 'transactionStatus'),
        type: readString(json, 'type'),
        status: readString(json, 'status'),
        description: readString(json, 'description'),
        myRole: readString(json, 'myRole'),
        requestedResolution: readStringOrNull(json, 'requestedResolution'),
        resolution: readStringOrNull(json, 'resolution'),
        resolutionAmountIdr: readIntOrNull(json, 'resolutionAmountIdr'),
        resolutionNote: readStringOrNull(json, 'resolutionNote'),
        openedByMe: readBool(json, 'openedByMe'),
        evidenceDueAt: readDate(json, 'evidenceDueAt'),
        slaDueAt: readDate(json, 'slaDueAt'),
        appealDeadline: readDate(json, 'appealDeadline'),
        allowedActions: readStringList(json, 'allowedActions'),
        evidence: readList(json, 'evidence').map(DisputeEvidence.fromJson).toList(),
        timeline: readList(json, 'timeline').map(DisputeTimelineEntry.fromJson).toList(),
        createdAt: readDate(json, 'createdAt'),
      );

  final String id;
  final String number;
  final String transactionId;
  final String transactionNumber;
  final String? transactionStatus;
  final String type;
  final String status;
  final String description;
  final String myRole;
  final String? requestedResolution;
  final String? resolution;
  final int? resolutionAmountIdr;
  final String? resolutionNote;
  final bool openedByMe;
  final DateTime? evidenceDueAt;
  final DateTime? slaDueAt;
  final DateTime? appealDeadline;
  final List<String> allowedActions;
  final List<DisputeEvidence> evidence;
  final List<DisputeTimelineEntry> timeline;
  final DateTime? createdAt;

  bool get canAddEvidence => allowedActions.contains('ADD_EVIDENCE');
  bool get canAppeal => allowedActions.contains('APPEAL');
  bool get canWithdraw => allowedActions.contains('WITHDRAW');
}

class ReferralReward {
  const ReferralReward({required this.program, required this.status, required this.refereeName, required this.rewardIdr, this.createdAt});

  factory ReferralReward.fromJson(Json json) => ReferralReward(
        program: readString(json, 'program'),
        status: readString(json, 'status'),
        refereeName: readString(json, 'refereeName'),
        rewardIdr: readInt(json, 'rewardIdr'),
        createdAt: readDate(json, 'createdAt'),
      );

  final String program;
  final String status;
  final String refereeName;
  final int rewardIdr;
  final DateTime? createdAt;
}

class MyReferrals {
  const MyReferrals({
    required this.code,
    required this.shareLink,
    required this.buyerEnabled,
    required this.buyerReferrerCreditIdr,
    required this.buyerRefereeCreditIdr,
    required this.buyerMinFirstTransactionIdr,
    required this.buyerMonthlyCapIdr,
    required this.creditExpiryDays,
    required this.travelerEnabled,
    required this.travelerReferrerCreditIdr,
    required this.travelerRequiredCompleted,
    required this.invited,
    required this.pending,
    required this.rewarded,
    required this.totalEarnedIdr,
    required this.monthEarnedIdr,
    required this.rewards,
  });

  factory MyReferrals.fromJson(Json json) {
    final programs = readObject(json, 'programs');
    final buyer = readObject(programs, 'buyer');
    final traveler = readObject(programs, 'traveler');
    final stats = readObject(json, 'stats');
    return MyReferrals(
      code: readString(json, 'code'),
      shareLink: readString(json, 'shareLink'),
      buyerEnabled: readBool(buyer, 'enabled'),
      buyerReferrerCreditIdr: readInt(buyer, 'referrerCreditIdr'),
      buyerRefereeCreditIdr: readInt(buyer, 'refereeCreditIdr'),
      buyerMinFirstTransactionIdr: readInt(buyer, 'minFirstTransactionIdr'),
      buyerMonthlyCapIdr: readInt(buyer, 'monthlyCapIdr'),
      creditExpiryDays: readInt(buyer, 'creditExpiryDays'),
      travelerEnabled: readBool(traveler, 'enabled'),
      travelerReferrerCreditIdr: readInt(traveler, 'referrerCreditIdr'),
      travelerRequiredCompleted: readInt(traveler, 'requiredCompletedTransactions'),
      invited: readInt(stats, 'invited'),
      pending: readInt(stats, 'pending') + readInt(stats, 'underReview'),
      rewarded: readInt(stats, 'rewarded'),
      totalEarnedIdr: readInt(stats, 'totalEarnedIdr'),
      monthEarnedIdr: readInt(stats, 'monthEarnedIdr'),
      rewards: readList(json, 'rewards').map(ReferralReward.fromJson).toList(),
    );
  }

  final String code;
  final String shareLink;
  final bool buyerEnabled;
  final int buyerReferrerCreditIdr;
  final int buyerRefereeCreditIdr;
  final int buyerMinFirstTransactionIdr;
  final int buyerMonthlyCapIdr;
  final int creditExpiryDays;
  final bool travelerEnabled;
  final int travelerReferrerCreditIdr;
  final int travelerRequiredCompleted;
  final int invited;
  final int pending;
  final int rewarded;
  final int totalEarnedIdr;
  final int monthEarnedIdr;
  final List<ReferralReward> rewards;
}

class CreditEntry {
  const CreditEntry({required this.id, required this.amountIdr, required this.label, this.expiresAt, this.createdAt});

  factory CreditEntry.fromJson(Json json) => CreditEntry(
        id: readString(json, 'id'),
        amountIdr: readInt(json, 'amountIdr'),
        label: readString(json, 'label', readString(json, 'reason')),
        expiresAt: readDate(json, 'expiresAt'),
        createdAt: readDate(json, 'createdAt'),
      );

  final String id;
  final int amountIdr;
  final String label;
  final DateTime? expiresAt;
  final DateTime? createdAt;
}

class Credits {
  const Credits({
    required this.balanceIdr,
    required this.availableIdr,
    required this.expiringSoonIdr,
    required this.expiringWithinDays,
    required this.history,
    this.nextExpiryAt,
    this.nextCursor,
  });

  factory Credits.fromJson(Json json) {
    final expiring = readObject(json, 'expiringSoon');
    final history = readObject(json, 'history');
    return Credits(
      balanceIdr: readInt(json, 'balanceIdr'),
      availableIdr: readInt(json, 'availableIdr'),
      expiringSoonIdr: readInt(expiring, 'totalIdr'),
      expiringWithinDays: readInt(expiring, 'withinDays'),
      history: readList(history, 'data').map(CreditEntry.fromJson).toList(),
      nextExpiryAt: readDate(json, 'nextExpiryAt'),
      nextCursor: readStringOrNull(history, 'nextCursor'),
    );
  }

  final int balanceIdr;
  final int availableIdr;
  final int expiringSoonIdr;
  final int expiringWithinDays;
  final List<CreditEntry> history;
  final DateTime? nextExpiryAt;
  final String? nextCursor;
}

class PromotionValidation {
  const PromotionValidation({required this.valid, required this.code, required this.discountIdr, required this.message});

  factory PromotionValidation.fromJson(Json json) => PromotionValidation(
        valid: readBool(json, 'valid'),
        code: readString(json, 'code'),
        discountIdr: readInt(json, 'discountIdr') + readInt(json, 'cashbackIdr'),
        message: readString(json, 'message'),
      );

  final bool valid;
  final String code;
  final int discountIdr;
  final String message;
}

class FaqItem {
  const FaqItem({required this.slug, required this.category, required this.question, required this.excerpt});

  factory FaqItem.fromJson(Json json) => FaqItem(
        slug: readString(json, 'slug'),
        category: readString(json, 'category'),
        question: readString(json, 'question'),
        excerpt: readString(json, 'excerpt'),
      );

  final String slug;
  final String category;
  final String question;
  final String excerpt;
}

class FaqArticle {
  const FaqArticle({required this.slug, required this.question, required this.answerMd, this.updatedAt});

  factory FaqArticle.fromJson(Json json) => FaqArticle(
        slug: readString(json, 'slug'),
        question: readString(json, 'question'),
        answerMd: readString(json, 'answerMd'),
        updatedAt: readDate(json, 'updatedAt'),
      );

  final String slug;
  final String question;
  final String answerMd;
  final DateTime? updatedAt;
}

class TicketMessage {
  const TicketMessage({required this.id, required this.authorType, required this.mine, required this.body, this.createdAt});

  factory TicketMessage.fromJson(Json json) => TicketMessage(
        id: readString(json, 'id'),
        authorType: readString(json, 'authorType'),
        mine: readBool(json, 'mine'),
        body: readString(json, 'body'),
        createdAt: readDate(json, 'createdAt'),
      );

  final String id;
  final String authorType;
  final bool mine;
  final String body;
  final DateTime? createdAt;
}

class SupportTicket {
  const SupportTicket({
    required this.id,
    required this.number,
    required this.category,
    required this.subject,
    required this.status,
    required this.priority,
    this.transactionId,
    this.slaDueAt,
    this.createdAt,
    this.updatedAt,
    this.messages = const <TicketMessage>[],
  });

  factory SupportTicket.fromJson(Json json) => SupportTicket(
        id: readString(json, 'id'),
        number: readString(json, 'number'),
        category: readString(json, 'category'),
        subject: readString(json, 'subject'),
        status: readString(json, 'status'),
        priority: readString(json, 'priority', 'NORMAL'),
        transactionId: readStringOrNull(json, 'transactionId'),
        slaDueAt: readDate(json, 'slaDueAt'),
        createdAt: readDate(json, 'createdAt'),
        updatedAt: readDate(json, 'updatedAt'),
        messages: readList(json, 'messages').map(TicketMessage.fromJson).toList(),
      );

  final String id;
  final String number;
  final String category;
  final String subject;
  final String status;
  final String priority;
  final String? transactionId;
  final DateTime? slaDueAt;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final List<TicketMessage> messages;

  bool get isClosed => status == 'CLOSED';
}

/// `GET /support/complaint-info` — consumer complaint channel (Permendag 19/2026): published
/// channels (null while not announced), first-response SLA by priority (config `support.sla`)
/// and the government escalation channel.
class ComplaintInfo {
  const ComplaintInfo({
    required this.complaintPriority,
    required this.complaintFirstResponseHours,
    required this.hoursByPriority,
    required this.slaIsAssumption,
    required this.escalationAuthority,
    required this.escalationUnit,
    required this.escalationMinistry,
    required this.escalationVerifiedAt,
    required this.escalationOutOfCourt,
    this.whatsappUrl,
    this.email,
    this.webUrl,
    this.escalationWhatsappDisplay,
    this.escalationWhatsappUrl,
    this.escalationEmail,
    this.escalationPhoneDisplay,
    this.escalationPhoneNumber,
    this.escalationWebsite,
  });

  factory ComplaintInfo.fromJson(Json json) {
    final channels = readObject(json, 'channels');
    final whatsapp = readObjectOrNull(channels, 'whatsapp');
    final sla = readObject(json, 'sla');
    final hours = readObject(sla, 'hoursByPriority');
    final escalation = readObject(json, 'escalation');
    final escWhatsapp = readObject(escalation, 'whatsapp');
    final escPhone = readObject(escalation, 'phone');
    final verification = readObject(escalation, 'verification');
    return ComplaintInfo(
      whatsappUrl: whatsapp == null ? null : readStringOrNull(whatsapp, 'url'),
      email: readStringOrNull(channels, 'email'),
      webUrl: readStringOrNull(channels, 'webUrl'),
      complaintPriority: readString(sla, 'complaintPriority', 'HIGH'),
      complaintFirstResponseHours: readInt(sla, 'complaintFirstResponseHours'),
      hoursByPriority: <String, int>{
        for (final p in priorities)
          if (readIntOrNull(hours, p) != null) p: readInt(hours, p),
      },
      slaIsAssumption: readBool(sla, 'isAssumption', true),
      escalationAuthority: readString(escalation, 'authority'),
      escalationUnit: readString(escalation, 'unit'),
      escalationMinistry: readString(escalation, 'ministry'),
      escalationWhatsappDisplay: readStringOrNull(escWhatsapp, 'display'),
      escalationWhatsappUrl: readStringOrNull(escWhatsapp, 'url'),
      escalationEmail: readStringOrNull(escalation, 'email'),
      escalationPhoneDisplay: readStringOrNull(escPhone, 'display'),
      escalationPhoneNumber: readStringOrNull(escPhone, 'number'),
      escalationWebsite: readStringOrNull(escalation, 'website'),
      escalationVerifiedAt: readString(verification, 'accessedAt'),
      escalationOutOfCourt: readString(escalation, 'outOfCourt'),
    );
  }

  /// Most urgent first, the order the SLA table is shown in.
  static const List<String> priorities = <String>['URGENT', 'HIGH', 'NORMAL', 'LOW'];

  final String? whatsappUrl;
  final String? email;
  final String? webUrl;
  final String complaintPriority;
  final int complaintFirstResponseHours;
  final Map<String, int> hoursByPriority;
  final bool slaIsAssumption;
  final String escalationAuthority;
  final String escalationUnit;
  final String escalationMinistry;
  final String? escalationWhatsappDisplay;
  final String? escalationWhatsappUrl;
  final String? escalationEmail;
  final String? escalationPhoneDisplay;
  final String? escalationPhoneNumber;
  final String? escalationWebsite;
  final String escalationVerifiedAt;
  final String escalationOutOfCourt;
}

class RatingSummary {
  const RatingSummary({this.travelerAverage, this.travelerCount = 0, this.buyerAverage, this.buyerCount = 0});

  factory RatingSummary.fromJson(Json json) {
    final asTraveler = readObject(json, 'asTraveler');
    final asBuyer = readObject(json, 'asBuyer');
    return RatingSummary(
      travelerAverage: readDoubleOrNull(asTraveler, 'average'),
      travelerCount: readInt(asTraveler, 'count'),
      buyerAverage: readDoubleOrNull(asBuyer, 'average'),
      buyerCount: readInt(asBuyer, 'count'),
    );
  }

  final double? travelerAverage;
  final int travelerCount;
  final double? buyerAverage;
  final int buyerCount;
}
