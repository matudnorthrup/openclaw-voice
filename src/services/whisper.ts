import OpenAI, { toFile } from 'openai';
import { pcmToWav } from '../audio/wav-utils.js';
import { config } from '../config.js';

export interface StreamingTranscribeOptions {
  enablePartials?: boolean;
  chunkMs?: number;
  minChunkMs?: number;
  overlapMs?: number;
  maxChunks?: number;
  onPartial?: (event: StreamingPartialEvent) => void;
}

export interface StreamingPartialEvent {
  text: string;
  chunkIndex: number;
  totalChunks: number;
  elapsedMs: number;
}

interface ParsedPcmWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  blockAlign: number;
  pcmData: Buffer;
}

interface StreamingChunkSpec {
  startByte: number;
  endByte: number;
  durationMs: number;
}

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

function parsePcmWav(wavBuffer: Buffer): ParsedPcmWav | null {
  if (wavBuffer.length < 44) return null;
  if (wavBuffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (wavBuffer.toString('ascii', 8, 12) !== 'WAVE') return null;

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let blockAlign = 0;
  let pcmData: Buffer | null = null;

  let offset = 12;
  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString('ascii', offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > wavBuffer.length) break;

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      const audioFormat = wavBuffer.readUInt16LE(dataStart);
      channels = wavBuffer.readUInt16LE(dataStart + 2);
      sampleRate = wavBuffer.readUInt32LE(dataStart + 4);
      blockAlign = wavBuffer.readUInt16LE(dataStart + 12);
      bitsPerSample = wavBuffer.readUInt16LE(dataStart + 14);
      if (audioFormat !== 1) return null;
    } else if (chunkId === 'data') {
      pcmData = wavBuffer.subarray(dataStart, dataEnd);
    }

    offset = dataEnd + (chunkSize % 2);
  }

  if (!pcmData || sampleRate <= 0 || channels <= 0 || bitsPerSample !== 16 || blockAlign <= 0) {
    return null;
  }

  return { sampleRate, channels, bitsPerSample, blockAlign, pcmData };
}

function alignToBlock(bytes: number, blockAlign: number): number {
  if (blockAlign <= 0) return bytes;
  const aligned = Math.floor(bytes / blockAlign) * blockAlign;
  return Math.max(blockAlign, aligned);
}

function makeChunkSpecs(
  wav: ParsedPcmWav,
  options: Required<Pick<StreamingTranscribeOptions, 'chunkMs' | 'minChunkMs' | 'overlapMs' | 'maxChunks'>>,
): StreamingChunkSpec[] {
  const bytesPerMs = (wav.sampleRate * wav.blockAlign) / 1000;
  const chunkBytes = alignToBlock(Math.round(options.chunkMs * bytesPerMs), wav.blockAlign);
  const minChunkBytes = alignToBlock(Math.round(options.minChunkMs * bytesPerMs), wav.blockAlign);
  const maxOverlap = Math.max(0, chunkBytes - wav.blockAlign);
  const overlapBytes = Math.min(
    alignToBlock(Math.round(options.overlapMs * bytesPerMs), wav.blockAlign),
    maxOverlap,
  );
  const stepBytes = Math.max(wav.blockAlign, chunkBytes - overlapBytes);

  if (chunkBytes <= 0 || wav.pcmData.length < wav.blockAlign) return [];

  const specs: StreamingChunkSpec[] = [];
  for (let start = 0; start < wav.pcmData.length && specs.length < options.maxChunks; start += stepBytes) {
    const end = Math.min(wav.pcmData.length, start + chunkBytes);
    const length = end - start;
    if (length < minChunkBytes && specs.length > 0) break;
    const durationMs = Math.max(
      1,
      Math.round((length / wav.blockAlign) / wav.sampleRate * 1000),
    );
    specs.push({ startByte: start, endByte: end, durationMs });
    if (end >= wav.pcmData.length) break;
  }

  return specs;
}

function buildChunkWav(wav: ParsedPcmWav, spec: StreamingChunkSpec): Buffer {
  const chunkPcm = wav.pcmData.subarray(spec.startByte, spec.endByte);
  return pcmToWav(chunkPcm, wav.sampleRate, wav.channels, wav.bitsPerSample);
}

export function createStreamingChunkPlan(
  wavBuffer: Buffer,
  options: Required<Pick<StreamingTranscribeOptions, 'chunkMs' | 'minChunkMs' | 'overlapMs' | 'maxChunks'>>,
): Array<{ chunkIndex: number; durationMs: number }> {
  const parsed = parsePcmWav(wavBuffer);
  if (!parsed) return [];
  return makeChunkSpecs(parsed, options).map((spec, idx) => ({
    chunkIndex: idx,
    durationMs: spec.durationMs,
  }));
}

async function emitStreamingPartials(
  wavBuffer: Buffer,
  options: Required<Pick<StreamingTranscribeOptions, 'chunkMs' | 'minChunkMs' | 'overlapMs' | 'maxChunks'>> & {
    onPartial: NonNullable<StreamingTranscribeOptions['onPartial']>;
  },
  doneRef: { done: boolean },
): Promise<number> {
  const parsed = parsePcmWav(wavBuffer);
  if (!parsed) return 0;

  const specs = makeChunkSpecs(parsed, options);
  // One chunk gives little value and risks duplicate feedback.
  if (specs.length < 2) return 0;

  let emitted = 0;
  let lastNormalized = '';
  const startedAt = Date.now();

  for (let i = 0; i < specs.length; i++) {
    if (doneRef.done) break;
    const spec = specs[i];
    const chunkWav = buildChunkWav(parsed, spec);
    const partialText = (await transcribeLocal(chunkWav)).trim();
    if (!partialText) continue;
    const normalized = partialText.toLowerCase();
    if (normalized === lastNormalized) continue;
    lastNormalized = normalized;
    emitted += 1;
    options.onPartial({
      text: partialText,
      chunkIndex: i,
      totalChunks: specs.length,
      elapsedMs: Date.now() - startedAt,
    });
  }

  return emitted;
}

export async function transcribe(
  wavBuffer: Buffer,
  options: StreamingTranscribeOptions = {},
): Promise<string> {
  const start = Date.now();
  const enablePartials = Boolean(options.enablePartials && options.onPartial && config.whisperUrl);

  let partialPromise: Promise<number> | null = null;
  const doneRef = { done: false };
  if (enablePartials) {
    const chunkMs = Math.max(250, options.chunkMs ?? 900);
    const minChunkMs = Math.max(200, options.minChunkMs ?? 450);
    const overlapMs = Math.max(0, options.overlapMs ?? 180);
    const maxChunks = Math.max(1, Math.floor(options.maxChunks ?? 8));
    partialPromise = emitStreamingPartials(
      wavBuffer,
      {
        chunkMs,
        minChunkMs,
        overlapMs,
        maxChunks,
        onPartial: options.onPartial!,
      },
      doneRef,
    ).catch((err: any) => {
      console.warn(`Whisper partial streaming disabled for utterance: ${err?.message ?? err}`);
      return 0;
    });
  }

  const text = config.whisperUrl
    ? await transcribeLocal(wavBuffer)
    : await transcribeOpenAI(wavBuffer);
  doneRef.done = true;

  const partialCount = partialPromise ? await partialPromise : 0;
  const elapsed = Date.now() - start;
  if (partialCount > 0) {
    console.log(`Whisper STT: "${text}" (${elapsed}ms, partials=${partialCount})`);
  } else {
    console.log(`Whisper STT: "${text}" (${elapsed}ms)`);
  }

  return text;
}
