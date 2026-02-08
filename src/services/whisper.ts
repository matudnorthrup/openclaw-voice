import OpenAI, { toFile } from 'openai';
import { config } from '../config.js';

const openai = new OpenAI({ apiKey: config.openaiApiKey });

export async function transcribe(wavBuffer: Buffer): Promise<string> {
  const start = Date.now();

  const file = await toFile(wavBuffer, 'utterance.wav', { type: 'audio/wav' });

  const response = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language: 'en',
    response_format: 'json',
  });

  const elapsed = Date.now() - start;
  console.log(`Whisper STT: "${response.text}" (${elapsed}ms)`);

  return response.text;
}
