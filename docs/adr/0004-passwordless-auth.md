# ADR 0004 — Passwordless authentication

- Status: Accepted (2026-09)
- Deciders: owner (GM), engineering

## Context
Buyers and travelers are consumers on mobile; passwords add reset flows, credential-stuffing risk and storage
liability. Phone verification is needed anyway (KYC level 2). Apple requires an equivalent privacy-preserving login
option when third-party login is offered (App Review 4.8).

## Decision
- Login = OTP (SMS, WhatsApp or e-mail) or Google / Apple ID token. First successful login creates the account
  (with explicit TOS + PRIVACY consent); registration is separate from KYC.
- OTP: 6 digits, 5-minute expiry, 5 attempts, HMAC-stored code and destination, cooldown 60 s, 5/h + 10/day per
  destination, 20/h per IP (DB-backed, works across Worker isolates).
- Sessions: access JWT HS256 15 minutes; opaque 256-bit refresh token (SHA-256 stored), single use, rotation, reuse
  detection revokes the whole family.
- Admin: same login + mandatory TOTP enrolment and step-up (≤ 15 min) for sensitive actions; recovery codes stored
  as HMAC.
- Token transport = `Authorization: Bearer` header only (no cookies → no CSRF surface).

## Consequences
- OTP delivery is a hard dependency: on staging, with e-mail/SMS in log mode, nobody can log in until Resend (or
  Google Sign-In) is configured — see `docs/07-deployment.md` §6.
- SMS/WhatsApp OTP costs money per message (Twilio; WhatsApp needs an approved template) → owner approval.
- SIM-swap risk remains for SMS; high-value actions are additionally gated by KYC level, risk scoring and payout
  account name matching.

## Alternatives considered
- Passwords + optional 2FA — more support load and breach impact.
- Passkeys/WebAuthn — attractive later (especially for admins); not in MVP scope.
