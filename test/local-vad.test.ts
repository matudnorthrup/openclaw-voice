import { describe, expect, it } from 'vitest';
import { computeLocalVadRuntimeOptions } from '../src/audio/local-vad.js';

describe('computeLocalVadRuntimeOptions', () => {
  it('derives frame counts from silence and min-speech durations', () => {
    const options = computeLocalVadRuntimeOptions({
      silenceDurationMs: 500,
      minSpeechDurationMs: 600,
      vadFrameSamples: 512,
      vadPositiveSpeechThreshold: 0.5,
      vadNegativeSpeechThreshold: 0.35,
    });

    // 512 samples @ 16kHz = 32ms/frame
    expect(options.redemptionFrames).toBe(16);
    expect(options.minSpeechFrames).toBe(19);
    expect(options.preSpeechPadFrames).toBe(1);
  });

  it('clamps invalid thresholds and keeps negative <= positive', () => {
    const options = computeLocalVadRuntimeOptions({
      silenceDurationMs: 1000,
      minSpeechDurationMs: 300,
      vadFrameSamples: 1024,
      vadPositiveSpeechThreshold: 1.5,
      vadNegativeSpeechThreshold: 2,
    });

    expect(options.positiveSpeechThreshold).toBe(1);
    expect(options.negativeSpeechThreshold).toBe(1);
  });

  it('ensures at least one frame for silence/min-speech', () => {
    const options = computeLocalVadRuntimeOptions({
      silenceDurationMs: 1,
      minSpeechDurationMs: 1,
      vadFrameSamples: 1536,
      vadPositiveSpeechThreshold: -1,
      vadNegativeSpeechThreshold: -2,
    });

    expect(options.positiveSpeechThreshold).toBe(0);
    expect(options.negativeSpeechThreshold).toBe(0);
    expect(options.redemptionFrames).toBe(1);
    expect(options.minSpeechFrames).toBe(1);
  });
});
