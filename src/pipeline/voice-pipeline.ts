import { VoiceConnection } from '@discordjs/voice';
import { TextChannel } from 'discord.js';
import { AudioReceiver } from '../discord/audio-receiver.js';
import { DiscordAudioPlayer } from '../discord/audio-player.js';
import { transcribe } from '../services/whisper.js';
import { getResponse, quickCompletion } from '../services/claude.js';
import { textToSpeechStream } from '../services/tts.js';
import { SessionTranscript } from '../services/session-transcript.js';
import { config } from '../config.js';
import { parseVoiceCommand, matchesWakeWord, matchChannelSelection, matchQueueChoice, matchSwitchChoice, type VoiceCommand, type ChannelOption } from '../services/voice-commands.js';
import { getVoiceSettings, setSilenceDuration, setSpeechThreshold, setGatedMode, resolveNoiseLevel, getNoisePresetNames } from '../services/voice-settings.js';
import { PipelineStateMachine, type TransitionEffect } from './pipeline-state.js';
import { initEarcons } from '../audio/earcons.js';
import type { ChannelRouter } from '../services/channel-router.js';
import type { GatewaySync } from '../services/gateway-sync.js';
import type { QueueState } from '../services/queue-state.js';
import type { ResponsePoller } from '../services/response-poller.js';
import type { VoiceMode } from '../services/queue-state.js';
import type { InboxTracker, ChannelActivity } from '../services/inbox-tracker.js';

export class VoicePipeline {
  private receiver: AudioReceiver;
  private player: DiscordAudioPlayer;
  private stateMachine: PipelineStateMachine;
  private logChannel: TextChannel | null = null;
  private session: SessionTranscript;
  private router: ChannelRouter | null = null;
  private gatewaySync: GatewaySync | null = null;
  private queueState: QueueState | null = null;
  private responsePoller: ResponsePoller | null = null;
  private inboxTracker: InboxTracker | null = null;
  private inboxLogChannel: TextChannel | null = null;
  private lastSpokenText: string = '';
  private silentWait = false;
  private gateGraceUntil = 0;

  constructor(
    connection: VoiceConnection,
    logChannel?: TextChannel,
  ) {
    this.player = new DiscordAudioPlayer();
    this.player.attach(connection);
    this.logChannel = logChannel || null;
    this.inboxLogChannel = logChannel || null;
    this.session = new SessionTranscript();

    // Initialize earcon cache and state machine
    initEarcons();
    this.stateMachine = new PipelineStateMachine();
    this.stateMachine.setTimeoutHandler((effects) => this.applyEffects(effects));

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
    this.stateMachine.destroy();
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

  private isProcessing(): boolean {
    const st = this.stateMachine.getStateType();
    return st === 'PROCESSING' || st === 'TRANSCRIBING' || st === 'SPEAKING';
  }

  /**
   * Apply a list of transition effects produced by the state machine.
   */
  private async applyEffects(effects: TransitionEffect[]): Promise<void> {
    for (const effect of effects) {
      switch (effect.type) {
        case 'earcon':
          this.player.playEarconSync(effect.name);
          break;
        case 'speak':
          await this.speakResponse(effect.text);
          break;
        case 'stop-playback':
          this.player.stopPlayback();
          break;
        case 'start-waiting-loop':
          this.player.startWaitingLoop();
          break;
        case 'stop-waiting-loop':
          this.player.stopWaitingLoop();
          break;
      }
    }
  }

  private async handleUtterance(userId: string, wavBuffer: Buffer, durationMs: number): Promise<void> {
    // Interrupt TTS playback if user speaks — but don't kill the waiting tone
    const wasPlayingResponse = this.player.isPlaying() && !this.player.isWaiting();

    // Open mode: interrupt immediately. Gated mode: defer until after transcription.
    if (wasPlayingResponse && !getVoiceSettings().gated) {
      console.log('User spoke during playback — interrupting');
      this.player.stopPlayback();
    }

    const gatedInterrupt = wasPlayingResponse && getVoiceSettings().gated;

    // Check if busy — buffer utterance instead of silently dropping
    if (this.isProcessing()) {
      console.log('Already processing — buffering utterance');
      const effects = this.stateMachine.transition({ type: 'UTTERANCE_RECEIVED' });
      this.stateMachine.bufferUtterance(userId, wavBuffer, durationMs);
      await this.applyEffects(effects);
      return;
    }

    // Transition to TRANSCRIBING
    this.stateMachine.transition({ type: 'UTTERANCE_RECEIVED' });

    // listening earcon is deferred until we know this is a valid interaction
    // (post-wake-word in gated mode, or any AWAITING state input)

    const pipelineStart = Date.now();

    try {
      // Start waiting indicator sound
      // In gated mode, defer until after wake word is confirmed (avoid chime on noise/side talk)
      // In gated interrupt, defer because Watson is still talking
      if (!getVoiceSettings().gated) {
        this.player.startWaitingLoop();
      }

      // Step 1: Speech-to-text
      let transcript = await transcribe(wavBuffer);
      if (!transcript || transcript.trim().length === 0) {
        console.log('Empty transcript, skipping');
        this.player.stopWaitingLoop();
        this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
        return;
      }

      this.stateMachine.transition({ type: 'TRANSCRIPT_READY', transcript });

      // Step 1.5: Check for awaiting responses (bypass LLM)
      // These are valid interactions that don't need a wake word
      if (this.stateMachine.getStateType() === 'AWAITING_CHANNEL_SELECTION' ||
          this.stateMachine.getChannelSelectionState()) {
        this.player.playEarconSync('listening');
        console.log(`Channel selection input: "${transcript}"`);
        await this.handleChannelSelection(transcript);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command (selection) complete: ${totalMs}ms total`);
        return;
      }

      if (this.stateMachine.getQueueChoiceState()) {
        this.player.playEarconSync('listening');
        console.log(`Queue choice input: "${transcript}"`);
        await this.handleQueueChoiceResponse(transcript);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command (queue choice) complete: ${totalMs}ms total`);
        return;
      }

      if (this.stateMachine.getSwitchChoiceState()) {
        this.player.playEarconSync('listening');
        console.log(`Switch choice input: "${transcript}"`);
        await this.handleSwitchChoiceResponse(transcript);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command (switch choice) complete: ${totalMs}ms total`);
        return;
      }

      if (this.stateMachine.getNewPostFlowState()) {
        this.player.playEarconSync('listening');
        const flowState = this.stateMachine.getNewPostFlowState()!;
        console.log(`New-post flow (${flowState.step}): "${transcript}"`);
        const fallThrough = await this.handleNewPostStep(transcript);
        if (!fallThrough) {
          const totalMs = Date.now() - pipelineStart;
          console.log(`Voice command (new-post flow) complete: ${totalMs}ms total`);
          return;
        }
        // Body step completed — fall through to LLM with body as transcript
        transcript = fallThrough;
        console.log('New-post flow complete — falling through to LLM');
      }

      // Gate check: in gated mode, discard utterances that don't start with the wake word
      // Grace period: skip gate for 5s after Watson finishes speaking
      const inGracePeriod = Date.now() < this.gateGraceUntil;
      if (getVoiceSettings().gated && !inGracePeriod && !matchesWakeWord(transcript, config.botName)) {
        if (gatedInterrupt) {
          console.log(`Gated: discarded interrupt "${transcript}"`);
          // Don't stop playback — Watson keeps talking
        } else {
          console.log(`Gated: discarded "${transcript}"`);
          this.player.stopWaitingLoop();
        }
        this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
        return;
      }

      // Valid interaction confirmed — play listening earcon
      this.player.playEarconSync('listening');

      // Gated mode: passed gate check — start waiting loop now
      if (getVoiceSettings().gated) {
        if (inGracePeriod && !matchesWakeWord(transcript, config.botName)) {
          console.log('Gate grace period: processing without wake word');
        }
        if (gatedInterrupt) {
          console.log('Gated interrupt: wake word confirmed, interrupting playback');
          this.player.stopPlayback();
        }
        this.player.startWaitingLoop();
      }

      const command = parseVoiceCommand(transcript, config.botName);
      if (command) {
        if (command.type === 'new-post') {
          console.log('New-post command: starting guided flow');
          await this.startNewPostFlow();
          const totalMs = Date.now() - pipelineStart;
          console.log(`Voice command complete: ${totalMs}ms total`);
          return;
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

      this.stateMachine.transition({ type: 'PROCESSING_STARTED' });

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
      this.stateMachine.transition({ type: 'PROCESSING_COMPLETE' });

      // Re-process buffered utterance if any
      const buffered = this.stateMachine.getBufferedUtterance();
      if (buffered) {
        console.log('Re-processing buffered utterance');
        // Use setImmediate to avoid deep recursion
        setImmediate(() => {
          this.handleUtterance(buffered.userId, buffered.wavBuffer, buffered.durationMs);
        });
      }
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
      case 'voice-status':
        await this.handleVoiceStatus();
        break;
      case 'gated-mode':
        await this.handleGatedMode(command.enabled);
        break;
      case 'pause':
        this.handlePause();
        break;
      case 'replay':
        await this.handleReplay();
        break;
    }
  }

  private async startNewPostFlow(): Promise<void> {
    if (!this.router) return;

    const forums = this.router.listForumChannels();
    if (forums.length === 0) {
      await this.speakResponse('There are no forum channels available.');
      return;
    }

    const names = forums.map((f) => f.name).join(', ');
    this.stateMachine.transition({
      type: 'ENTER_NEW_POST_FLOW',
      step: 'forum',
      timeoutMs: 30_000,
    });

    await this.speakResponse(`Which forum? Available: ${names}.`);
  }

  private async handleNewPostStep(transcript: string): Promise<string | null> {
    const flowState = this.stateMachine.getNewPostFlowState();
    if (!flowState || !this.router) return null;

    const { step } = flowState;

    if (step === 'forum') {
      const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');

      // Check for cancel
      if (/^(?:cancel|nevermind|never\s*mind|forget\s*it|stop)$/.test(input)) {
        const effects = this.stateMachine.transition({ type: 'CANCEL_FLOW' });
        await this.applyEffects(effects);
        await this.speakResponse('Cancelled.');
        return null;
      }

      const match = this.router.findForumChannel(input);
      if (!match) {
        const effects = this.stateMachine.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
        await this.applyEffects(effects);
        await this.speakResponse(`I couldn't find a forum matching "${transcript}". Try again, or say cancel.`);
        return null;
      }

      this.stateMachine.transition({
        type: 'NEW_POST_ADVANCE',
        step: 'title',
        forumId: match.id,
        forumName: match.name,
        timeoutMs: 30_000,
      });

      this.player.playEarconSync('acknowledged');
      await this.speakResponse(`Got it, ${match.name}. What should the post be called?`);
      return null;
    }

    if (step === 'title') {
      const input = transcript.trim().replace(/[.!?]+$/, '');

      if (/^(?:cancel|nevermind|never\s*mind|forget\s*it|stop)$/i.test(input)) {
        const effects = this.stateMachine.transition({ type: 'CANCEL_FLOW' });
        await this.applyEffects(effects);
        await this.speakResponse('Cancelled.');
        return null;
      }

      this.stateMachine.transition({
        type: 'NEW_POST_ADVANCE',
        step: 'body',
        forumId: flowState.forumId,
        forumName: flowState.forumName,
        title: input,
        timeoutMs: 60_000,
      });

      this.player.playEarconSync('acknowledged');
      await this.speakResponse(`Title: ${input}. What's the prompt?`);
      return null;
    }

    if (step === 'body') {
      const body = transcript.trim();

      if (/^(?:cancel|nevermind|never\s*mind|forget\s*it|stop)$/i.test(body.toLowerCase().replace(/[.!?,]+$/, ''))) {
        const effects = this.stateMachine.transition({ type: 'CANCEL_FLOW' });
        await this.applyEffects(effects);
        await this.speakResponse('Cancelled.');
        return null;
      }

      const { forumId, forumName, title } = flowState;
      this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });

      const result = await this.router.createForumPost(forumId!, title!, body);
      if (result.success) {
        await this.onChannelSwitch();
        console.log(`Created forum post "${title}" in ${result.forumName}, switched to thread ${result.threadId}`);
        this.player.playEarconSync('acknowledged');
        await this.speakResponse(`Created ${title} in ${forumName}. You're now in the new thread.`);
        // Return body so pipeline falls through to LLM
        return body;
      } else {
        console.warn(`Forum post creation failed: ${result.error}`);
        await this.speakResponse(`Sorry, I couldn't create the post. ${result.error}`);
      }
    }

    return null;
  }

  private async handleDirectSwitch(channelName: string): Promise<void> {
    if (!this.router) return;

    // Try to find the channel by fuzzy matching against known channels
    const allChannels = this.router.listChannels();
    const lower = channelName.toLowerCase();
    let match = allChannels.find(
      (c) =>
        c.name.toLowerCase() === lower ||
        c.displayName.toLowerCase() === lower ||
        c.displayName.toLowerCase().includes(lower) ||
        lower.includes(c.name.toLowerCase()) ||
        lower.includes(c.displayName.toLowerCase()),
    );

    // LLM fallback: if string matching failed, ask the utility model (include forum threads)
    if (!match) {
      const forumThreads = await this.router.getForumThreads();
      const allCandidates = [
        ...allChannels.map((c) => ({ name: c.name, displayName: c.displayName })),
        ...forumThreads.map((t) => ({ name: t.name, displayName: t.displayName })),
      ];
      const llmResult = await this.matchChannelWithLLM(channelName, allCandidates);
      if (llmResult) {
        if ('best' in llmResult) {
          match = allChannels.find((c) => c.name === llmResult.best.name) ?? undefined;
          // If not a static channel, it might be a forum thread — switch by numeric ID
          if (!match && llmResult.best.name.startsWith('id:')) {
            const threadId = llmResult.best.name.slice(3);
            const threadResult = await this.router.switchTo(threadId);
            if (threadResult.success) {
              await this.onChannelSwitch();
              const displayName = threadResult.displayName || llmResult.best.displayName;
              const lastMsg = this.router.getLastMessage();
              if (lastMsg) {
                const fullContent = lastMsg.role === 'user'
                  ? `You last said: ${lastMsg.content}`
                  : lastMsg.content;
                this.stateMachine.transition({
                  type: 'ENTER_SWITCH_CHOICE',
                  lastMessage: fullContent,
                  timeoutMs: 30_000,
                });
                await this.speakResponse(`Switched to ${displayName}. Read, or prompt?`, { inbox: true });
                this.player.playEarconSync('ready');
              } else {
                await this.speakResponse(`Switched to ${displayName}.`, { inbox: true });
              }
              return;
            }
          }
        } else if ('options' in llmResult && llmResult.options.length > 0) {
          // Ambiguous — present options using the selection flow
          const options: ChannelOption[] = llmResult.options.map((ch, i) => ({
            index: i + 1,
            name: ch.name,
            displayName: ch.displayName,
          }));

          const lines = options.map((o) => `${o.index}: ${o.displayName}`);
          const responseText = `No exact match for ${channelName}. Did you mean: ${lines.join('. ')}? Say a number or channel name.`;

          this.stateMachine.transition({
            type: 'ENTER_CHANNEL_SELECTION',
            options,
            timeoutMs: 15_000,
          });

          await this.speakResponse(responseText, { inbox: true });
          return;
        }
      }
    }

    const target = match ? match.name : channelName;
    const result = await this.router.switchTo(target);

    let responseText: string;
    if (result.success) {
      await this.onChannelSwitch();

      // Check for queued responses — read them in full
      const readyItems = this.queueState?.getReadyItems().filter(
        (i) => i.channel === target,
      ) ?? [];

      if (readyItems.length > 0) {
        responseText = `Switched to ${result.displayName || target}.`;
        for (const item of readyItems) {
          responseText += ` ${item.responseText}`;
          this.queueState!.markHeard(item.id);
        }
        this.responsePoller?.check();
      } else {
        // No queued responses — check if there's a last message to offer
        const lastMsg = this.router.getLastMessage();
        if (lastMsg) {
          const displayName = result.displayName || target;
          responseText = `Switched to ${displayName}. Read, or prompt?`;

          // Store full last message for reading if user says "read"
          const fullContent = lastMsg.role === 'user'
            ? `You last said: ${lastMsg.content}`
            : lastMsg.content;

          this.stateMachine.transition({
            type: 'ENTER_SWITCH_CHOICE',
            lastMessage: fullContent,
            timeoutMs: 30_000,
          });

          // Update inbox snapshot now (don't wait for choice)
          if (this.inboxTracker?.isActive()) {
            const sessionKey = this.router.getActiveSessionKey();
            const currentCount = await this.getCurrentMessageCount(sessionKey);
            console.log(`InboxTracker: markSeen ${target} (${sessionKey}) count=${currentCount}`);
            this.inboxTracker.markSeen(sessionKey, currentCount);
          }

          await this.speakResponse(responseText, { inbox: true });
          this.player.playEarconSync('ready');
          return;
        } else {
          responseText = `Switched to ${result.displayName || target}.`;
        }
      }

      // Update inbox snapshot for this channel so it's marked as "seen"
      if (this.inboxTracker?.isActive()) {
        const sessionKey = this.router.getActiveSessionKey();
        const currentCount = await this.getCurrentMessageCount(sessionKey);
        console.log(`InboxTracker: markSeen ${target} (${sessionKey}) count=${currentCount}`);
        this.inboxTracker.markSeen(sessionKey, currentCount);
      }
    } else {
      responseText = `I couldn't find a channel called ${channelName}.`;
    }

    await this.speakResponse(responseText, { inbox: true });
  }

  private async matchChannelWithLLM(
    userPhrase: string,
    channels: { name: string; displayName: string }[],
  ): Promise<{ best: { name: string; displayName: string }; confident: boolean } | { options: { name: string; displayName: string }[] } | null> {
    try {
      const channelList = channels.map((c) => `${c.name}: ${c.displayName}`).join('\n');

      const result = await quickCompletion(
        `You are a channel matcher. Given a list of channels and a user description, rank the top matches.
Reply in this exact format:
- If one channel is a clear match: BEST: channel_name
- If 2-3 channels could match: OPTIONS: channel1, channel2, channel3
- If nothing matches: NONE
Use channel names (the part before the colon). Do not explain.`,
        `Channels:\n${channelList}\n\nUser wants: "${userPhrase}"`,
      );

      const cleaned = result.trim();
      console.log(`LLM channel match result: "${cleaned}"`);

      const findChannel = (query: string) =>
        channels.find((c) =>
          c.name.toLowerCase() === query ||
          c.displayName.toLowerCase() === query ||
          c.displayName.toLowerCase().startsWith(query) ||
          query.startsWith(c.displayName.toLowerCase()),
        );

      // Parse BEST: single confident match
      const bestMatch = cleaned.match(/^BEST:\s*(.+)$/i);
      if (bestMatch) {
        const name = bestMatch[1].trim().toLowerCase();
        const matched = findChannel(name);
        if (matched) {
          console.log(`LLM channel match: "${userPhrase}" → ${matched.name} (confident)`);
          return { best: matched, confident: true };
        }
      }

      // Parse OPTIONS: multiple candidates
      const optionsMatch = cleaned.match(/^OPTIONS:\s*(.+)$/i);
      if (optionsMatch) {
        const names = optionsMatch[1].split(',').map((n) => n.trim().toLowerCase());
        const resolved = names
          .map((n) => findChannel(n))
          .filter((c): c is { name: string; displayName: string; active: boolean } => c != null);
        if (resolved.length > 0) {
          console.log(`LLM channel match: "${userPhrase}" → ${resolved.length} options`);
          return { options: resolved };
        }
      }

      // Single name without prefix (backwards compat / fallback)
      const fallback = findChannel(cleaned.toLowerCase());
      if (fallback) {
        return { best: fallback, confident: true };
      }

      return null;
    } catch (err: any) {
      console.warn(`LLM channel match failed: ${err.message}`);
      return null;
    }
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

    // Enter selection mode via state machine
    this.stateMachine.transition({
      type: 'ENTER_CHANNEL_SELECTION',
      options,
      timeoutMs: 15_000,
    });

    await this.speakResponse(responseText);
    this.player.playEarconSync('ready');
  }

  private async handleChannelSelection(transcript: string): Promise<void> {
    const selState = this.stateMachine.getChannelSelectionState();
    if (!selState || !this.router) return;

    const { options } = selState;
    const selected = matchChannelSelection(transcript, options);

    if (!selected) {
      // Unrecognized — reprompt with error earcon
      const effects = this.stateMachine.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
      await this.applyEffects(effects);
      return;
    }

    // Recognized — clear the awaiting state
    this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
    this.player.playEarconSync('acknowledged');

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

  private async handleVoiceStatus(): Promise<void> {
    const parts: string[] = [];

    // Mode
    const mode = this.queueState?.getMode() ?? 'wait';
    const modeLabel = mode === 'queue' ? 'inbox' : mode;
    const gateLabel = getVoiceSettings().gated ? 'gated' : 'open';
    parts.push(`Mode: ${modeLabel}, ${gateLabel}.`);

    // Active channel
    if (this.router) {
      const active = this.router.getActiveChannel();
      const displayName = (active as any).displayName || active.name;
      parts.push(`Channel: ${displayName}.`);
    }

    // Queue items
    if (this.queueState) {
      const ready = this.queueState.getReadyItems().length;
      const pending = this.queueState.getPendingItems().length;
      if (ready > 0 || pending > 0) {
        const qParts: string[] = [];
        if (ready > 0) qParts.push(`${ready} ready`);
        if (pending > 0) qParts.push(`${pending} processing`);
        parts.push(`Queue: ${qParts.join(', ')}.`);
      }
    }

    // Voice settings
    const s = getVoiceSettings();
    const presetMap: Record<number, string> = { 300: 'low', 500: 'medium', 800: 'high' };
    const noiseLabel = presetMap[s.speechThreshold] ?? String(s.speechThreshold);
    parts.push(`Noise: ${noiseLabel}. Delay: ${s.silenceDurationMs} milliseconds.`);

    await this.speakResponse(parts.join(' '), { inbox: true });
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

    this.lastSpokenText = responseText;
    const ttsStream = await textToSpeechStream(responseText);
    this.player.stopWaitingLoop();
    this.player.stopPlayback();
    this.stateMachine.transition({ type: 'SPEAKING_STARTED' });
    await this.player.playStream(ttsStream);
    this.stateMachine.transition({ type: 'SPEAKING_COMPLETE' });
    this.gateGraceUntil = Date.now() + 5_000;
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

    this.dispatchToLLMFireAndForget(userId, transcript, item.id, sessionKey);

    // Brief confirmation with acknowledged earcon
    this.player.playEarconSync('acknowledged');
    await this.speakResponse(`Queued to ${displayName}.`, { inbox: true });
  }

  private async handleAskMode(userId: string, transcript: string): Promise<void> {
    // Speak the prompt, then await choice via state machine
    await this.speakResponse('Inbox, or wait?', { inbox: true });
    this.player.playEarconSync('ready');

    this.stateMachine.transition({
      type: 'ENTER_QUEUE_CHOICE',
      userId,
      transcript,
      timeoutMs: 20_000,
    });
  }

  private async handleQueueChoiceResponse(transcript: string): Promise<void> {
    const choiceState = this.stateMachine.getQueueChoiceState();
    if (!choiceState) return;

    const { userId, transcript: originalTranscript } = choiceState;

    const choice = matchQueueChoice(transcript);
    if (choice === 'queue') {
      this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
      await this.handleQueueMode(userId, originalTranscript);
      // Auto-check inbox after dispatch in ask mode
      if (this.inboxTracker?.isActive()) {
        await this.handleInboxCheck();
      }
    } else if (choice === 'silent') {
      this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
      this.silentWait = true;
      await this.handleSilentQueue(userId, originalTranscript);
    } else if (choice === 'wait') {
      this.player.playEarconSync('acknowledged');
      this.stateMachine.transition({ type: 'PROCESSING_STARTED' });
      this.player.startWaitingLoop();
      await this.handleWaitMode(userId, originalTranscript);
    } else {
      // Try navigation commands — with or without wake word
      // Queue the original prompt first, then navigate
      const navCommand = parseVoiceCommand(transcript, config.botName)
        ?? this.matchBareQueueCommand(transcript);
      if (navCommand && (navCommand.type === 'switch' || navCommand.type === 'list' || navCommand.type === 'default')) {
        console.log(`Queue choice: navigation (${navCommand.type}), queuing original prompt first`);
        this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
        await this.handleQueueMode(userId, originalTranscript);
        await this.handleVoiceCommand(navCommand);
      } else {
        // Unrecognized — reprompt with error earcon
        const effects = this.stateMachine.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
        await this.applyEffects(effects);
      }
    }
  }

  private async handleSilentQueue(userId: string, transcript: string): Promise<void> {
    if (!this.router || !this.queueState) {
      await this.handleWaitMode(userId, transcript);
      return;
    }

    const activeChannel = this.router.getActiveChannel();
    const channelName = activeChannel.name;
    const displayName = (activeChannel as any).displayName || channelName;
    const sessionKey = this.router.getActiveSessionKey();

    this.log(`**You:** ${transcript}`);
    this.session.appendUserMessage(userId, transcript, channelName);

    const item = this.queueState.enqueue({
      channel: channelName,
      displayName,
      sessionKey,
      userMessage: transcript,
    });

    this.dispatchToLLMFireAndForget(userId, transcript, item.id, sessionKey);

    // One confirmation tone, then silence
    console.log('Silent queue: dispatched, playing single tone');
    this.player.stopWaitingLoop();
    this.player.playEarconSync('acknowledged');
  }

  private async handleSwitchChoiceResponse(transcript: string): Promise<void> {
    const switchState = this.stateMachine.getSwitchChoiceState();
    if (!switchState) return;

    const { lastMessage } = switchState;

    const choice = matchSwitchChoice(transcript);
    if (choice === 'read') {
      this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
      // Read the full last message
      await this.speakResponse(lastMessage, { inbox: true });
    } else if (choice === 'prompt') {
      this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
      // Confirm with a ready earcon so user knows Watson is ready
      console.log('Switch choice: prompt');
      this.player.stopWaitingLoop();
      this.player.playEarconSync('ready');
    } else if (choice === 'cancel') {
      const effects = this.stateMachine.transition({ type: 'CANCEL_FLOW' });
      await this.applyEffects(effects);
      console.log('Switch choice: cancel');
      this.player.stopWaitingLoop();
    } else {
      // Unrecognized — reprompt with error earcon
      const effects = this.stateMachine.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
      await this.applyEffects(effects);
    }
  }

  private dispatchToLLMFireAndForget(userId: string, transcript: string, queueItemId: string, sessionKey: string): void {
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
        if (gatewaySync?.isConnected()) {
          await gatewaySync.inject(sessionKey, transcript, 'voice-user');
          await gatewaySync.inject(sessionKey, response, 'voice-assistant');

          // Update inbox snapshot so our own messages don't appear as "new"
          if (this.inboxTracker?.isActive()) {
            const count = await this.getCurrentMessageCount(sessionKey);
            this.inboxTracker.markSeen(sessionKey, count);
          }
        }

        pollerRef?.check();

        // Silent wait: auto-read the full response instead of a brief notification
        if (this.silentWait) {
          this.silentWait = false;
          queueRef.markHeard(queueItemId);
          pollerRef?.check();
          this.notifyIfIdle(response);
        } else {
          // Notify user if idle
          const displayName = (activeChannel as any).displayName || channelName;
          this.notifyIfIdle(`Response ready from ${displayName}.`);
        }
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
      // Clear inbox flow if active
      if (this.stateMachine.getInboxFlowState()) {
        this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
      }
    }

    const labels: Record<VoiceMode, string> = {
      wait: 'Wait mode. I will wait for each response before you can speak again.',
      queue: 'Inbox mode. Your messages will be dispatched and you can keep talking.',
      ask: 'Ask mode. I will ask you whether to inbox or wait for each message.',
    };
    await this.speakResponse(labels[mode], { inbox: true });
  }

  private async handleGatedMode(enabled: boolean): Promise<void> {
    setGatedMode(enabled);
    const message = enabled
      ? "Gated mode. I'll only respond when you say Watson."
      : "Open mode. I'll respond to everything.";
    await this.speakResponse(message, { inbox: true });
  }

  private handlePause(): void {
    console.log('Pause command: stopping playback');
    this.player.stopPlayback();
  }

  private async handleReplay(): Promise<void> {
    if (!this.lastSpokenText) {
      await this.speakResponse("I haven't said anything yet.");
      return;
    }
    console.log(`Replay: "${this.lastSpokenText.slice(0, 60)}..."`);
    await this.speakResponse(this.lastSpokenText, { isReplay: true });
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
          await this.speakResponse(`Nothing new yet. ${pending.length} still processing.`, { inbox: true });
        } else {
          await this.speakResponse('Nothing new.', { inbox: true });
        }
        return;
      }

      // Store as inbox flow for "next" traversal via state machine
      this.stateMachine.transition({
        type: 'ENTER_INBOX_FLOW',
        items: activities,
      });

      const channelNames = activities.map((a) => a.displayName);
      const pending = this.queueState.getPendingItems();
      const pendingSuffix = pending.length > 0 ? ` ${pending.length} still processing.` : '';

      await this.speakResponse(
        `New activity in ${channelNames.join(', ')}.${pendingSuffix} Say next, done, or go to a channel.`,
        { inbox: true },
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

    await this.speakResponse(`You have ${parts.join(', and ')}.`, { inbox: true });
  }

  private async handleInboxNext(): Promise<void> {
    if (!this.queueState) {
      await this.speakResponse('Queue mode is not available.');
      return;
    }

    // If we have an inbox flow from a prior check, use it
    let activity: ChannelActivity | null = null;
    const flowState = this.stateMachine.getInboxFlowState();

    if (flowState && flowState.index < flowState.items.length) {
      activity = flowState.items[flowState.index] as ChannelActivity;
      this.stateMachine.transition({ type: 'INBOX_ADVANCE' });
    } else if (this.inboxTracker?.isActive() && this.router) {
      // Mark current channel as seen BEFORE fresh check so it doesn't re-appear
      const currentSessionKey = this.router.getActiveSessionKey();
      const currentCount = await this.getCurrentMessageCount(currentSessionKey);
      this.inboxTracker.markSeen(currentSessionKey, currentCount);

      // Fresh check if flow is exhausted or not started
      const channels = this.router.getAllChannelSessionKeys();
      const activities = await this.inboxTracker.checkInbox(channels);
      if (activities.length > 0) {
        this.stateMachine.transition({
          type: 'ENTER_INBOX_FLOW',
          items: activities,
        });
        this.stateMachine.transition({ type: 'INBOX_ADVANCE' });
        activity = activities[0];
      }
    }

    if (activity) {
      const parts = await this.readInboxItem(activity);

      // Report remaining
      const updatedFlow = this.stateMachine.getInboxFlowState();
      const remaining = updatedFlow
        ? updatedFlow.items.length - updatedFlow.index
        : 0;

      if (remaining > 0) {
        parts.push(`${remaining} more. Say next or done.`);
      } else {
        this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
        parts.push(await this.switchHomeWithMessage("That's everything."));
      }

      const fullText = parts.join(' ');
      this.lastSpokenText = fullText;
      const ttsStream = await textToSpeechStream(fullText);
      this.player.stopWaitingLoop();
      this.player.stopPlayback();
      await this.player.playStream(ttsStream);
      this.gateGraceUntil = Date.now() + 5_000;
      return;
    }

    // Fallback: try old-style queue next (single item)
    const item = this.queueState.getNextReady();
    if (!item) {
      const pending = this.queueState.getPendingItems();
      if (pending.length > 0) {
        await this.speakResponse(`Nothing ready yet. ${pending.length} still waiting.`, { inbox: true });
      } else {
        await this.speakResponse(await this.switchHomeWithMessage("Nothing new in the inbox."), { inbox: true });
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

    const fullText = prefix + item.responseText + suffix;
    this.lastSpokenText = fullText;
    const ttsStream = await textToSpeechStream(fullText);
    this.player.stopWaitingLoop();
    this.player.stopPlayback();
    await this.player.playStream(ttsStream);
    this.gateGraceUntil = Date.now() + 5_000;
  }

  private async switchHomeWithMessage(prefix: string): Promise<string> {
    if (this.router) {
      const result = await this.router.switchToDefault();
      if (result.success) {
        await this.onChannelSwitch();
        return `${prefix} Switching to ${result.displayName || 'General'}.`;
      }
    }
    return prefix;
  }

  private async readInboxItem(activity: ChannelActivity): Promise<string[]> {
    const parts: string[] = [];

    // Switch to the channel
    if (this.router) {
      const result = await this.router.switchTo(activity.channelName);
      if (result.success) {
        await this.onChannelSwitch();
      }
    }

    // Check for queued responses — read in full if present
    const readyItems = this.queueState?.getReadyItems().filter(
      (i) => i.sessionKey === activity.sessionKey,
    ) ?? [];

    if (readyItems.length > 0) {
      parts.push(`Switched to ${activity.displayName}.`);
      for (const item of readyItems) {
        parts.push(item.responseText);
        this.queueState!.markHeard(item.id);
      }
      this.responsePoller?.check();
    } else {
      // No queued responses — brief context from last message
      parts.push(this.buildSwitchConfirmation(activity.displayName));
    }

    // Mark this channel as seen
    if (this.inboxTracker) {
      const currentCount = await this.getCurrentMessageCount(activity.sessionKey);
      console.log(`InboxTracker: markSeen ${activity.channelName} (${activity.sessionKey}) count=${currentCount}`);
      this.inboxTracker.markSeen(activity.sessionKey, currentCount);
    }

    return parts;
  }

  private async getCurrentMessageCount(sessionKey: string): Promise<number> {
    if (!this.gatewaySync?.isConnected()) return 0;
    const result = await this.gatewaySync.getHistory(sessionKey, 40);
    return result?.messages?.length ?? 0;
  }

  private matchBareQueueCommand(transcript: string): VoiceCommand | null {
    const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');

    // "next", "next one", "next response", "next message", "next channel", "done", "I'm done", "move on", "skip"
    if (/^(?:next(?:\s+(?:response|one|message|channel))?|(?:i'?m\s+)?done|i\s+am\s+done|move\s+on|skip(?:\s+(?:this(?:\s+(?:one|message))?|it))?)$/.test(input)) {
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

    // "inbox list", "inbox", "what do I have", "check inbox", "what's new", etc.
    if (/^(?:inbox(?:\s+list)?|what\s+do\s+(?:i|you)\s+have(?:\s+for\s+me)?|check\s+(?:the\s+)?(?:queue|inbox)|what'?s\s+(?:waiting|ready|new)|queue\s+status)$/.test(input)) {
      return { type: 'inbox-check' };
    }

    return null;
  }

  private buildSwitchConfirmation(displayName: string): string {
    const lastMsg = this.router?.getLastMessage();
    let text = `Switched to ${displayName}.`;
    if (lastMsg) {
      // Truncate long messages for TTS
      const content = lastMsg.content.length > 200
        ? lastMsg.content.slice(0, 200) + '...'
        : lastMsg.content;
      if (lastMsg.role === 'user') {
        text += ` You last said: ${content}`;
      } else {
        text += ` ${content}`;
      }
    }
    return text;
  }

  private async speakResponse(text: string, options?: { inbox?: boolean; isReplay?: boolean }): Promise<void> {
    if (options?.inbox) {
      this.logToInbox(`**${config.botName}:** ${text}`);
    } else {
      this.log(`**${config.botName}:** ${text}`);
    }
    if (!options?.isReplay) {
      this.lastSpokenText = text;
    }
    const ttsStream = await textToSpeechStream(text);
    this.player.stopWaitingLoop();
    this.player.stopPlayback();
    await this.player.playStream(ttsStream);
    this.gateGraceUntil = Date.now() + 5_000;
  }

  private logToInbox(message: string): void {
    if (!this.inboxLogChannel) return;
    this.sendChunked(this.inboxLogChannel, message).catch((err) => {
      console.error('Failed to log to inbox channel:', err.message);
    });
  }

  notifyIfIdle(message: string): void {
    if (this.silentWait) {
      console.log(`Idle notify skipped (silent wait): "${message.slice(0, 60)}..."`);
      return;
    }
    if (this.isProcessing() || this.player.isPlaying()) {
      console.log(`Idle notify skipped (busy): "${message}"`);
      return;
    }

    console.log(`Idle notify: "${message}"`);
    this.logToInbox(`**${config.botName}:** ${message}`);

    textToSpeechStream(message)
      .then((stream) => {
        // Re-check idle — user may have started speaking while TTS was generating
        if (!this.isProcessing() && !this.player.isPlaying()) {
          this.player.playStream(stream).then(() => {
            this.gateGraceUntil = Date.now() + 5_000;
          });
        }
      })
      .catch((err) => {
        console.warn(`Idle notify TTS failed: ${err.message}`);
      });
  }

  private async syncToOpenClaw(userText: string, assistantText: string): Promise<void> {
    if (!this.gatewaySync?.isConnected() || !this.router) return;

    try {
      const sessionKey = this.router.getActiveSessionKey();
      await this.gatewaySync.inject(sessionKey, userText, 'voice-user');
      await this.gatewaySync.inject(sessionKey, assistantText, 'voice-assistant');

      // Update inbox snapshot so our own messages don't appear as "new"
      if (this.inboxTracker?.isActive()) {
        const count = await this.getCurrentMessageCount(sessionKey);
        this.inboxTracker.markSeen(sessionKey, count);
      }
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
