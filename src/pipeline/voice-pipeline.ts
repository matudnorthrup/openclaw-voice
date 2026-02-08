import { VoiceConnection } from '@discordjs/voice';
import { TextChannel } from 'discord.js';
import { AudioReceiver } from '../discord/audio-receiver.js';
import { DiscordAudioPlayer } from '../discord/audio-player.js';
import { transcribe } from '../services/whisper.js';
import { getResponse } from '../services/claude.js';
import { textToSpeechStream } from '../services/elevenlabs.js';

export class VoicePipeline {
  private receiver: AudioReceiver;
  private player: DiscordAudioPlayer;
  private processing = false;
  private logChannel: TextChannel | null = null;

  constructor(
    connection: VoiceConnection,
    silenceDurationMs: number,
    logChannel?: TextChannel,
  ) {
    this.player = new DiscordAudioPlayer();
    this.player.attach(connection);
    this.logChannel = logChannel || null;

    this.receiver = new AudioReceiver(
      connection,
      silenceDurationMs,
      (userId, wavBuffer, durationMs) => this.handleUtterance(userId, wavBuffer, durationMs),
    );
  }

  start(): void {
    this.receiver.start();
    console.log('Voice pipeline started');
  }

  stop(): void {
    this.receiver.stop();
    this.player.stopPlayback();
    console.log('Voice pipeline stopped');
  }

  isPlaying(): boolean {
    return this.player.isPlaying();
  }

  interrupt(): void {
    if (this.player.isPlaying()) {
      console.log('Interrupting playback');
      this.player.stopPlayback();
    }
  }

  private async handleUtterance(userId: string, wavBuffer: Buffer, durationMs: number): Promise<void> {
    // Interrupt current playback if speaking while Watson is responding
    if (this.player.isPlaying()) {
      console.log('User spoke during playback — interrupting');
      this.player.stopPlayback();
    }

    if (this.processing) {
      console.log('Already processing an utterance, skipping');
      return;
    }

    this.processing = true;
    const pipelineStart = Date.now();

    try {
      // Step 1: Speech-to-text
      const transcript = await transcribe(wavBuffer);
      if (!transcript || transcript.trim().length === 0) {
        console.log('Empty transcript, skipping');
        return;
      }

      // Log to text channel
      this.log(`**You:** ${transcript}`);

      // Step 2: LLM response
      const response = await getResponse(userId, transcript);

      // Log to text channel
      this.log(`**Watson:** ${response}`);

      // Step 3: Text-to-speech + playback
      const ttsStream = await textToSpeechStream(response);
      await this.player.playStream(ttsStream);

      const totalMs = Date.now() - pipelineStart;
      console.log(`Pipeline complete: ${totalMs}ms total`);
    } catch (error) {
      console.error('Pipeline error:', error);
    } finally {
      this.processing = false;
    }
  }

  private log(message: string): void {
    if (this.logChannel) {
      this.logChannel.send(message).catch((err) => {
        console.error('Failed to log to text channel:', err.message);
      });
    }
  }
}
