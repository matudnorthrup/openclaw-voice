import { Readable } from 'node:stream';
import { config } from '../config.js';

export async function textToSpeechStream(text: string): Promise<Readable> {
  const start = Date.now();
  const voiceId = config.elevenLabsVoiceId;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
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

  const elapsed = Date.now() - start;
  console.log(`ElevenLabs TTS: first byte in ${elapsed}ms`);

  // Convert Web ReadableStream to Node Readable
  return Readable.fromWeb(response.body as any);
}
