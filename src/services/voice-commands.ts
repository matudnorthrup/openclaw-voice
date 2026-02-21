import type { VoiceMode } from './queue-state.js';

export type VoiceCommand =
  | { type: 'switch'; channel: string }
  | { type: 'dispatch'; body: string }
  | { type: 'list' }
  | { type: 'default' }
  | { type: 'noise'; level: string }
  | { type: 'delay'; value: number }
  | { type: 'delay-adjust'; direction: 'longer' | 'shorter' }
  | { type: 'settings' }
  | { type: 'new-post' }
  | { type: 'mode'; mode: VoiceMode }
  | { type: 'inbox-check' }
  | { type: 'inbox-next' }
  | { type: 'inbox-clear' }
  | { type: 'read-last-message' }
  | { type: 'voice-status' }
  | { type: 'voice-channel' }
  | { type: 'gated-mode'; enabled: boolean }
  | { type: 'wake-check' }
  | { type: 'silent-wait' }
  | { type: 'hear-full-message' }
  | { type: 'pause' }
  | { type: 'replay' }
  | { type: 'earcon-tour' }
  | { type: 'what-channel' };

export interface ChannelOption {
  index: number;
  name: string;
  displayName: string;
}

/**
 * Extracts the portion of a transcript starting from a valid wake word position.
 * Handles common Whisper STT artifacts:
 * - Filler words prepended before wake word ("And hello Watson")
 * - Wake word appearing after sentence boundaries ("Bad luck. Hello Watson, do X")
 * Returns null if no valid wake word position is found.
 */
export function extractFromWakeWord(transcript: string, botName: string): string | null {
  const trimmed = transcript.trim();
  if (!trimmed) return null;
  const escaped = escapeRegex(botName);

  // Core wake pattern: optional "hey/hello" + bot name
  const wakeCore = `(?:(?:hey|hello),?\\s+)?${escaped}\\b`;

  // 1. Direct match at start (existing behavior)
  if (new RegExp(`^${wakeCore}`, 'i').test(trimmed)) {
    return trimmed;
  }

  // 2. Match at start with filler prefix (common Whisper artifact)
  const fillerWords = '(?:and|so|okay|oh|um|uh|well|like|but|now)';
  if (new RegExp(`^${fillerWords}[,.]?\\s+${wakeCore}`, 'i').test(trimmed)) {
    const wakeMatch = trimmed.match(new RegExp(wakeCore, 'i'));
    if (wakeMatch?.index !== undefined) {
      return trimmed.slice(wakeMatch.index);
    }
  }

  // 3. Scan sentence boundaries — find first segment starting with wake word
  const segments = trimmed.split(/(?<=[.!?\n])\s+/);
  if (segments.length > 1) {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i].replace(/^[.!?\s]+/, '').trim();
      if (!seg) continue;

      if (new RegExp(`^${wakeCore}`, 'i').test(seg)) {
        return segments.slice(i).join(' ').replace(/^[.!?\s]+/, '').trim();
      }

      // Filler + wake at segment start
      if (new RegExp(`^${fillerWords}[,.]?\\s+${wakeCore}`, 'i').test(seg)) {
        const wakeMatch = seg.match(new RegExp(wakeCore, 'i'));
        if (wakeMatch?.index !== undefined) {
          const rest = seg.slice(wakeMatch.index);
          const remaining = segments.slice(i + 1).join(' ');
          return (rest + (remaining ? ' ' + remaining : '')).trim();
        }
      }
    }
  }

  return null;
}

export function matchesWakeWord(transcript: string, botName: string): boolean {
  return extractFromWakeWord(transcript, botName) !== null;
}

export function parseVoiceCommand(transcript: string, botName: string): VoiceCommand | null {
  // Extract the effective transcript starting from the wake word
  const effective = extractFromWakeWord(transcript, botName);
  if (!effective) return null;

  const trimmed = effective.trim();
  const trigger = new RegExp(`^(?:(?:hey|hello),?\\s+)?${escapeRegex(botName)}[,.]?\\s*`, 'i');
  const match = trimmed.match(trigger);
  if (!match) return null;

  // Handle repeated wake-only utterances like:
  // "Hello Watson. Hello Watson."
  // "Hello Watson, Watson"
  const restRaw = trimmed.slice(match[0].length).trim();
  if (restRaw.length > 0) {
    const wakeOnlySegment = new RegExp(`^(?:(?:hey|hello),?\\s+)?${escapeRegex(botName)}$`, 'i');
    const segments = restRaw
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length > 0 && segments.every((seg) => wakeOnlySegment.test(seg))) {
      return { type: 'wake-check' };
    }
  }

  const rest = trimmed
    .slice(match[0].length)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[.!?,]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bin-?box\b/g, 'inbox')
    .replace(/\bin\s+box\b/g, 'inbox')
    .replace(/\b(?:wheat|weight|wade|weigh)\b/g, 'wait');
  if (!rest) {
    return { type: 'wake-check' };
  }

  // Mode switch — must come before "switch to X" to avoid matching "switch to inbox mode" as a channel switch
  // Avoid "switch to" prefix here — it collides with the channel-switch regex when STT mangles words.
  // Use "enable", "activate", "set", or bare "<mode> mode" instead.
  const modeMatch = rest.match(/^(?:(?:enable|activate|set)\s+)?(inbox|queue|wait|ask)\s+mode$/);
  if (modeMatch) {
    const spoken = modeMatch[1];
    const mode: VoiceMode = spoken === 'inbox' ? 'queue' : spoken as VoiceMode;
    return { type: 'mode', mode };
  }

  // "dispatch to <channel> <payload>", "dispatch this message to <channel> <payload>",
  // and natural variants like "dispatch this in my <channel> ..."
  // Keep this before switch parsing so dispatch phrases don't degrade into channel switch.
  const dispatchMatch = rest.match(
    /^(?:(?:please|can\s+you|could\s+you|would\s+you)\s+)*(?:dispatch|deliver|route)\s+(?:this(?:\s+message)?\s+)?(?:to|in|into)\s+(.+)$/,
  );
  if (dispatchMatch) {
    const body = dispatchMatch[1].trim();
    if (body.length > 0) {
      return { type: 'dispatch', body };
    }
  }

  // "switch to X", "go to X", "change to X", "move to X"
  // "which to X" — common Whisper mishearing of "switch to"
  // Exclude "inbox" — handled below as inbox-check
  const switchMatch = rest.match(/^(?:switch|which|go|change|move)\s+to\s+(.+)$/);
  if (switchMatch) {
    const target = switchMatch[1].trim();
    if (/^(?:inbox|the\s+inbox|my\s+inbox)$/.test(target)) {
      return { type: 'inbox-check' };
    }
    return { type: 'switch', channel: target };
  }

  // "change channels", "switch channels", "list channels", "show channels"
  // Voice UX: map these to inbox status rather than channel enumeration.
  if (/^(?:change|switch|list|show)\s+channels?$/.test(rest)) {
    return { type: 'inbox-check' };
  }

  // "go back", "go to default", "go home", "default", "go to default channel"
  if (/^(?:go\s+back|go\s+(?:to\s+)?default(?:\s+channel)?|go\s+home|default)$/.test(rest)) {
    return { type: 'default' };
  }

  // "set noise to high", "set noise level high", "noise low", "noise 800"
  const noiseMatch = rest.match(/^(?:set\s+)?noise(?:\s+level)?\s+(?:to\s+)?(.+)$/);
  if (noiseMatch) {
    return { type: 'noise', level: noiseMatch[1].trim() };
  }

  // "set delay to 3000", "delay 2000", "set delay 500 milliseconds"
  const delayMatch = rest.match(
    /^(?:set\s+)?delay\s+(?:to\s+)?(\d+)(?:\s*(?:ms|millisecond|milliseconds))?$/,
  );
  if (delayMatch) {
    return { type: 'delay', value: parseInt(delayMatch[1], 10) };
  }

  // "longer delay", "shorter delay", "delay longer", "delay shorter"
  const delayAdjustMatch = rest.match(/^(longer|shorter)\s+delay$|^delay\s+(longer|shorter)$/);
  if (delayAdjustMatch) {
    const direction = (delayAdjustMatch[1] || delayAdjustMatch[2]) as 'longer' | 'shorter';
    return { type: 'delay-adjust', direction };
  }

  // "voice settings", "settings", "what are my settings", "what are the settings"
  if (/^(?:voice\s+)?settings$|^what\s+are\s+(?:my|the)\s+settings$/.test(rest)) {
    return { type: 'settings' };
  }

  // "create/make/start a post/thread/topic" — kicks off guided multi-step flow
  if (/(?:make|create|start)\s+.*?(?:post|thread|topic|discussion)/.test(rest)) {
    return { type: 'new-post' };
  }

  // "what channel", "channel", "which channel", "current channel", "where am I"
  if (/^(?:(?:what|which|current)\s+)?channel$|^where\s+am\s+i$/.test(rest)) {
    return { type: 'what-channel' };
  }

  // "voice status", "status"
  if (/^(?:voice\s+)?status$/.test(rest)) {
    return { type: 'voice-status' };
  }

  // "voice channel", "what channel", "which channel", "current channel", "where am I"
  if (/^(?:(?:voice|what|which|current)\s+channel|where\s+am\s+i|what\s+channel\s+(?:am\s+i\s+(?:in|on)|is\s+this))$/.test(rest)) {
    return { type: 'voice-channel' };
  }

  // "gated mode", "gate on" → enable gated; "open mode", "gate off", "ungated mode" → disable
  if (/^(?:gated\s+mode|gate\s+on)$/.test(rest)) {
    return { type: 'gated-mode', enabled: true };
  }
  if (/^(?:open\s+mode|gate\s+off|ungated\s+mode)$/.test(rest)) {
    return { type: 'gated-mode', enabled: false };
  }

  // "inbox list", "what do I have", "check inbox", "what's new", "inbox"
  if (/^(?:inbox(?:\s+(?:list|status|check))?|what\s+do\s+(?:i|you)\s+have(?:\s+for\s+me)?|check\s+(?:the\s+)?(?:queue|inbox)|what'?s\s+(?:waiting|ready|new)|queue\s+status)$/.test(rest)) {
    return { type: 'inbox-check' };
  }
  if (/\bback\s+to\s+inbox\b/.test(rest) || /\binbox\s+list\b/.test(rest)) {
    return { type: 'inbox-check' };
  }

  // "next", "next response", "next one", "next message", "next channel", "done", "I'm done", "move on", "skip", "skip it", "skip this"
  if (/^(?:next(?:\s+(?:response|one|message|channel))?|(?:i'?m\s+)?done|i\s+am\s+done|move\s+on|skip(?:\s+(?:it|this(?:\s+(?:one|message|part))?|that))?)$/.test(rest)) {
    return { type: 'inbox-next' };
  }

  // "clear inbox", "clear the inbox", "mark inbox read", "clear all"
  if (/^(?:clear\s+(?:the\s+)?inbox|mark\s+(?:the\s+)?inbox\s+(?:as\s+)?read|mark\s+all\s+read|clear\s+all)$/.test(rest)) {
    return { type: 'inbox-clear' };
  }

  // "read last message", "read the last message", "last message"
  if (/^(?:read\s+(?:the\s+)?last\s+message|last\s+message)$/.test(rest)) {
    return { type: 'read-last-message' };
  }

  // "hear full message", "hear a full message", "here full message" (STT homophone),
  // "hear fullness" (STT misheard), "read full message", "full message"
  if (/^(?:hear|here|read|play)\s+(?:(?:the|a|an)\s+)?full(?:ness|\s+message)$|^full\s+message$/.test(rest)) {
    return { type: 'hear-full-message' };
  }

  // "silent", "wait quietly", "quiet wait" — only meaningful while a wait is in-flight
  if (/^(?:silent|silently|wait\s+quietly|quiet\s+wait)$/.test(rest)) {
    return { type: 'silent-wait' };
  }

  // "pause", "stop", "be quiet", etc.
  if (/^(?:pause|stop(?:\s+talking)?|be\s+quiet|shut\s+up|shush|hush|quiet|silence|enough)$/.test(rest)) {
    return { type: 'pause' };
  }

  // "replay", "re-read", "reread", "read that again", "say that again", "repeat", "repeat that", "what did you say", "come again"
  if (/^(?:replay|re-?read|read\s+that\s+again|say\s+that\s+again|repeat(?:\s+that)?|what\s+did\s+you\s+say|come\s+again)$/.test(rest)) {
    return { type: 'replay' };
  }

  // Earcon/sound demo commands: "earcon tour", "voice tour", "sound check", etc.
  if (/^(?:(?:earcon|earcons|sound|sounds|voice|audio)\s+(?:tour|demo|test|check)|test\s+(?:earcon|earcons|sounds?|audio)|ear\s+contour)$/.test(rest)) {
    return { type: 'earcon-tour' };
  }

  return null;
}

export function matchSwitchChoice(transcript: string): 'read' | 'prompt' | 'cancel' | null {
  const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');

  // Match "cancel" first — discard
  if (/^(?:cancel|nevermind|never\s*mind|forget\s*it|nothing)$/.test(input)) return 'cancel';
  if (/\b(?:cancel|nevermind|never\s*mind|forget\s*it)\b/.test(input)) return 'cancel';

  // Match "prompt" and variants
  if (/^(?:prompt|skip|no|nope|pass|just prompt|new prompt|skip it|new message)$/.test(input)) return 'prompt';
  if (/\b(?:prompt|frompt|prompts?|prompted|romped|ramped|skip|pass)\b/.test(input)) return 'prompt';
  if (/\bnew\s+(?:prompt|message)\b/.test(input)) return 'prompt';

  // Match "read" and variants (including common STT confusions)
  if (/^(?:read|read it|read that|yes|yeah|yep|sure|go ahead|read it back|read back|last message)$/.test(input)) return 'read';
  if (/\b(?:read|reed|red)\b/.test(input)) return 'read';
  if (/\blast\s+message\b/.test(input)) return 'read';
  if (/\b(?:yes|yeah|yep|sure)\b/.test(input)) return 'read';

  return null;
}

export function matchQueueChoice(transcript: string): 'queue' | 'wait' | 'silent' | 'cancel' | null {
  const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');
  const hasQueue = /\b(?:send\s+to\s+inbox|inbox|in box|queue|cue|q)\b/.test(input);
  const hasWait = /\b(?:wait\s+here|wait|weight|wheat|wade|weigh|way)\b/.test(input);

  // Match "silent" / "silently" — queue but wait without tones
  if (/^(?:silent|silently|silence|quiet|quietly|shh)$/.test(input)) return 'silent';
  if (/\b(?:silent|silently|silence|quiet|quietly|shh)\b/.test(input)) return 'silent';

  // Match "inbox" and variants — the prompt asks "Inbox, or wait?"
  if (hasQueue && hasWait) return null;
  if (hasQueue) return 'queue';
  if (/^(?:send\s+to\s+inbox|inbox|in box|queue|cue|q|yes|yep|yeah)$/.test(input)) return 'queue';
  if (/\bsend\s+to\s+inbox\b/.test(input)) return 'queue';
  if (/\b(?:yes|yep|yeah)\b/.test(input)) return 'queue';

  // Match "wait" and common Whisper misrecognitions
  if (hasWait) return 'wait';
  if (/^(?:wait\s+here|wait|weight|wheat|wade|weigh|way|no|nope)$/.test(input)) return 'wait';
  if (/\bwait\s+here\b/.test(input)) return 'wait';
  if (/\b(?:no|nope)\b/.test(input)) return 'wait';

  // Match "cancel" — discard the utterance entirely
  if (/^(?:cancel|nevermind|never\s*mind|forget\s*it|discard|nothing|ignore|ignore\s+that)$/.test(input)) return 'cancel';
  if (/\b(?:cancel|nevermind|never\s*mind|forget\s*it|discard|nothing|ignore)\b/.test(input)) return 'cancel';

  return null;
}

export function matchChannelSelection(
  transcript: string,
  options: ChannelOption[],
): ChannelOption | null {
  const input = transcript.trim().toLowerCase();

  // Try numeric match: "1", "2", "number 3", etc.
  const numMatch = input.match(/^(?:number\s+)?(\d+)$/);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    return options.find((o) => o.index === num) ?? null;
  }

  // Try exact display name match
  const exact = options.find(
    (o) => o.displayName.toLowerCase() === input || o.name.toLowerCase() === input,
  );
  if (exact) return exact;

  // Try substring / fuzzy match (display name contains input or input contains display name)
  const fuzzy = options.find(
    (o) =>
      o.displayName.toLowerCase().includes(input) ||
      input.includes(o.displayName.toLowerCase()) ||
      o.name.toLowerCase().includes(input) ||
      input.includes(o.name.toLowerCase()),
  );
  return fuzzy ?? null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
