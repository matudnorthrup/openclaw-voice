import { GatewaySync, type ChatMessage } from '../services/gateway-sync.js';

export type SessionListEntry = {
  key: string;
  displayName?: string;
  channel?: string;
  status?: string;
};

export type BackfillableMessage = {
  stamp: number;
  role: 'user' | 'assistant';
  label: 'voice-user' | 'voice-assistant' | 'discord-user' | 'discord-assistant';
  text: string;
  signature: string;
};

const ALLOWED_LABELS = new Set<BackfillableMessage['label']>([
  'voice-user',
  'voice-assistant',
  'discord-user',
  'discord-assistant',
]);

const LABEL_PREFIX_RE = /^(?:\[(?:discord-user|discord-assistant|voice-user|voice-assistant)\]\s*)+/i;

const METADATA_RE = [
  /conversation info \(untrusted metadata\):/i,
  /sender \(untrusted metadata\):/i,
  /\[chat messages since your last reply/i,
  /\[current message - respond to this\]/i,
];

export function channelIdFromSessionKey(sessionKey: string): string | null {
  const normalized = GatewaySync.normalizeCompletionUserId(sessionKey);
  const match = normalized.match(/channel:(\d+)$/);
  return match ? match[1] : null;
}

export function canonicalSessionKeyForChannel(channelId: string): string {
  return GatewaySync.sessionKeyForChannel(channelId);
}

export function groupSessionFamilies(sessions: SessionListEntry[]): Map<string, string[]> {
  const families = new Map<string, string[]>();
  for (const session of sessions) {
    const channelId = channelIdFromSessionKey(session.key);
    if (!channelId) continue;
    const list = families.get(channelId) ?? [];
    list.push(session.key);
    families.set(channelId, list);
  }

  for (const [channelId, keys] of families) {
    const deduped = Array.from(new Set(keys)).sort((a, b) => a.length - b.length);
    families.set(channelId, deduped);
  }
  return families;
}

export function toBackfillableMessage(
  message: ChatMessage & { timestamp?: number },
  fallbackStamp: number,
): BackfillableMessage | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;

  const rawText = extractMessageText(message.content);
  if (!rawText) return null;

  if (METADATA_RE.some((re) => re.test(rawText))) return null;

  const label = extractMessageLabel(message, rawText);
  if (!label || !ALLOWED_LABELS.has(label)) return null;

  const cleaned = cleanMessageText(rawText);
  if (!cleaned) return null;

  const normalized = normalizeText(cleaned);
  if (!normalized) return null;

  const stamp = getMessageStamp(message, fallbackStamp);
  const signature = `${label}|${normalized.slice(0, 800)}`;

  return {
    stamp,
    role: message.role,
    label,
    text: cleaned,
    signature,
  };
}

export function getMessageStamp(message: ChatMessage & { timestamp?: number }, fallbackStamp: number): number {
  const ts = (message as any)?.timestamp;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  return fallbackStamp;
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function cleanMessageText(text: string): string {
  return text.replace(LABEL_PREFIX_RE, '').trim();
}

export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (typeof block === 'string') return block;
        if (block && typeof block.text === 'string') return block.text;
        return '';
      })
      .filter((part: string) => part.length > 0)
      .join('\n');
  }
  if (content == null) return '';
  return String(content);
}

export function extractMessageLabel(
  message: ChatMessage,
  rawText: string,
): BackfillableMessage['label'] | null {
  if (typeof message.label === 'string' && message.label.trim()) {
    const explicit = message.label.trim().toLowerCase();
    if (ALLOWED_LABELS.has(explicit as BackfillableMessage['label'])) {
      return explicit as BackfillableMessage['label'];
    }
  }

  const prefix = rawText.match(/^\[([a-z][\w-]*)\]\s*/i)?.[1]?.toLowerCase();
  if (prefix && ALLOWED_LABELS.has(prefix as BackfillableMessage['label'])) {
    return prefix as BackfillableMessage['label'];
  }

  return null;
}
