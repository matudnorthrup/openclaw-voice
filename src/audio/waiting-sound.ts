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
 * Generates a meditative waiting sound: two G4 bell strikes (same note)
 * each with a multi-tap echo trail fading into distance, followed by silence.
 *
 * Sound: ~1.8s of bell strikes + echo trails
 * Silence: ~1.2s gap
 * Total: ~3s per loop cycle
 */
export function generateWaitingTone(): Buffer {
  const soundDuration = 1.8;
  const silenceDuration = 1.2;
  const totalDuration = soundDuration + silenceDuration;
  const totalSamples = Math.floor(totalDuration * SAMPLE_RATE);

  const mix = new Float64Array(totalSamples);

  const amp = 5000;
  const decay = 5;

  // First G4 (392 Hz) bell strike
  const strike1 = bellTone(392, amp, 0.7, decay);
  mixInto(mix, strike1, 0);

  // First strike echo trail
  const echoTaps1 = [
    { delay: 0.28, volume: 0.22 },
    { delay: 0.50, volume: 0.10 },
  ];
  for (const tap of echoTaps1) {
    const d = Math.floor(tap.delay * SAMPLE_RATE);
    for (let i = 0; i < strike1.length && (d + i) < totalSamples; i++) {
      mix[d + i] += strike1[i] * tap.volume;
    }
  }

  // Second G4 strike — offset 0.7s, slightly quieter
  const strike2Offset = Math.floor(0.7 * SAMPLE_RATE);
  const strike2 = bellTone(392, amp * 0.8, 0.6, decay * 1.1);
  mixInto(mix, strike2, strike2Offset);

  // Second strike echo trail
  const echoTaps2 = [
    { delay: 0.28, volume: 0.18 },
    { delay: 0.52, volume: 0.07 },
  ];
  for (const tap of echoTaps2) {
    const d = strike2Offset + Math.floor(tap.delay * SAMPLE_RATE);
    for (let i = 0; i < strike2.length && (d + i) < totalSamples; i++) {
      mix[d + i] += strike2[i] * tap.volume;
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
