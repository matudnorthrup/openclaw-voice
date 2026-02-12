import { VoiceConnection } from '@discordjs/voice';
import { TextChannel } from 'discord.js';
import { AudioReceiver } from '../discord/audio-receiver.js';
import { DiscordAudioPlayer } from '../discord/audio-player.js';
import { transcribe } from '../services/whisper.js';
import { getResponse } from '../services/claude.js';
import { textToSpeechStream } from '../services/tts.js';
import { SessionTranscript } from '../services/session-transcript.js';
import { config } from '../config.js';
import { parseVoiceCommand, matchChannelSelection, type VoiceCommand, type ChannelOption } from '../services/voice-commands.js';
import { getVoiceSettings, setSilenceDuration, setSpeechThreshold, resolveNoiseLevel } from '../services/voice-settings.js';
import type { ChannelRouter } from '../services/channel-router.js';
import type { GatewaySync } from '../services/gateway-sync.js';

export class VoicePipeline {
  private receiver: AudioReceiver;
  private player: DiscordAudioPlayer;
  private processing = false;
  private logChannel: TextChannel | null = null;
  private session: SessionTranscript;
  private router: ChannelRouter | null = null;
  private gatewaySync: GatewaySync | null = null;
  private awaitingSelection: { options: ChannelOption[]; timeout: NodeJS.Timeout } | null = null;

  constructor(
    connection: VoiceConnection,
    logChannel?: TextChannel,
  ) {
    this.player = new DiscordAudioPlayer();
    this.player.attach(connection);
    this.logChannel = logChannel || null;
    this.session = new SessionTranscript();

    this.receiver = new AudioReceiver(
      connection,
      (userId, wavBuffer, durationMs) => this.handleUtterance(userId, wavBuffer, durationMs),
    );
  }

  setRouter(router: ChannelRouter): void {
    this.router = router;
  }

  setGatewaySync(sync: GatewaySync): void {
    this.gatewaySync = sync;
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

      // Step 1.5: Check for voice commands (bypass LLM)
      if (this.awaitingSelection) {
        console.log(`Channel selection input: "${transcript}"`);
        await this.handleChannelSelection(transcript);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command (selection) complete: ${totalMs}ms total`);
        return;
      }

      const command = parseVoiceCommand(transcript, config.botName);
      if (command) {
        if (command.type === 'new-post') {
          console.log(`New-post command: forum="${command.forum}" title="${command.title}"`);
          await this.handleNewPost(command.forum, command.title);
          // Fall through to LLM — do NOT return
        } else {
          console.log(`Voice command detected: ${command.type}`);
          await this.handleVoiceCommand(command);
          const totalMs = Date.now() - pipelineStart;
          console.log(`Voice command complete: ${totalMs}ms total`);
          return;
        }
      }

      const channelName = this.router?.getActiveChannel().name;

      // Log to text channel + session transcript
      this.log(`**You:** ${transcript}`);
      this.session.appendUserMessage(userId, transcript, channelName);

      // Step 2: LLM response
      let responseText: string;
      if (this.router) {
        const activeChannel = this.router.getActiveChannel();
        const systemPrompt = this.router.getSystemPrompt();
        // Refresh history from gateway to pick up text messages
        await this.router.refreshHistory();
        const history = this.router.getHistory();
        // Use channel-scoped user ID so the gateway treats each channel as a separate conversation
        const scopedUserId = `${userId}:${activeChannel.name}`;
        const { response, history: updatedHistory } = await getResponse(scopedUserId, transcript, {
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
      this.log(`**${config.botName}:** ${responseText}`);
      this.session.appendAssistantMessage(responseText, channelName);

      // Fire-and-forget sync to OpenClaw text session
      void this.syncToOpenClaw(transcript, responseText);

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

  private async handleVoiceCommand(command: VoiceCommand): Promise<void> {
    switch (command.type) {
      case 'switch':
        await this.handleDirectSwitch(command.channel);
        break;
      case 'list':
        await this.handleListChannels();
        break;
      case 'default':
        await this.handleDefaultSwitch();
        break;
      case 'noise':
        await this.handleNoise(command.level);
        break;
      case 'delay':
        await this.handleDelay(command.value);
        break;
      case 'delay-adjust':
        await this.handleDelayAdjust(command.direction);
        break;
      case 'settings':
        await this.handleReadSettings();
        break;
    }
  }

  private async handleNewPost(forum: string, title: string): Promise<void> {
    if (!this.router) return;

    const result = await this.router.createForumPost(forum, title);
    if (result.success) {
      await this.onChannelSwitch();
      console.log(`Created forum post "${title}" in ${result.forumName}, switched to thread ${result.threadId}`);
    } else {
      console.warn(`Forum post creation failed: ${result.error} — continuing in current channel`);
    }
  }

  private async handleDirectSwitch(channelName: string): Promise<void> {
    if (!this.router) return;

    // Try to find the channel by fuzzy matching against known channels
    const allChannels = this.router.listChannels();
    const lower = channelName.toLowerCase();
    const match = allChannels.find(
      (c) =>
        c.name.toLowerCase() === lower ||
        c.displayName.toLowerCase() === lower ||
        c.displayName.toLowerCase().includes(lower) ||
        lower.includes(c.name.toLowerCase()),
    );

    const target = match ? match.name : channelName;
    const result = await this.router.switchTo(target);

    let responseText: string;
    if (result.success) {
      await this.onChannelSwitch();
      responseText = this.buildSwitchConfirmation(result.displayName || target);
    } else {
      responseText = `I couldn't find a channel called ${channelName}.`;
    }

    await this.speakResponse(responseText);
  }

  private async handleListChannels(): Promise<void> {
    if (!this.router) return;

    const recent = this.router.getRecentChannels(5);
    if (recent.length === 0) {
      await this.speakResponse('There are no other channels available.');
      return;
    }

    const options: ChannelOption[] = recent.map((ch, i) => ({
      index: i + 1,
      name: ch.name,
      displayName: ch.displayName,
    }));

    const lines = options.map((o) => `${o.index}: ${o.displayName}`);
    const responseText = `Here are your recent channels. ${lines.join('. ')}. Say a number or channel name.`;

    // Enter selection mode with 15s timeout
    this.awaitingSelection = {
      options,
      timeout: setTimeout(() => {
        console.log('Channel selection timed out');
        this.awaitingSelection = null;
      }, 15_000),
    };

    await this.speakResponse(responseText);
  }

  private async handleChannelSelection(transcript: string): Promise<void> {
    if (!this.awaitingSelection || !this.router) return;

    const { options, timeout } = this.awaitingSelection;
    clearTimeout(timeout);
    this.awaitingSelection = null;

    const selected = matchChannelSelection(transcript, options);
    if (!selected) {
      await this.speakResponse("I didn't catch that. You can try again by saying hey " + config.botName + ", change channels.");
      return;
    }

    const result = await this.router.switchTo(selected.name);
    if (result.success) {
      await this.onChannelSwitch();
      await this.speakResponse(this.buildSwitchConfirmation(result.displayName || selected.displayName));
    } else {
      await this.speakResponse(`I couldn't switch to ${selected.displayName}.`);
    }
  }

  private async handleDefaultSwitch(): Promise<void> {
    if (!this.router) return;

    const result = await this.router.switchToDefault();
    if (result.success) {
      await this.onChannelSwitch();
      await this.speakResponse(`Switched back to ${result.displayName || 'default'}.`);
    } else {
      await this.speakResponse("I couldn't switch to the default channel.");
    }
  }

  private async handleNoise(level: string): Promise<void> {
    const resolved = resolveNoiseLevel(level);
    if (!resolved) {
      await this.speakResponse("I didn't recognize that noise level. Try low, medium, or high.");
      return;
    }
    setSpeechThreshold(resolved.threshold);
    await this.speakResponse(`Noise threshold set to ${resolved.label}.`);
  }

  private async handleDelay(value: number): Promise<void> {
    const clamped = Math.max(500, Math.min(10000, value));
    setSilenceDuration(clamped);
    await this.speakResponse(`Silence delay set to ${clamped} milliseconds.`);
  }

  private async handleDelayAdjust(direction: 'longer' | 'shorter'): Promise<void> {
    const current = getVoiceSettings().silenceDurationMs;
    const delta = direction === 'longer' ? 500 : -500;
    const updated = Math.max(500, Math.min(10000, current + delta));
    setSilenceDuration(updated);
    const verb = direction === 'longer' ? 'increased' : 'decreased';
    await this.speakResponse(`Silence delay ${verb} to ${updated} milliseconds.`);
  }

  private async handleReadSettings(): Promise<void> {
    const s = getVoiceSettings();
    await this.speakResponse(
      `Silence delay: ${s.silenceDurationMs} milliseconds. ` +
      `Noise threshold: ${s.speechThreshold}. ` +
      `Minimum speech duration: ${s.minSpeechDurationMs} milliseconds.`,
    );
  }

  private buildSwitchConfirmation(displayName: string): string {
    const lastMsg = this.router?.getLastMessage();
    let text = `Switched to ${displayName}.`;
    if (lastMsg) {
      const speaker = lastMsg.role === 'user' ? 'you' : config.botName;
      // Truncate long messages for TTS
      const content = lastMsg.content.length > 200
        ? lastMsg.content.slice(0, 200) + '...'
        : lastMsg.content;
      text += ` The last message was from ${speaker}: ${content}`;
    }
    return text;
  }

  private async speakResponse(text: string): Promise<void> {
    this.log(`**${config.botName}:** ${text}`);
    const ttsStream = await textToSpeechStream(text);
    this.player.stopWaitingLoop();
    this.player.stopPlayback();
    await this.player.playStream(ttsStream);
  }

  private async syncToOpenClaw(userText: string, assistantText: string): Promise<void> {
    if (!this.gatewaySync?.isConnected() || !this.router) return;

    try {
      const sessionKey = this.router.getActiveSessionKey();
      await this.gatewaySync.inject(sessionKey, userText, 'voice-user');
      await this.gatewaySync.inject(sessionKey, assistantText, 'voice-assistant');
    } catch (err: any) {
      console.warn(`OpenClaw sync failed: ${err.message}`);
    }
  }

  private async sendChunked(channel: TextChannel, message: string): Promise<void> {
    const MAX_LEN = 2000;
    for (let i = 0; i < message.length; i += MAX_LEN) {
      await channel.send(message.slice(i, i + MAX_LEN));
    }
  }

  private log(message: string): void {
    const send = (channel: TextChannel) => {
      this.sendChunked(channel, message).catch((err) => {
        console.error('Failed to log to text channel:', err.message);
      });
    };

    if (this.router) {
      this.router.getLogChannel().then((channel) => {
        if (channel) send(channel);
      });
    } else if (this.logChannel) {
      send(this.logChannel);
    }
  }
}
