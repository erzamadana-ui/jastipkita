// Fixtures shaped exactly like docs/api/openapi.json (components.schemas.*) responses.

/// The 11 price lines of domain model §10 (Quote.lines), in display order.
List<Map<String, dynamic>> priceLinesJson() => <Map<String, dynamic>>[
      _line('ITEM_PRICE', 'Harga Barang', 'Item price', 1000000, bucket: 'ITEM_FUNDS'),
      _line('TRAVELER_FEE', 'Traveler Fee', 'Traveler fee', 150000, bucket: 'TRAVELER_FEE'),
      _line('CUSTOMS_DUTY', 'Bea Masuk', 'Customs duty', 75000, bucket: 'CUSTOMS_RESERVE', estimate: true, rule: 'customs:PASSENGER_GOODS@v3'),
      _line('IMPORT_TAX', 'Pajak Impor', 'Import tax', 120000, bucket: 'CUSTOMS_RESERVE', estimate: true, rule: 'customs:PASSENGER_GOODS@v3'),
      _line('PROTECTION_FEE', 'JastipKita Protection', 'JastipKita Protection', 20000, bucket: 'PLATFORM_REVENUE', rule: 'fee:protection@v1'),
      _line('PLATFORM_FEE', 'Platform Fee', 'Platform fee', 25000, bucket: 'PLATFORM_REVENUE', rule: 'fee:platform@v1'),
      _line('SERVICE_TAX', 'Pajak atas layanan platform', 'Platform service tax', 4950, bucket: 'TAX_PAYABLE', rule: 'tax:vat@v1'),
      _line('PAYMENT_FEE', 'Biaya Pembayaran', 'Payment fee', 4440, bucket: 'PAYMENT_FEE', rule: 'fee:channel:VA@v1'),
      _line('DISCOUNT', 'Diskon promo', 'Promo discount', -25000, bucket: 'PROMO_FUNDING'),
      _line('REFERRAL_CREDIT', 'JastipKita Credit', 'JastipKita Credit', -10000, bucket: 'CREDIT_FUNDING'),
      _line('TOTAL', 'Total Landed Cost', 'Total landed cost', 1364390),
    ];

const int fixtureTotalIdr = 1364390;

Map<String, dynamic> _line(
  String type,
  String labelId,
  String labelEn,
  int amount, {
  String? bucket,
  bool estimate = false,
  String? rule,
}) =>
    <String, dynamic>{
      'type': type,
      'labelId': labelId,
      'labelEn': labelEn,
      'amountIdr': amount,
      'bucket': bucket,
      'isEstimate': estimate,
      'ruleRef': rule,
    };

Map<String, dynamic> quoteJson({List<Map<String, dynamic>>? lines, String status = 'ACTIVE'}) => <String, dynamic>{
      'quoteId': '5f1d7a52-3a4e-4d3c-9a57-0d7a0b1c2e3f',
      'transactionId': '0b7f6d7e-5a3b-4a51-9c61-6f2d1c0e9a11',
      'status': status,
      'createdAt': '2026-09-27T07:00:00.000Z',
      'expiresAt': '2026-09-27T07:30:00.000Z',
      'currency': 'IDR',
      'totalIdr': fixtureTotalIdr,
      'paymentChannel': 'VA',
      'lines': lines ?? priceLinesJson(),
      'estimateBadges': <String>['CUSTOMS_DUTY', 'IMPORT_TAX'],
      'fx': <String, dynamic>{
        'base': 'JPY',
        'quote': 'IDR',
        'spotRate': '108.2500000000',
        'markupBps': 150,
        'lockedRate': '109.8737500000',
        'lockedAt': '2026-09-27T07:00:00.000Z',
        'expiresAt': '2026-09-27T07:15:00.000Z',
      },
      'customs': <String, dynamic>{'ruleCode': 'PASSENGER_GOODS', 'dutyIdr': 75000, 'importTaxIdr': 120000, 'isEstimate': true},
      'restricted': <String, dynamic>{'classification': 'DECLARATION_REQUIRED', 'requiresAcknowledgement': true},
      'promotion': <String, dynamic>{'discountIdr': 25000, 'cashbackIdr': 0},
      'credit': <String, dynamic>{'appliedIdr': 10000, 'availableIdr': 40000, 'withdrawable': false},
    };

Map<String, dynamic> purchaseGateJson({required bool canPurchase}) => <String, dynamic>{
      'canPurchase': canPurchase,
      'banner': canPurchase ? 'PURCHASE_APPROVED' : 'DO_NOT_PURCHASE',
      'paymentBadge': 'PAYMENT_SECURED',
      'tone': canPurchase ? 'success' : 'error',
      'messageId': canPurchase ? 'Boleh dibeli' : 'JANGAN BELI DULU',
      'messageEn': canPurchase ? 'Purchase approved' : 'DO NOT PURCHASE YET',
    };

Map<String, dynamic> transactionDetailJson({
  String status = 'PAYMENT_SECURED',
  String role = 'TRAVELER',
  bool canPurchase = false,
}) =>
    <String, dynamic>{
      'id': '0b7f6d7e-5a3b-4a51-9c61-6f2d1c0e9a11',
      'number': 'JK-260927-0001',
      'status': status,
      'role': role,
      'quote': quoteJson(status: 'ACCEPTED'),
      'payments': <Map<String, dynamic>>[
        <String, dynamic>{
          'id': 'b1c2d3e4-0000-4000-8000-000000000001',
          'purpose': 'CHECKOUT',
          'status': 'SECURED',
          'amountIdr': fixtureTotalIdr,
          'refundedIdr': 0,
          'channel': 'VA',
          'provider': 'MOCK',
          'providerEnv': 'TEST',
          'sandbox': true,
          'checkoutUrl': null,
          'expiresAt': null,
          'securedAt': '2026-09-27T07:05:00.000Z',
          'failureReason': null,
          'createdAt': '2026-09-27T07:01:00.000Z',
        },
      ],
      'priceConfirmations': <Object>[],
      'purchaseProof': null,
      'delivery': null,
      'refunds': <Object>[],
      'purchaseGate': purchaseGateJson(canPurchase: canPurchase),
      'allowedActions': <String>['PRICE_CHECK', 'CANCEL', 'CHAT'],
    };

Map<String, dynamic> tripPublicJson() => <String, dynamic>{
      'id': '7a0c1b2d-1111-4222-8333-944455556666',
      'status': 'ACTIVE',
      'originCountry': 'JP',
      'originCity': 'Tokyo',
      'destinationCountry': 'ID',
      'destinationCity': 'Jakarta',
      'departureDate': '2026-10-12',
      'arrivalDate': '2026-10-13',
      'capacityRemainingKg': 6.5,
      'itemsRemaining': 4,
      'fee': <String, dynamic>{'type': 'FIXED', 'value': 150000, 'label': 'Rp150.000 / barang'},
      'excludedCategories': <String>['ELECTRONICS'],
      'verified': true,
      'traveler': <String, dynamic>{
        'id': '3c4d5e6f-aaaa-4bbb-8ccc-dddd00001111',
        'displayName': 'Budi S.',
        'trustBadge': <String, dynamic>{'tier': 'TRAVELER_VERIFIED', 'label': 'Traveler terverifikasi'},
        'identityVerified': true,
        'rating': <String, dynamic>{'average': 4.9, 'count': 128},
        'completedTransactions': 57,
      },
    };

Map<String, dynamic> tokensJson() => <String, dynamic>{
      'tokenType': 'Bearer',
      'accessToken': 'eyJhbGciOi.access',
      'accessTokenExpiresAt': '2026-09-27T07:15:00.000Z',
      'refreshToken': 'rt_abc',
      'refreshTokenExpiresAt': '2026-10-27T07:00:00.000Z',
      'sessionId': '9d8c7b6a-1234-4abc-8def-001122334455',
    };
