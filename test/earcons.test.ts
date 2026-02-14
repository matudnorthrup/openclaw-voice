import { describe, it, expect, beforeAll } from 'vitest';
import { initEarcons, getEarcon, EARCON_NAMES, type EarconName } from '../src/audio/earcons.js';

const SAMPLE_RATE = 48000;

beforeAll(() => {
  initEarcons();
});

describe('earcons', () => {
  for (const name of EARCON_NAMES) {
    describe(name, () => {
      it('generates a valid WAV buffer', () => {
        const buf = getEarcon(name);
        expect(buf).toBeInstanceOf(Buffer);
        expect(buf.length).toBeGreaterThan(44); // WAV header is 44 bytes
      });

      it('has valid RIFF/WAV header', () => {
        const buf = getEarcon(name);
        // RIFF magic
        expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
        // WAVE format
        expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
        // fmt chunk
        expect(buf.toString('ascii', 12, 16)).toBe('fmt ');
        // PCM format (1)
        expect(buf.readUInt16LE(20)).toBe(1);
        // Mono
        expect(buf.readUInt16LE(22)).toBe(1);
        // 48kHz
        expect(buf.readUInt32LE(24)).toBe(SAMPLE_RATE);
        // 16-bit
        expect(buf.readUInt16LE(34)).toBe(16);
        // data chunk
        expect(buf.toString('ascii', 36, 40)).toBe('data');
      });

      it('is under 500ms duration', () => {
        const buf = getEarcon(name);
        const dataSize = buf.readUInt32LE(40);
        const bytesPerSample = 2; // 16-bit
        const numSamples = dataSize / bytesPerSample;
        const durationMs = (numSamples / SAMPLE_RATE) * 1000;
        expect(durationMs).toBeLessThan(500);
      });

      it('has consistent file size field', () => {
        const buf = getEarcon(name);
        const riffSize = buf.readUInt32LE(4);
        expect(riffSize).toBe(buf.length - 8);
      });

      it('has consistent data size field', () => {
        const buf = getEarcon(name);
        const dataSize = buf.readUInt32LE(40);
        expect(dataSize).toBe(buf.length - 44);
      });
    });
  }

  it('initEarcons caches all earcons', () => {
    for (const name of EARCON_NAMES) {
      const buf1 = getEarcon(name);
      const buf2 = getEarcon(name);
      // Same reference (cached)
      expect(buf1).toBe(buf2);
    }
  });

  it('each earcon has a unique waveform', () => {
    const buffers = EARCON_NAMES.map((name) => getEarcon(name));
    for (let i = 0; i < buffers.length; i++) {
      for (let j = i + 1; j < buffers.length; j++) {
        // Different lengths or different content
        const same = buffers[i].length === buffers[j].length &&
          buffers[i].equals(buffers[j]);
        expect(same).toBe(false);
      }
    }
  });
});

describe('earcon durations within expected ranges', () => {
  const expectedMaxMs: Record<EarconName, number> = {
    'listening': 240,
    'acknowledged': 340,
    'error': 320,
    'timeout-warning': 270,
    'cancelled': 370,
    'ready': 380,
    'busy': 170,
    'gate-closed': 270,
  };

  for (const name of EARCON_NAMES) {
    it(`${name} is within expected duration`, () => {
      const buf = getEarcon(name);
      const dataSize = buf.readUInt32LE(40);
      const numSamples = dataSize / 2;
      const durationMs = (numSamples / SAMPLE_RATE) * 1000;
      expect(durationMs).toBeLessThanOrEqual(expectedMaxMs[name]);
      expect(durationMs).toBeGreaterThan(0);
    });
  }
});
