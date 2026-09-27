// Fake API responses for the store screenshots, shaped like docs/api/openapi.json. Amounts are
// internally consistent (the 11 price lines add up to the total and to every payment option).

const String storeTxId = '0b7f6d7e-5a3b-4a51-9c61-6f2d1c0e9a11';

Map<String, dynamic> storeProfile({String mode = 'BUYER'}) => <String, dynamic>{
      'id': 'u-rina',
      'email': 'rina@example.com',
      'emailVerified': true,
      'phone': '+6281234567890',
      'phoneVerified': true,
      'displayName': 'Rina Amelia',
      'avatarFileId': null,
      'locale': 'id',
      'countryCode': 'ID',
      'status': 'ACTIVE',
      'kycLevel': 3,
      'activeMode': mode,
      'trustScore': 88,
      'referralCode': 'RINA25',
      'transactionEmail': null,
      'roles': <String>['USER'],
      'mfaEnabled': false,
      'deletionScheduledFor': null,
      'createdAt': '2025-11-02T03:00:00.000Z',
    };

Map<String, dynamic> storeConsents() => <String, dynamic>{
      'current': <Map<String, dynamic>>[
        <String, dynamic>{'type': 'TOS', 'version': '0.1-template', 'granted': true, 'decidedAt': '2025-11-02T03:00:00.000Z'},
        <String, dynamic>{'type': 'PRIVACY', 'version': '0.1-template', 'granted': true, 'decidedAt': '2025-11-02T03:00:00.000Z'},
      ],
      'history': <Object>[],
      'requiredAtSignup': <String>['TOS', 'PRIVACY'],
    };

Map<String, dynamic> _country(String code, String id, String en, String currency, {bool origin = true, bool destination = false}) =>
    <String, dynamic>{'code': code, 'nameId': id, 'nameEn': en, 'currencyCode': currency, 'isOrigin': origin, 'isDestination': destination};

Map<String, dynamic> storeCountries() => <String, dynamic>{
      'data': <Map<String, dynamic>>[
        _country('JP', 'Jepang', 'Japan', 'JPY'),
        _country('SG', 'Singapura', 'Singapore', 'SGD'),
        _country('KR', 'Korea Selatan', 'South Korea', 'KRW'),
        _country('MY', 'Malaysia', 'Malaysia', 'MYR'),
        _country('AU', 'Australia', 'Australia', 'AUD'),
        _country('US', 'Amerika Serikat', 'United States', 'USD'),
        _country('ID', 'Indonesia', 'Indonesia', 'IDR', origin: false, destination: true),
      ],
    };

Map<String, dynamic> storeCategories() => <String, dynamic>{
      'data': <Map<String, dynamic>>[
        <String, dynamic>{'code': 'BAGS', 'nameId': 'Tas & dompet', 'nameEn': 'Bags & wallets', 'riskLevel': 'MEDIUM', 'requiresSerial': false, 'requiresVideo': false},
        <String, dynamic>{'code': 'FASHION', 'nameId': 'Fashion & sepatu', 'nameEn': 'Fashion & shoes', 'riskLevel': 'LOW', 'requiresSerial': false, 'requiresVideo': false},
        <String, dynamic>{'code': 'FOOD', 'nameId': 'Makanan kemasan', 'nameEn': 'Packaged food', 'riskLevel': 'LOW', 'requiresSerial': false, 'requiresVideo': false},
      ],
    };

Map<String, dynamic> storeCurrencies() => <String, dynamic>{
      'data': <Map<String, dynamic>>[
        <String, dynamic>{'code': 'IDR', 'minorUnits': 0, 'symbol': 'Rp', 'name': 'Rupiah'},
        <String, dynamic>{'code': 'JPY', 'minorUnits': 0, 'symbol': '¥', 'name': 'Yen'},
        <String, dynamic>{'code': 'SGD', 'minorUnits': 2, 'symbol': r'S$', 'name': 'Singapore dollar'},
      ],
    };

Map<String, dynamic> _profile(String id, String name, int score, String tier, int kyc, double rating, int count) => <String, dynamic>{
      'id': id,
      'displayName': name,
      'trustBadge': <String, dynamic>{'tier': kyc >= 4 ? 'TRAVELER_VERIFIED' : 'IDENTITY_VERIFIED', 'label': 'Traveler terverifikasi'},
      'trustScore': score,
      'trustTier': <String, dynamic>{'tier': tier, 'label': tier, 'labelEn': tier},
      'kycLevel': kyc,
      'identityVerified': true,
      'rating': <String, dynamic>{'average': rating, 'count': count},
      'completedTransactions': count,
    };

Map<String, dynamic> _trip(String id, String originCountry, String originCity, String city, String dep, String arr, int kg, String fee,
        Map<String, dynamic> traveler) =>
    <String, dynamic>{
      'id': id,
      'status': 'ACTIVE',
      'originCountry': originCountry,
      'originCity': originCity,
      'destinationCountry': 'ID',
      'destinationCity': city,
      'departureDate': dep,
      'arrivalDate': arr,
      'capacityRemainingKg': kg,
      'itemsRemaining': 4,
      'fee': <String, dynamic>{'type': 'FIXED', 'value': 150000, 'label': fee},
      'excludedCategories': <String>[],
      'verified': true,
      'traveler': traveler,
    };

Map<String, dynamic> storeDiscoveryTrips() => <String, dynamic>{
      'data': <Map<String, dynamic>>[
        _trip('t-budi', 'JP', 'Tokyo', 'Jakarta', '2026-10-12', '2026-10-13', 7, 'Rp150.000 / barang',
            _profile('p-budi', 'Budi S.', 92, 'EXCELLENT', 5, 4.9, 128)),
        _trip('t-dewi', 'KR', 'Seoul', 'Surabaya', '2026-10-15', '2026-10-15', 5, 'Rp125.000 / barang',
            _profile('p-dewi', 'Dewi K.', 86, 'EXCELLENT', 4, 4.8, 64)),
        _trip('t-arif', 'SG', 'Singapura', 'Medan', '2026-10-18', '2026-10-18', 10, 'Rp90.000 / barang',
            _profile('p-arif', 'Arif H.', 79, 'GOOD', 4, 4.7, 31)),
      ],
      'nextCursor': null,
    };

Map<String, dynamic> _gate(bool canPurchase) => <String, dynamic>{
      'canPurchase': canPurchase,
      'banner': canPurchase ? 'PURCHASE_APPROVED' : 'DO_NOT_PURCHASE',
      'paymentBadge': 'PAYMENT_SECURED',
      'tone': canPurchase ? 'success' : 'error',
      'messageId': canPurchase ? 'Boleh dibeli' : 'JANGAN BELI DULU',
      'messageEn': canPurchase ? 'Purchase approved' : 'DO NOT PURCHASE YET',
    };

Map<String, dynamic> storeBuyerTransactions() => <String, dynamic>{
      'data': <Map<String, dynamic>>[
        <String, dynamic>{
          'id': 'tx-bag',
          'number': 'JK-261004-0127',
          'status': 'TRAVELING',
          'role': 'BUYER',
          'totalIdr': 10689400,
          'securedIdr': 10689400,
          'purchaseGate': _gate(false),
          'item': <String, dynamic>{'productName': 'Coach Tabby Shoulder Bag 26', 'categoryCode': 'BAGS', 'merchantCountry': 'JP', 'imageUrl': null},
          'counterparty': <String, dynamic>{'id': 'p-budi', 'role': 'TRAVELER', 'displayName': 'Budi S.', 'avatarUrl': null},
        },
        <String, dynamic>{
          'id': storeTxId,
          'number': 'JK-260927-0001',
          'status': 'PAYMENT_SECURED',
          'role': 'BUYER',
          'totalIdr': storeQuoteTotal,
          'securedIdr': storeQuoteTotal,
          'purchaseGate': _gate(false),
          'item': <String, dynamic>{'productName': 'Onitsuka Tiger Mexico 66', 'categoryCode': 'FASHION', 'merchantCountry': 'JP', 'imageUrl': null},
          'counterparty': <String, dynamic>{'id': 'p-budi', 'role': 'TRAVELER', 'displayName': 'Budi S.', 'avatarUrl': null},
        },
      ],
      'nextCursor': null,
    };

// ---------------------------------------------------------------- quote (¥11.000 sneakers)
const int storeQuoteTotal = 1398422;

Map<String, dynamic> _line(String type, int amount, {bool estimate = false, String? rule}) => <String, dynamic>{
      'type': type,
      'labelId': type,
      'labelEn': type,
      'amountIdr': amount,
      'bucket': null,
      'isEstimate': estimate,
      'ruleRef': rule,
    };

Map<String, dynamic> _option(String channel, String label, int fee, {bool refundable = true, bool selected = false, int? max, bool available = true}) =>
    <String, dynamic>{
      'channel': channel,
      'label': label,
      'feeIdr': fee,
      'totalIdr': storeQuoteTotal - 4440 + fee,
      'bearer': 'BUYER',
      'refundable': refundable,
      'minAmountIdr': channel == 'VA' ? 10000 : null,
      'maxAmountIdr': max,
      'available': available,
      'unavailableReason': available ? null : 'ABOVE_CHANNEL_MAX',
      'selected': selected,
    };

Map<String, dynamic> storeQuote({String status = 'ACTIVE'}) {
  final now = DateTime.now().toUtc();
  return <String, dynamic>{
    'quoteId': 'q-store-1',
    'transactionId': storeTxId,
    'status': status,
    'createdAt': now.toIso8601String(),
    'expiresAt': now.add(const Duration(minutes: 14, seconds: 32)).toIso8601String(),
    'currency': 'IDR',
    'totalIdr': storeQuoteTotal,
    'paymentChannel': 'VA',
    'paymentOptions': <Map<String, dynamic>>[
      _option('VA', 'Virtual Account', 4440, refundable: false, selected: true, max: 50000000),
      _option('QRIS', 'QRIS', 9758, max: 10000000),
      _option('EWALLET', 'E-Wallet', 20910),
      _option('CARD', 'Kartu kredit/debit', 42425),
    ],
    'item': <String, dynamic>{'currency': 'JPY', 'unitPriceMinor': 11000, 'quantity': 1, 'totalMinor': 11000},
    'lines': <Map<String, dynamic>>[
      _line('ITEM_PRICE', 1208612),
      _line('TRAVELER_FEE', 150000),
      _line('CUSTOMS_DUTY', 0, estimate: true, rule: 'customs:PASSENGER_GOODS@v3'),
      _line('IMPORT_TAX', 0, estimate: true, rule: 'customs:PASSENGER_GOODS@v3'),
      _line('PROTECTION_FEE', 24172, rule: 'fee:protection@v1'),
      _line('PLATFORM_FEE', 30215, rule: 'fee:platform@v1'),
      _line('SERVICE_TAX', 5983, rule: 'tax:vat@v1'),
      _line('PAYMENT_FEE', 4440, rule: 'fee:channel:VA@v1'),
      _line('DISCOUNT', -25000),
      _line('REFERRAL_CREDIT', 0),
      _line('TOTAL', storeQuoteTotal),
    ],
    'estimateBadges': <String>['CUSTOMS_DUTY', 'IMPORT_TAX'],
    'fx': <String, dynamic>{
      'base': 'JPY',
      'quote': 'IDR',
      'spotRate': '108.2500000000',
      'markupBps': 150,
      'lockedRate': '109.8738000000',
      'lockedAt': now.toIso8601String(),
      'expiresAt': now.add(const Duration(minutes: 14, seconds: 32)).toIso8601String(),
      'status': 'ACTIVE',
    },
    'customs': <String, dynamic>{'ruleCode': 'PASSENGER_GOODS', 'dutyIdr': 0, 'importTaxIdr': 0, 'totalIdr': 0, 'isEstimate': true},
    'restricted': <String, dynamic>{'classification': 'ALLOWED', 'requiresAcknowledgement': false, 'blocksCheckout': false},
    'promotion': <String, dynamic>{'discountIdr': 25000, 'cashbackIdr': 0},
    'credit': <String, dynamic>{'appliedIdr': 0, 'availableIdr': 50000, 'withdrawable': false},
  };
}

Map<String, dynamic> _party(String name, int score, String tier, int kyc, {double asTraveler = 4.9, int travelerCount = 128}) => <String, dynamic>{
      'id': 'p-${name.toLowerCase().replaceAll(RegExp(r'[^a-z]'), '')}',
      'displayName': name,
      'avatarUrl': null,
      'trustScore': score,
      'trustTier': <String, dynamic>{'tier': tier, 'label': tier, 'labelEn': tier},
      'trustBadge': <String, dynamic>{'tier': 'TRAVELER_VERIFIED', 'label': 'Traveler terverifikasi'},
      'kycLevel': kyc,
      'identityVerified': true,
      'ratingSummary': <String, dynamic>{
        'asTraveler': <String, dynamic>{'average': asTraveler, 'count': travelerCount},
        'asBuyer': <String, dynamic>{'average': 5.0, 'count': 12},
      },
      'memberSince': '2025-01-10T00:00:00.000Z',
      'rating': null,
    };

/// Transaction detail. [role] BUYER | TRAVELER, [status] any FSM status.
Map<String, dynamic> storeDetail({required String role, required String status, List<String> actions = const <String>[]}) {
  final now = DateTime.now().toUtc();
  final approved = status == 'PURCHASE_APPROVED';
  return <String, dynamic>{
    'id': storeTxId,
    'number': 'JK-260927-0001',
    'status': status,
    'role': role,
    'buyerId': 'u-rina',
    'travelerId': 'p-budi',
    'totalIdr': storeQuoteTotal,
    'securedIdr': storeQuoteTotal,
    'itemCurrency': 'JPY',
    'quantity': 1,
    'deliveryMethod': 'MEETUP',
    'purchaseCeiling': <String, dynamic>{'minor': 12000, 'idr': 1318485},
    'purchaseCeilingMinor': 12000,
    'purchaseCeilingIdr': 1318485,
    'autoConfirmAt': null,
    'statusChangedAt': now.toIso8601String(),
    'createdAt': now.subtract(const Duration(days: 2)).toIso8601String(),
    'updatedAt': now.toIso8601String(),
    'cancelledAt': null,
    'completedAt': null,
    'purchaseGate': _gate(approved),
    'item': <String, dynamic>{
      'productName': 'Onitsuka Tiger Mexico 66',
      'productUrl': 'https://www.onitsukatiger.com/jp/',
      'merchantName': 'Onitsuka Tiger Ginza',
      'merchantCountry': 'JP',
      'categoryCode': 'FASHION',
      'hsCode': null,
      'variant': 'Birch/Peacoat · EU 42',
      'quantity': 1,
      'unitPriceMinor': 11000,
      'currency': 'JPY',
      'priceCurrency': 'JPY',
      'imageUrl': null,
      'maxBudgetIdr': null,
    },
    'buyer': _party('Rina A.', 88, 'EXCELLENT', 3, asTraveler: 0, travelerCount: 0),
    'traveler': _party('Budi S.', 92, 'EXCELLENT', 5),
    'trip': <String, dynamic>{
      'id': 't-budi',
      'status': 'ACTIVE',
      'originCountry': 'JP',
      'originCity': 'Tokyo',
      'destinationCountry': 'ID',
      'destinationCity': 'Jakarta',
      'departureDate': '2026-10-12',
      'arrivalDate': '2026-10-13',
    },
    'quote': storeQuote(status: 'ACCEPTED'),
    'payments': <Map<String, dynamic>>[
      <String, dynamic>{
        'id': 'pay-1',
        'purpose': 'CHECKOUT',
        'status': 'SECURED',
        'amountIdr': storeQuoteTotal,
        'refundedIdr': 0,
        'channel': 'VA',
        'provider': 'XENDIT',
        'providerEnv': 'LIVE',
        'sandbox': false,
        'checkoutUrl': null,
        'expiresAt': null,
        'securedAt': now.subtract(const Duration(hours: 3)).toIso8601String(),
        'failureReason': null,
        'createdAt': now.subtract(const Duration(hours: 4)).toIso8601String(),
      },
    ],
    'priceConfirmations': <Object>[],
    'purchaseProof': null,
    'customsDeclaration': null,
    'delivery': role == 'BUYER' && status == 'READY_FOR_HANDOVER'
        ? <String, dynamic>{
            'id': 'd-1',
            'method': 'MEETUP',
            'status': 'SCHEDULED',
            'courierName': null,
            'trackingNumber': null,
            'addressCity': 'Jakarta',
            'meetupPoint': 'Lobby Stasiun MRT Bundaran HI',
            'scheduledAt': now.add(const Duration(hours: 2)).toIso8601String(),
            'confirmedAt': null,
            'confirmedVia': null,
            'proofFileIds': <String>[],
            'pin': <String, dynamic>{'locked': false, 'attemptsRemaining': 5},
            'pinAvailable': true,
          }
        : null,
    'refunds': <Object>[],
    'payout': null,
    'conversationId': 'c-1',
    'allowedActions': actions,
  };
}

Map<String, dynamic> storeTimeline(String status) {
  final now = DateTime.now().toUtc();
  final path = <String>['REQUEST_CREATED', 'MATCHED', 'AWAITING_PAYMENT', 'PAYMENT_SECURED'];
  if (status == 'PURCHASE_APPROVED') path.add('PURCHASE_APPROVED');
  return <String, dynamic>{
    'events': <Map<String, dynamic>>[
      for (var i = 0; i < path.length; i++)
        <String, dynamic>{
          'from': i == 0 ? null : path[i - 1],
          'to': path[i],
          'actorType': 'SYSTEM',
          'reason': null,
          'at': now.subtract(Duration(hours: (path.length - i) * 5)).toIso8601String(),
        },
    ],
  };
}

Map<String, dynamic> storeHandoverPin() => <String, dynamic>{
      'pin': '482915',
      'qrToken': 'qt_7Hq2mV9x',
      'qrPayload': 'jastipkita://handover/$storeTxId?t=qt_7Hq2mV9x',
      'qrExpiresAt': DateTime.now().toUtc().add(const Duration(minutes: 4, seconds: 48)).toIso8601String(),
      'attemptsRemaining': 5,
      'note': '',
    };

// ---------------------------------------------------------------- create request (¥88.000 bag)
Map<String, dynamic> storeExtraction() => <String, dynamic>{
      'drafts': <Map<String, dynamic>>[
        <String, dynamic>{
          'sourceType': 'URL',
          'productUrl': 'https://www.coachjapan.jp/tabby-shoulder-bag-26',
          'productName': 'Coach Tabby Shoulder Bag 26',
          'merchantName': 'Coach Japan',
          'merchantCountry': 'JP',
          'unitPriceMinor': 88000,
          'priceCurrency': 'JPY',
          'imageUrl': null,
          'categoryCode': 'BAGS',
          'variant': 'Black · Polished pebble leather',
        },
      ],
      'confidence': 0.94,
      'needsManualInput': false,
      'warnings': <String>[],
      'mode': 'LIVE',
    };

Map<String, dynamic> storeRestrictedCheck() => <String, dynamic>{
      'classification': 'ALLOWED',
      'blocksCheckout': false,
      'requiresAcknowledgement': false,
      'messages': <String>[],
      'permitAuthorities': <String>[],
      'airlineDg': false,
      'ruleRef': null,
      'disclaimer': null,
    };

Map<String, dynamic> storeCustomsEstimate() => <String, dynamic>{
      'treatment': 'PASSENGER_GOODS',
      'estimate': <String, dynamic>{
        'dutyIdr': 147100,
        'importTaxIdr': 309800,
        'totalIdr': 456900,
        'customsValueIdr': 9668900,
        'ruleRef': 'customs:PASSENGER_GOODS@v3',
        'sourceReference': 'PMK 203/PMK.04/2017',
        'warnings': <Object>[],
      },
      'treatmentExplanation':
          'Barang bawaan penumpang: pembebasan USD 500 per orang, sisanya kena bea masuk 10% serta PPN & PPh impor. Nilai final ditetapkan Bea Cukai.',
      'disclaimer': null,
    };
