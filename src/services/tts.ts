import { Readable } from 'node:stream';
import { config } from '../config.js';

type TtsBackend = 'kokoro' | 'chatterbox' | 'elevenlabs';
const validTtsBackends: ReadonlyArray<TtsBackend> = ['kokoro', 'chatterbox', 'elevenlabs'];
let primaryBackendUnavailableUntil = 0;
let runtimeBackendOverride: TtsBackend | null = null;

export function getTtsBackend(): TtsBackend {
  return runtimeBackendOverride ?? (parseBackend(config.ttsBackend) || 'elevenlabs');
}

export function setTtsBackend(backend: TtsBackend): void {
  runtimeBackendOverride = backend;
  primaryBackendUnavailableUntil = 0; // reset failover state
}

export function getAvailableTtsBackends(): TtsBackend[] {
  const available: TtsBackend[] = [];
  if (config.elevenLabsApiKey) available.push('elevenlabs');
  if (config.kokoroUrl) available.push('kokoro');
  if (config.chatterboxUrl) available.push('chatterbox');
  return available.length > 0 ? available : ['elevenlabs'];
}
const failureSignatures = new Map<string, { count: number; firstAt: number; lastAt: number }>();

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

function parseBackend(raw: string): TtsBackend | null {
  const value = raw.trim().toLowerCase();
  if ((validTtsBackends as readonly string[]).includes(value)) {
    return value as TtsBackend;
  }
  return null;
}

function memorySnapshot(): string {
  const m = process.memoryUsage();
  const rssMb = (m.rss / (1024 * 1024)).toFixed(1);
  const heapUsedMb = (m.heapUsed / (1024 * 1024)).toFixed(1);
  const extMb = (m.external / (1024 * 1024)).toFixed(1);
  return `rssMb=${rssMb} heapUsedMb=${heapUsedMb} externalMb=${extMb}`;
}

function errorSignature(backend: TtsBackend, err: any): string {
  const msg = `${err?.message ?? ''} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!msg) return `${backend}:unknown`;
  const normalized = msg.length > 200 ? msg.slice(0, 200) : msg;
  return `${backend}:${normalized}`;
}

function logFailure(backend: TtsBackend, text: string, err: any): void {
  const signature = errorSignature(backend, err);
  const now = Date.now();
  const prev = failureSignatures.get(signature);
  const next = prev
    ? { count: prev.count + 1, firstAt: prev.firstAt, lastAt: now }
    : { count: 1, firstAt: now, lastAt: now };
  failureSignatures.set(signature, next);

  const windowSec = ((next.lastAt - next.firstAt) / 1000).toFixed(1);
  const msg = err?.message ?? String(err);
  console.warn(
    `TTS failure backend=${backend} signature="${signature}" count=${next.count} windowSec=${windowSec} textLen=${text.length} ${memorySnapshot()} msg="${msg}"`,
  );
}

async function synthesize(backend: TtsBackend, text: string): Promise<{ stream: Readable; backend: TtsBackend }> {
  const fn = backends[backend];
  if (!fn) {
    throw new Error(`Unknown TTS backend: ${backend}. Use: ${Object.keys(backends).join(', ')}`);
  }
  const start = Date.now();
  const stream = await fn(text);
  const elapsed = Date.now() - start;
  console.log(`TTS [${backend}]: first byte in ${elapsed}ms`);
  return { stream, backend };
}

export async function textToSpeechStream(text: string): Promise<Readable> {
  const primary = runtimeBackendOverride ?? parseBackend(config.ttsBackend);
  if (!primary) {
    throw new Error(`Unknown TTS backend: ${config.ttsBackend}. Use: ${Object.keys(backends).join(', ')}`);
  }
  const fallback = parseBackend(config.ttsFallbackBackend);
  const useFallbackFirst =
    !!fallback &&
    fallback !== primary &&
    Date.now() < primaryBackendUnavailableUntil;

  const order: TtsBackend[] = useFallbackFirst
    ? [fallback!, primary]
    : fallback && fallback !== primary
      ? [primary, fallback]
      : [primary];

  let lastError: any = null;
  for (let i = 0; i < order.length; i++) {
    const backend = order[i];
    try {
      const out = await synthesize(backend, text);
      if (backend !== primary) {
        console.warn(`TTS fallback active: ${primary} -> ${backend}`);
      } else if (Date.now() >= primaryBackendUnavailableUntil && primaryBackendUnavailableUntil > 0) {
        console.log(`TTS primary recovered: ${primary}`);
      }
      if (backend === primary) {
        primaryBackendUnavailableUntil = 0;
      }
      return out.stream;
    } catch (err: any) {
      lastError = err;
      logFailure(backend, text, err);
      if (backend === primary && order.length > 1) {
        primaryBackendUnavailableUntil = Date.now() + Math.max(3_000, config.ttsPrimaryRetryMs);
      }
      if (i < order.length - 1) {
        const next = order[i + 1];
        console.warn(`TTS failover attempt: ${backend} -> ${next}`);
      }
    }
  }

  throw lastError ?? new Error('TTS failed with unknown error');
}
