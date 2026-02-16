import { VoiceConnection, EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import { isLikelySpeech, stereoToMono } from '../audio/silence-detector.js';
import { pcmToWav } from '../audio/wav-utils.js';
import { getVoiceSettings } from '../services/voice-settings.js';

export interface UtteranceHandler {
  (userId: string, wavBuffer: Buffer, durationMs: number): void;
}

export interface RejectedAudioHandler {
  (userId: string, durationMs: number): void;
}

export class AudioReceiver {
  private connection: VoiceConnection;
  private onUtterance: UtteranceHandler;
  private onRejectedAudio: RejectedAudioHandler | null;
  private listening = false;
  private activeSubscriptions = new Set<string>();

  constructor(
    connection: VoiceConnection,
    onUtterance: UtteranceHandler,
    onRejectedAudio?: RejectedAudioHandler,
  ) {
    this.connection = connection;
    this.onUtterance = onUtterance;
    this.onRejectedAudio = onRejectedAudio ?? null;
  }

  start(): void {
    if (this.listening) return;
    this.listening = true;
    console.log('Audio receiver started, listening for speech...');

    const receiver = this.connection.receiver;

    receiver.speaking.on('start', (userId: string) => {
      if (!this.listening) return;
      this.subscribeToUser(userId);
    });
  }

  stop(): void {
    this.listening = false;
    console.log('Audio receiver stopped');
  }

  hasActiveSpeech(): boolean {
    return this.activeSubscriptions.size > 0;
  }

  private subscribeToUser(userId: string): void {
    if (this.activeSubscriptions.has(userId)) return;
    this.activeSubscriptions.add(userId);

    const receiver = this.connection.receiver;

    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: getVoiceSettings().silenceDurationMs,
      },
    });

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    const chunks: Buffer[] = [];
    const startTime = Date.now();

    opusStream.pipe(decoder);

    decoder.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    decoder.on('end', () => {
      this.activeSubscriptions.delete(userId);
      const durationMs = Date.now() - startTime;
      const stereoPcm = Buffer.concat(chunks);

      if (stereoPcm.length === 0) {
        return;
      }

      const monoPcm = stereoToMono(stereoPcm);

      if (isLikelySpeech(monoPcm)) {
        const wavBuffer = pcmToWav(monoPcm);
        console.log(`Got utterance from ${userId}: ${durationMs}ms, ${monoPcm.length} bytes PCM`);
        this.onUtterance(userId, wavBuffer, durationMs);
      } else {
        console.log(`Discarded noise from ${userId}: ${durationMs}ms`);
        this.onRejectedAudio?.(userId, durationMs);
      }
    });

    decoder.on('error', (err: Error) => {
      console.error(`Decoder error for ${userId}:`, err.message);
    });

    opusStream.on('error', (err: Error) => {
      this.activeSubscriptions.delete(userId);
      console.error(`Opus stream error for ${userId}:`, err.message);
    });
  }
}
