/**
 * RMS energy-based speech detection for PCM audio.
 * PCM format: 16-bit signed integer, little-endian, mono, 48kHz.
 */

const SPEECH_THRESHOLD = 500; // RMS threshold — below this is considered noise/silence
const MIN_SPEECH_SAMPLES = 48000 * 0.3; // At least 300ms of audio to be considered speech (48kHz mono)

export function calculateRMSEnergy(pcm: Buffer): number {
  const samples = pcm.length / 2; // 16-bit = 2 bytes per sample
  if (samples === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / samples);
}

export function isLikelySpeech(pcm: Buffer): boolean {
  const samples = pcm.length / 2;
  if (samples < MIN_SPEECH_SAMPLES) return false;

  const rms = calculateRMSEnergy(pcm);
  return rms > SPEECH_THRESHOLD;
}

export function stereoToMono(stereo: Buffer): Buffer {
  const mono = Buffer.alloc(stereo.length / 2);
  for (let i = 0; i < stereo.length; i += 4) {
    const left = stereo.readInt16LE(i);
    const right = stereo.readInt16LE(i + 2);
    const avg = Math.round((left + right) / 2);
    mono.writeInt16LE(avg, i / 2);
  }
  return mono;
}
