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

export class DiscordAudioPlayer {
  private player: AudioPlayer;
  private connection: VoiceConnection | null = null;

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

  stopPlayback(): void {
    this.player.stop(true);
  }

  isPlaying(): boolean {
    return this.player.state.status === AudioPlayerStatus.Playing ||
           this.player.state.status === AudioPlayerStatus.Buffering;
  }

  getPlayer(): AudioPlayer {
    return this.player;
  }
}
