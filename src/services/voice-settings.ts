export interface VoiceSettingsValues {
  silenceDurationMs: number;
  speechThreshold: number;
  minSpeechDurationMs: number;
  gated: boolean;
}

const NOISE_PRESETS: Record<string, number> = {
  low: 300,
  medium: 500,
  high: 800,
};

const settings: VoiceSettingsValues = {
  silenceDurationMs: 500,
  speechThreshold: 500,
  minSpeechDurationMs: 600,
  gated: true,
};

let initialized = false;

export function initVoiceSettings(values: Partial<VoiceSettingsValues>): void {
  if (values.silenceDurationMs !== undefined) settings.silenceDurationMs = values.silenceDurationMs;
  if (values.speechThreshold !== undefined) settings.speechThreshold = values.speechThreshold;
  if (values.minSpeechDurationMs !== undefined) settings.minSpeechDurationMs = values.minSpeechDurationMs;
  initialized = true;
}

export function getVoiceSettings(): Readonly<VoiceSettingsValues> {
  return settings;
}

export function setSilenceDuration(ms: number): void {
  settings.silenceDurationMs = ms;
}

export function setSpeechThreshold(value: number): void {
  settings.speechThreshold = value;
}

export function setMinSpeechDuration(ms: number): void {
  settings.minSpeechDurationMs = ms;
}

export function setGatedMode(on: boolean): void {
  settings.gated = on;
}

export function resolveNoiseLevel(input: string): { threshold: number; label: string } | null {
  const preset = NOISE_PRESETS[input.toLowerCase()];
  if (preset !== undefined) {
    return { threshold: preset, label: input.toLowerCase() };
  }

  const numeric = parseInt(input, 10);
  if (!isNaN(numeric) && numeric > 0) {
    return { threshold: numeric, label: String(numeric) };
  }

  return null;
}

export function getNoisePresetNames(): string[] {
  return Object.keys(NOISE_PRESETS);
}
