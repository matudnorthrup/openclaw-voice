import { VoiceConnection, EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import type { Readable } from 'stream';
import { computeLocalVadRuntimeOptions, LocalVadProcessor, type LocalVadEvent } from '../audio/local-vad.js';
import { isLikelySpeech, stereoToMono } from '../audio/silence-detector.js';
import { pcmToWav } from '../audio/wav-utils.js';
import { getVoiceSettings } from '../services/voice-settings.js';

export interface UtteranceHandler {
  (userId: string, wavBuffer: Buffer, durationMs: number): void;
}

export interface RejectedAudioHandler {
  (userId: string, durationMs: number): void;
}

interface LocalUserSession {
  userId: string;
  opusStream: Readable;
  decoder: prism.opus.Decoder;
  vadPromise: Promise<LocalVadProcessor | null>;
  processingChain: Promise<void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  streamStartAt: number;
  speechStartedAt: number;
  emittedUtterances: number;
  sawAudio: boolean;
}

export class AudioReceiver {
  private connection: VoiceConnection;
  private onUtterance: UtteranceHandler;
  private onRejectedAudio: RejectedAudioHandler | null;
  private listening = false;
  private activeSubscriptions = new Set<string>();
  private localSessions = new Map<string, LocalUserSession>();
  private localVadSupported = true;
  private lastSpeechStartedAt = 0;
  private readonly onSpeakingStart = (userId: string) => {
    if (!this.listening) return;
    this.lastSpeechStartedAt = Date.now();
    this.subscribeToUser(userId);
  };

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

    this.connection.receiver.speaking.on('start', this.onSpeakingStart);
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    this.connection.receiver.speaking.off('start', this.onSpeakingStart);
    for (const userId of [...this.localSessions.keys()]) {
      this.closeLocalSession(userId, 'receiver-stop');
    }
    this.activeSubscriptions.clear();
    console.log('Audio receiver stopped');
  }

  hasActiveSpeech(): boolean {
    for (const session of this.localSessions.values()) {
      if (session.speechStartedAt > 0) return true;
    }
    for (const userId of this.activeSubscriptions) {
      if (!this.localSessions.has(userId)) return true;
    }
    return false;
  }

  getLastSpeechStartedAt(): number {
    return this.lastSpeechStartedAt;
  }

  private subscribeToUser(userId: string, forceLegacy = false): void {
    if (this.activeSubscriptions.has(userId)) return;

    const shouldUseLocal = (
      !forceLegacy
      && this.localVadSupported
      && getVoiceSettings().audioProcessing === 'local'
    );

    if (shouldUseLocal) {
      this.subscribeWithLocalVad(userId);
      return;
    }

    this.subscribeWithDiscordEndpointing(userId);
  }

  private subscribeWithDiscordEndpointing(userId: string): void {
    this.activeSubscriptions.add(userId);

    const receiver = this.connection.receiver;

    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: getVoiceSettings().silenceDurationMs,
      },
    });

    const decoder: prism.opus.Decoder = new prism.opus.Decoder({
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

  private subscribeWithLocalVad(userId: string): void {
    this.activeSubscriptions.add(userId);

    const receiver = this.connection.receiver;
    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.Manual,
      },
    });

    const decoder: prism.opus.Decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    const session: LocalUserSession = {
      userId,
      opusStream,
      decoder,
      vadPromise: this.createLocalVadProcessor(userId),
      processingChain: Promise.resolve(),
      idleTimer: null,
      closing: false,
      streamStartAt: Date.now(),
      speechStartedAt: 0,
      emittedUtterances: 0,
      sawAudio: false,
    };

    this.localSessions.set(userId, session);
    this.resetLocalIdleTimer(session);

    opusStream.pipe(decoder);

    decoder.on('data', (chunk: Buffer) => {
      if (session.closing) return;
      session.sawAudio = true;
      this.resetLocalIdleTimer(session);
      this.enqueueLocalChunk(session, chunk);
    });

    decoder.on('end', () => {
      this.closeLocalSession(userId, 'decoder-end');
    });

    decoder.on('error', (err: Error) => {
      console.error(`Local decoder error for ${userId}:`, err.message);
      this.closeLocalSession(userId, 'decoder-error');
    });

    opusStream.on('error', (err: Error) => {
      console.error(`Local opus stream error for ${userId}:`, err.message);
      this.closeLocalSession(userId, 'opus-error');
    });

    opusStream.on('end', () => {
      this.closeLocalSession(userId, 'opus-end');
    });

    opusStream.on('close', () => {
      this.closeLocalSession(userId, 'opus-close');
    });
  }

  private createLocalVadProcessor(userId: string): Promise<LocalVadProcessor | null> {
    const settings = getVoiceSettings();
    const options = computeLocalVadRuntimeOptions(settings);
    return LocalVadProcessor.create(options).catch((err: any) => {
      const message = err?.message || String(err);
      this.localVadSupported = false;
      console.error(`Local VAD unavailable (${message}). Falling back to Discord endpointing.`);
      setImmediate(() => {
        this.closeLocalSession(userId, 'vad-init-failed');
        if (!this.listening) return;
        this.subscribeToUser(userId, true);
      });
      return null;
    });
  }

  private enqueueLocalChunk(session: LocalUserSession, stereoChunk: Buffer): void {
    session.processingChain = session.processingChain
      .then(async () => {
        if (session.closing) return;
        const vad = await session.vadPromise;
        if (!vad || session.closing) return;
        const monoChunk = stereoToMono(stereoChunk);
        const events = await vad.processMonoPcm(monoChunk);
        this.handleLocalVadEvents(session, events);
      })
      .catch((err: any) => {
        console.error(`Local VAD processing error for ${session.userId}:`, err?.message || err);
        this.closeLocalSession(session.userId, 'vad-processing-error');
      });
  }

  private handleLocalVadEvents(session: LocalUserSession, events: LocalVadEvent[]): void {
    for (const event of events) {
      if (event.type === 'speech-start') {
        session.speechStartedAt = Date.now();
        continue;
      }

      if (event.type === 'misfire') {
        const durationMs = session.speechStartedAt > 0
          ? Math.max(0, Date.now() - session.speechStartedAt)
          : 0;
        session.speechStartedAt = 0;
        this.onRejectedAudio?.(session.userId, durationMs);
        continue;
      }

      if (!event.pcm16 || !event.sampleRate || !event.durationMs) {
        continue;
      }

      session.speechStartedAt = 0;
      session.emittedUtterances += 1;
      const wavBuffer = pcmToWav(event.pcm16, event.sampleRate);
      console.log(
        `Got local-VAD utterance from ${session.userId}: ${event.durationMs}ms, ${event.pcm16.length} bytes PCM`,
      );
      this.onUtterance(session.userId, wavBuffer, event.durationMs);
    }
  }

  private closeLocalSession(userId: string, reason: string): void {
    const session = this.localSessions.get(userId);
    if (!session || session.closing) return;

    session.closing = true;
    this.localSessions.delete(userId);
    this.activeSubscriptions.delete(userId);
    this.clearLocalIdleTimer(session);

    void session.processingChain
      .catch(() => undefined)
      .then(async () => {
        const vad = await session.vadPromise.catch(() => null);
        if (vad) {
          const flushEvents = vad.flush();
          this.handleLocalVadEvents(session, flushEvents);
        }

        if (session.sawAudio && session.emittedUtterances === 0) {
          const durationMs = Math.max(0, Date.now() - session.streamStartAt);
          console.log(`Discarded local non-speech from ${userId}: ${durationMs}ms (${reason})`);
          this.onRejectedAudio?.(userId, durationMs);
        }
      })
      .finally(() => {
        session.opusStream.unpipe(session.decoder);
        session.opusStream.destroy();
        session.decoder.removeAllListeners();
        session.decoder.destroy();
      });
  }

  private resetLocalIdleTimer(session: LocalUserSession): void {
    this.clearLocalIdleTimer(session);
    const settings = getVoiceSettings();
    const idleMs = Math.max(settings.localStreamIdleMs, settings.silenceDurationMs + 500);
    session.idleTimer = setTimeout(() => {
      this.closeLocalSession(session.userId, 'idle-timeout');
    }, idleMs);
  }

  private clearLocalIdleTimer(session: LocalUserSession): void {
    if (!session.idleTimer) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}
