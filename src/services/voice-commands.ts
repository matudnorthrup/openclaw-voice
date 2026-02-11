export type VoiceCommand =
  | { type: 'switch'; channel: string }
  | { type: 'list' }
  | { type: 'default' }
  | { type: 'noise'; level: string }
  | { type: 'delay'; value: number }
  | { type: 'delay-adjust'; direction: 'longer' | 'shorter' }
  | { type: 'settings' };

export interface ChannelOption {
  index: number;
  name: string;
  displayName: string;
}

export function parseVoiceCommand(transcript: string, botName: string): VoiceCommand | null {
  const trimmed = transcript.trim();
  const trigger = new RegExp(`^hey,?\\s+${escapeRegex(botName)}[,.]?\\s+`, 'i');
  const match = trimmed.match(trigger);
  if (!match) return null;

  const rest = trimmed.slice(match[0].length).trim().toLowerCase();

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
