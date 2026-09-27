import { z } from '@hono/zod-openapi';
import { ConsentInputSchema, DeviceInputSchema, ProfileSchema } from '../me/schemas';

export const OtpChannel = z.enum(['SMS', 'WHATSAPP', 'EMAIL']);
export const OtpPurpose = z.enum(['LOGIN', 'VERIFY_PHONE', 'VERIFY_EMAIL']);

export const OtpRequestBody = z
  .object({
    channel: OtpChannel,
    destination: z.string().min(5).max(254).openapi({ example: '+6281234567890' }),
    purpose: OtpPurpose.default('LOGIN'),
    locale: z.enum(['id', 'en']).optional(),
  })
  .openapi('OtpRequest');

export const OtpRequestResponse = z
  .object({
    challengeId: z.string().uuid(),
    expiresAt: z.string(),
    resendAvailableAt: z.string(),
    devCode: z.string().optional().openapi({ description: 'Only when OTP_DEV_ECHO=true (development/test); never in staging/production' }),
  })
  .openapi('OtpChallenge');

export const TokensSchema = z
  .object({
    tokenType: z.literal('Bearer'),
    accessToken: z.string(),
    accessTokenExpiresAt: z.string(),
    refreshToken: z.string(),
    refreshTokenExpiresAt: z.string(),
    sessionId: z.string().uuid(),
  })
  .openapi('Tokens');

const SignupExtras = {
  device: DeviceInputSchema.optional(),
  consents: z
    .array(ConsentInputSchema)
    .max(10)
    .optional()
    .openapi({ description: 'Required when a new account is created: TOS and PRIVACY granted (MARKETING optional)' }),
};

export const OtpVerifyBody = z
  .object({
    challengeId: z.string().uuid(),
    code: z.string().regex(/^\d{6}$/),
    ...SignupExtras,
  })
  .openapi('OtpVerify');

export const LoginResponse = z
  .object({
    tokens: TokensSchema,
    user: ProfileSchema,
    isNewUser: z.boolean(),
  })
  .openapi('LoginResult');

export const OtpVerifyResponse = z
  .object({
    purpose: OtpPurpose,
    verified: z.literal(true),
    user: ProfileSchema,
    tokens: TokensSchema.optional().openapi({ description: 'LOGIN only' }),
    isNewUser: z.boolean().optional().openapi({ description: 'LOGIN only' }),
  })
  .openapi('OtpVerifyResult');

export const GoogleBody = z
  .object({
    idToken: z.string().min(20).max(8192),
    nonce: z.string().max(256).optional(),
    ...SignupExtras,
  })
  .openapi('GoogleSignIn');

export const AppleBody = z
  .object({
    identityToken: z.string().min(20).max(8192),
    nonce: z.string().max(256).optional(),
    fullName: z
      .object({ givenName: z.string().max(40).optional(), familyName: z.string().max(40).optional() })
      .optional()
      .openapi({ description: 'Apple sends the name only on the FIRST authorization; stored only when the account is created' }),
    ...SignupExtras,
  })
  .openapi('AppleSignIn');

export const RefreshBody = z.object({ refreshToken: z.string().min(20).max(200) }).openapi('Refresh');
export const RefreshResponse = z.object({ tokens: TokensSchema }).openapi('RefreshResult');

export const SessionSchema = z
  .object({
    id: z.string().uuid(),
    current: z.boolean(),
    createdAt: z.string(),
    lastActiveAt: z.string(),
    expiresAt: z.string(),
    device: z.object({ id: z.string().uuid(), platform: z.string(), appVersion: z.string().nullable() }).nullable(),
    userAgent: z.string().nullable(),
  })
  .openapi('Session');

export const MfaEnrollResponse = z
  .object({
    factorId: z.string().uuid(),
    secret: z.string().openapi({ description: 'Base32 TOTP secret — shown ONCE, never returned again' }),
    otpauthUri: z.string(),
    issuer: z.string(),
  })
  .openapi('MfaEnrollment');

export const MfaCodeBody = z.object({ code: z.string().regex(/^\d{6}$/) }).openapi('MfaCode');
export const MfaVerifyBody = z
  .object({
    code: z.string().regex(/^\d{6}$/).optional(),
    recoveryCode: z.string().regex(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/).optional(),
  })
  .refine((b) => !!b.code !== !!b.recoveryCode, { message: 'Isi salah satu: code atau recoveryCode' })
  .openapi('MfaVerify');

export const MfaConfirmResponse = z
  .object({
    confirmed: z.literal(true),
    recoveryCodes: z.array(z.string()).openapi({ description: 'Shown ONCE' }),
    accessToken: z.string(),
    accessTokenExpiresAt: z.string(),
    mfaAt: z.number().int(),
  })
  .openapi('MfaConfirmation');

export const MfaVerifyResponse = z
  .object({ accessToken: z.string(), accessTokenExpiresAt: z.string(), mfaAt: z.number().int(), method: z.enum(['TOTP', 'RECOVERY_CODE']) })
  .openapi('MfaStepUp');
