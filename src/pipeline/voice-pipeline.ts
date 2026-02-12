import { VoiceConnection } from '@discordjs/voice';
import { TextChannel } from 'discord.js';
import { AudioReceiver } from '../discord/audio-receiver.js';
import { DiscordAudioPlayer } from '../discord/audio-player.js';
import { transcribe } from '../services/whisper.js';
import { getResponse } from '../services/claude.js';
import { textToSpeechStream } from '../services/tts.js';
import { SessionTranscript } from '../services/session-transcript.js';
import { config } from '../config.js';
import { parseVoiceCommand, matchChannelSelection, matchQueueChoice, type VoiceCommand, type ChannelOption } from '../services/voice-commands.js';
import { getVoiceSettings, setSilenceDuration, setSpeechThreshold, resolveNoiseLevel } from '../services/voice-settings.js';
import type { ChannelRouter } from '../services/channel-router.js';
import type { GatewaySync } from '../services/gateway-sync.js';
import type { QueueState } from '../services/queue-state.js';
import type { ResponsePoller } from '../services/response-poller.js';
import type { VoiceMode } from '../services/queue-state.js';
import type { InboxTracker, ChannelActivity } from '../services/inbox-tracker.js';

export class VoicePipeline {
  private receiver: AudioReceiver;
  private player: DiscordAudioPlayer;
  private processing = false;
  private logChannel: TextChannel | null = null;
  private session: SessionTranscript;
  private router: ChannelRouter | null = null;
  private gatewaySync: GatewaySync | null = null;
  private awaitingSelection: { options: ChannelOption[]; timeout: NodeJS.Timeout } | null = null;
  private queueState: QueueState | null = null;
  private responsePoller: ResponsePoller | null = null;
  private awaitingQueueChoice: { timeout: NodeJS.Timeout } | null = null;
  private inboxTracker: InboxTracker | null = null;
  private inboxFlow: ChannelActivity[] | null = null;
  private inboxFlowIndex = 0;

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

  setQueueState(state: QueueState): void {
    this.queueState = state;
  }

  setResponsePoller(poller: ResponsePoller): void {
    this.responsePoller = poller;
  }

  setInboxTracker(tracker: InboxTracker): void {
    this.inboxTracker = tracker;
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

      // Step 1.5: Check for awaiting responses (bypass LLM)
      if (this.awaitingSelection) {
        console.log(`Channel selection input: "${transcript}"`);
        await this.handleChannelSelection(transcript);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command (selection) complete: ${totalMs}ms total`);
        return;
      }

      if (this.awaitingQueueChoice) {
        console.log(`Queue choice input: "${transcript}"`);
        await this.handleQueueChoiceResponse(transcript);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command (queue choice) complete: ${totalMs}ms total`);
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

      // In queue/ask mode, also match bare navigation commands without "Hey Watson" prefix
      const mode = this.queueState?.getMode() ?? 'wait';
      if (mode !== 'wait') {
        const bareCommand = this.matchBareQueueCommand(transcript);
        if (bareCommand) {
          console.log(`Bare queue command detected: ${bareCommand.type}`);
          await this.handleVoiceCommand(bareCommand);
          const totalMs = Date.now() - pipelineStart;
          console.log(`Voice command complete: ${totalMs}ms total`);
          return;
        }
      }
      if (mode === 'queue') {
        await this.handleQueueMode(userId, transcript);
      } else if (mode === 'ask') {
        await this.handleAskMode(userId, transcript);
      } else {
        await this.handleWaitMode(userId, transcript);
      }

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
      case 'mode':
        await this.handleModeSwitch(command.mode);
        break;
      case 'inbox-check':
        await this.handleInboxCheck();
        break;
      case 'inbox-next':
        await this.handleInboxNext();
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

      // Queue-aware: auto-read ready item for this channel
      if (this.queueState) {
        const readyItem = this.queueState.getReadyByChannel(target);
        if (readyItem) {
          responseText += ` You have a queued response here.`;
        }
      }

      // Update inbox snapshot for this channel so it drops from inbox
      if (this.inboxTracker?.isActive() && this.router) {
        const sessionKey = this.router.getActiveSessionKey();
        const count = await this.getCurrentMessageCount(sessionKey);
        this.inboxTracker.markSeen(sessionKey, count);
      }
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

  private async handleWaitMode(userId: string, transcript: string): Promise<void> {
    const channelName = this.router?.getActiveChannel().name;

    this.log(`**You:** ${transcript}`);
    this.session.appendUserMessage(userId, transcript, channelName);

    let responseText: string;
    if (this.router) {
      const activeChannel = this.router.getActiveChannel();
      const systemPrompt = this.router.getSystemPrompt();
      await this.router.refreshHistory();
      const history = this.router.getHistory();
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

    this.log(`**${config.botName}:** ${responseText}`);
    this.session.appendAssistantMessage(responseText, channelName);

    void this.syncToOpenClaw(transcript, responseText);

    const ttsStream = await textToSpeechStream(responseText);
    this.player.stopWaitingLoop();
    this.player.stopPlayback();
    await this.player.playStream(ttsStream);
  }

  private async handleQueueMode(userId: string, transcript: string): Promise<void> {
    if (!this.router || !this.queueState) {
      // Fall back to wait mode if queue state not available
      await this.handleWaitMode(userId, transcript);
      return;
    }

    const activeChannel = this.router.getActiveChannel();
    const channelName = activeChannel.name;
    const displayName = (activeChannel as any).displayName || channelName;
    const sessionKey = this.router.getActiveSessionKey();

    this.log(`**You:** ${transcript}`);
    this.session.appendUserMessage(userId, transcript, channelName);

    // Enqueue and dispatch fire-and-forget
    const item = this.queueState.enqueue({
      channel: channelName,
      displayName,
      sessionKey,
      userMessage: transcript,
    });

    this.dispatchToLLMFireAndForget(userId, transcript, item.id);

    // Brief confirmation — stop waiting loop quickly
    // Confirm dispatch + summarize inbox activity
    let readySuffix = '';
    if (this.inboxTracker?.isActive() && this.router) {
      const channels = this.router.getAllChannelSessionKeys();
      const activities = await this.inboxTracker.checkInbox(channels);
      if (activities.length > 0) {
        const channelList = activities.map((a, i) => `${i + 1}. ${a.displayName}`).join('. ');
        const totalReady = activities.reduce((sum, a) => sum + a.queuedReadyCount + a.newMessageCount, 0);
        readySuffix = ` ${totalReady} item${totalReady > 1 ? 's' : ''} across ${activities.length} channel${activities.length > 1 ? 's' : ''}. ${channelList}.`;
      }
    } else {
      const readyItems = this.queueState.getReadyItems();
      if (readyItems.length > 0) {
        const channels = [...new Set(readyItems.map((r) => r.displayName))];
        const channelList = channels.map((ch, i) => `${i + 1}. ${ch}`).join('. ');
        readySuffix = ` ${readyItems.length} response${readyItems.length > 1 ? 's' : ''} ready. ${channelList}.`;
      }
    }
    await this.speakResponse(`Sent to ${displayName}.${readySuffix}`);
  }

  private async handleAskMode(userId: string, transcript: string): Promise<void> {
    // Speak the prompt, then await choice
    await this.speakResponse('Inbox, or wait?');

    this.awaitingQueueChoice = {
      timeout: setTimeout(() => {
        console.log('Queue choice timed out, defaulting to wait');
        this.awaitingQueueChoice = null;
        // Default to wait mode behavior
        this.processing = true;
        this.player.startWaitingLoop();
        this.handleWaitMode(userId, transcript)
          .catch((err) => {
            console.error('Wait mode fallback error:', err);
            this.player.stopWaitingLoop();
            this.player.stopPlayback();
          })
          .finally(() => {
            this.processing = false;
          });
      }, 20_000),
    };

    // Store transcript/userId for when choice comes in
    (this.awaitingQueueChoice as any).userId = userId;
    (this.awaitingQueueChoice as any).transcript = transcript;
  }

  private async handleQueueChoiceResponse(transcript: string): Promise<void> {
    if (!this.awaitingQueueChoice) return;

    const { timeout } = this.awaitingQueueChoice;
    const userId = (this.awaitingQueueChoice as any).userId as string;
    const originalTranscript = (this.awaitingQueueChoice as any).transcript as string;
    clearTimeout(timeout);
    this.awaitingQueueChoice = null;

    const choice = matchQueueChoice(transcript);
    if (choice === 'queue') {
      await this.handleQueueMode(userId, originalTranscript);
    } else {
      // Default to wait for unrecognized input too
      await this.handleWaitMode(userId, originalTranscript);
    }
  }

  private dispatchToLLMFireAndForget(userId: string, transcript: string, queueItemId: string): void {
    if (!this.router || !this.queueState) return;

    const activeChannel = this.router.getActiveChannel();
    const systemPrompt = this.router.getSystemPrompt();
    const channelName = activeChannel.name;

    // Capture state we need before the async work
    const routerRef = this.router;
    const queueRef = this.queueState;
    const pollerRef = this.responsePoller;
    const gatewaySync = this.gatewaySync;
    const session = this.session;

    void (async () => {
      try {
        await routerRef.refreshHistory();
        const history = routerRef.getHistory();
        const scopedUserId = `${userId}:${activeChannel.name}`;
        const { response, history: updatedHistory } = await getResponse(scopedUserId, transcript, {
          systemPrompt,
          history,
        });
        routerRef.setHistory(updatedHistory);

        // Generate summary (first sentence or first 100 chars)
        const summary = response.length > 100
          ? response.slice(0, 100) + '...'
          : response;

        queueRef.markReady(queueItemId, summary, response);
        console.log(`Queue item ${queueItemId} ready (channel: ${channelName})`);

        // Log + session transcript
        this.log(`**${config.botName}:** ${response}`);
        session.appendAssistantMessage(response, channelName);

        // Sync to OpenClaw
        if (gatewaySync?.isConnected() && routerRef) {
          const sessionKey = routerRef.getActiveSessionKey();
          await gatewaySync.inject(sessionKey, transcript, 'voice-user');
          await gatewaySync.inject(sessionKey, response, 'voice-assistant');
        }

        pollerRef?.check();
      } catch (err: any) {
        console.error(`Fire-and-forget LLM dispatch failed for ${queueItemId}: ${err.message}`);
      }
    })();

    this.responsePoller?.check();
  }

  private async handleModeSwitch(mode: VoiceMode): Promise<void> {
    if (!this.queueState) {
      await this.speakResponse('Queue mode is not available.');
      return;
    }

    this.queueState.setMode(mode);

    // Activate/deactivate inbox based on mode
    if (mode === 'queue' || mode === 'ask') {
      if (this.inboxTracker && this.router) {
        const channels = this.router.getAllChannelSessionKeys();
        await this.inboxTracker.activate(channels);
      }
    } else {
      // wait mode — deactivate inbox
      if (this.inboxTracker) {
        this.inboxTracker.deactivate();
      }
      this.inboxFlow = null;
      this.inboxFlowIndex = 0;
    }

    const labels: Record<VoiceMode, string> = {
      wait: 'Wait mode. I will wait for each response before you can speak again.',
      queue: 'Queue mode. Your messages will be dispatched and you can keep talking.',
      ask: 'Ask mode. I will ask you whether to queue or wait for each message.',
    };
    await this.speakResponse(labels[mode]);
  }

  private async handleInboxCheck(): Promise<void> {
    if (!this.queueState) {
      await this.speakResponse('Queue mode is not available.');
      return;
    }

    // If inbox tracker is active, do a unified check
    if (this.inboxTracker?.isActive() && this.router) {
      const channels = this.router.getAllChannelSessionKeys();
      const activities = await this.inboxTracker.checkInbox(channels);

      if (activities.length === 0) {
        // Also check pending queue items
        const pending = this.queueState.getPendingItems();
        if (pending.length > 0) {
          await this.speakResponse(`Nothing new yet. ${pending.length} still processing.`);
        } else {
          await this.speakResponse('Nothing new.');
        }
        return;
      }

      // Store as inbox flow for "next" traversal
      this.inboxFlow = activities;
      this.inboxFlowIndex = 0;

      const channelCount = activities.length;
      const summaryParts = activities.map((a) => {
        const parts: string[] = [];
        if (a.newMessageCount > 0) {
          parts.push(`${a.newMessageCount} new message${a.newMessageCount > 1 ? 's' : ''}`);
        }
        if (a.queuedReadyCount > 0) {
          parts.push(`${a.queuedReadyCount} queued response${a.queuedReadyCount > 1 ? 's' : ''}`);
        }
        return `${a.displayName} has ${parts.join(' and ')}`;
      });

      const pending = this.queueState.getPendingItems();
      const pendingSuffix = pending.length > 0 ? ` ${pending.length} still processing.` : '';

      await this.speakResponse(
        `You have new activity in ${channelCount} channel${channelCount > 1 ? 's' : ''}. ` +
        `${summaryParts.join('. ')}.${pendingSuffix} Say next to start reading.`,
      );
      return;
    }

    // Fallback: queue-only check (wait mode or no inbox tracker)
    const ready = this.queueState.getReadyItems();
    const pending = this.queueState.getPendingItems();

    if (ready.length === 0 && pending.length === 0) {
      await this.speakResponse('Nothing new.');
      return;
    }

    const parts: string[] = [];
    if (ready.length > 0) {
      const channels = [...new Set(ready.map((r) => r.displayName))];
      parts.push(`${ready.length} ready from ${channels.join(', ')}`);
    }
    if (pending.length > 0) {
      parts.push(`${pending.length} still waiting`);
    }

    await this.speakResponse(`You have ${parts.join(', and ')}.`);
  }

  private async handleInboxNext(): Promise<void> {
    if (!this.queueState) {
      await this.speakResponse('Queue mode is not available.');
      return;
    }

    // If we have an inbox flow from a prior check, use it
    let activity: ChannelActivity | null = null;

    if (this.inboxFlow && this.inboxFlowIndex < this.inboxFlow.length) {
      activity = this.inboxFlow[this.inboxFlowIndex];
      this.inboxFlowIndex++;
    } else if (this.inboxTracker?.isActive() && this.router) {
      // Fresh check if flow is exhausted or not started
      const channels = this.router.getAllChannelSessionKeys();
      const activities = await this.inboxTracker.checkInbox(channels);
      if (activities.length > 0) {
        this.inboxFlow = activities;
        this.inboxFlowIndex = 1;
        activity = activities[0];
      }
    }

    if (activity) {
      // Switch to the channel
      if (this.router) {
        const result = await this.router.switchTo(activity.channelName);
        if (result.success) {
          await this.onChannelSwitch();
        }
      }

      // Build TTS content
      const parts: string[] = [];
      parts.push(`${activity.displayName}.`);

      // Read new gateway messages
      if (activity.newMessages.length > 0 && this.inboxTracker) {
        const formatted = this.inboxTracker.formatForTTS(activity.newMessages);
        if (formatted) {
          parts.push(formatted);
        }
      }

      // Read voice-queued ready items for this channel
      const readyItems = this.queueState.getReadyItems().filter(
        (i) => i.sessionKey === activity!.sessionKey,
      );
      for (const item of readyItems) {
        parts.push(item.responseText);
        this.queueState.markHeard(item.id);
      }
      this.responsePoller?.check();

      // Update snapshot to mark this channel as seen
      if (this.inboxTracker) {
        const currentCount = await this.getCurrentMessageCount(activity.sessionKey);
        this.inboxTracker.markSeen(activity.sessionKey, currentCount);
      }

      // Report remaining
      const remaining = this.inboxFlow
        ? this.inboxFlow.length - this.inboxFlowIndex
        : 0;

      if (remaining > 0) {
        parts.push(`${remaining} more channel${remaining > 1 ? 's' : ''}. Say next.`);
      } else {
        parts.push("That's everything.");
        this.inboxFlow = null;
        this.inboxFlowIndex = 0;
      }

      const ttsStream = await textToSpeechStream(parts.join(' '));
      this.player.stopWaitingLoop();
      this.player.stopPlayback();
      await this.player.playStream(ttsStream);
      return;
    }

    // Fallback: try old-style queue next (single item)
    const item = this.queueState.getNextReady();
    if (!item) {
      const pending = this.queueState.getPendingItems();
      if (pending.length > 0) {
        await this.speakResponse(`Nothing ready yet. ${pending.length} still waiting.`);
      } else {
        await this.speakResponse("That's everything.");
      }
      return;
    }

    // Switch to the response's channel
    if (this.router) {
      const result = await this.router.switchTo(item.channel);
      if (result.success) {
        await this.onChannelSwitch();
      }
    }

    // Read the response aloud
    this.queueState.markHeard(item.id);
    this.responsePoller?.check();

    const remaining = this.queueState.getReadyItems().length;
    const prefix = `From ${item.displayName}: `;
    const suffix = remaining > 0 ? ` ${remaining} more in queue.` : '';

    const ttsStream = await textToSpeechStream(prefix + item.responseText + suffix);
    this.player.stopWaitingLoop();
    this.player.stopPlayback();
    await this.player.playStream(ttsStream);
  }

  private async getCurrentMessageCount(sessionKey: string): Promise<number> {
    if (!this.gatewaySync?.isConnected()) return 0;
    const result = await this.gatewaySync.getHistory(sessionKey, 40);
    return result?.messages?.length ?? 0;
  }

  private matchBareQueueCommand(transcript: string): VoiceCommand | null {
    const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');

    // "next", "next one", "next response", "next message", "next channel"
    if (/^next(?:\s+(?:response|one|message|channel))?$/.test(input)) {
      return { type: 'inbox-next' };
    }

    // "go to X", "switch to X"
    const switchMatch = input.match(/^(?:go|switch|change|move)\s+to\s+(.+)$/);
    if (switchMatch) {
      return { type: 'switch', channel: switchMatch[1].trim() };
    }

    // "go back", "go home", "default"
    if (/^(?:go\s+back|go\s+home|default)$/.test(input)) {
      return { type: 'default' };
    }

    // "what do I have", "check queue", "check inbox", "what's new", "inbox", etc.
    if (/^(?:what\s+do\s+(?:i|you)\s+have(?:\s+for\s+me)?|check\s+(?:the\s+)?(?:queue|inbox)|what'?s\s+(?:waiting|ready|new)|queue\s+status|inbox)$/.test(input)) {
      return { type: 'inbox-check' };
    }

    return null;
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
