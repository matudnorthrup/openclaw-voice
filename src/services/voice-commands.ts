import type { VoiceMode } from './queue-state.js';

export type VoiceCommand =
  | { type: 'switch'; channel: string }
  | { type: 'list' }
  | { type: 'default' }
  | { type: 'noise'; level: string }
  | { type: 'delay'; value: number }
  | { type: 'delay-adjust'; direction: 'longer' | 'shorter' }
  | { type: 'settings' }
  | { type: 'new-post'; forum: string; title: string }
  | { type: 'mode'; mode: VoiceMode }
  | { type: 'inbox-check' }
  | { type: 'inbox-next' }
  | { type: 'voice-status' };

export interface ChannelOption {
  index: number;
  name: string;
  displayName: string;
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

  // "make/create/start a (new) (forum) post/thread in [forum] about/called/titled [title]"
  const newPostMatch = rest.match(
    /^(?:make|create|start)\s+(?:a\s+)?(?:new\s+)?(?:forum\s+)?(?:post|thread)\s+in\s+(?:the\s+|my\s+)?(.+?)\s+(?:about|called|titled)\s+(.+)$/
  );
  if (newPostMatch) {
    return { type: 'new-post', forum: newPostMatch[1].trim(), title: newPostMatch[2].trim() };
  }

  // "voice status", "status"
  if (/^(?:voice\s+)?status$/.test(rest)) {
    return { type: 'voice-status' };
  }

  // "inbox list", "what do I have", "check inbox", "what's new", "inbox"
  if (/^(?:inbox(?:\s+list)?|what\s+do\s+(?:i|you)\s+have(?:\s+for\s+me)?|check\s+(?:the\s+)?(?:queue|inbox)|what'?s\s+(?:waiting|ready|new)|queue\s+status)$/.test(rest)) {
    return { type: 'inbox-check' };
  }

  // "next", "next response", "next one", "next message", "next channel", "done", "I'm done", "move on", "skip"
  if (/^(?:next(?:\s+(?:response|one|message|channel))?|(?:i'?m\s+)?done|i\s+am\s+done|move\s+on|skip(?:\s+(?:this(?:\s+(?:one|message))?|it))?)$/.test(rest)) {
    return { type: 'inbox-next' };
  }

  return null;
}

export function matchQueueChoice(transcript: string): 'queue' | 'wait' | null {
  const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');

  // Match "inbox" and variants — the prompt asks "Inbox, or wait?"
  if (/\binbox\b|\bqueue\b|\bcue\b/.test(input)) return 'queue';
  if (/^(?:inbox|in box|queue|cue|q|yes|yep|yeah)$/.test(input)) return 'queue';

  // Match "wait" and common Whisper misrecognitions
  if (/\bwait\b/.test(input)) return 'wait';
  if (/^(?:wait|weight|wade|weigh|way|no|nope)$/.test(input)) return 'wait';

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
