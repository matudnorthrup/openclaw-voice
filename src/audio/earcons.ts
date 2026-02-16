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
  | 'busy'
  | 'gate-closed';

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
 * Single high A5 tap — "Heard you" (~200ms)
 * Brief, bright, high register. Distinct from everything else by being
 * the only earcon in the A5 range with a single-note shape.
 */
function generateListening(): Buffer {
  const duration = 0.2;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);

  // A5 (880 Hz) — high, light, quick
  const note = warmBellTone(880, 2400, 0.18, 8);
  mixInto(mix, note, 0);

  return mixToWav(mix);
}

/**
 * Warm ascending G4→C5 — "Got it" (~500ms)
 * Celebratory ascending perfect fourth. No echo (distinguishes from processing loop).
 */
function generateAcknowledged(): Buffer {
  const duration = 0.5;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 3200;

  // G4 (392 Hz)
  const note1 = warmBellTone(392, amp, 0.35, 6);
  mixInto(mix, note1, 0);

  // C5 (523 Hz) — ascending fourth, bright finish
  const note2 = warmBellTone(523, amp * 0.85, 0.3, 6);
  mixInto(mix, note2, Math.floor(0.16 * SAMPLE_RATE));

  return mixToWav(mix);
}

/**
 * Low descending G3→E3 — "Didn't understand" (~450ms)
 * Dropped into low register so negative cues feel distinct from positive ones.
 */
function generateError(): Buffer {
  const duration = 0.45;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 3500;

  // G3 (196 Hz) — low, warm, boosted for equal loudness
  const note1 = warmBellTone(196, 5500, 0.3, 6);
  mixInto(mix, note1, 0);

  // E3 (165 Hz) — descending, settles low
  const note2 = warmBellTone(165, 5500 * 0.8, 0.28, 6.5);
  mixInto(mix, note2, Math.floor(0.16 * SAMPLE_RATE));

  return mixToWav(mix);
}

/**
 * Tick-tock clock: four alternating knocks — "Time running out" (~700ms)
 * Percussive, fast-decay tones alternating between two close pitches
 * like a clock mechanism. Tick (higher) → tock (lower) × 2.
 */
function generateTimeoutWarning(): Buffer {
  const duration = 0.7;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 3200;
  const knockDecay = 18; // Very fast decay = percussive knock

  // Tick (D5, 587 Hz) — sharp, bright
  const tick = warmBellTone(587, amp, 0.1, knockDecay);
  // Tock (A4, 440 Hz) — slightly lower, duller
  const tock = warmBellTone(440, amp * 0.85, 0.1, knockDecay);

  // tick-tock tick-tock with even spacing
  mixInto(mix, tick, 0);
  mixInto(mix, tock, Math.floor(0.15 * SAMPLE_RATE));
  mixInto(mix, tick, Math.floor(0.33 * SAMPLE_RATE));
  mixInto(mix, tock, Math.floor(0.48 * SAMPLE_RATE));

  return mixToWav(mix);
}

/**
 * Three-note warm descent G4→E4→C4 — "Flow ended / winding down" (~600ms)
 * Deliberate three-step descent distinguishes from gate-closed's single tap.
 */
function generateCancelled(): Buffer {
  const duration = 0.6;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 3000;

  // G4 (392 Hz) — start, boosted for low-end resolve
  const note1 = warmBellTone(392, 4200, 0.3, 6);
  mixInto(mix, note1, 0);

  // E4 (330 Hz) — step down
  const note2 = warmBellTone(330, 4200 * 0.85, 0.28, 6.5);
  mixInto(mix, note2, Math.floor(0.16 * SAMPLE_RATE));

  // C4 (262 Hz) — resolve to bottom
  const note3 = warmBellTone(262, 4200 * 0.75, 0.25, 7);
  mixInto(mix, note3, Math.floor(0.32 * SAMPLE_RATE));

  return mixToWav(mix);
}

/**
 * Charge refrain: E5→G5→C6 — "Your turn!" (~700ms)
 * Three ascending notes ending on a high C6 resolve. The signature sound
 * of the system — memorable, bright, unmistakable. Given space to ring.
 */
function generateReady(): Buffer {
  const duration = 0.7;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 2800;

  // E5 (659 Hz) — launch
  const note1 = warmBellTone(659, amp, 0.25, 6.5);
  mixInto(mix, note1, 0);

  // G5 (784 Hz) — step up
  const note2 = warmBellTone(784, amp * 0.9, 0.25, 6.5);
  mixInto(mix, note2, Math.floor(0.14 * SAMPLE_RATE));

  // C6 (1047 Hz) — bright resolve, let it ring out
  const note3 = warmBellTone(1047, amp * 0.85, 0.4, 5);
  mixInto(mix, note3, Math.floor(0.28 * SAMPLE_RATE));

  return mixToWav(mix);
}

/**
 * Warm low G3 hum — "I heard you but I'm busy" (~300ms)
 */
function generateBusy(): Buffer {
  const duration = 0.3;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);

  // G3 (196 Hz) — low, warm, boosted for equal loudness
  const note = warmBellTone(196, 5000, 0.25, 6);
  mixInto(mix, note, 0);

  return mixToWav(mix);
}

/**
 * Single soft D4 tap — "Gate shut" (~250ms)
 * Minimal, subtle, mid-low register. A quiet "click shut" — distinct from
 * listening's high A5 tap and busy's low G3 hum.
 */
function generateGateClosed(): Buffer {
  const duration = 0.25;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);

  // Single soft D4 (294 Hz) — boosted for equal loudness, quick decay
  const note = warmBellTone(294, 3200, 0.2, 10);
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
  'gate-closed': generateGateClosed,
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
  'cancelled', 'ready', 'busy', 'gate-closed',
];
