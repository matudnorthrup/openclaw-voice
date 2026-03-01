export type AudioProcessingMode = 'discord' | 'local';
export type EndpointingMode = 'silence' | 'indicate';
export type VadFrameSamples = 512 | 1024 | 1536;

export interface VoiceSettingsValues {
  silenceDurationMs: number;
  speechThreshold: number;
  minSpeechDurationMs: number;
  gated: boolean;
  audioProcessing: AudioProcessingMode;
  endpointingMode: EndpointingMode;
  indicateCloseWords: string[];
  indicateTimeoutMs: number;
  sttStreamingEnabled: boolean;
  sttStreamingChunkMs: number;
  sttStreamingMinChunkMs: number;
  sttStreamingOverlapMs: number;
  sttStreamingMaxChunks: number;
  vadPositiveSpeechThreshold: number;
  vadNegativeSpeechThreshold: number;
  vadFrameSamples: VadFrameSamples;
  localStreamIdleMs: number;
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
  audioProcessing: 'discord',
  endpointingMode: 'silence',
  indicateCloseWords: ['over and out', 'over', 'whiskey foxtrot', 'whiskey delta', "i'm done", "i'm finished", 'go ahead'],
  indicateTimeoutMs: 20000,
  sttStreamingEnabled: false,
  sttStreamingChunkMs: 900,
  sttStreamingMinChunkMs: 450,
  sttStreamingOverlapMs: 180,
  sttStreamingMaxChunks: 8,
  vadPositiveSpeechThreshold: 0.5,
  vadNegativeSpeechThreshold: 0.35,
  vadFrameSamples: 512,
  localStreamIdleMs: 4000,
};

let initialized = false;

export function initVoiceSettings(values: Partial<VoiceSettingsValues>): void {
  if (values.silenceDurationMs !== undefined) settings.silenceDurationMs = values.silenceDurationMs;
  if (values.speechThreshold !== undefined) settings.speechThreshold = values.speechThreshold;
  if (values.minSpeechDurationMs !== undefined) settings.minSpeechDurationMs = values.minSpeechDurationMs;
  if (values.gated !== undefined) settings.gated = values.gated;
  if (values.audioProcessing !== undefined) settings.audioProcessing = values.audioProcessing;
  if (values.endpointingMode !== undefined) settings.endpointingMode = values.endpointingMode;
  if (values.indicateCloseWords !== undefined) settings.indicateCloseWords = values.indicateCloseWords;
  if (values.indicateTimeoutMs !== undefined) settings.indicateTimeoutMs = values.indicateTimeoutMs;
  if (values.sttStreamingEnabled !== undefined) settings.sttStreamingEnabled = values.sttStreamingEnabled;
  if (values.sttStreamingChunkMs !== undefined) settings.sttStreamingChunkMs = Math.max(250, values.sttStreamingChunkMs);
  if (values.sttStreamingMinChunkMs !== undefined) settings.sttStreamingMinChunkMs = Math.max(200, values.sttStreamingMinChunkMs);
  if (values.sttStreamingOverlapMs !== undefined) settings.sttStreamingOverlapMs = Math.max(0, values.sttStreamingOverlapMs);
  if (values.sttStreamingMaxChunks !== undefined) settings.sttStreamingMaxChunks = Math.max(1, values.sttStreamingMaxChunks);
  if (values.vadPositiveSpeechThreshold !== undefined) settings.vadPositiveSpeechThreshold = values.vadPositiveSpeechThreshold;
  if (values.vadNegativeSpeechThreshold !== undefined) settings.vadNegativeSpeechThreshold = values.vadNegativeSpeechThreshold;
  if (values.vadFrameSamples !== undefined) settings.vadFrameSamples = values.vadFrameSamples;
  if (values.localStreamIdleMs !== undefined) settings.localStreamIdleMs = values.localStreamIdleMs;
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

export function setAudioProcessingMode(mode: AudioProcessingMode): void {
  settings.audioProcessing = mode;
}

export function setEndpointingMode(mode: EndpointingMode): void {
  settings.endpointingMode = mode;
}

export function setIndicateCloseWords(words: string[]): void {
  settings.indicateCloseWords = words
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

export function setIndicateTimeoutMs(ms: number): void {
  settings.indicateTimeoutMs = Math.max(1000, ms);
}

export function setSttStreamingEnabled(enabled: boolean): void {
  settings.sttStreamingEnabled = enabled;
}

export function setSttStreamingChunkMs(ms: number): void {
  settings.sttStreamingChunkMs = Math.max(250, ms);
}

export function setSttStreamingMinChunkMs(ms: number): void {
  settings.sttStreamingMinChunkMs = Math.max(200, ms);
}

export function setSttStreamingOverlapMs(ms: number): void {
  settings.sttStreamingOverlapMs = Math.max(0, ms);
}

export function setSttStreamingMaxChunks(maxChunks: number): void {
  settings.sttStreamingMaxChunks = Math.max(1, Math.floor(maxChunks));
}

export function setLocalVadThresholds(positive: number, negative: number): void {
  settings.vadPositiveSpeechThreshold = positive;
  settings.vadNegativeSpeechThreshold = negative;
}

export function setLocalVadFrameSamples(samples: VadFrameSamples): void {
  settings.vadFrameSamples = samples;
}

export function setLocalStreamIdleMs(ms: number): void {
  settings.localStreamIdleMs = ms;
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
