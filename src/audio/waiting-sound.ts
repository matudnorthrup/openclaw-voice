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
 * Generates a gentle waiting sound: a single warm G4 bell strike that trails
 * off into distance via multi-tap echo (25% → 12% → 5%), followed by silence.
 *
 * Sound: ~1.5s of bell + echo trail
 * Silence: ~1.5s gap
 * Total: ~3s per loop cycle
 */
export function generateWaitingTone(): Buffer {
  const soundDuration = 1.5;
  const silenceDuration = 1.5;
  const totalDuration = soundDuration + silenceDuration;
  const totalSamples = Math.floor(totalDuration * SAMPLE_RATE);

  const mix = new Float64Array(totalSamples);

  const amp = 5000;
  const decay = 5;

  // Single G4 (392 Hz) bell strike — warm, full ring
  const strike = bellTone(392, amp, 0.8, decay);
  mixInto(mix, strike, 0);

  // Multi-tap echo trail — each repeat quieter and further away
  const echoTaps = [
    { delay: 0.30, volume: 0.25 },
    { delay: 0.55, volume: 0.12 },
    { delay: 0.80, volume: 0.05 },
  ];
  for (const tap of echoTaps) {
    const delaySamples = Math.floor(tap.delay * SAMPLE_RATE);
    for (let i = 0; i < strike.length && (delaySamples + i) < totalSamples; i++) {
      mix[delaySamples + i] += strike[i] * tap.volume;
    }
  }

  // Convert float mix to 16-bit PCM
  const pcm = Buffer.alloc(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    const clamped = Math.max(-32767, Math.min(32767, Math.round(mix[i])));
    pcm.writeInt16LE(clamped, i * 2);
  }

  return pcmToWav(pcm, SAMPLE_RATE, CHANNELS);
}
