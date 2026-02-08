import { VoiceConnection } from '@discordjs/voice';
import { TextChannel } from 'discord.js';
import { AudioReceiver } from '../discord/audio-receiver.js';
import { DiscordAudioPlayer } from '../discord/audio-player.js';
import { transcribe } from '../services/whisper.js';
import { getResponse } from '../services/claude.js';
import { textToSpeechStream } from '../services/elevenlabs.js';
import { SessionTranscript } from '../services/session-transcript.js';
import type { ChannelRouter } from '../services/channel-router.js';

export class VoicePipeline {
  private receiver: AudioReceiver;
  private player: DiscordAudioPlayer;
  private processing = false;
  private logChannel: TextChannel | null = null;
  private session: SessionTranscript;
  private router: ChannelRouter | null = null;

  constructor(
    connection: VoiceConnection,
    silenceDurationMs: number,
    logChannel?: TextChannel,
  ) {
    this.player = new DiscordAudioPlayer();
    this.player.attach(connection);
    this.logChannel = logChannel || null;
    this.session = new SessionTranscript();

    this.receiver = new AudioReceiver(
      connection,
      silenceDurationMs,
      (userId, wavBuffer, durationMs) => this.handleUtterance(userId, wavBuffer, durationMs),
    );
  }

  setRouter(router: ChannelRouter): void {
    this.router = router;
  }

  async onChannelSwitch(): Promise<void> {
    if (this.router) {
      const routerLogChannel = await this.router.getLogChannel();
      if (routerLogChannel) {
        this.logChannel = routerLogChannel;
      }
    }
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
    // Interrupt TTS playback if user speaks — but don't kill the waiting tone
    if (this.player.isPlaying() && !this.player.isWaiting()) {
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
      // Start waiting indicator sound
      this.player.startWaitingLoop();

      // Step 1: Speech-to-text
      const transcript = await transcribe(wavBuffer);
      if (!transcript || transcript.trim().length === 0) {
        console.log('Empty transcript, skipping');
        this.player.stopWaitingLoop();
        return;
      }

      const channelName = this.router?.getActiveChannel().name;

      // Log to text channel + session transcript
      this.log(`**You:** ${transcript}`);
      this.session.appendUserMessage(userId, transcript, channelName);

      // Step 2: LLM response
      let responseText: string;
      if (this.router) {
        const systemPrompt = this.router.getSystemPrompt();
        const history = this.router.getHistory();
        const { response, history: updatedHistory } = await getResponse(userId, transcript, {
          systemPrompt,
          history,
        });
        this.router.setHistory(updatedHistory);
        responseText = response;
      } else {
        const { response } = await getResponse(userId, transcript);
        responseText = response;
      }

      // Log to text channel + session transcript
      this.log(`**Watson:** ${responseText}`);
      this.session.appendAssistantMessage(responseText, channelName);

      // Step 3: Text-to-speech + playback — stop waiting loop, start TTS
      const ttsStream = await textToSpeechStream(responseText);
      this.player.stopWaitingLoop();
      this.player.stopPlayback();
      await this.player.playStream(ttsStream);

      const totalMs = Date.now() - pipelineStart;
      console.log(`Pipeline complete: ${totalMs}ms total`);
    } catch (error) {
      console.error('Pipeline error:', error);
      this.player.stopWaitingLoop();
      this.player.stopPlayback();
    } finally {
      this.processing = false;
    }
  }

  private log(message: string): void {
    if (this.router) {
      this.router.getLogChannel().then((channel) => {
        if (channel) {
          channel.send(message).catch((err) => {
            console.error('Failed to log to text channel:', err.message);
          });
        }
      });
    } else if (this.logChannel) {
      this.logChannel.send(message).catch((err) => {
        console.error('Failed to log to text channel:', err.message);
      });
    }
  }
}
