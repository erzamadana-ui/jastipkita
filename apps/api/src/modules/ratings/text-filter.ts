/**
 * Light comment filter for ratings: masks common Indonesian/English profanity and contact details
 * (reusing the chat moderation masks). Comments stay published — this is hygiene, not censorship.
 */
import { moderateText } from '../chat/moderation';

const PROFANITY = [
  'anjing',
  'anjir',
  'bangsat',
  'babi',
  'bajingan',
  'keparat',
  'brengsek',
  'kampret',
  'goblok',
  'goblog',
  'tolol',
  'bego',
  'idiot',
  'kontol',
  'memek',
  'ngentot',
  'jancuk',
  'asu',
  'tai',
  'fuck',
  'fucking',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'dick',
];
const PROFANITY_RE = new RegExp(`\\b(${PROFANITY.join('|')})\\b`, 'gi');

export interface FilteredComment {
  text: string | null;
  reasons: string[];
}

export function filterComment(raw: string | null | undefined): FilteredComment {
  const trimmed = raw?.replace(/\s+/g, ' ').trim() ?? '';
  if (!trimmed) return { text: null, reasons: [] };
  const reasons: string[] = [];
  let text = trimmed.replace(PROFANITY_RE, (w) => {
    if (!reasons.includes('PROFANITY_MASKED')) reasons.push('PROFANITY_MASKED');
    return `${w.charAt(0)}${'*'.repeat(Math.max(1, w.length - 1))}`;
  });
  const mod = moderateText(text);
  if (mod.masked !== text) {
    reasons.push('CONTACT_MASKED');
    text = mod.masked;
  }
  return { text, reasons };
}
