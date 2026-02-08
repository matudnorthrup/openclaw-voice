import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'hello-watson.wav');

describe('Full pipeline (no Discord)', () => {
  it('should chain WAV → Whisper → Claude → ElevenLabs', async () => {
    // Skip if any key is missing
    const keys = ['OPENAI_API_KEY', 'GATEWAY_TOKEN', 'ELEVENLABS_API_KEY'];
    for (const key of keys) {
      const val = process.env[key];
      if (!val || val.startsWith('your_')) {
        console.log(`${key} not set, skipping full pipeline test`);
        return;
      }
    }

    // Generate fixture if needed
    if (!existsSync(FIXTURE_PATH)) {
      try {
        execSync(
          `say -o "${FIXTURE_PATH}" --data-format=LEI16@48000 "Hello Watson, how are you today?"`,
          { timeout: 10_000 },
        );
      } catch {
        console.log('macOS say command not available, skipping');
        return;
      }
    }

    const { transcribe } = await import('../src/services/whisper.js');
    const { getResponse, clearConversation } = await import('../src/services/claude.js');
    const { textToSpeechStream } = await import('../src/services/elevenlabs.js');

    const pipelineStart = Date.now();

    // Step 1: STT
    const wavBuffer = readFileSync(FIXTURE_PATH);
    const transcript = await transcribe(wavBuffer);
    const sttMs = Date.now() - pipelineStart;
    console.log(`STT: "${transcript}" (${sttMs}ms)`);
    expect(transcript.length).toBeGreaterThan(0);

    // Step 2: LLM
    const llmStart = Date.now();
    const { response } = await getResponse('pipeline-test', transcript);
    const llmMs = Date.now() - llmStart;
    console.log(`LLM: "${response.slice(0, 80)}..." (${llmMs}ms)`);
    expect(response.length).toBeGreaterThan(0);

    // Step 3: TTS
    const ttsStart = Date.now();
    const stream = await textToSpeechStream(response);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    const ttsMs = Date.now() - ttsStart;
    const audio = Buffer.concat(chunks);
    console.log(`TTS: ${audio.length} bytes (${ttsMs}ms)`);
    expect(audio.length).toBeGreaterThan(100);

    const totalMs = Date.now() - pipelineStart;
    console.log(`Total pipeline: ${totalMs}ms`);

    clearConversation('pipeline-test');
  });
});
