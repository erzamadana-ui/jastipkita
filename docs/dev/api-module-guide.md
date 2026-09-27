# API Module Guide (wajib dibaca sebelum menulis modul API)

Baca juga: `CONVENTIONS.md`, `docs/00-domain-model.md` (binding), `docs/03-database.md`, `packages/core/README.md`, `docs/research/02-xendit-integration.md`.

## 1. Struktur
```
apps/api/src/
  app.ts                 createApp(deps) — middleware global, error handler, OpenAPI /v1/openapi.json
  context.ts             AppDeps, AuthContext, AppEnv
  env.ts                 konfigurasi (zod) + guard produksi
  lib/                   errors, crypto (AES-GCM, HMAC, TOTP), logger, clock, pagination, openapi helpers
  db/sql.ts              postgres.js (Sql / TxSql), camel(), withTx()
  middleware/            requestContext, requireAuth/optionalAuth, requireKycLevel, requirePermission,
                         requireRecentMfa, requireAdmin, requireIdempotency, rateLimit
  services/              config-service (business_configs ACTIVE, cache 30s), audit (jk_audit),
                         outbox (jk_outbox), session (JWT + refresh rotation), risk (risk_assessments)
  providers/<kind>/      factory per jenis provider; mock di providers/mock.ts
  modules/<group>.ts     registrasi route per grup (dimiliki satu tim/agen)
  modules/<module>/      routes.ts · service.ts · repository.ts · schemas.ts · *.test.ts
  jobs/<group>.ts        outbox subscribers, scheduled jobs, queue handlers per grup
  jobs/runner.ts         runWorkerTick / drainWorker / enqueueJob
test/helpers.ts          createTestContext() — DB terisolasi per file test, provider MOCK, FixedClock
```

## 2. Pola modul
- **routes.ts**: `const r = createRouter(); r.openapi(createRoute({...}), handler); app.route('/', r)`. Setiap route WAJIB `createRoute` (agar masuk OpenAPI) dengan `tags`, `summary`, `security: bearer` bila butuh auth, request schema zod, response schema (pakai `jsonContent`, spread `errorResponses`). Middleware per route via `middleware: [requireAuth, ...] as const`.
- **service.ts**: logika bisnis; memanggil engine `@jastipkita/core` (jangan duplikasi rumus). Menerima `deps` + `auth`. Membuka transaksi DB (`deps.sql.begin`) untuk mutasi multi-tabel. Tidak mengembalikan kolom `*_enc` / hash ke klien.
- **repository.ts**: hanya SQL (tagged template postgres.js — **selalu parameterized**, tidak ada string concat SQL). Mengembalikan objek camelCase.
- **schemas.ts**: schema zod + `.openapi('Nama')` untuk komponen yang dipakai ulang.
- JSON camelCase; uang IDR integer; waktu ISO-8601 UTC.
- Error: `throw Errors.xxx(...)` atau `new AppError(status, CODE, message, details)`. Kode error UPPER_SNAKE, pesan Bahasa Indonesia ramah pengguna.
- Perubahan status transaksi **hanya** lewat `SELECT * FROM transition_transaction(id, expectedVersion, to, actorType, actorId, reason, meta)` — sebelum itu jalankan guard dari `@jastipkita/core` (`canTransition`/`assertTransition` + guard context). Error SQLSTATE JK409/JK422/JK403 otomatis dipetakan.
- Status entitas lain (trip, dispute, payment, refund, payout, price confirmation, KYC, quote, fx lock) juga FSM — gunakan fungsi/transisi DB yang tersedia (`transition_trip`, `transition_dispute`, `status_transitions`, trigger FSM) dan engine core untuk guard.
- Audit: `await audit(tx, {...})` untuk setiap aksi finansial/konfigurasi/role/trust/KYC/admin — **statement terakhir sebelum commit**. Jangan menaruh PII mentah di audit.
- Notifikasi: jangan kirim email/push langsung dari service. Tulis event outbox (`emitEvent(tx, ...)`) di transaksi yang sama; grup engagement berlangganan event dan mengirim in-app/push/email.
- Mutasi finansial: `middleware: [requireAuth, requireIdempotency]` + header `Idempotency-Key`.
- PII: enkripsi dengan `deps.crypto.encrypt(value, aad)` (AAD = `"<table>.<col>:<id>"`), cari/dedupe dengan `deps.crypto.hashIdentifier(kind, normalized)`.
- Waktu: selalu `deps.clock.now()` (bukan `new Date()`) agar test deterministik.
- Konfigurasi bisnis: `await deps.config.get('pricing.platform_fee')` — jangan hard-code angka.
- Rate limit: `rateLimit({...})` untuk endpoint publik/sensitif + limit berbasis DB di service untuk OTP/login/pembayaran.
- Dev-only route: daftarkan hanya bila `deps.env.APP_ENV` ∈ {development, test}.

## 3. Aturan kerja paralel (agen)
- Setiap grup HANYA mengubah: `src/modules/<group>.ts`, `src/jobs/<group>.ts`, folder modulnya sendiri, `src/providers/<kind>/` milik grupnya, dan migrasi pada rentang nomornya. Butuh perubahan di file bersama (`lib/`, `middleware/`, `services/`, `app.ts`, `providers/types.ts`, `test/helpers.ts`)? **Jangan ubah** — buat helper lokal di modul Anda dan laporkan kebutuhan di ringkasan akhir.
- Rentang nomor migrasi: identity `0020–0029`, marketplace `0030–0039`, money `0040–0049`, engagement `0050–0059`, admin `0060–0069`, QA/E2E `0070–0079`. Format file mengikuti `db/migrations/README.md` (satu `BEGIN;` & `COMMIT;`). Jangan edit migrasi yang sudah ada. Jalankan `bash db/scripts/test-db.sh` setelah menambah migrasi.
- **Dilarang** `pnpm install`/menambah dependency. Yang tersedia: hono, @hono/zod-openapi, zod, postgres, jose, aws4fetch, @jastipkita/core, vitest, tsx. HTTP ke provider eksternal pakai `fetch`.
- Test: `cd apps/api && npx vitest run src/modules/<modul>` (DB per file otomatis). Sebelum selesai: `npx tsc --noEmit -p apps/api` bersih dan seluruh test grup Anda hijau. Jangan menjalankan seluruh suite berulang-ulang jika grup lain sedang bekerja (boleh sekali di akhir).
- Tabel lintas grup boleh dibaca/ditulis sesuai kebutuhan (mis. money menulis `credit_entries` CHECKOUT_REDEEM), tetapi endpoint & job milik grup lain jangan dibuat.

## 4. Katalog endpoint & kepemilikan
Base `/v1`. 🔒 = butuh auth, 💰 = butuh `Idempotency-Key`, (Kn) = KYC level minimum.

### identity (auth, me, devices, consents, files, KYC, payout accounts, privacy)
- `POST /auth/otp/request` {channel SMS|WHATSAPP|EMAIL, destination, purpose LOGIN|VERIFY_PHONE|VERIFY_EMAIL} → {challengeId, expiresAt, devCode?}
- `POST /auth/otp/verify` {challengeId, code, device?} → LOGIN: {tokens, user, isNewUser}; VERIFY_*: 🔒 menaikkan level (VERIFY_PHONE → K2)
- `POST /auth/google` {idToken, device?} · `POST /auth/apple` {identityToken, fullName?, device?} → {tokens, user, isNewUser}
- `POST /auth/refresh` {refreshToken} · `POST /auth/logout` 🔒 · `GET /auth/sessions` 🔒 · `DELETE /auth/sessions/{id}` 🔒
- `POST /auth/mfa/totp/enroll` 🔒admin · `POST /auth/mfa/totp/confirm` 🔒 · `POST /auth/mfa/verify` 🔒 → token baru dengan `mfa_at` (step-up)
- `GET /me` 🔒 · `PATCH /me` 🔒 {displayName, locale, transactionEmail, countryCode} · `POST /me/mode` 🔒 {mode}
- `POST /me/devices` 🔒 {platform, pushToken, appVersion, fingerprint} · `DELETE /me/devices/{id}` 🔒
- `GET /me/consents` 🔒 · `POST /me/consents` 🔒 {type, version, granted}
- `POST /files/uploads` 🔒 {purpose, contentType, sizeBytes, sha256?} → {fileId, upload{url,method,headers}, expiresAt} · `POST /files/{id}/complete` 🔒 (magic-bytes check, scan, sha256) · `GET /files/{id}/url` 🔒
- `GET /kyc/status` 🔒 · `POST /kyc/submissions` 🔒 (K2) · `GET/POST /kyc/payout-accounts` 🔒 (K3) · `DELETE /kyc/payout-accounts/{id}` · `POST /kyc/payout-accounts/{id}/default`
- `POST /privacy/export` 🔒 · `GET /privacy/requests` 🔒 · `POST /privacy/delete-account` 🔒 · `POST /privacy/cancel-deletion` 🔒
- dev: `PUT /dev/storage/upload/{token}`, `GET /dev/storage/download/{token}`

### marketplace (catalog, FX, customs, restricted, trips, requests, offers, matching, extraction)
- `GET /catalog/countries` · `GET /catalog/categories` · `GET /catalog/currencies` (publik)
- `GET /fx/rates?base=&quote=` (publik, dengan timestamp & sumber) · `POST /fx/locks` 🔒
- `POST /customs/estimate` (publik, kalkulator) · `POST /restricted/check` (publik)
- `GET /trips` (publik, discovery) · `POST /trips` 🔒 · `GET /trips/mine` 🔒 · `GET /trips/{id}` · `PATCH /trips/{id}` 🔒 · `POST /trips/{id}/verification` 🔒 · `POST /trips/{id}/publish` 🔒 (K3/K4) · `POST /trips/{id}/depart|complete|cancel` 🔒 · `GET /trips/{id}/recommended-requests` 🔒
- `POST /requests/extract` 🔒 {url|fileId|query} · `POST /requests` 🔒 · `GET /requests/mine` 🔒 · `GET /requests/open` 🔒 (traveler) · `GET /requests/{id}` 🔒 · `PATCH /requests/{id}` 🔒 · `POST /requests/{id}/publish|cancel` 🔒 · `GET /requests/{id}/recommended-travelers` 🔒
- `POST /requests/{id}/offers` 🔒 (traveler, K3) · `POST /trips/{id}/invites` 🔒 (buyer) · `GET /requests/{id}/offers` 🔒 · `GET /offers/mine` 🔒 · `POST /offers/{id}/accept|decline|withdraw` 🔒
- **Accept offer** membuat baris `transactions` (status REQUEST_CREATED, nomor `JK-…` dari core) lalu `transition_transaction(→ MATCHED)` dalam satu transaksi DB; reservasi kapasitas trip; menutup offer lain.
- Jobs: ambil kurs (fx_rates) berkala; kedaluwarsakan offer & request; otomasi trip (TRAVELING/COMPLETED).

### money (transaksi setelah MATCHED, quote/checkout, SafePay/Xendit, webhook, ledger, price confirmation, purchase proof, perjalanan, bea cukai, delivery, konfirmasi, pembatalan, refund, payout, proteksi/asuransi)
- `GET /transactions` 🔒 (?role=buyer|traveler&status=) · `GET /transactions/{id}` 🔒 (detail + quote lines + `purchaseGate` + `allowedActions` untuk pemanggil) · `GET /transactions/{id}/timeline` 🔒
- `POST /transactions/{id}/quote` 🔒 {channel, promoCode?, useCredit?} → breakdown lengkap (FX lock, customs, restricted, limit)
- `POST /transactions/{id}/checkout` 🔒💰 (K2) {quoteId, channel, acknowledgeRestricted} → {paymentId, checkoutUrl, expiresAt}
- `GET /transactions/{id}/payment` 🔒
- `POST /webhooks/payments/xendit` · `POST /webhooks/payments/mock` (verifikasi token/signature, dedupe event, proses)
- dev: `GET /dev/mock-checkout/{ref}` (halaman simulasi) · `POST /dev/mock-checkout/{ref}/pay`
- Traveler: `POST /transactions/{id}/price-check` · `POST /transactions/{id}/price-confirmations/{pcId}/clarify` · `POST /transactions/{id}/purchase-proof` · `POST /transactions/{id}/status` {to} · `POST /transactions/{id}/customs-declaration` · `POST /transactions/{id}/delivery` · `POST /transactions/{id}/delivery/verify` {pin|qrToken} · `POST /transactions/{id}/delivery/shipped` · `POST /transactions/{id}/delivery/delivered`
- Buyer: `POST /transactions/{id}/price-confirmations/{pcId}/respond` 💰 {action APPROVE|REJECT|CLARIFY} · `GET /transactions/{id}/delivery/pin` · `POST /transactions/{id}/confirm-receipt` 💰
- `POST /transactions/{id}/cancel` 🔒💰 {reason, cause?} · `GET /transactions/{id}/refunds` 🔒 · `POST /refunds/{id}/destination` 🔒 (rekening buyer bila kanal tidak mendukung refund)
- `GET /payouts/mine` 🔒 · `GET /credits/balance` dibaca dari `credit_entries` (endpoint milik engagement)
- Jobs: kedaluwarsa quote/FX lock/payment, price confirmation, auto-confirm, COMPLETED + payout, proses refund & payout, rekonsiliasi.

### engagement (notifikasi, chat, rating, dispute, referral & credit, promo sisi user, support/FAQ, analytics, trust score)
- `GET /notifications` 🔒 · `GET /notifications/unread-count` 🔒 · `POST /notifications/{id}/read` · `POST /notifications/read-all` · `GET/PUT /notifications/preferences` 🔒
- `GET /conversations` 🔒 · `GET /conversations/{id}/messages` 🔒 · `POST /conversations/{id}/messages` 🔒 · `POST /conversations/{id}/read` 🔒
- `POST /transactions/{id}/ratings` 🔒 · `GET /users/{id}/rating-summary` (publik)
- `POST /transactions/{id}/disputes` 🔒 · `GET /disputes/mine` 🔒 · `GET /disputes/{id}` 🔒 · `POST /disputes/{id}/evidence` 🔒 · `POST /disputes/{id}/appeal` 🔒 · `POST /disputes/{id}/withdraw` 🔒
- `GET /referrals/me` 🔒 · `POST /referrals/apply` 🔒 {code} · `GET /credits` 🔒 (saldo, riwayat, akan kedaluwarsa)
- `POST /promotions/validate` 🔒 · `GET /promotions/active` (publik)
- `GET /support/faq` · `GET /support/faq/{slug}` · `POST /support/tickets` 🔒 · `GET /support/tickets` 🔒 · `GET /support/tickets/{id}` 🔒 · `POST /support/tickets/{id}/messages` 🔒
- `POST /analytics/events` (batch, anon diperbolehkan, allowlist nama event)
- Jobs/outbox: notifikasi multi-channel (in-app/push/email) untuk semua event lifecycle; pesan sistem chat; hadiah referral saat COMPLETED; hitung ulang Trust Score & evaluasi level 5; ringkasan rating; SLA dispute.

### admin (gelombang B) — `/v1/admin/*`, RBAC + MFA step-up untuk aksi sensitif
Dashboard metrik, users (suspend), KYC review, verifikasi trip, transaksi (lihat/override terbatas), dispute (resolusi → refund), refund approval (maker-checker), payout hold/release, business config (propose/approve, versi), customs & restricted rules (versi), promo, referral program, risk review, trust override (maker-checker), settlement accounts (masked, maker-checker + MFA, FINANCE_SUPER_ADMIN), audit log, DB & Infra Center, support tickets, moderasi chat, legal docs & FAQ, RBAC.

## 5. Definition of Done per modul
- Endpoint sesuai katalog, terdokumentasi di OpenAPI (schema request/response lengkap, contoh).
- Test integrasi per endpoint: happy path + auth/permission + validasi + aturan bisnis utama + idempotensi (bila 💰).
- Tidak ada TODO palsu pada fitur inti. Integrasi sandbox/mock diberi label jelas.
- `npx tsc --noEmit -p apps/api` bersih; test grup hijau.

## 6. Katalog event outbox (kontrak antar grup)
Producer menulis event di transaksi DB yang sama (`emitEvent(tx, aggregateType, aggregateId, eventType, payload)`); consumer mendaftar di `jobs/<group>.ts` → `outbox: { 'event.type': [handler] }`. Consumer WAJIB idempotent (pakai `event.eventId`). Payload tidak boleh berisi PII mentah (email/HP/rekening) — kirim id, consumer memuat data yang diperlukan.

| Event | Producer | Payload minimum |
|---|---|---|
| `transaction.status_changed` | DB `transition_transaction` | transactionId, number, from, to, version, buyerId, travelerId, actorType, actorId, reason, meta |
| `trip.status_changed` | DB `transition_trip` | tripId, from, to, … |
| `dispute.status_changed` | DB `transition_dispute` | disputeId, from, to, … |
| `config.activated` | DB | key, version |
| `user.anonymized` | DB `anonymize_user` | userId |
| `user.registered` | identity | userId, method (GOOGLE/APPLE/EMAIL/PHONE) |
| `user.phone_verified` | identity | userId |
| `kyc.submitted` / `kyc.approved` / `kyc.rejected` | identity (approved/rejected juga admin) | userId, submissionId, targetLevel, reason? |
| `kyc.level_changed` | identity | userId, from, to |
| `payout_account.verified` | identity | userId, payoutAccountId |
| `trip.verified` | admin/system | tripId, travelerId |
| `request.created` | marketplace | requestId, buyerId |
| `offer.created` / `offer.accepted` / `offer.declined` / `offer.expired` | marketplace | offerId, requestId, tripId, buyerId, travelerId, initiatedBy, transactionId? |
| `payment.checkout_created` | money | paymentId, transactionId, buyerId, amountIdr, expiresAt |
| `payment.secured` / `payment.expired` / `payment.failed` | money | paymentId, transactionId, buyerId, travelerId, amountIdr, channel? |
| `price_confirmation.requested` / `price_confirmation.resolved` | money | priceConfirmationId, transactionId, buyerId, travelerId, originalIdr, actualIdr, expiresAt, status |
| `purchase.proof_submitted` | money | transactionId, proofId, flagged |
| `delivery.pin_ready` | money | transactionId, buyerId (PIN TIDAK dikirim di payload/email — hanya di aplikasi) |
| `refund.requested` / `refund.succeeded` / `refund.failed` | money | refundId, transactionId, buyerId, amountIdr |
| `payout.scheduled` / `payout.paid` / `payout.failed` / `payout.on_hold` | money | payoutId, travelerId, transactionId, amountIdr |
| `receipt.final_available` | money | transactionId, buyerId |
| `dispute.opened` / `dispute.evidence_added` / `dispute.resolved` / `dispute.appealed` | engagement / admin | disputeId, transactionId, buyerId, travelerId, resolution? |
| `chat.message_created` | engagement | conversationId, messageId, senderId, recipientId, type |
| `referral.rewarded` | engagement | referralId, userId, amountIdr |
| `support.ticket_updated` | engagement / admin | ticketId, userId, status |
| `privacy.export_ready` / `account.deletion_scheduled` | identity | requestId?, userId, effectiveAt? |

Notifikasi (engagement) memetakan event di atas ke template in-app/push/email sesuai daftar lifecycle di brief (§18) dan preferensi user.
