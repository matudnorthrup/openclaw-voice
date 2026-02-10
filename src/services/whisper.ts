import OpenAI, { toFile } from 'openai';
import { config } from '../config.js';

async function transcribeLocal(wavBuffer: Buffer): Promise<string> {
  const formData = new FormData();
  const arrayBuffer = wavBuffer.buffer.slice(wavBuffer.byteOffset, wavBuffer.byteOffset + wavBuffer.byteLength) as ArrayBuffer;
  const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
  formData.append('file', blob, 'utterance.wav');
  formData.append('response_format', 'json');
  formData.append('temperature', '0.0');

  const response = await fetch(`${config.whisperUrl}/inference`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Whisper local error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as { text: string };
  return data.text;
}

async function transcribeOpenAI(wavBuffer: Buffer): Promise<string> {
  const openai = new OpenAI({ apiKey: config.openaiApiKey });
  const file = await toFile(wavBuffer, 'utterance.wav', { type: 'audio/wav' });

  const response = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language: 'en',
    response_format: 'json',
  });

  return response.text;
}

export async function transcribe(wavBuffer: Buffer): Promise<string> {
  const start = Date.now();

  const text = config.whisperUrl
    ? await transcribeLocal(wavBuffer)
    : await transcribeOpenAI(wavBuffer);

  const elapsed = Date.now() - start;
  console.log(`Whisper STT: "${text}" (${elapsed}ms)`);

  return text;
}
