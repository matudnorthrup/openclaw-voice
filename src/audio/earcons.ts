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
 * Warm C5→E5 bell with ring-out — "I captured your speech" (~400ms)
 */
function generateListening(): Buffer {
  const duration = 0.4;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 2800;

  // C5 (523 Hz) — let it ring
  const note1 = warmBellTone(523, amp, 0.3, 6);
  mixInto(mix, note1, 0);

  // E5 (659 Hz) — gentle overlap
  const note2 = warmBellTone(659, amp * 0.7, 0.25, 6.5);
  mixInto(mix, note2, Math.floor(0.12 * SAMPLE_RATE));

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
 * Warm descending E4→C4 — "Didn't understand" (~450ms)
 */
function generateError(): Buffer {
  const duration = 0.45;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 3500;

  // E4 (330 Hz) — warm tone, let it ring
  const note1 = warmBellTone(330, amp, 0.3, 6);
  mixInto(mix, note1, 0);

  // C4 (262 Hz) — descending resolution
  const note2 = warmBellTone(262, amp * 0.8, 0.28, 6.5);
  mixInto(mix, note2, Math.floor(0.16 * SAMPLE_RATE));

  return mixToWav(mix);
}

/**
 * Two warm A5 bell strikes — "About to time out" (~450ms)
 */
function generateTimeoutWarning(): Buffer {
  const duration = 0.45;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 3500;

  // First A5 bell (880 Hz)
  const ping1 = warmBellTone(880, amp, 0.2, 7);
  mixInto(mix, ping1, 0);

  // Second A5 bell — spaced out more
  const ping2 = warmBellTone(880, amp * 0.85, 0.2, 7.5);
  mixInto(mix, ping2, Math.floor(0.2 * SAMPLE_RATE));

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

  // G4 (392 Hz) — start
  const note1 = warmBellTone(392, amp, 0.3, 6);
  mixInto(mix, note1, 0);

  // E4 (330 Hz) — step down
  const note2 = warmBellTone(330, amp * 0.8, 0.28, 6.5);
  mixInto(mix, note2, Math.floor(0.16 * SAMPLE_RATE));

  // C4 (262 Hz) — resolve to bottom
  const note3 = warmBellTone(262, amp * 0.65, 0.25, 7);
  mixInto(mix, note3, Math.floor(0.32 * SAMPLE_RATE));

  return mixToWav(mix);
}

/**
 * Charge refrain: G4→G4→C5 — "Your turn!" (~550ms)
 * Three-note motif like the end of a trumpet charge. Two quick strikes
 * on the same note, then a bright resolve up.
 */
function generateReady(): Buffer {
  const duration = 0.55;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 3000;

  // G4 (392 Hz) — first strike
  const note1 = warmBellTone(392, amp, 0.2, 7);
  mixInto(mix, note1, 0);

  // G4 (392 Hz) — second strike, quick repeat
  const note2 = warmBellTone(392, amp * 0.9, 0.2, 7);
  mixInto(mix, note2, Math.floor(0.12 * SAMPLE_RATE));

  // C5 (523 Hz) — resolve up, let it ring
  const note3 = warmBellTone(523, amp * 0.85, 0.35, 5.5);
  mixInto(mix, note3, Math.floor(0.24 * SAMPLE_RATE));

  return mixToWav(mix);
}

/**
 * Warm low G3 hum — "I heard you but I'm busy" (~300ms)
 */
function generateBusy(): Buffer {
  const duration = 0.3;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);

  // G3 (196 Hz) — low, warm, subtle
  const note = warmBellTone(196, 3200, 0.25, 6);
  mixInto(mix, note, 0);

  return mixToWav(mix);
}

/**
 * Single soft A4 tap — "Gate shut" (~250ms)
 * Minimal, subtle. Just a quiet click-shut. Distinct from cancelled's three-note descent.
 */
function generateGateClosed(): Buffer {
  const duration = 0.25;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);

  // Single soft A4 (440 Hz) — quiet, quick decay
  const note = warmBellTone(440, 1800, 0.2, 9);
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
