import {
  AudioPlayer,
  AudioPlayerStatus,
  AudioResource,
  NoSubscriberBehavior,
  VoiceConnection,
  createAudioPlayer,
  createAudioResource,
  StreamType,
} from '@discordjs/voice';
import { Readable } from 'node:stream';
import { generateWaitingTone } from '../audio/waiting-sound.js';
import { getEarcon, type EarconName } from '../audio/earcons.js';
import { config } from '../config.js';

export class DiscordAudioPlayer {
  private player: AudioPlayer;
  private connection: VoiceConnection | null = null;
  private waitingLoop = false;
  private waitingTone: Buffer | null = null;
  private ttsPlaybackSeq = 0;
  private activeTtsPlaybackId: number | null = null;
  private activeEarconName: EarconName | null = null;
  private lastEarconCompletedAt = 0;

  private stamp(): string {
    return new Date().toISOString();
  }

  constructor() {
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });

    this.player.on('error', (error) => {
      console.error('Audio player error:', error.message);
    });
  }

  attach(connection: VoiceConnection): void {
    this.connection = connection;
    connection.subscribe(this.player);
  }

  async playStream(stream: Readable): Promise<void> {
    const playbackId = ++this.ttsPlaybackSeq;
    this.activeTtsPlaybackId = playbackId;
    console.log(`${this.stamp()} TTS playback started [${playbackId}]`);

    const resource = createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
    });

    this.player.play(resource);

    return new Promise<void>((resolve, reject) => {
      const onIdle = () => {
        cleanup();
        if (this.activeTtsPlaybackId === playbackId) {
          console.log(`${this.stamp()} TTS playback completed [${playbackId}]`);
          this.activeTtsPlaybackId = null;
        } else {
          console.log(`${this.stamp()} TTS playback completed (stale) [${playbackId}]`);
        }
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        if (this.activeTtsPlaybackId === playbackId) {
          console.log(`${this.stamp()} TTS playback stopped [${playbackId}] reason=player-error:${error.message}`);
          this.activeTtsPlaybackId = null;
        } else {
          console.log(`${this.stamp()} TTS playback errored (stale) [${playbackId}] reason=player-error:${error.message}`);
        }
        reject(error);
      };
      const cleanup = () => {
        this.player.removeListener(AudioPlayerStatus.Idle, onIdle);
        this.player.removeListener('error', onError);
      };

      this.player.on(AudioPlayerStatus.Idle, onIdle);
      this.player.on('error', onError);
    });
  }

  startWaitingLoop(): void {
    if (!this.waitingTone) {
      this.waitingTone = generateWaitingTone();
      console.log(`${this.stamp()} Waiting tone generated: ${this.waitingTone.length} bytes`);
    }
    console.log(`${this.stamp()} Waiting loop start`);
    this.waitingLoop = true;
    this.playNextWaitingTone();
  }

  stopWaitingLoop(): void {
    if (this.waitingLoop) {
      console.log(`${this.stamp()} Waiting loop stop`);
    }
    this.waitingLoop = false;
  }

  private playNextWaitingTone(): void {
    if (!this.waitingLoop || !this.waitingTone) return;

    const stream = new Readable({
      read() {},
    });
    stream.push(this.waitingTone);
    stream.push(null);

    const resource = createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
    });

    this.player.play(resource);

    const onIdle = () => {
      this.player.removeListener(AudioPlayerStatus.Idle, onIdle);
      if (this.waitingLoop) {
        this.playNextWaitingTone();
      }
    };
    this.player.on(AudioPlayerStatus.Idle, onIdle);
  }

  playSingleTone(): void {
    if (!this.waitingTone) {
      this.waitingTone = generateWaitingTone();
    }
    const stream = new Readable({ read() {} });
    stream.push(this.waitingTone);
    stream.push(null);
    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
    this.player.play(resource);
  }

  async playEarcon(name: EarconName): Promise<void> {
    await this.enforceEarconGap();
    this.activeEarconName = name;
    console.log(`${this.stamp()} Earcon start: ${name}`);
    const buf = getEarcon(name);
    const stream = new Readable({ read() {} });
    stream.push(buf);
    stream.push(null);
    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
    this.player.play(resource);

    return new Promise<void>((resolve) => {
      const onIdle = () => {
        this.player.removeListener(AudioPlayerStatus.Idle, onIdle);
        this.activeEarconName = null;
        this.lastEarconCompletedAt = Date.now();
        console.log(`${this.stamp()} Earcon complete: ${name}`);
        if (this.waitingLoop) {
          this.playNextWaitingTone();
        }
        resolve();
      };
      this.player.on(AudioPlayerStatus.Idle, onIdle);
    });
  }

  playEarconSync(name: EarconName): void {
    void this.playEarcon(name);
  }

  stopPlayback(reason = 'unspecified'): void {
    if (this.activeTtsPlaybackId !== null) {
      console.log(`${this.stamp()} TTS playback stopped [${this.activeTtsPlaybackId}] reason=${reason}`);
      this.activeTtsPlaybackId = null;
    }
    this.activeEarconName = null;
    this.waitingLoop = false;
    console.log(`${this.stamp()} Playback stop reason=${reason}`);
    this.player.stop(true);
  }

  isPlaying(): boolean {
    return this.player.state.status === AudioPlayerStatus.Playing ||
           this.player.state.status === AudioPlayerStatus.Buffering;
  }

  isWaiting(): boolean {
    return this.waitingLoop;
  }

  isPlayingEarcon(name: EarconName): boolean {
    if (!this.isPlaying()) return false;
    return this.activeEarconName === name;
  }

  getPlayer(): AudioPlayer {
    return this.player;
  }

  private async enforceEarconGap(): Promise<void> {
    const minGap = Math.max(0, config.earconMinGapMs || 0);
    if (minGap <= 0 || this.lastEarconCompletedAt <= 0) return;
    const elapsed = Date.now() - this.lastEarconCompletedAt;
    const waitMs = minGap - elapsed;
    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
