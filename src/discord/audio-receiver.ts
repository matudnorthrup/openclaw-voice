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

    // Debug: inspect the networking internals
    const state = this.connection.state as any;
    if (state.networking) {
      const net = state.networking;
      console.log('[DEBUG] Networking state code:', net.state?.code);

      // Check if UDP socket exists and listen for raw messages
      const udp = net.state?.udp;
      if (udp) {
        let udpCount = 0;
        udp.on('message', () => {
          udpCount++;
          if (udpCount === 1) console.log('[DEBUG] First UDP message received');
          if (udpCount % 500 === 0) console.log(`[DEBUG] UDP messages received: ${udpCount}`);
        });
        console.log('[DEBUG] UDP socket found, listening for raw messages');
      } else {
        console.log('[DEBUG] No UDP socket found in networking state');
      }

      // Check if WS is receiving packets
      const ws = net.state?.ws;
      if (ws) {
        ws.on('packet', (pkt: any) => {
          console.log('[DEBUG] WS packet received, op:', pkt.op, 'd:', JSON.stringify(pkt.d)?.slice(0, 200));
        });
        console.log('[DEBUG] WS found, listening for packets');
      } else {
        console.log('[DEBUG] No WS found in networking state');
      }
    } else {
      console.log('[DEBUG] No networking in connection state');
    }

    // Debug: check receiver's ssrcMap
    const ssrcMap = (receiver as any).ssrcMap;
    if (ssrcMap) {
      console.log('[DEBUG] ssrcMap entries:', ssrcMap.map?.size ?? 'unknown');
    }

    receiver.speaking.on('start', (userId: string) => {
      console.log(`[DEBUG] speaking.start event for userId: ${userId}`);
      if (!this.listening) return;
      this.subscribeToUser(userId);
    });

    receiver.speaking.on('end', (userId: string) => {
      console.log(`[DEBUG] speaking.end event for userId: ${userId}`);
    });

    console.log('[DEBUG] Connection state:', this.connection.state.status);
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
