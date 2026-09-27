import '../domain/domain.dart';
import '../storage/token_storage.dart';
import 'json.dart';

/// `Profile` (GET /me).
class Profile {
  const Profile({
    required this.id,
    required this.kycLevel,
    required this.activeMode,
    required this.trustScore,
    required this.locale,
    this.email,
    this.emailVerified = false,
    this.phone,
    this.phoneVerified = false,
    this.displayName,
    this.avatarFileId,
    this.countryCode,
    this.status = 'ACTIVE',
    this.referralCode = '',
    this.transactionEmail,
    this.deletionScheduledFor,
    this.createdAt,
  });

  factory Profile.fromJson(Json json) => Profile(
        id: readString(json, 'id'),
        email: readStringOrNull(json, 'email'),
        emailVerified: readBool(json, 'emailVerified'),
        phone: readStringOrNull(json, 'phone'),
        phoneVerified: readBool(json, 'phoneVerified'),
        displayName: readStringOrNull(json, 'displayName'),
        avatarFileId: readStringOrNull(json, 'avatarFileId'),
        locale: readString(json, 'locale', 'id'),
        countryCode: readStringOrNull(json, 'countryCode'),
        status: readString(json, 'status', 'ACTIVE'),
        kycLevel: readInt(json, 'kycLevel', 1),
        activeMode: readString(json, 'activeMode', UserMode.buyer),
        trustScore: readInt(json, 'trustScore'),
        referralCode: readString(json, 'referralCode'),
        transactionEmail: readStringOrNull(json, 'transactionEmail'),
        deletionScheduledFor: readDate(json, 'deletionScheduledFor'),
        createdAt: readDate(json, 'createdAt'),
      );

  final String id;
  final String? email;
  final bool emailVerified;
  final String? phone;
  final bool phoneVerified;
  final String? displayName;
  final String? avatarFileId;
  final String locale;
  final String? countryCode;
  final String status;
  final int kycLevel;
  final String activeMode;
  final int trustScore;
  final String referralCode;
  final String? transactionEmail;
  final DateTime? deletionScheduledFor;
  final DateTime? createdAt;

  bool get isTraveler => activeMode == UserMode.traveler;

  String get nameOrContact => displayName ?? email ?? phone ?? '';

  String get initials => initialsOf(nameOrContact);

  Profile copyWith({String? activeMode, int? kycLevel, String? displayName, String? transactionEmail}) => Profile(
        id: id,
        email: email,
        emailVerified: emailVerified,
        phone: phone,
        phoneVerified: phoneVerified,
        displayName: displayName ?? this.displayName,
        avatarFileId: avatarFileId,
        locale: locale,
        countryCode: countryCode,
        status: status,
        kycLevel: kycLevel ?? this.kycLevel,
        activeMode: activeMode ?? this.activeMode,
        trustScore: trustScore,
        referralCode: referralCode,
        transactionEmail: transactionEmail ?? this.transactionEmail,
        deletionScheduledFor: deletionScheduledFor,
        createdAt: createdAt,
      );
}

/// "Rina Maharani" → "RM"; "dimas@x.id" → "D".
String initialsOf(String name) {
  final words = name.trim().split(RegExp(r'\s+')).where((String w) => w.isNotEmpty).toList();
  if (words.isEmpty) return '?';
  final first = words.first.substring(0, 1);
  if (words.length == 1) return first.toUpperCase();
  return '$first${words[1].substring(0, 1)}'.toUpperCase();
}

class OtpChallenge {
  const OtpChallenge({required this.challengeId, this.expiresAt, this.resendAvailableAt, this.devCode});

  factory OtpChallenge.fromJson(Json json) => OtpChallenge(
        challengeId: readString(json, 'challengeId'),
        expiresAt: readDate(json, 'expiresAt'),
        resendAvailableAt: readDate(json, 'resendAvailableAt'),
        devCode: readStringOrNull(json, 'devCode'),
      );

  final String challengeId;
  final DateTime? expiresAt;
  final DateTime? resendAvailableAt;

  /// Only echoed by non-production APIs (`OTP_DEV_ECHO`).
  final String? devCode;
}

class LoginResult {
  const LoginResult({required this.user, this.tokens, this.isNewUser = false});

  factory LoginResult.fromJson(Json json) {
    final tokensJson = readObjectOrNull(json, 'tokens');
    return LoginResult(
      user: Profile.fromJson(readObject(json, 'user')),
      tokens: tokensJson == null ? null : AuthTokens.fromJson(tokensJson),
      isNewUser: readBool(json, 'isNewUser'),
    );
  }

  final Profile user;
  final AuthTokens? tokens;
  final bool isNewUser;
}

class ConsentDecision {
  const ConsentDecision({required this.type, required this.version, required this.granted, this.decidedAt});

  factory ConsentDecision.fromJson(Json json) => ConsentDecision(
        type: readString(json, 'type'),
        version: readString(json, 'version'),
        granted: readBool(json, 'granted'),
        decidedAt: readDate(json, 'decidedAt') ?? readDate(json, 'createdAt'),
      );

  final String type;
  final String version;
  final bool granted;
  final DateTime? decidedAt;
}

class ConsentState {
  const ConsentState({required this.current, required this.requiredAtSignup});

  factory ConsentState.fromJson(Json json) => ConsentState(
        current: readList(json, 'current').map(ConsentDecision.fromJson).toList(),
        requiredAtSignup: readStringList(json, 'requiredAtSignup'),
      );

  final List<ConsentDecision> current;
  final List<String> requiredAtSignup;

  bool isGranted(String type) => current.any((ConsentDecision c) => c.type == type && c.granted);

  List<String> get missingRequired => requiredAtSignup.where((String t) => !isGranted(t)).toList();
}

/// One consent to collect (`GET /consents/requirements`). The version comes from the server —
/// the API rejects any other (`422 CONSENT_VERSION_INVALID`).
class ConsentRequirement {
  const ConsentRequirement({
    required this.type,
    required this.isRequired,
    this.version,
    this.acceptedVersions = const <String>[],
    this.title,
    this.summary,
    this.url,
    this.granted,
    this.grantedVersion,
    this.upToDate,
  });

  factory ConsentRequirement.fromJson(Json json) => ConsentRequirement(
        type: readString(json, 'type'),
        isRequired: readBool(json, 'required'),
        version: readStringOrNull(json, 'version'),
        acceptedVersions: readStringList(json, 'acceptedVersions'),
        title: readStringOrNull(json, 'title'),
        summary: readStringOrNull(json, 'summary'),
        url: readStringOrNull(json, 'url') ?? readStringOrNull(json, 'documentUrl'),
        granted: json['granted'] is bool ? json['granted'] as bool : null,
        grantedVersion: readStringOrNull(json, 'grantedVersion'),
        upToDate: json['upToDate'] is bool ? json['upToDate'] as bool : null,
      );

  final String type;
  final bool isRequired;

  /// Current published version (null when no document is published for the type).
  final String? version;
  final List<String> acceptedVersions;
  final String? title;
  final String? summary;

  /// Public page of the document.
  final String? url;

  /// Only when called with a token.
  final bool? granted;
  final String? grantedVersion;
  final bool? upToDate;

  /// The version to send with a decision.
  String? get versionToSend => version ?? (acceptedVersions.isEmpty ? null : acceptedVersions.first);
}

class ConsentGroup {
  const ConsentGroup({
    this.requiredItems = const <ConsentRequirement>[],
    this.optionalItems = const <ConsentRequirement>[],
    this.satisfied,
  });

  factory ConsentGroup.fromJson(Json json) => ConsentGroup(
        requiredItems: readList(json, 'required').map(ConsentRequirement.fromJson).toList(),
        optionalItems: readList(json, 'optional').map(ConsentRequirement.fromJson).toList(),
        satisfied: json['satisfied'] is bool ? json['satisfied'] as bool : null,
      );

  final List<ConsentRequirement> requiredItems;
  final List<ConsentRequirement> optionalItems;
  final bool? satisfied;

  List<ConsentRequirement> get all => <ConsentRequirement>[...requiredItems, ...optionalItems];

  ConsentRequirement? byType(String type) {
    for (final r in all) {
      if (r.type == type) return r;
    }
    return null;
  }
}

class ConsentRequirements {
  const ConsentRequirements({required this.signup, required this.kyc, this.locale = 'id'});

  factory ConsentRequirements.fromJson(Json json) => ConsentRequirements(
        locale: readString(json, 'locale', 'id'),
        signup: ConsentGroup.fromJson(readObject(json, 'signup')),
        kyc: ConsentGroup.fromJson(readObject(json, 'kyc')),
      );

  final String locale;
  final ConsentGroup signup;
  final ConsentGroup kyc;

  /// Any consent type the server knows about (signup first, then KYC).
  ConsentRequirement? byType(String type) => signup.byType(type) ?? kyc.byType(type);
}

/// `GET /legal/documents` row; [LegalDocument] adds the Markdown body.
class LegalDocumentSummary {
  const LegalDocumentSummary({
    required this.type,
    required this.version,
    required this.title,
    this.locale = 'id',
    this.summary,
    this.effectiveAt,
    this.slug,
    this.url,
    this.isTemplate = false,
  });

  factory LegalDocumentSummary.fromJson(Json json) => LegalDocumentSummary(
        type: readString(json, 'type'),
        version: readString(json, 'version'),
        title: readString(json, 'title'),
        locale: readString(json, 'locale', 'id'),
        summary: readStringOrNull(json, 'summary'),
        effectiveAt: readDate(json, 'effectiveAt'),
        slug: readStringOrNull(json, 'slug'),
        url: readStringOrNull(json, 'url'),
        isTemplate: readBool(json, 'isTemplate'),
      );

  final String type;
  final String version;
  final String title;
  final String locale;
  final String? summary;
  final DateTime? effectiveAt;
  final String? slug;
  final String? url;

  /// Seeded template text not yet reviewed by counsel — shown with a notice.
  final bool isTemplate;
}

class LegalDocument {
  const LegalDocument({required this.summary, required this.bodyMd});

  factory LegalDocument.fromJson(Json json) =>
      LegalDocument(summary: LegalDocumentSummary.fromJson(json), bodyMd: readString(json, 'bodyMd'));

  final LegalDocumentSummary summary;
  final String bodyMd;
}

class SessionInfo {
  const SessionInfo({
    required this.id,
    required this.current,
    this.createdAt,
    this.lastActiveAt,
    this.platform,
    this.appVersion,
    this.userAgent,
  });

  factory SessionInfo.fromJson(Json json) {
    final device = readObjectOrNull(json, 'device');
    return SessionInfo(
      id: readString(json, 'id'),
      current: readBool(json, 'current'),
      createdAt: readDate(json, 'createdAt'),
      lastActiveAt: readDate(json, 'lastActiveAt'),
      platform: device == null ? null : readStringOrNull(device, 'platform'),
      appVersion: device == null ? null : readStringOrNull(device, 'appVersion'),
      userAgent: readStringOrNull(json, 'userAgent'),
    );
  }

  final String id;
  final bool current;
  final DateTime? createdAt;
  final DateTime? lastActiveAt;
  final String? platform;
  final String? appVersion;
  final String? userAgent;
}

class PrivacyRequest {
  const PrivacyRequest({
    required this.id,
    required this.type,
    required this.status,
    this.dueAt,
    this.scheduledFor,
    this.completedAt,
    this.exportFileId,
    this.rejectionReason,
    this.createdAt,
  });

  factory PrivacyRequest.fromJson(Json json) => PrivacyRequest(
        id: readString(json, 'id'),
        type: readString(json, 'type'),
        status: readString(json, 'status'),
        dueAt: readDate(json, 'dueAt'),
        scheduledFor: readDate(json, 'scheduledFor'),
        completedAt: readDate(json, 'completedAt'),
        exportFileId: readStringOrNull(json, 'exportFileId'),
        rejectionReason: readStringOrNull(json, 'rejectionReason'),
        createdAt: readDate(json, 'createdAt'),
      );

  final String id;
  final String type;
  final String status;
  final DateTime? dueAt;
  final DateTime? scheduledFor;
  final DateTime? completedAt;
  final String? exportFileId;
  final String? rejectionReason;
  final DateTime? createdAt;
}

class KycRequirement {
  const KycRequirement({required this.code, required this.met, required this.description});

  factory KycRequirement.fromJson(Json json) => KycRequirement(
        code: readString(json, 'code'),
        met: readBool(json, 'met'),
        description: readString(json, 'description'),
      );

  final String code;
  final bool met;
  final String description;
}

class KycSubmission {
  const KycSubmission({
    required this.id,
    required this.targetLevel,
    required this.status,
    this.idType,
    this.providerEnv,
    this.submittedAt,
    this.reviewedAt,
    this.decisionReason,
  });

  factory KycSubmission.fromJson(Json json) => KycSubmission(
        id: readString(json, 'id'),
        targetLevel: readInt(json, 'targetLevel', 3),
        status: readString(json, 'status'),
        idType: readStringOrNull(json, 'idType'),
        providerEnv: readStringOrNull(json, 'providerEnv'),
        submittedAt: readDate(json, 'submittedAt'),
        reviewedAt: readDate(json, 'reviewedAt'),
        decisionReason: readStringOrNull(json, 'decisionReason'),
      );

  final String id;
  final int targetLevel;
  final String status;
  final String? idType;
  final String? providerEnv;
  final DateTime? submittedAt;
  final DateTime? reviewedAt;
  final String? decisionReason;

  bool get isOpen => status == 'PENDING' || status == 'IN_REVIEW';
}

class KycStatus {
  const KycStatus({
    required this.level,
    required this.levelCode,
    required this.kycConsentGranted,
    required this.submissions,
    this.nextLevel,
    this.nextEvaluatedBy,
    this.requirements = const <KycRequirement>[],
  });

  factory KycStatus.fromJson(Json json) {
    final next = readObjectOrNull(json, 'next');
    return KycStatus(
      level: readInt(json, 'level', 1),
      levelCode: readString(json, 'levelCode', 'REGISTERED'),
      kycConsentGranted: readBool(json, 'kycConsentGranted'),
      submissions: readList(json, 'submissions').map(KycSubmission.fromJson).toList(),
      nextLevel: next == null ? null : readIntOrNull(next, 'level'),
      nextEvaluatedBy: next == null ? null : readStringOrNull(next, 'evaluatedBy'),
      requirements: next == null ? const <KycRequirement>[] : readList(next, 'requirements').map(KycRequirement.fromJson).toList(),
    );
  }

  final int level;
  final String levelCode;
  final bool kycConsentGranted;
  final List<KycSubmission> submissions;
  final int? nextLevel;
  final String? nextEvaluatedBy;
  final List<KycRequirement> requirements;

  KycSubmission? get openSubmission {
    for (final s in submissions) {
      if (s.isOpen) return s;
    }
    return null;
  }

  KycSubmission? get lastRejected {
    for (final s in submissions) {
      if (s.status == 'REJECTED') return s;
    }
    return null;
  }
}

class PayoutAccount {
  const PayoutAccount({
    required this.id,
    required this.bankCode,
    required this.accountMask,
    required this.holderName,
    required this.verificationStatus,
    required this.isDefault,
  });

  factory PayoutAccount.fromJson(Json json) => PayoutAccount(
        id: readString(json, 'id'),
        bankCode: readString(json, 'bankCode'),
        accountMask: readString(json, 'accountMask'),
        holderName: readString(json, 'holderName'),
        verificationStatus: readString(json, 'verificationStatus'),
        isDefault: readBool(json, 'isDefault'),
      );

  final String id;
  final String bankCode;

  /// Always masked by the API (`****0961`); the full number never reaches the client.
  final String accountMask;
  final String holderName;
  final String verificationStatus;
  final bool isDefault;

  bool get isVerified => verificationStatus == 'VERIFIED';
}
