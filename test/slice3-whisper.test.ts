import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// This test requires:
// 1. OPENAI_API_KEY set in .env
// 2. macOS `say` command available for generating test fixtures

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'hello-watson.wav');

describe('Whisper STT', () => {
  it('should generate test fixture via macOS say command', () => {
    // Generate fixture if it doesn't exist
    if (!existsSync(FIXTURE_PATH)) {
      try {
        execSync(
          `say -o "${FIXTURE_PATH}" --data-format=LEI16@48000 "Hello Watson, how are you today?"`,
          { timeout: 10_000 },
        );
      } catch {
        console.log('macOS say command not available, skipping fixture generation');
        return;
      }
    }
    expect(existsSync(FIXTURE_PATH)).toBe(true);
    const stats = readFileSync(FIXTURE_PATH);
    expect(stats.length).toBeGreaterThan(1000);
  });

  it('should transcribe speech from WAV file', async () => {
    if (!existsSync(FIXTURE_PATH)) {
      console.log('Test fixture not available, skipping');
      return;
    }

    if (!process.env['OPENAI_API_KEY'] || process.env['OPENAI_API_KEY'] === 'your_openai_api_key_here') {
      console.log('OPENAI_API_KEY not set, skipping API test');
      return;
    }

    // Dynamic import to avoid config validation errors when keys aren't set
    const { transcribe } = await import('../src/services/whisper.js');
    const wavBuffer = readFileSync(FIXTURE_PATH);
    const transcript = await transcribe(wavBuffer);

    expect(transcript.length).toBeGreaterThan(0);
    const lower = transcript.toLowerCase();
    expect(lower).toContain('hello');
    expect(lower).toMatch(/watson/i);
  });
});
