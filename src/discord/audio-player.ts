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

export class DiscordAudioPlayer {
  private player: AudioPlayer;
  private connection: VoiceConnection | null = null;
  private waitingLoop = false;
  private waitingTone: Buffer | null = null;

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
    const resource = createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
    });

    this.player.play(resource);

    return new Promise<void>((resolve, reject) => {
      const onIdle = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
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
      console.log(`Waiting tone generated: ${this.waitingTone.length} bytes`);
    }
    this.waitingLoop = true;
    this.playNextWaitingTone();
  }

  stopWaitingLoop(): void {
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
    const buf = getEarcon(name);
    const stream = new Readable({ read() {} });
    stream.push(buf);
    stream.push(null);
    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
    this.player.play(resource);

    return new Promise<void>((resolve) => {
      const onIdle = () => {
        this.player.removeListener(AudioPlayerStatus.Idle, onIdle);
        if (this.waitingLoop) {
          this.playNextWaitingTone();
        }
        resolve();
      };
      this.player.on(AudioPlayerStatus.Idle, onIdle);
    });
  }

  playEarconSync(name: EarconName): void {
    const buf = getEarcon(name);
    const stream = new Readable({ read() {} });
    stream.push(buf);
    stream.push(null);
    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
    this.player.play(resource);

    const onIdle = () => {
      this.player.removeListener(AudioPlayerStatus.Idle, onIdle);
      if (this.waitingLoop) {
        this.playNextWaitingTone();
      }
    };
    this.player.on(AudioPlayerStatus.Idle, onIdle);
  }

  stopPlayback(): void {
    this.waitingLoop = false;
    this.player.stop(true);
  }

  isPlaying(): boolean {
    return this.player.state.status === AudioPlayerStatus.Playing ||
           this.player.state.status === AudioPlayerStatus.Buffering;
  }

  isWaiting(): boolean {
    return this.waitingLoop;
  }

  getPlayer(): AudioPlayer {
    return this.player;
  }
}
