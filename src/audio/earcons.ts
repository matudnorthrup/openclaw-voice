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
 * Warm ascending G4→C5 with echo — "Got it" (~600ms)
 * Two notes forming a perfect fourth (like the processing loop) with a soft echo tail.
 */
function generateAcknowledged(): Buffer {
  const duration = 0.6;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 3200;

  // G4 (392 Hz) — same root as processing loop
  const note1 = warmBellTone(392, amp, 0.4, 6);
  mixInto(mix, note1, 0);

  // C5 (523 Hz) — perfect fourth up
  const note2 = warmBellTone(523, amp * 0.8, 0.35, 6.5);
  mixInto(mix, note2, Math.floor(0.15 * SAMPLE_RATE));

  // Soft echo at 25% volume, 200ms later
  const echoDelay = Math.floor(0.2 * SAMPLE_RATE);
  for (let i = 0; i < note1.length && (echoDelay + i) < samples; i++) {
    mix[echoDelay + i] += note1[i] * 0.2;
  }
  for (let i = 0; i < note2.length && (echoDelay + Math.floor(0.15 * SAMPLE_RATE) + i) < samples; i++) {
    mix[echoDelay + Math.floor(0.15 * SAMPLE_RATE) + i] += note2[i] * 0.2;
  }

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
 * Warm descending G4→D4 with gentle tail — "Flow ended / timed out" (~500ms)
 */
function generateCancelled(): Buffer {
  const duration = 0.5;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 3200;

  // G4 (392 Hz)
  const note1 = warmBellTone(392, amp, 0.35, 6);
  mixInto(mix, note1, 0);

  // D4 (294 Hz) — descending
  const note2 = warmBellTone(294, amp * 0.75, 0.3, 6.5);
  mixInto(mix, note2, Math.floor(0.18 * SAMPLE_RATE));

  return mixToWav(mix);
}

/**
 * Warm D5→A4 bell with echo — "Your turn to speak" (~550ms)
 * Descending perfect fourth (inverse of acknowledged) with echo tail.
 */
function generateReady(): Buffer {
  const duration = 0.55;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 3000;

  // D5 (587 Hz) — bright start
  const note1 = warmBellTone(587, amp, 0.35, 6);
  mixInto(mix, note1, 0);

  // A4 (440 Hz) — settling down, "your turn"
  const note2 = warmBellTone(440, amp * 0.75, 0.3, 6.5);
  mixInto(mix, note2, Math.floor(0.14 * SAMPLE_RATE));

  // Soft echo
  const echoDelay = Math.floor(0.22 * SAMPLE_RATE);
  for (let i = 0; i < note1.length && (echoDelay + i) < samples; i++) {
    mix[echoDelay + i] += note1[i] * 0.18;
  }
  for (let i = 0; i < note2.length && (echoDelay + Math.floor(0.14 * SAMPLE_RATE) + i) < samples; i++) {
    mix[echoDelay + Math.floor(0.14 * SAMPLE_RATE) + i] += note2[i] * 0.18;
  }

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
 * Soft descending D5→A4 — "Grace period ended, wake word required" (~250ms)
 */
function generateGateClosed(): Buffer {
  const duration = 0.25;
  const samples = Math.floor(duration * SAMPLE_RATE);
  const mix = new Float64Array(samples);
  const amp = 2000;

  const note1 = warmBellTone(587, amp, 0.14, 9);        // D5
  mixInto(mix, note1, 0);
  const note2 = warmBellTone(440, amp * 0.7, 0.14, 9.5); // A4
  mixInto(mix, note2, Math.floor(0.1 * SAMPLE_RATE));

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
