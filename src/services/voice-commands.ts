import type { VoiceMode } from './queue-state.js';

export type VoiceCommand =
  | { type: 'switch'; channel: string }
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
  | { type: 'voice-status' }
  | { type: 'gated-mode'; enabled: boolean }
  | { type: 'pause' }
  | { type: 'replay' }
  | { type: 'earcon-tour' };

export interface ChannelOption {
  index: number;
  name: string;
  displayName: string;
}

export function matchesWakeWord(transcript: string, botName: string): boolean {
  const pattern = new RegExp(`^(?:(?:hey|hello),?\\s+)?${escapeRegex(botName)}\\b`, 'i');
  return pattern.test(transcript.trim());
}

export function parseVoiceCommand(transcript: string, botName: string): VoiceCommand | null {
  const trimmed = transcript.trim();
  const trigger = new RegExp(`^(?:(?:hey|hello),?\\s+)?${escapeRegex(botName)}[,.]?\\s+`, 'i');
  const match = trimmed.match(trigger);
  if (!match) return null;

  const rest = trimmed.slice(match[0].length).trim().toLowerCase().replace(/[.!?,]+$/, '');

  // Mode switch — must come before "switch to X" to avoid matching "switch to inbox mode" as a channel switch
  const modeMatch = rest.match(/^(?:switch\s+to\s+)?(inbox|queue|wait|ask)\s+mode$/);
  if (modeMatch) {
    const spoken = modeMatch[1];
    const mode: VoiceMode = spoken === 'inbox' ? 'queue' : spoken as VoiceMode;
    return { type: 'mode', mode };
  }

  // "switch to X", "go to X", "change to X", "move to X"
  const switchMatch = rest.match(/^(?:switch|go|change|move)\s+to\s+(.+)$/);
  if (switchMatch) {
    return { type: 'switch', channel: switchMatch[1].trim() };
  }

  // "change channels", "switch channels", "list channels", "show channels"
  if (/^(?:change|switch|list|show)\s+channels?$/.test(rest)) {
    return { type: 'list' };
  }

  // "go back", "go to default", "go home", "default", "go to default channel"
  if (/^(?:go\s+back|go\s+(?:to\s+)?default(?:\s+channel)?|go\s+home|default)$/.test(rest)) {
    return { type: 'default' };
  }

  // "set noise to high", "noise low", "noise 800"
  const noiseMatch = rest.match(/^(?:set\s+)?noise\s+(?:to\s+)?(.+)$/);
  if (noiseMatch) {
    return { type: 'noise', level: noiseMatch[1].trim() };
  }

  // "set delay to 3000", "delay 2000"
  const delayMatch = rest.match(/^(?:set\s+)?delay\s+(?:to\s+)?(\d+)$/);
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

  // "voice status", "status"
  if (/^(?:voice\s+)?status$/.test(rest)) {
    return { type: 'voice-status' };
  }

  // "gated mode", "gate on" → enable gated; "open mode", "gate off", "ungated mode" → disable
  if (/^(?:gated\s+mode|gate\s+on)$/.test(rest)) {
    return { type: 'gated-mode', enabled: true };
  }
  if (/^(?:open\s+mode|gate\s+off|ungated\s+mode)$/.test(rest)) {
    return { type: 'gated-mode', enabled: false };
  }

  // "inbox list", "what do I have", "check inbox", "what's new", "inbox"
  if (/^(?:inbox(?:\s+list)?|what\s+do\s+(?:i|you)\s+have(?:\s+for\s+me)?|check\s+(?:the\s+)?(?:queue|inbox)|what'?s\s+(?:waiting|ready|new)|queue\s+status)$/.test(rest)) {
    return { type: 'inbox-check' };
  }
  if (/\bback\s+to\s+inbox\b/.test(rest) || /\binbox\s+list\b/.test(rest)) {
    return { type: 'inbox-check' };
  }

  // "next", "next response", "next one", "next message", "next channel", "done", "I'm done", "move on", "skip"
  if (/^(?:next(?:\s+(?:response|one|message|channel))?|(?:i'?m\s+)?done|i\s+am\s+done|move\s+on|skip(?:\s+(?:this(?:\s+(?:one|message))?|it))?)$/.test(rest)) {
    return { type: 'inbox-next' };
  }

  // "pause", "stop", "stop talking", "be quiet", "shut up", "shush", "hush", "quiet", "silence", "enough"
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
