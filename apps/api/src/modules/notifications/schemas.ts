import { z } from '@hono/zod-openapi';
import { PageQuery } from '../../lib/pagination';
import { CHANNELS, PREF_GROUPS } from './templates/types';

export const NotificationSchema = z
  .object({
    id: z.string().uuid(),
    type: z.string().openapi({ example: 'transaction.payment_secured', description: 'Template key' }),
    category: z.string().openapi({ example: 'PAYMENT' }),
    title: z.string(),
    body: z.string(),
    data: z.record(z.string(), z.unknown()).openapi({ description: 'deepLink, webUrl, ids (transactionId, disputeId, …)' }),
    readAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('Notification');

export const NotificationListQuery = PageQuery.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .openapi({ description: 'Only unread notifications' }),
});

export const NotificationPage = z.object({ data: z.array(NotificationSchema), nextCursor: z.string().nullable() }).openapi('NotificationPage');

export const UnreadCountSchema = z.object({ count: z.number().int() }).openapi('UnreadCount');
export const ReadResultSchema = z.object({ id: z.string().uuid(), readAt: z.string() }).openapi('NotificationRead');
export const ReadAllResultSchema = z.object({ updated: z.number().int() }).openapi('NotificationReadAll');

export const PrefGroupSchema = z.enum(PREF_GROUPS);
export const ChannelSchema = z.enum(CHANNELS);

export const PreferencesSchema = z
  .object({
    groups: z.array(
      z.object({
        group: PrefGroupSchema,
        label: z.string(),
        channels: z.array(z.object({ channel: ChannelSchema, enabled: z.boolean(), locked: z.boolean() })),
      }),
    ),
    criticalNotice: z.string(),
  })
  .openapi('NotificationPreferences');

export const PreferencesUpdateSchema = z
  .object({
    preferences: z
      .array(z.object({ group: PrefGroupSchema, channel: ChannelSchema, enabled: z.boolean() }))
      .min(1)
      .max(15),
  })
  .openapi('NotificationPreferencesUpdate');
