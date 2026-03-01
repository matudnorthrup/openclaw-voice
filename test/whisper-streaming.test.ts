import { describe, expect, it } from 'vitest';
import { pcmToWav } from '../src/audio/wav-utils.js';
import { createStreamingChunkPlan } from '../src/services/whisper.js';

function makeMonoWav(durationMs: number, sampleRate = 16000): Buffer {
  const sampleCount = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const pcm = Buffer.alloc(sampleCount * 2); // 16-bit mono silence
  return pcmToWav(pcm, sampleRate, 1, 16);
}

describe('createStreamingChunkPlan', () => {
  it('returns an empty plan for invalid/non-wav input', () => {
    const plan = createStreamingChunkPlan(Buffer.from('not-a-wav'), {
      chunkMs: 900,
      minChunkMs: 450,
      overlapMs: 180,
      maxChunks: 8,
    });
    expect(plan).toEqual([]);
  });

  it('splits longer wav into overlapping chunks', () => {
    const wav = makeMonoWav(3000);
    const plan = createStreamingChunkPlan(wav, {
      chunkMs: 1000,
      minChunkMs: 400,
      overlapMs: 200,
      maxChunks: 12,
    });

    expect(plan.length).toBeGreaterThan(1);
    expect(plan[0]?.durationMs).toBeGreaterThanOrEqual(900);
    expect(plan[plan.length - 1]?.durationMs).toBeGreaterThan(0);
  });

  it('respects max chunk limit', () => {
    const wav = makeMonoWav(10000);
    const plan = createStreamingChunkPlan(wav, {
      chunkMs: 800,
      minChunkMs: 300,
      overlapMs: 150,
      maxChunks: 3,
    });

    expect(plan.length).toBe(3);
  });
});
