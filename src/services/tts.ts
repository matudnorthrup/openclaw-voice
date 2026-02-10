import { Readable } from 'node:stream';
import { config } from '../config.js';

type TtsBackend = 'kokoro' | 'chatterbox' | 'elevenlabs';

async function ttsElevenLabs(text: string): Promise<Readable> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${config.elevenLabsVoiceId}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': config.elevenLabsApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        output_format: 'mp3_44100_128',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ElevenLabs API error ${response.status}: ${body}`);
  }

  if (!response.body) {
    throw new Error('ElevenLabs returned no body');
  }

  return Readable.fromWeb(response.body as any);
}

async function ttsKokoro(text: string): Promise<Readable> {
  const response = await fetch(
    `${config.kokoroUrl}/v1/audio/speech`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: text,
        voice: config.kokoroVoice,
        response_format: 'wav',
        stream: true,
        speed: 1.0,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Kokoro API error ${response.status}: ${body}`);
  }

  if (!response.body) {
    throw new Error('Kokoro returned no body');
  }

  return Readable.fromWeb(response.body as any);
}

async function ttsChatterbox(text: string): Promise<Readable> {
  const response = await fetch(
    `${config.chatterboxUrl}/v1/audio/speech`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: text,
        voice: config.chatterboxVoice,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Chatterbox API error ${response.status}: ${body}`);
  }

  if (!response.body) {
    throw new Error('Chatterbox returned no body');
  }

  return Readable.fromWeb(response.body as any);
}

const backends: Record<TtsBackend, (text: string) => Promise<Readable>> = {
  kokoro: ttsKokoro,
  chatterbox: ttsChatterbox,
  elevenlabs: ttsElevenLabs,
};

export async function textToSpeechStream(text: string): Promise<Readable> {
  const backend = config.ttsBackend as TtsBackend;
  const fn = backends[backend];
  if (!fn) {
    throw new Error(`Unknown TTS backend: ${backend}. Use: ${Object.keys(backends).join(', ')}`);
  }

  const start = Date.now();
  const stream = await fn(text);
  const elapsed = Date.now() - start;
  console.log(`TTS [${backend}]: first byte in ${elapsed}ms`);

  return stream;
}
