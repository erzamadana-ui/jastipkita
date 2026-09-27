import { z } from '@hono/zod-openapi';

export const MESSAGE_TYPES = ['TEXT', 'IMAGE', 'PRODUCT', 'RECEIPT', 'SYSTEM', 'STATUS'] as const;

export const MessageSchema = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    type: z.enum(MESSAGE_TYPES),
    senderId: z.string().uuid().nullable(),
    mine: z.boolean(),
    body: z.string().nullable().openapi({ description: 'Text as visible to participants (sensitive parts masked when FLAGGED; null when HIDDEN)' }),
    attachments: z.array(z.object({ fileId: z.string().uuid(), mime: z.string() })),
    meta: z.record(z.string(), z.unknown()).openapi({ description: 'product / receipt / status references' }),
    moderation: z.object({ status: z.enum(['CLEAN', 'FLAGGED', 'HIDDEN']), reasons: z.array(z.string()) }),
    createdAt: z.string(),
  })
  .openapi('ChatMessage');

export const ConversationSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(['OPEN', 'LOCKED', 'ARCHIVED']),
    myRole: z.enum(['BUYER', 'TRAVELER']),
    counterpart: z.object({ id: z.string().uuid(), name: z.string(), role: z.enum(['BUYER', 'TRAVELER']) }),
    transaction: z.object({ id: z.string().uuid(), number: z.string(), status: z.string(), productName: z.string().nullable() }).nullable(),
    lastMessage: z
      .object({ id: z.string().uuid(), type: z.string(), preview: z.string(), senderId: z.string().uuid().nullable(), createdAt: z.string() })
      .nullable(),
    unreadCount: z.number().int(),
    lastMessageAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('Conversation');

export const ConversationPage = z.object({ data: z.array(ConversationSchema), nextCursor: z.string().nullable() }).openapi('ConversationPage');
export const MessagePage = z.object({ data: z.array(MessageSchema), nextCursor: z.string().nullable() }).openapi('ChatMessagePage');

export const SendMessageSchema = z
  .object({
    type: z.enum(MESSAGE_TYPES).openapi({ description: 'SYSTEM / STATUS are reserved for the platform (403)' }),
    body: z.string().max(4000).optional().openapi({ description: 'TEXT body or IMAGE caption' }),
    fileIds: z.array(z.string().uuid()).min(1).max(5).optional().openapi({ description: 'IMAGE: completed files with purpose CHAT owned by the sender' }),
    requestId: z.string().uuid().optional().openapi({ description: 'PRODUCT: the request of this conversation' }),
    purchaseProofId: z.string().uuid().optional().openapi({ description: 'RECEIPT (traveler only): purchase proof of this transaction' }),
  })
  .openapi('SendChatMessage');

export const MarkReadSchema = z.object({ messageId: z.string().uuid().optional() }).openapi('ChatMarkRead');
export const MarkReadResult = z
  .object({ conversationId: z.string().uuid(), lastReadMessageId: z.string().uuid().nullable(), lastReadAt: z.string(), unreadCount: z.number().int() })
  .openapi('ChatReadState');
