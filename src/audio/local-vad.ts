import { Message, NonRealTimeVAD, Resampler } from '@ricky0123/vad-node';
import type { VadFrameSamples, VoiceSettingsValues } from '../services/voice-settings.js';

const DISCORD_SAMPLE_RATE = 48_000;
const VAD_SAMPLE_RATE = 16_000;

export interface LocalVadRuntimeOptions {
  frameSamples: VadFrameSamples;
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  redemptionFrames: number;
  minSpeechFrames: number;
  preSpeechPadFrames: number;
}

export interface LocalVadEvent {
  type: 'speech-start' | 'speech-end' | 'misfire';
  pcm16?: Buffer;
  sampleRate?: number;
  durationMs?: number;
}

export function computeLocalVadRuntimeOptions(
  settings: Pick<
    VoiceSettingsValues,
    | 'silenceDurationMs'
    | 'minSpeechDurationMs'
    | 'vadFrameSamples'
    | 'vadPositiveSpeechThreshold'
    | 'vadNegativeSpeechThreshold'
  >,
): LocalVadRuntimeOptions {
  const frameSamples = settings.vadFrameSamples;
  const frameDurationMs = frameDurationForSamples(frameSamples);
  const positiveSpeechThreshold = clamp(settings.vadPositiveSpeechThreshold, 0, 1);
  const negativeSpeechThreshold = clamp(
    Math.min(settings.vadNegativeSpeechThreshold, positiveSpeechThreshold),
    0,
    positiveSpeechThreshold,
  );

  return {
    frameSamples,
    positiveSpeechThreshold,
    negativeSpeechThreshold,
    redemptionFrames: Math.max(1, Math.ceil(settings.silenceDurationMs / frameDurationMs)),
    minSpeechFrames: Math.max(1, Math.ceil(settings.minSpeechDurationMs / frameDurationMs)),
    preSpeechPadFrames: 1,
  };
}

export class LocalVadProcessor {
  private readonly frameProcessor: NonNullable<NonRealTimeVAD['frameProcessor']>;
  private readonly resampler: Resampler;

  private constructor(
    frameProcessor: NonNullable<NonRealTimeVAD['frameProcessor']>,
    frameSamples: VadFrameSamples,
  ) {
    this.frameProcessor = frameProcessor;
    this.resampler = new Resampler({
      nativeSampleRate: DISCORD_SAMPLE_RATE,
      targetSampleRate: VAD_SAMPLE_RATE,
      targetFrameSize: frameSamples,
    });
  }

  static async create(options: LocalVadRuntimeOptions): Promise<LocalVadProcessor> {
    const vad = await NonRealTimeVAD.new({
      frameSamples: options.frameSamples,
      positiveSpeechThreshold: options.positiveSpeechThreshold,
      negativeSpeechThreshold: options.negativeSpeechThreshold,
      redemptionFrames: options.redemptionFrames,
      minSpeechFrames: options.minSpeechFrames,
      preSpeechPadFrames: options.preSpeechPadFrames,
      submitUserSpeechOnPause: false,
    });

    if (!vad.frameProcessor) {
      throw new Error('Local VAD initialization failed: frame processor unavailable');
    }

    return new LocalVadProcessor(vad.frameProcessor, options.frameSamples);
  }

  async processMonoPcm(pcmChunk: Buffer): Promise<LocalVadEvent[]> {
    if (pcmChunk.length === 0) return [];

    const floatChunk = pcm16ToFloat32(pcmChunk);
    const frames = this.resampler.process(floatChunk);
    if (frames.length === 0) return [];

    const events: LocalVadEvent[] = [];
    for (const frame of frames) {
      const result = await this.frameProcessor.process(frame);
      this.collectEvent(events, result.msg, result.audio);
    }
    return events;
  }

  flush(): LocalVadEvent[] {
    const result = this.frameProcessor.endSegment();
    const events: LocalVadEvent[] = [];
    this.collectEvent(events, result.msg, result.audio);
    return events;
  }

  private collectEvent(
    events: LocalVadEvent[],
    msg: Message | undefined,
    audio: Float32Array | undefined,
  ): void {
    if (!msg) return;
    switch (msg) {
      case Message.SpeechStart:
        events.push({ type: 'speech-start' });
        return;
      case Message.SpeechEnd: {
        if (!audio || audio.length === 0) return;
        const pcm16 = float32ToPcm16(audio);
        const durationMs = Math.round((audio.length / VAD_SAMPLE_RATE) * 1000);
        events.push({
          type: 'speech-end',
          pcm16,
          sampleRate: VAD_SAMPLE_RATE,
          durationMs,
        });
        return;
      }
      case Message.VADMisfire:
        events.push({ type: 'misfire' });
        return;
      default:
        return;
    }
  }
}

function frameDurationForSamples(samples: VadFrameSamples): number {
  return (samples / VAD_SAMPLE_RATE) * 1000;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function pcm16ToFloat32(pcm: Buffer): Float32Array {
  const sampleCount = Math.floor(pcm.length / 2);
  const float = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm.readInt16LE(i * 2);
    float[i] = sample / 32768;
  }
  return float;
}

function float32ToPcm16(audio: Float32Array): Buffer {
  const pcm = Buffer.alloc(audio.length * 2);
  for (let i = 0; i < audio.length; i++) {
    const sample = clamp(audio[i], -1, 1);
    const value = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    pcm.writeInt16LE(value, i * 2);
  }
  return pcm;
}
