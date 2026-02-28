const CONTEXT_MARKER_RE = /\[Current message[\s\S]{0,30}respond to this\]/i;
const CHAT_HISTORY_MARKER_RE = /\[Chat messages since your last reply/i;
const USER_TRANSCRIPT_MARKER_RE = /\[(?:voice-user|discord-user)\]/i;
const ASSISTANT_LABEL_PREFIX_RE = /^(?:\[(?:voice-assistant|discord-assistant)\]\s*)+/i;
const ASSISTANT_LABEL_INLINE_RE = /\n\s*\[(?:voice-assistant|discord-assistant)\]/i;
const GATEWAY_METADATA_PATTERNS = [
  /conversation info \(untrusted metadata\):/i,
  /sender \(untrusted metadata\):/i,
  CHAT_HISTORY_MARKER_RE,
  CONTEXT_MARKER_RE,
];

function earliestIndex(text: string, patterns: RegExp[]): number {
  let best = -1;
  for (const pattern of patterns) {
    const idx = text.search(pattern);
    if (idx < 0) continue;
    if (best < 0 || idx < best) best = idx;
  }
  return best;
}

export function isGatewayMetadataWrapper(text: string): boolean {
  return GATEWAY_METADATA_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Defensive scrub for assistant payload artifacts produced by gateway/session
 * prompt formatting. Keeps only the assistant portion and drops transcript
 * wrappers like "[voice-user]" and context blocks.
 */
export function sanitizeAssistantResponse(text: string): string {
  let cleaned = (text ?? '').trim();
  if (!cleaned) return '';

  cleaned = cleaned.replace(ASSISTANT_LABEL_PREFIX_RE, '').trim();

  const cutoff = earliestIndex(cleaned, [
    USER_TRANSCRIPT_MARKER_RE,
    CHAT_HISTORY_MARKER_RE,
    CONTEXT_MARKER_RE,
    ASSISTANT_LABEL_INLINE_RE,
  ]);
  if (cutoff > 0) {
    cleaned = cleaned.slice(0, cutoff).trimEnd();
  }

  if (cleaned.search(USER_TRANSCRIPT_MARKER_RE) === 0) return '';
  if (cleaned.search(CHAT_HISTORY_MARKER_RE) === 0) return '';
  if (cleaned.search(CONTEXT_MARKER_RE) === 0) return '';

  return cleaned.trim();
}
