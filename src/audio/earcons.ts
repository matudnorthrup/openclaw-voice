import { pcmToWav } from './wav-utils.js';

const SAMPLE_RATE = 48000;
const CHANNELS = 1;

export type EarconName =
  | 'listening'
  | 'acknowledged'
  | 'error'
  | 'timeout-warning'
  | 'cancelled'
  | 'ready'
  | 'busy';

const cache = new Map<EarconName, Buffer>();

/**
 * Synthesizes a single bell/tone with exponential decay.
 */
function tone(
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
    const fundamental = Math.sin(2 * Math.PI * frequency * t);
    const harmonic2 = 0.3 * Math.sin(2 * Math.PI * frequency * 2 * t);
    out[i] = amplitude * env * (fundamental + harmonic2);
  }

  return out;
}

/**
 * Warm bell/kalimba-like tone (closer to the processing loop timbre).
 */
function warmBellTone(
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
 * Converts a float mix buffer to a WAV Buffer.
 */
function mixToWav(mix: Float64Array): Buffer {
  const pcm = Buffer.alloc(mix.length * 2);
  for (let i = 0; i < mix.length; i++) {
    const clamped = Math.max(-32767, Math.min(32767, Math.round(mix[i])));
    pcm.writeInt16LE(clamped, i * 2);
  }
  return pcmToWav(pcm, SAMPLE_RATE, CHANNELS);
}

/**
 * Soft C5→E5 with a bit more hold — "I captured your speech" (~230ms)
 */
function generateListening(): Buffer {
  const duration = 0.23;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 2500;

  // C5 (523 Hz) for first half
  const note1 = warmBellTone(523, amp, 0.14, 9);
  mixInto(mix, note1, 0);

  // E5 (659 Hz) for second half
  const note2 = warmBellTone(659, amp * 0.72, 0.13, 9.5);
  mixInto(mix, note2, Math.floor(0.1 * SAMPLE_RATE));

  return mixToWav(mix);
}

/**
 * Warm ascending bell motif C4→E4→G4→C5 — "Got it" (~320ms)
 */
function generateAcknowledged(): Buffer {
  const duration = 0.32;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 3300;

  const note1 = warmBellTone(262, amp, 0.11, 7.3); // C4
  mixInto(mix, note1, 0);
  const note2 = warmBellTone(330, amp * 0.93, 0.11, 7.6); // E4
  mixInto(mix, note2, Math.floor(0.055 * SAMPLE_RATE));
  const note3 = warmBellTone(392, amp * 0.88, 0.12, 7.8); // G4
  mixInto(mix, note3, Math.floor(0.115 * SAMPLE_RATE));
  const note4 = warmBellTone(523, amp * 0.84, 0.12, 7); // C5
  mixInto(mix, note4, Math.floor(0.175 * SAMPLE_RATE));

  return mixToWav(mix);
}

/**
 * Descending E4→C4 — "Didn't understand" (~300ms)
 */
function generateError(): Buffer {
  const duration = 0.3;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 4000;

  // E4 (330 Hz)
  const note1 = tone(330, amp, 0.18, 8);
  mixInto(mix, note1, 0);

  // C4 (262 Hz)
  const note2 = tone(262, amp * 0.85, 0.18, 8);
  mixInto(mix, note2, Math.floor(0.14 * SAMPLE_RATE));

  return mixToWav(mix);
}

/**
 * Two quick A5 pings — "About to time out" (~250ms)
 */
function generateTimeoutWarning(): Buffer {
  const duration = 0.25;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 4000;

  // First A5 ping (880 Hz)
  const ping1 = tone(880, amp, 0.1, 15);
  mixInto(mix, ping1, 0);

  // Second A5 ping
  const ping2 = tone(880, amp, 0.1, 15);
  mixInto(mix, ping2, Math.floor(0.13 * SAMPLE_RATE));

  return mixToWav(mix);
}

/**
 * Descending G4→D4 — "Flow ended / timed out" (~350ms)
 */
function generateCancelled(): Buffer {
  const duration = 0.35;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 3500;

  // G4 (392 Hz)
  const note1 = tone(392, amp, 0.2, 7);
  mixInto(mix, note1, 0);

  // D4 (294 Hz)
  const note2 = tone(294, amp * 0.8, 0.2, 7);
  mixInto(mix, note2, Math.floor(0.17 * SAMPLE_RATE));

  return mixToWav(mix);
}

/**
 * Distinct warm cadence A4→D5→F#5→D5 — "Your turn to speak" (~360ms)
 */
function generateReady(): Buffer {
  const duration = 0.36;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 3050;

  const strike1 = warmBellTone(440, amp, 0.13, 7.4); // A4
  mixInto(mix, strike1, 0);
  const strike2 = warmBellTone(587, amp * 0.96, 0.14, 7.1); // D5
  mixInto(mix, strike2, Math.floor(0.085 * SAMPLE_RATE));
  const strike3 = warmBellTone(740, amp * 0.84, 0.11, 7.6); // F#5
  mixInto(mix, strike3, Math.floor(0.165 * SAMPLE_RATE));
  const strike4 = warmBellTone(587, amp * 0.74, 0.12, 7.1); // D5 resolve
  mixInto(mix, strike4, Math.floor(0.235 * SAMPLE_RATE));

  return mixToWav(mix);
}

/**
 * Brief low G3 hum — "I heard you but I'm busy" (~150ms)
 */
function generateBusy(): Buffer {
  const duration = 0.15;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);

  // G3 (196 Hz) — low, subtle
  const note = tone(196, 3500, duration, 6);
  mixInto(mix, note, 0);

  return mixToWav(mix);
}

const generators: Record<EarconName, () => Buffer> = {
  'listening': generateListening,
  'acknowledged': generateAcknowledged,
  'error': generateError,
  'timeout-warning': generateTimeoutWarning,
  'cancelled': generateCancelled,
  'ready': generateReady,
  'busy': generateBusy,
};

/**
 * Pre-generate and cache all earcons. Call at startup.
 */
export function initEarcons(): void {
  for (const [name, gen] of Object.entries(generators)) {
    const buf = gen();
    cache.set(name as EarconName, buf);
    console.log(`Earcon '${name}' generated: ${buf.length} bytes`);
  }
}

/**
 * Get a pre-generated earcon buffer by name.
 * Falls back to generating on-demand if not initialized.
 */
export function getEarcon(name: EarconName): Buffer {
  let buf = cache.get(name);
  if (!buf) {
    const gen = generators[name];
    buf = gen();
    cache.set(name, buf);
  }
  return buf;
}

/**
 * All earcon names for iteration/testing.
 */
export const EARCON_NAMES: EarconName[] = [
  'listening', 'acknowledged', 'error', 'timeout-warning',
  'cancelled', 'ready', 'busy',
];
