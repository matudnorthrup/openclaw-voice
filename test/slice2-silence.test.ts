import { describe, it, expect } from 'vitest';
import { calculateRMSEnergy, isLikelySpeech, stereoToMono } from '../src/audio/silence-detector.js';
import { pcmToWav } from '../src/audio/wav-utils.js';

function generateSineWave(frequency: number, durationMs: number, amplitude: number, sampleRate = 48000): Buffer {
  const samples = Math.floor(sampleRate * durationMs / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate));
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }
  return buf;
}

function generateSilence(durationMs: number, sampleRate = 48000): Buffer {
  const samples = Math.floor(sampleRate * durationMs / 1000);
  return Buffer.alloc(samples * 2); // All zeros = silence
}

function generateStereoFromMono(mono: Buffer): Buffer {
  const stereo = Buffer.alloc(mono.length * 2);
  for (let i = 0; i < mono.length; i += 2) {
    const sample = mono.readInt16LE(i);
    stereo.writeInt16LE(sample, i * 2);
    stereo.writeInt16LE(sample, i * 2 + 2);
  }
  return stereo;
}

describe('calculateRMSEnergy', () => {
  it('should return 0 for empty buffer', () => {
    expect(calculateRMSEnergy(Buffer.alloc(0))).toBe(0);
  });

  it('should return 0 for silence', () => {
    const silence = generateSilence(100);
    expect(calculateRMSEnergy(silence)).toBe(0);
  });

  it('should return high energy for loud sine wave', () => {
    const loud = generateSineWave(440, 500, 20000);
    const rms = calculateRMSEnergy(loud);
    expect(rms).toBeGreaterThan(5000);
  });

  it('should return low energy for quiet sine wave', () => {
    const quiet = generateSineWave(440, 500, 100);
    const rms = calculateRMSEnergy(quiet);
    expect(rms).toBeLessThan(200);
  });

  it('should have higher energy for louder signals', () => {
    const quiet = generateSineWave(440, 500, 1000);
    const loud = generateSineWave(440, 500, 10000);
    expect(calculateRMSEnergy(loud)).toBeGreaterThan(calculateRMSEnergy(quiet));
  });
});

describe('isLikelySpeech', () => {
  it('should reject silence', () => {
    const silence = generateSilence(1000);
    expect(isLikelySpeech(silence)).toBe(false);
  });

  it('should reject very short audio even if loud', () => {
    const short = generateSineWave(440, 100, 20000); // 100ms
    expect(isLikelySpeech(short)).toBe(false);
  });

  it('should accept loud audio of sufficient length', () => {
    const speech = generateSineWave(440, 500, 20000); // 500ms, loud
    expect(isLikelySpeech(speech)).toBe(true);
  });

  it('should reject quiet noise', () => {
    const noise = generateSineWave(440, 500, 50);
    expect(isLikelySpeech(noise)).toBe(false);
  });
});

describe('stereoToMono', () => {
  it('should halve buffer length', () => {
    const stereo = Buffer.alloc(200);
    const mono = stereoToMono(stereo);
    expect(mono.length).toBe(100);
  });

  it('should average left and right channels', () => {
    const stereo = Buffer.alloc(4);
    stereo.writeInt16LE(1000, 0);  // Left
    stereo.writeInt16LE(3000, 2);  // Right
    const mono = stereoToMono(stereo);
    expect(mono.readInt16LE(0)).toBe(2000);
  });

  it('should preserve mono content from identical channels', () => {
    const mono = generateSineWave(440, 100, 10000);
    const stereo = generateStereoFromMono(mono);
    const result = stereoToMono(stereo);
    // Should be roughly equal (rounding differences possible)
    for (let i = 0; i < mono.length; i += 2) {
      expect(Math.abs(mono.readInt16LE(i) - result.readInt16LE(i))).toBeLessThanOrEqual(1);
    }
  });
});

describe('pcmToWav', () => {
  it('should create valid WAV header', () => {
    const pcm = generateSineWave(440, 100, 10000);
    const wav = pcmToWav(pcm);

    // Check RIFF header
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');

    // File size
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);

    // PCM format
    expect(wav.readUInt16LE(20)).toBe(1);

    // Channels
    expect(wav.readUInt16LE(22)).toBe(1);

    // Sample rate
    expect(wav.readUInt32LE(24)).toBe(48000);

    // Bits per sample
    expect(wav.readUInt16LE(34)).toBe(16);

    // Data size
    expect(wav.readUInt32LE(40)).toBe(pcm.length);

    // Total size = header + data
    expect(wav.length).toBe(44 + pcm.length);
  });

  it('should include PCM data after header', () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const wav = pcmToWav(pcm);
    expect(wav.slice(44)).toEqual(pcm);
  });
});
