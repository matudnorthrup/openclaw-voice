import { pcmToWav } from './wav-utils.js';

const SAMPLE_RATE = 48000;
const CHANNELS = 1;

/**
 * Synthesizes a single bell/kalimba-like tone with natural decay.
 * Uses fundamental + harmonics with exponential decay for a warm, organic sound.
 */
function bellTone(
  frequency: number,
  amplitude: number,
  durationSec: number,
  decayRate: number,
): Float64Array {
  const samples = Math.floor(durationSec * SAMPLE_RATE);
  const out = new Float64Array(samples);

  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-decayRate * t);

    // Fundamental + harmonics for warmth
    const fundamental = Math.sin(2 * Math.PI * frequency * t);
    const harmonic2 = 0.3 * Math.sin(2 * Math.PI * frequency * 2 * t);
    const harmonic3 = 0.08 * Math.sin(2 * Math.PI * frequency * 3 * t);

    out[i] = amplitude * env * (fundamental + harmonic2 + harmonic3);
  }

  return out;
}

/**
 * Mixes a source signal into a destination buffer at a given sample offset.
 */
function mixInto(dest: Float64Array, src: Float64Array, offsetSamples: number): void {
  for (let i = 0; i < src.length && (offsetSamples + i) < dest.length; i++) {
    dest[offsetSamples + i] += src[i];
  }
}

/**
 * Generates a gentle waiting sound: two soft bell tones forming a pleasant
 * interval (G4 → C5, a perfect fourth), with a subtle echo, followed by silence.
 *
 * Sound: ~1s of gentle bell tones with echo tail
 * Silence: ~2s gap
 * Total: ~3s per loop cycle
 */
export function generateWaitingTone(): Buffer {
  const soundDuration = 1.0;
  const silenceDuration = 2.0;
  const totalDuration = soundDuration + silenceDuration;
  const totalSamples = Math.floor(totalDuration * SAMPLE_RATE);

  const mix = new Float64Array(totalSamples);

  const amp = 5000;
  const decay = 6;

  // Note 1: G4 (392 Hz)
  const note1 = bellTone(392, amp, 0.6, decay);
  mixInto(mix, note1, 0);

  // Note 2: C5 (523 Hz) — starts 220ms later, slightly quieter
  const note2 = bellTone(523, amp * 0.75, 0.5, decay * 1.2);
  mixInto(mix, note2, Math.floor(0.22 * SAMPLE_RATE));

  // Soft echo of both notes at 25% volume, 280ms later
  const echoDelay = Math.floor(0.28 * SAMPLE_RATE);
  const echoAmp = 0.25;
  for (let i = 0; i < note1.length && (echoDelay + i) < totalSamples; i++) {
    mix[echoDelay + i] += note1[i] * echoAmp;
  }
  for (let i = 0; i < note2.length && (echoDelay + Math.floor(0.22 * SAMPLE_RATE) + i) < totalSamples; i++) {
    mix[echoDelay + Math.floor(0.22 * SAMPLE_RATE) + i] += note2[i] * echoAmp;
  }

  // Convert float mix to 16-bit PCM
  const pcm = Buffer.alloc(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    const clamped = Math.max(-32767, Math.min(32767, Math.round(mix[i])));
    pcm.writeInt16LE(clamped, i * 2);
  }

  return pcmToWav(pcm, SAMPLE_RATE, CHANNELS);
}
