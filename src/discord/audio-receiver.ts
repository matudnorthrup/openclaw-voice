import { VoiceConnection, EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import { isLikelySpeech, stereoToMono } from '../audio/silence-detector.js';
import { pcmToWav } from '../audio/wav-utils.js';

export interface UtteranceHandler {
  (userId: string, wavBuffer: Buffer, durationMs: number): void;
}

export class AudioReceiver {
  private connection: VoiceConnection;
  private silenceDurationMs: number;
  private onUtterance: UtteranceHandler;
  private listening = false;

  constructor(
    connection: VoiceConnection,
    silenceDurationMs: number,
    onUtterance: UtteranceHandler,
  ) {
    this.connection = connection;
    this.silenceDurationMs = silenceDurationMs;
    this.onUtterance = onUtterance;
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

  private subscribeToUser(userId: string): void {
    const receiver = this.connection.receiver;

    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: this.silenceDurationMs,
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
      }
    });

    decoder.on('error', (err: Error) => {
      console.error(`Decoder error for ${userId}:`, err.message);
    });

    opusStream.on('error', (err: Error) => {
      console.error(`Opus stream error for ${userId}:`, err.message);
    });
  }
}
