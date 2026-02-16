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
import { initEarcons, type EarconName } from '../audio/earcons.js';
import type { ChannelRouter } from '../services/channel-router.js';
import type { GatewaySync } from '../services/gateway-sync.js';
import type { QueueState } from '../services/queue-state.js';
import type { ResponsePoller } from '../services/response-poller.js';
import type { VoiceMode } from '../services/queue-state.js';
import type { InboxTracker, ChannelActivity } from '../services/inbox-tracker.js';

export class VoicePipeline {
  private static readonly READY_GRACE_MS = 5_000;
  // Absorb Discord/VAD timing jitter at the ready->speak handoff.
  private static readonly READY_HANDOFF_TOLERANCE_MS = 600;
  // Rejected-audio reprompts are useful for brief misses, but noisy long chunks
  // create chaotic beep loops in guided flows.
  private static readonly MAX_REJECTED_REPROMPT_MS = 2200;
  private static readonly PROCESSING_LOOP_START_DELAY_MS = 350;
  private static readonly FAST_CUE_COALESCE_MS = 220;
  private static readonly COMMAND_CLASSIFIER_MAX_CHARS = 420;
  private static readonly NEW_POST_TIMEOUT_PROMPT_GUARD_MS = 8_000;

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
  private lastSpokenFullText: string = '';
  private lastSpokenWasSummary = false;
  private lastPlaybackText: string = '';
  private lastPlaybackCompletedAt = 0;
  private silentWait = false;
  private gateGraceUntil = 0;
  private promptGraceUntil = 0;
  private rejectRepromptInFlight = false;
  private rejectRepromptCooldownUntil = 0;
  private ignoreProcessingUtterancesUntil = 0;
  private waitingLoopTimer: NodeJS.Timeout | null = null;
  private fastCueTimer: NodeJS.Timeout | null = null;
  private pendingFastCue: EarconName | null = null;
  private pendingFastCueResolvers: Array<() => void> = [];
  private pendingWaitCallback: ((responseText: string) => void) | null = null;
  private activeWaitQueueItemId: string | null = null;
  private speculativeQueueItemId: string | null = null;
  private graceExpiryTimer: NodeJS.Timeout | null = null;
  private quietPendingWait = false;
  private deferredWaitResponseText: string | null = null;
  private deferredWaitRetryTimer: NodeJS.Timeout | null = null;
  private failedWakeCueCooldownUntil = 0;
  private missedWakeAnalysisInFlight = false;
  private deferredIdleNotifyTimers = new Map<string, NodeJS.Timeout>();
  private idleNotifyInFlight = false;
  private dependencyAlertCooldownUntil: Record<'stt' | 'tts', number> = {
    stt: 0,
    tts: 0,
  };
  private newPostTimeoutPromptGuardUntil = 0;

  private stamp(): string {
    return new Date().toISOString();
  }

  private shouldCueFailedWake(transcript: string): boolean {
    const input = transcript.trim().toLowerCase();
    if (!input) return false;
    // Explicit near-wake attempts (common STT confusion: "weak test/check")
    // should always get feedback in gated mode.
    if (/\b(?:wake|weak)\s+(?:check|test)\b/i.test(input)) return true;
    // Near-miss wake guard: mentions bot name + likely command words,
    // but does not pass strict wake-at-start matching.
    if (!/\bwatson\b/i.test(input)) return false;
    if (matchesWakeWord(transcript, config.botName)) return false;
    const words = input.split(/\s+/).filter(Boolean);
    if (words.length <= 3) return true;
    return /\b(?:hello|hey|inbox|switch|go|list|status|read|dispatch|next|done)\b/i.test(input);
  }

  private looksLikeBareCommandAttempt(transcript: string): boolean {
    const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/g, '');
    if (!input) return false;
    if (matchesWakeWord(transcript, config.botName)) return false;
    const words = input.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 20) return false;
    if (/^(?:switch|go|change|move)\s+to\s+.+$/.test(input)) return true;
    if (/\b(?:switch|go|change|move)\s+to\s+[a-z0-9#:_-]{2,}/.test(input)) return true;
    return /^(?:inbox(?:\s+list)?|next|done|skip|clear\s+(?:the\s+)?inbox|read\s+(?:the\s+)?last\s+message|last\s+message|voice\s+status|status)$/.test(input) ||
      /\b(?:inbox|next|done|skip|read\s+(?:the\s+)?last\s+message|last\s+message|voice\s+status)\b/.test(input);
  }

  private seemsCommandLikeForMissedWakeLLM(transcript: string): boolean {
    const input = transcript.trim().toLowerCase();
    if (!input) return false;
    const words = input.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 18) return false;
    return /\b(?:switch|go to|change to|move to|inbox|mode|read|last message|next|skip|clear|dispatch|status|replay|repeat|pause|silent)\b/.test(input);
  }

  private async maybeCueMissedWakeFromLLM(transcript: string, mode: VoiceMode, inGracePeriod: boolean): Promise<void> {
    if (this.missedWakeAnalysisInFlight) return;
    if (!this.seemsCommandLikeForMissedWakeLLM(transcript)) return;
    this.missedWakeAnalysisInFlight = true;
    try {
      const inferred = await this.inferVoiceCommandLLM(transcript, mode, inGracePeriod);
      if (!inferred) return;
      const now = Date.now();
      if (now < this.failedWakeCueCooldownUntil) return;
      this.failedWakeCueCooldownUntil = now + 1500;
      console.log(`Missed wake inferred by LLM (intent=${inferred.type}) — emitting error earcon`);
      void this.playFastCue('error');
    } finally {
      this.missedWakeAnalysisInFlight = false;
    }
  }

  private cueFailedWakeIfNeeded(transcript: string): void {
    if (!this.shouldCueFailedWake(transcript)) return;
    const now = Date.now();
    if (now < this.failedWakeCueCooldownUntil) return;
    this.failedWakeCueCooldownUntil = now + 1500;
    console.log('Failed-wake guard: emitting error earcon');
    void this.playFastCue('error');
  }

  private getReadyItemsForSession(sessionKey: string, channelName?: string) {
    return this.queueState?.getReadyItems().filter(
      (item) => item.sessionKey === sessionKey || (!!channelName && item.channel === channelName),
    ) ?? [];
  }

  private isNonLexicalTranscript(transcript: string): boolean {
    const text = transcript.trim();
    if (!text) return true;

    // Whisper markers like "[BLANK_AUDIO]" / "[SOUND]" should never route into
    // command parsing or prompt dispatch.
    if (/^(?:\s*\[[a-z0-9_ -]+\]\s*)+$/i.test(text)) return true;

    // If there's no alphabetic signal at all, treat as non-lexical noise.
    return !/[a-z]/i.test(text);
  }

  private normalizeForEcho(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isLikelyPlaybackEcho(transcript: string): boolean {
    if (matchesWakeWord(transcript, config.botName)) return false;
    if (!this.lastPlaybackText || !this.lastPlaybackCompletedAt) return false;
    if (Date.now() - this.lastPlaybackCompletedAt > 15_000) return false;

    const spoken = this.normalizeForEcho(this.lastPlaybackText);
    const heard = this.normalizeForEcho(transcript);
    if (!spoken || !heard) return false;
    if (heard.length < 8) return false;
    if (heard.split(' ').length < 2) return false;

    return spoken.includes(heard);
  }

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
      (userId, durationMs) => this.handleRejectedAudio(userId, durationMs),
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
    this.clearFastCueQueue();
    this.clearGraceTimer();
    this.clearDeferredWaitRetry();
    this.player.stopPlayback('pipeline-stop');
    this.pendingWaitCallback = null;
    this.activeWaitQueueItemId = null;
    this.speculativeQueueItemId = null;
    for (const timer of this.deferredIdleNotifyTimers.values()) {
      clearTimeout(timer);
    }
    this.deferredIdleNotifyTimers.clear();
    this.idleNotifyInFlight = false;
    this.stateMachine.destroy();
    console.log('Voice pipeline stopped');
  }

  isPlaying(): boolean {
    return this.player.isPlaying();
  }

  interrupt(): void {
    if (this.player.isPlaying()) {
      console.log('Interrupting playback');
      this.player.stopPlayback('external-interrupt');
    }
  }

  /**
   * Whether Watson is actively doing work (STT, LLM, TTS).
   * AWAITING states are NOT "processing" — Watson is waiting for user input.
   */
  private isProcessing(): boolean {
    const st = this.stateMachine.getStateType();
    return st === 'PROCESSING' || st === 'TRANSCRIBING' || st === 'SPEAKING';
  }

  /**
   * Whether Watson is busy in any non-IDLE state.
   * Used by notifyIfIdle to prevent notifications during AWAITING prompts.
   */
  private isBusy(): boolean {
    return this.stateMachine.getStateType() !== 'IDLE';
  }

  /**
   * Apply a list of transition effects produced by the state machine.
   */
  private async applyEffects(effects: TransitionEffect[]): Promise<void> {
    // When guided new-post flow times out, prevent immediate follow-on dictation
    // from being treated as a normal channel prompt.
    const newPostTimedOut = effects.some(
      (effect) =>
        effect.type === 'speak' &&
        effect.text.toLowerCase().includes('new post flow timed out'),
    );
    if (newPostTimedOut) {
      this.newPostTimeoutPromptGuardUntil = Date.now() + VoicePipeline.NEW_POST_TIMEOUT_PROMPT_GUARD_MS;
      console.log(
        `New-post timeout guard enabled for ${VoicePipeline.NEW_POST_TIMEOUT_PROMPT_GUARD_MS}ms`,
      );
    }

    for (const effect of effects) {
      switch (effect.type) {
        case 'earcon':
          await this.player.playEarcon(effect.name);
          break;
        case 'speak':
          await this.speakResponse(effect.text);
          break;
        case 'stop-playback':
          this.player.stopPlayback('state-machine-effect');
          break;
        case 'start-waiting-loop':
          this.startWaitingLoop();
          break;
        case 'stop-waiting-loop':
          this.stopWaitingLoop();
          break;
      }
    }
  }

  private async handleUtterance(userId: string, wavBuffer: Buffer, durationMs: number): Promise<void> {
    // Clear stale speculative queue item (safety net for timeout edge case)
    if (this.speculativeQueueItemId && !this.stateMachine.getQueueChoiceState()) {
      this.speculativeQueueItemId = null;
    }

    const stateAtStart = this.stateMachine.getStateType();
    const isSpeakingAtStart = stateAtStart === 'SPEAKING';
    const gatedMode = getVoiceSettings().gated;
    const nowAtCapture = Date.now();
    const utteranceStartEstimate = nowAtCapture - Math.max(0, durationMs);
    const graceFromGateAtCapture =
      nowAtCapture < this.gateGraceUntil ||
      utteranceStartEstimate < (this.gateGraceUntil + VoicePipeline.READY_HANDOFF_TOLERANCE_MS);
    const graceFromPromptAtCapture =
      nowAtCapture < this.promptGraceUntil ||
      utteranceStartEstimate < (this.promptGraceUntil + VoicePipeline.READY_HANDOFF_TOLERANCE_MS);

    // Interrupt TTS playback if user speaks — but don't kill the waiting tone
    const wasPlayingResponse = this.player.isPlaying() && !this.player.isWaiting();

    // Open mode: interrupt immediately. Gated mode: defer until after transcription.
    if (wasPlayingResponse && !gatedMode) {
      console.log('User spoke during playback — interrupting');
      this.player.stopPlayback('speech-during-playback-open-mode');
    }

    const gatedInterrupt = wasPlayingResponse && gatedMode;
    const gatedSpeakingProbe = gatedInterrupt && isSpeakingAtStart;
    const gateClosedCueInterrupt = gatedInterrupt && this.player.isPlayingEarcon('gate-closed');
    let keepCurrentState = false;
    let playedListeningEarly = false;

    // Check if busy — buffer utterance instead of silently dropping
    if (this.isProcessing() && !gatedSpeakingProbe) {
      if (Date.now() < this.ignoreProcessingUtterancesUntil) {
        console.log('Ignoring utterance during short post-choice debounce window');
        return;
      }
      console.log('Already processing — buffering utterance');
      const effects = this.stateMachine.transition({ type: 'UTTERANCE_RECEIVED' });
      this.stateMachine.bufferUtterance(userId, wavBuffer, durationMs);
      await this.applyEffects(effects);
      return;
    }

    // Transition to TRANSCRIBING
    if (!gatedSpeakingProbe) {
      this.stateMachine.transition({ type: 'UTTERANCE_RECEIVED' });
    }

    // For AWAITING states, play listening earcon immediately — no wake word needed,
    // so we know this is a valid interaction before STT even runs
    const stateType = this.stateMachine.getStateType();
    if (this.stateMachine.isAwaitingState()) {
      // Play immediately here (no fast-cue coalescing) so it can't fire late and
      // preempt a near-immediate spoken command response.
      void this.player.playEarcon('listening');
      playedListeningEarly = true;
    } else if (gatedMode && (graceFromGateAtCapture || graceFromPromptAtCapture)) {
      // In grace, speech should feel accepted immediately even for non-awaiting turns.
      // Play immediately here (no fast-cue coalescing) so it can't fire late and
      // preempt a near-immediate spoken command response.
      void this.player.playEarcon('listening');
      playedListeningEarly = true;
    }

    const pipelineStart = Date.now();

    try {
      // Start waiting indicator sound
      // Skip for: gated mode (deferred until wake word), AWAITING states (no processing needed),
      // and inbox/ask capture where a queue acknowledgement is expected instead of "processing".
      const isAwaiting = this.stateMachine.isAwaitingState() || this.stateMachine.getStateType() === 'INBOX_FLOW';
      const modeAtCapture = this.queueState?.getMode() ?? 'wait';
      if (!gatedMode && !isAwaiting && modeAtCapture === 'wait') {
        this.startWaitingLoop();
      }

      // Step 1: Speech-to-text
      let transcript = await transcribe(wavBuffer);
      if (!transcript || transcript.trim().length === 0) {
        console.log('Empty transcript, skipping');
        this.stopWaitingLoop();
        if (this.stateMachine.isAwaitingState()) {
          await this.playReadyEarcon();
          return;
        }
        if (gatedSpeakingProbe) {
          keepCurrentState = true;
          return;
        }
        this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
        return;
      }

      if (this.isNonLexicalTranscript(transcript)) {
        console.log(`Non-lexical transcript ignored: "${transcript}"`);
        this.stopWaitingLoop();
        if (this.stateMachine.isAwaitingState()) {
          await this.playReadyEarcon();
        } else if (gatedSpeakingProbe) {
          keepCurrentState = true;
        } else {
          this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
        }
        return;
      }

      if (this.isLikelyPlaybackEcho(transcript)) {
        console.log(`Playback echo suppressed: "${transcript}"`);
        this.stopWaitingLoop();
        if (this.stateMachine.isAwaitingState()) {
          await this.playReadyEarcon();
        } else if (gatedSpeakingProbe) {
          keepCurrentState = true;
        } else {
          this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
        }
        return;
      }

      this.stateMachine.transition({ type: 'TRANSCRIPT_READY', transcript });

      // Step 1.5: Check for awaiting responses (bypass LLM)
      // These are valid interactions that don't need a wake word
      if (this.stateMachine.getStateType() === 'AWAITING_CHANNEL_SELECTION' ||
          this.stateMachine.getChannelSelectionState()) {
        console.log(`Channel selection input: "${transcript}"`);
        await this.handleChannelSelection(transcript);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command (selection) complete: ${totalMs}ms total`);
        return;
      }

      if (this.stateMachine.getQueueChoiceState()) {
        console.log(`Queue choice input: "${transcript}"`);
        await this.handleQueueChoiceResponse(transcript);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command (queue choice) complete: ${totalMs}ms total`);
        return;
      }

      if (this.stateMachine.getSwitchChoiceState()) {
        console.log(`Switch choice input: "${transcript}"`);
        await this.handleSwitchChoiceResponse(transcript);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command (switch choice) complete: ${totalMs}ms total`);
        return;
      }

      if (this.stateMachine.getNewPostFlowState()) {
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
      // While a wait callback is pending, require wake word in gated mode.
      // Grace windows are intended for explicit "your turn" handoffs, not
      // background processing where accidental noises can cause interruptions.
      const mode = this.queueState?.getMode() ?? 'wait';
      const allowGraceBypass = this.pendingWaitCallback === null;
      const hasWakeWord = matchesWakeWord(transcript, config.botName);
      const inGracePeriod = (
        allowGraceBypass &&
        (
          graceFromGateAtCapture ||
          graceFromPromptAtCapture ||
          Date.now() < (this.gateGraceUntil + VoicePipeline.READY_HANDOFF_TOLERANCE_MS) ||
          Date.now() < (this.promptGraceUntil + VoicePipeline.READY_HANDOFF_TOLERANCE_MS)
        )
      );
      const interruptGraceEligible = allowGraceBypass && (graceFromGateAtCapture || graceFromPromptAtCapture);

      // By design in gated mode, interrupting active playback must include wake word.
      if (gatedInterrupt && !hasWakeWord && !gateClosedCueInterrupt && !interruptGraceEligible) {
        console.log(`Gated interrupt rejected (wake word required): "${transcript}"`);
        if (gatedSpeakingProbe) {
          keepCurrentState = true;
        } else {
          this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
        }
        return;
      }
      if (gatedMode && !inGracePeriod && !hasWakeWord) {
        if (gatedInterrupt) {
          console.log(`Gated: discarded interrupt "${transcript}"`);
          // Don't stop playback — Watson keeps talking
          if (gatedSpeakingProbe) {
            keepCurrentState = true;
          } else {
            this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
          }
          this.cueFailedWakeIfNeeded(transcript);
        } else if (this.pendingWaitCallback) {
          console.log(`Gated: discarded "${transcript}" (wait processing continues)`);
          this.cueFailedWakeIfNeeded(transcript);
          void this.maybeCueMissedWakeFromLLM(transcript, mode, inGracePeriod);
          // Don't stop waiting loop — pending wait callback is active
          this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
        } else {
          console.log(`Gated: discarded "${transcript}"`);
          if (this.looksLikeBareCommandAttempt(transcript)) {
            const now = Date.now();
            if (now >= this.failedWakeCueCooldownUntil) {
              this.failedWakeCueCooldownUntil = now + 1500;
              console.log('Failed command attempt without wake word: emitting error earcon');
              void this.playFastCue('error');
            }
          } else {
            this.cueFailedWakeIfNeeded(transcript);
            void this.maybeCueMissedWakeFromLLM(transcript, mode, inGracePeriod);
          }
          this.stopWaitingLoop();
          this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
        }
        return;
      }

      const preParsedCommand = parseVoiceCommand(transcript, config.botName);
      const suppressListeningCue = preParsedCommand?.type === 'wake-check';

      // Valid interaction confirmed — play listening earcon and wait for it to finish
      this.clearGraceTimer();
      if (!playedListeningEarly && !suppressListeningCue) {
        await this.playFastCue('listening');
      }
      if (graceFromPromptAtCapture || Date.now() < this.promptGraceUntil) {
        this.promptGraceUntil = 0;
      }

      // Gated mode: passed gate check — start waiting loop now
      // Skip in ask mode — no LLM processing, Watson just speaks "Inbox, or wait?"
      if (gatedMode) {
        if (inGracePeriod && !hasWakeWord) {
          console.log('Gate grace period: processing without wake word');
        }
        if (gatedInterrupt) {
          if (gateClosedCueInterrupt && !hasWakeWord) {
            console.log('Gated interrupt: allowing speech over gate-closed cue');
            this.player.stopPlayback('speech-over-gate-closed-cue');
          } else if (!hasWakeWord && interruptGraceEligible) {
            console.log('Gated interrupt: accepted during ready handoff grace');
            this.player.stopPlayback('speech-during-playback-gated-grace');
          } else {
            console.log('Gated interrupt: wake word confirmed, interrupting playback');
            this.player.stopPlayback('speech-during-playback-gated-wake');
          }
          this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
        }
      }

      const command = preParsedCommand;
      if (command) {
        const resolvedCommand = this.resolveDoneCommandForContext(command, transcript);
        if (command.type === 'new-post') {
          console.log('New-post command: starting guided flow');
          await this.startNewPostFlow();
          const totalMs = Date.now() - pipelineStart;
          console.log(`Voice command complete: ${totalMs}ms total`);
          return;
        } else {
          console.log(`Voice command detected: ${resolvedCommand.type}`);
          await this.handleVoiceCommand(resolvedCommand, userId);
          const totalMs = Date.now() - pipelineStart;
          console.log(`Voice command complete: ${totalMs}ms total`);
          return;
        }
      }

      // In queue/ask mode, or during grace windows, match bare navigation commands
      // without requiring the wake word.
      if (mode !== 'wait' || inGracePeriod) {
        const bareCommand = this.matchBareQueueCommand(transcript);
        if (bareCommand) {
          const resolvedBareCommand = this.resolveDoneCommandForContext(bareCommand, transcript);
          console.log(`Bare queue command detected: ${resolvedBareCommand.type}`);
          await this.handleVoiceCommand(resolvedBareCommand, userId);
          const totalMs = Date.now() - pipelineStart;
          console.log(`Voice command complete: ${totalMs}ms total`);
          return;
        }
      }

      // Fallback command classifier (LLM): catches STT variations that regex misses.
      // During gated playback interrupts without wake word, avoid LLM command
      // inference to reduce false positives from cough/noise transcripts.
      const allowLlmInference = !(gatedInterrupt && !hasWakeWord);
      const inferredCommand = allowLlmInference
        ? await this.inferVoiceCommandLLM(transcript, mode, inGracePeriod)
        : null;
      if (inferredCommand) {
        const resolvedInferred = this.resolveDoneCommandForContext(inferredCommand, transcript);
        console.log(`Voice command detected (LLM): ${resolvedInferred.type}`);
        await this.handleVoiceCommand(resolvedInferred, userId);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command complete: ${totalMs}ms total`);
        return;
      }

      // Safety guard: in queue mode, avoid silently dispatching free-form prompts
      // from open-mic chatter during grace windows. Commands still work via
      // deterministic/LLM command paths above; prompts require explicit wake.
      if (mode === 'queue' && inGracePeriod && !hasWakeWord) {
        console.log(`Queue prompt suppressed (wake required): "${transcript}"`);
        this.stopWaitingLoop();
        this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
        return;
      }

      if (Date.now() < this.newPostTimeoutPromptGuardUntil) {
        const remainingMs = this.newPostTimeoutPromptGuardUntil - Date.now();
        console.log(
          `Prompt dispatch suppressed by new-post timeout guard (${Math.max(0, remainingMs)}ms remaining)`,
        );
        await this.player.playEarcon('error');
        await this.speakResponse(
          'Post creation timed out. I did not send that message. Say create post to try again.',
          { inbox: true },
        );
        await this.playReadyEarcon();
        return;
      }

      this.cancelPendingWait('new prompt dispatch');

      this.stateMachine.transition({ type: 'PROCESSING_STARTED' });
      if (mode === 'wait') {
        this.startWaitingLoop(VoicePipeline.PROCESSING_LOOP_START_DELAY_MS);
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
      const dependencyIssue = this.classifyDependencyIssue(error);
      if (dependencyIssue) {
        this.notifyDependencyIssue(dependencyIssue.type, dependencyIssue.message);
      } else {
        void this.playFastCue('error');
      }
      this.stopWaitingLoop();
      this.player.stopPlayback('pipeline-error');
    } finally {
      // Don't overwrite AWAITING/flow states — they were set intentionally by handlers
      const st = this.stateMachine.getStateType();
      if (!keepCurrentState && !this.stateMachine.isAwaitingState() && st !== 'INBOX_FLOW') {
        this.stateMachine.transition({ type: 'PROCESSING_COMPLETE' });
      }

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

  private handleRejectedAudio(userId: string, durationMs: number): void {
    if (!this.stateMachine.isAwaitingState()) return;
    const st = this.stateMachine.getStateType();
    // Avoid noisy reprompt loops in command-selection states.
    // Keep this only for guided new-post flow where users benefit from correction.
    if (st !== 'NEW_POST_FLOW') return;
    if (this.player.isPlaying() || this.isProcessing()) {
      console.log(`Rejected audio ignored during active playback/processing from ${userId} (${durationMs}ms)`);
      return;
    }
    if (durationMs > VoicePipeline.MAX_REJECTED_REPROMPT_MS) {
      console.log(`Rejected audio ignored (too long for reprompt) from ${userId} (${durationMs}ms)`);
      return;
    }
    if (this.rejectRepromptInFlight) return;
    if (Date.now() < this.rejectRepromptCooldownUntil) return;

    this.rejectRepromptInFlight = true;
    this.rejectRepromptCooldownUntil = Date.now() + 5000;
    console.log(`Rejected low-confidence audio during ${st} from ${userId} (${durationMs}ms)`);

    void (async () => {
      try {
        const effects = this.stateMachine.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
        await this.applyEffects(effects);
        await this.playReadyEarcon();
      } finally {
        this.rejectRepromptInFlight = false;
      }
    })();
  }

  private async handleVoiceCommand(command: VoiceCommand, userId = 'voice-user'): Promise<void> {
    // Any explicit command means user intent is clear; clear transient post-timeout guard.
    this.newPostTimeoutPromptGuardUntil = 0;
    if (command.type !== 'silent-wait') {
      this.cancelPendingWait(`voice command: ${command.type}`);
    }
    if (command.type === 'switch' || command.type === 'list' || command.type === 'default' || command.type === 'dispatch') {
      this.clearInboxFlowIfActive(`voice command: ${command.type}`);
    }
    switch (command.type) {
      case 'switch':
        await this.handleDirectSwitch(command.channel);
        break;
      case 'dispatch':
        await this.handleDispatch(command.body, userId);
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
      case 'inbox-clear':
        await this.handleInboxClear();
        break;
      case 'read-last-message':
        await this.handleReadLastMessage();
        break;
      case 'what-channel':
        await this.handleWhatChannel();
        break;
      case 'voice-status':
        await this.handleVoiceStatus();
        break;
      case 'voice-channel':
        await this.handleVoiceChannel();
        break;
      case 'gated-mode':
        await this.handleGatedMode(command.enabled);
        break;
      case 'wake-check':
        await this.handleWakeCheck();
        break;
      case 'silent-wait':
        await this.handleSilentWait();
        break;
      case 'hear-full-message':
        await this.handleHearFullMessage();
        break;
      case 'pause':
        this.handlePause();
        break;
      case 'replay':
        await this.handleReplay();
        break;
      case 'earcon-tour':
        await this.handleEarconTour();
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
    });

    await this.speakResponse(`Which forum? Available: ${names}.`);
    await this.playReadyEarcon();
  }

  private async handleNewPostStep(transcript: string): Promise<string | null> {
    const flowState = this.stateMachine.getNewPostFlowState();
    if (!flowState || !this.router) return null;

    const { step } = flowState;

    if (step === 'forum') {
      const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');

      // Check for cancel
      if (this.isCancelIntent(input)) {
        const effects = this.stateMachine.transition({ type: 'CANCEL_FLOW' });
        await this.applyEffects(effects);
        await this.speakResponse('Cancelled.');
        return null;
      }

      const match = this.router.findForumChannel(input);
      if (!match) {
        await this.repromptAwaiting();
        await this.speakResponse(`I couldn't find a forum matching "${transcript}". Try again, or say cancel.`);
        await this.playReadyEarcon();
        return null;
      }

      this.stateMachine.transition({
        type: 'NEW_POST_ADVANCE',
        step: 'title',
        forumId: match.id,
        forumName: match.name,
      });

      await this.player.playEarcon('acknowledged');
      await this.speakResponse(`Got it, ${match.name}. What should the post be called?`);
      await this.playReadyEarcon();
      return null;
    }

    if (step === 'title') {
      const input = transcript.trim().replace(/[.!?]+$/, '');

      if (this.isCancelIntent(input)) {
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
      });

      await this.player.playEarcon('acknowledged');
      await this.speakResponse(`Title: ${input}. What's the prompt?`);
      await this.playReadyEarcon();
      return null;
    }

    if (step === 'body') {
      const body = transcript.trim();

      if (this.isCancelIntent(body)) {
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
        await this.player.playEarcon('acknowledged');
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

  private isCancelIntent(text: string): boolean {
    const normalized = text
      .toLowerCase()
      .replace(/[.!?,]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return /\b(?:cancel|nevermind|never mind|forget it|stop)\b/.test(normalized);
  }

  private async handleDirectSwitch(channelName: string): Promise<void> {
    if (!this.router) return;

    const mode = this.queueState?.getMode() ?? 'wait';
    if (mode === 'wait') {
      this.startWaitingLoop();
    }
    try {
      // Channel resolution can take a moment (fuzzy + LLM fallback).
      // Confirm acceptance immediately so long silences feel intentional.
      await this.playFastCue('acknowledged');

      // Try to find the channel by fuzzy matching against known channels
      const allChannels = this.router.listChannels();
      let match = allChannels.find((c) => this.channelNamesMatch(channelName, c.name, c.displayName));

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
                await this.speakResponse(`Switched to ${displayName}.`, { inbox: true });
                await this.playReadyEarcon();
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
            });

            await this.speakResponse(responseText, { inbox: true });
            await this.playReadyEarcon();
            return;
          }
        }
      }

      const target = match ? match.name : channelName;
      const result = await this.router.switchTo(target);

      let responseText: string;
      if (result.success) {
        await this.onChannelSwitch();
        const activeSessionKey = this.router.getActiveSessionKey();

        // Check for queued responses — read them in full
        const readyItems = this.getReadyItemsForSession(activeSessionKey, target);

        if (readyItems.length > 0) {
          responseText = `Switched to ${result.displayName || target}.`;
          for (const item of readyItems) {
            responseText += ` ${item.responseText}`;
            this.queueState!.markHeard(item.id);
          }
          this.responsePoller?.check();
        } else if (this.inboxTracker?.isActive() && this.router) {
          // Coming from inbox — check if this channel has new messages to read
          const sessionKey = this.router.getActiveSessionKey();
          const channels = this.router.getAllChannelSessionKeys();
          const activities = await this.inboxTracker.checkInbox(channels);
          const activity = activities.find((a) => a.sessionKey === sessionKey);

          if (activity && activity.newMessages.length > 0) {
            const formatted = this.inboxTracker.formatForTTS(activity.newMessages);
            responseText = `Switched to ${result.displayName || target}. ${formatted}`;

            // Advance inbox flow past this channel so "next" skips to the following one
            let flowState = this.stateMachine.getInboxFlowState();
            if (flowState) {
              const flowItems = flowState.items as ChannelActivity[];
              while (flowState && flowState.index < flowItems.length && flowItems[flowState.index]?.sessionKey === sessionKey) {
                this.stateMachine.transition({ type: 'INBOX_ADVANCE' });
                flowState = this.stateMachine.getInboxFlowState();
              }
            }
          } else {
            responseText = `Switched to ${result.displayName || target}.`;
          }
        } else {
          responseText = `Switched to ${result.displayName || target}.`;
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
      await this.playReadyEarcon();
    } finally {
      this.stopWaitingLoop();
    }
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
        channels.find((c) => this.channelNamesMatch(query, c.name, c.displayName));

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
    });

    await this.speakResponse(responseText);
    await this.playReadyEarcon();
  }

  private async handleChannelSelection(transcript: string): Promise<void> {
    const selState = this.stateMachine.getChannelSelectionState();
    if (!selState || !this.router) return;

    const { options } = selState;
    const selected = matchChannelSelection(transcript, options);

    if (!selected) {
      // Unrecognized — reprompt with error earcon
      await this.repromptAwaiting();
      await this.playReadyEarcon();
      return;
    }

    // Recognized — clear the awaiting state
    this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
    await this.acknowledgeAwaitingChoice();

    const result = await this.router.switchTo(selected.name);
    if (result.success) {
      await this.onChannelSwitch();
      await this.speakResponse(this.buildSwitchConfirmation(result.displayName || selected.displayName));
      await this.playReadyEarcon();
    } else {
      await this.speakResponse(`I couldn't switch to ${selected.displayName}.`);
      await this.playReadyEarcon();
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
    await this.playReadyEarcon();
  }

  private async handleNoise(level: string): Promise<void> {
    const resolved = resolveNoiseLevel(level);
    if (!resolved) {
      await this.speakResponse("I didn't recognize that noise level. Try low, medium, or high.");
      await this.playReadyEarcon();
      return;
    }
    setSpeechThreshold(resolved.threshold);
    await this.speakResponse(`Noise threshold set to ${resolved.label}.`);
    await this.playReadyEarcon();
  }

  private async handleDelay(value: number): Promise<void> {
    const clamped = Math.max(500, Math.min(10000, value));
    setSilenceDuration(clamped);
    await this.speakResponse(`Silence delay set to ${clamped} milliseconds.`);
    await this.playReadyEarcon();
  }

  private async handleDelayAdjust(direction: 'longer' | 'shorter'): Promise<void> {
    const current = getVoiceSettings().silenceDurationMs;
    const delta = direction === 'longer' ? 500 : -500;
    const updated = Math.max(500, Math.min(10000, current + delta));
    setSilenceDuration(updated);
    const verb = direction === 'longer' ? 'increased' : 'decreased';
    await this.speakResponse(`Silence delay ${verb} to ${updated} milliseconds.`);
    await this.playReadyEarcon();
  }

  private async handleReadSettings(): Promise<void> {
    const s = getVoiceSettings();
    await this.speakResponse(
      `Silence delay: ${s.silenceDurationMs} milliseconds. ` +
      `Noise threshold: ${s.speechThreshold}. ` +
      `Minimum speech duration: ${s.minSpeechDurationMs} milliseconds.`,
    );
    await this.playReadyEarcon();
  }

  private async handleVoiceChannel(): Promise<void> {
    if (this.router) {
      const active = this.router.getActiveChannel();
      const displayName = (active as any).displayName || active.name;
      await this.speakResponse(displayName, { inbox: true });
    } else {
      await this.speakResponse('No channel active.', { inbox: true });
    }
    await this.playReadyEarcon();
  }

  private async handleWhatChannel(): Promise<void> {
    if (!this.router) {
      await this.speakResponse('Channel routing is not available right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }
    const active = this.router.getActiveChannel();
    const displayName = (active as any).displayName || active.name;
    await this.speakResponse(displayName, { inbox: true });
    await this.playReadyEarcon();
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
    await this.playReadyEarcon();
  }

  private async handleReadLastMessage(): Promise<void> {
    if (!this.router) {
      await this.speakResponse('Channel routing is not available right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const active = this.router.getActiveChannel();
    const displayName = (active as any).displayName || active.name;
    const lastMsg = await this.router.getLastMessageFresh();
    if (!lastMsg) {
      await this.speakResponse(`I don't see a recent message in ${displayName}.`, { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const normalized = this.toSpokenText(lastMsg.content, '').trim();
    const isVeryShort = normalized.length > 0 && normalized.length < 24;
    const raw = lastMsg.role === 'user'
      ? (
        isVeryShort
          ? `The last message is short. You said: ${normalized}`
          : `You last said: ${lastMsg.content}`
      )
      : (
        isVeryShort
          ? `The last message is short. ${normalized}`
          : this.toSpokenText(lastMsg.content, 'Message available.')
      );
    const spoken = raw.length > 900 ? `${raw.slice(0, 900)}...` : raw;
    await this.speakResponse(spoken, { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleDispatch(body: string, userId: string): Promise<void> {
    if (!this.router || !this.queueState) {
      await this.speakResponse('Dispatch is not available right now.');
      await this.playReadyEarcon();
      return;
    }

    const parsed = this.parseDispatchBody(body);
    if (!parsed) {
      const fail = 'Dispatch failed. Say: dispatch to channel name, then your message.';
      this.logToInbox(`**${config.botName}:** ${fail}`);
      await this.speakResponse(fail, { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const target = this.resolveDispatchTarget(parsed.channelQuery);
    if (!target) {
      const fail = `Dispatch failed. I couldn't find channel ${parsed.channelQuery}.`;
      this.logToInbox(`**${config.botName}:** ${fail}`);
      await this.speakResponse(fail, { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const sessionKey = this.router.getSessionKeyFor(target.name);
    const systemPrompt = this.router.getSystemPromptFor(target.name);

    this.log(`**You:** ${parsed.payload}`, target.name);
    this.session.appendUserMessage(userId, parsed.payload, target.name);

    const item = this.queueState.enqueue({
      channel: target.name,
      displayName: target.displayName,
      sessionKey,
      userMessage: parsed.payload,
    });

    this.dispatchToLLMFireAndForget(userId, parsed.payload, item.id, {
      channelName: target.name,
      displayName: target.displayName,
      sessionKey,
      systemPrompt,
    });

    await this.player.playEarcon('acknowledged');
    await this.speakResponse(`Dispatched to ${target.displayName}.`, { inbox: true });
    await this.playReadyEarcon();
  }

  private parseDispatchBody(body: string): { channelQuery: string; payload: string } | null {
    const trimmed = body.trim().replace(/^[,.\s]+|[,.\s]+$/g, '');
    if (!trimmed) return null;

    const direct = trimmed.match(/^(.+?)\s*[:\-]\s*(.+)$/);
    if (direct) {
      const channelQuery = direct[1].trim().replace(/\s+channel$/i, '').trim();
      const payload = direct[2].trim();
      if (channelQuery && payload) return { channelQuery, payload };
    }

    const said = trimmed.match(/^(.+?)\s+(?:that|say|saying)\s+(.+)$/i);
    if (said) {
      const channelQuery = said[1].trim().replace(/\s+channel$/i, '').trim();
      const payload = said[2].trim();
      if (channelQuery && payload) return { channelQuery, payload };
    }

    const tokens = this.tokenizeWithPositions(trimmed);
    if (tokens.length < 2) return null;

    let best: { name: string; displayName: string; consumed: number } | null = null;
    for (const channel of this.router!.listChannels()) {
      const variantSets = [channel.name, channel.displayName]
        .flatMap((label) => this.channelMatchForms(label))
        .map((form) => form.split(' ').filter(Boolean));

      for (const variant of variantSets) {
        const consumed = this.matchDispatchPrefix(tokens, variant);
        if (consumed === 0) continue;
        if (!best || consumed > best.consumed) {
          best = { name: channel.name, displayName: channel.displayName, consumed };
        }
      }
    }

    if (!best) return null;
    if (best.consumed >= tokens.length) return null;

    const payloadStart = tokens[best.consumed].start;
    const payload = trimmed.slice(payloadStart).trim();
    if (!payload) return null;
    return { channelQuery: best.name, payload };
  }

  private resolveDispatchTarget(channelQuery: string): { name: string; displayName: string } | null {
    if (!this.router) return null;
    const all = this.router.listChannels();
    return all.find((c) => this.channelNamesMatch(channelQuery, c.name, c.displayName)) ?? null;
  }

  private tokenizeWithPositions(text: string): Array<{ token: string; start: number }> {
    const out: Array<{ token: string; start: number }> = [];
    const re = /[a-z0-9]+/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      out.push({ token: match[0].toLowerCase(), start: match.index });
    }
    return out;
  }

  private matchDispatchPrefix(
    tokens: Array<{ token: string; start: number }>,
    candidate: string[],
  ): number {
    if (candidate.length === 0) return 0;
    let idx = 0;

    while (
      idx < tokens.length &&
      (
        tokens[idx].token === 'to' ||
        tokens[idx].token === 'the' ||
        tokens[idx].token === 'my'
      )
    ) {
      idx++;
    }

    for (let j = 0; j < candidate.length; j++) {
      if (idx + j >= tokens.length) return 0;
      if (tokens[idx + j].token !== candidate[j]) return 0;
    }

    let consumed = idx + candidate.length;
    if (consumed < tokens.length && tokens[consumed].token === 'channel') {
      consumed += 1;
    }
    return consumed;
  }

  private resolveDoneCommandForContext(command: VoiceCommand, transcript: string): VoiceCommand {
    if (command.type !== 'inbox-next') return command;
    if (this.stateMachine.getInboxFlowState()) return command;

    const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');
    const wakePrefix = config.botName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const donePattern = new RegExp(
      `^(?:(?:hey|hello),?\\s+)?${wakePrefix}[,.]?\\s*(?:done|(?:i'?m|i\\s+am)\\s+done)$|^(?:done|(?:i'?m|i\\s+am)\\s+done)$`,
      'i',
    );
    if (donePattern.test(input)) {
      return { type: 'default' };
    }
    return command;
  }

  private cancelPendingWait(reason: string): void {
    if (this.pendingWaitCallback) {
      console.log(`Cancelling pending wait (${reason})`);
      this.pendingWaitCallback = null;
      this.activeWaitQueueItemId = null;
      this.quietPendingWait = false;
      this.stopWaitingLoop();
      // Queue item stays as pending/ready — shows up in inbox
    }
  }

  private async handleSilentWait(): Promise<void> {
    if (!this.pendingWaitCallback) {
      await this.speakResponse('Nothing is processing right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    this.quietPendingWait = true;
    this.stopWaitingLoop();
    console.log('Silent wait enabled for active processing item');
  }

  private deliverWaitResponse(responseText: string): void {
    void (async () => {
      try {
        this.stopWaitingLoop();
        this.player.stopPlayback('wait-response-delivery');
        if (!this.isBusy() || this.player.isWaiting()) {
          this.stateMachine.transition({ type: 'SPEAKING_STARTED' });
          await this.speakResponse(responseText, { allowSummary: true, forceFull: false });
          this.stateMachine.transition({ type: 'SPEAKING_COMPLETE' });
          await this.playReadyEarcon();
        } else {
          // Pipeline got busy (often due to an overlapping command like "silent").
          // Retry delivery once we return to idle instead of dropping it.
          console.log('Wait response delivery deferred (pipeline busy)');
          this.deferWaitResponse(responseText);
        }
      } catch (err: any) {
        console.error(`Wait response delivery failed: ${err.message}`);
      }
    })();
  }

  private deferWaitResponse(responseText: string): void {
    this.deferredWaitResponseText = responseText;
    if (this.deferredWaitRetryTimer) return;
    this.deferredWaitRetryTimer = setInterval(() => {
      if (!this.deferredWaitResponseText) {
        this.clearDeferredWaitRetry();
        return;
      }
      if (this.isBusy() || this.player.isPlaying()) {
        return;
      }
      const text = this.deferredWaitResponseText;
      this.deferredWaitResponseText = null;
      this.clearDeferredWaitRetry();
      this.deliverWaitResponse(text);
    }, 700);
  }

  private clearDeferredWaitRetry(): void {
    if (this.deferredWaitRetryTimer) {
      clearInterval(this.deferredWaitRetryTimer);
      this.deferredWaitRetryTimer = null;
    }
    this.deferredWaitResponseText = null;
  }

  private setGateGrace(ms: number): void {
    this.gateGraceUntil = Date.now() + ms;
    this.scheduleGraceExpiry();
  }

  private setPromptGrace(ms: number): void {
    this.promptGraceUntil = Date.now() + ms;
    this.scheduleGraceExpiry();
  }

  private scheduleGraceExpiry(): void {
    if (this.graceExpiryTimer) {
      clearTimeout(this.graceExpiryTimer);
      this.graceExpiryTimer = null;
    }
    if (!getVoiceSettings().gated) return;
    const latestGrace = Math.max(this.gateGraceUntil, this.promptGraceUntil);
    const remaining = latestGrace - Date.now();
    if (remaining <= 0) return;
    this.graceExpiryTimer = setTimeout(() => {
      this.graceExpiryTimer = null;
      this.onGraceExpired();
    }, remaining);
  }

  private clearGraceTimer(): void {
    if (this.graceExpiryTimer) {
      clearTimeout(this.graceExpiryTimer);
      this.graceExpiryTimer = null;
    }
  }

  private onGraceExpired(): void {
    if (!getVoiceSettings().gated) return;
    if (this.pendingWaitCallback) return;
    if (this.isBusy() || this.player.isPlaying()) return;
    if (this.receiver.hasActiveSpeech()) {
      console.log(`${this.stamp()} Grace period expired during active speech — suppressing gate-closed cue`);
      return;
    }
    console.log(`${this.stamp()} Grace period expired — gate closed`);
    void this.playFastCue('gate-closed');
  }

  private async handleWaitMode(userId: string, transcript: string): Promise<void> {
    const channelName = this.router?.getActiveChannel().name;

    // Non-blocking path: dispatch fire-and-forget with a wait callback
    if (this.router && this.queueState) {
      const activeChannel = this.router.getActiveChannel();
      const displayName = (activeChannel as any).displayName || activeChannel.name;
      const sessionKey = this.router.getActiveSessionKey();

      this.log(`**You:** ${transcript}`, channelName);
      this.session.appendUserMessage(userId, transcript, channelName);

      const item = this.queueState.enqueue({
        channel: activeChannel.name,
        displayName,
        sessionKey,
        userMessage: transcript,
      });

      // Register wait callback — will be invoked when LLM finishes
      this.activeWaitQueueItemId = item.id;
      this.quietPendingWait = false;
      this.pendingWaitCallback = (responseText: string) => {
        this.deliverWaitResponse(responseText);
      };

      this.dispatchToLLMFireAndForget(userId, transcript, item.id, {
        channelName: activeChannel.name,
        displayName,
        sessionKey,
        systemPrompt: this.router.getSystemPrompt(),
      });

      // Return immediately — waiting loop keeps running, pipeline goes to IDLE via finally block
      // OpenClaw sync happens in the dispatch completion handler to avoid gateway conflicts
      return;
    }

    // Synchronous fallback when queueState is not available
    this.log(`**You:** ${transcript}`, channelName);
    this.session.appendUserMessage(userId, transcript, channelName);

    const sessionScopedUser = this.router?.getActiveSessionKey() ?? userId;
    const { response } = await getResponse(sessionScopedUser, transcript);
    const responseText = response;

    this.log(`**${config.botName}:** ${responseText}`, channelName);
    this.session.appendAssistantMessage(responseText, channelName);

    void this.syncToOpenClaw(transcript, responseText);

    this.stopWaitingLoop();
    this.stateMachine.transition({ type: 'SPEAKING_STARTED' });
    await this.speakResponse(responseText, { allowSummary: true, forceFull: false });
    this.stateMachine.transition({ type: 'SPEAKING_COMPLETE' });
    await this.playReadyEarcon();
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

    this.log(`**You:** ${transcript}`, channelName);
    this.session.appendUserMessage(userId, transcript, channelName);

    // Enqueue and dispatch fire-and-forget
    const item = this.queueState.enqueue({
      channel: channelName,
      displayName,
      sessionKey,
      userMessage: transcript,
    });

    this.dispatchToLLMFireAndForget(userId, transcript, item.id, {
      channelName,
      displayName,
      sessionKey,
      systemPrompt: this.router.getSystemPrompt(),
    });

    // Brief confirmation, then immediate inbox status so the user has
    // deterministic post-queue context before the ready handoff.
    await this.player.playEarcon('acknowledged');
    await this.speakResponse(`Queued to ${displayName}.`, { inbox: true });
    await this.speakInboxQueueStatus();
    await this.playReadyEarcon();
  }

  private async handleAskMode(userId: string, transcript: string): Promise<void> {
    if (!this.router || !this.queueState) {
      // Fall back to old behavior if no queue state
      this.stateMachine.transition({
        type: 'ENTER_QUEUE_CHOICE',
        userId,
        transcript,
      });
      await this.speakResponse('Send to inbox, or wait here?', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const activeChannel = this.router.getActiveChannel();
    const channelName = activeChannel.name;
    const displayName = (activeChannel as any).displayName || channelName;
    const sessionKey = this.router.getActiveSessionKey();

    this.log(`**You:** ${transcript}`, channelName);
    this.session.appendUserMessage(userId, transcript, channelName);

    // Enqueue and dispatch speculatively — LLM starts immediately
    const item = this.queueState.enqueue({
      channel: channelName,
      displayName,
      sessionKey,
      userMessage: transcript,
    });

    this.speculativeQueueItemId = item.id;
    this.dispatchToLLMFireAndForget(userId, transcript, item.id, {
      channelName,
      displayName,
      sessionKey,
      systemPrompt: this.router.getSystemPrompt(),
    });

    // Enter choice state and prompt user — LLM works in parallel
    // OpenClaw sync happens in the dispatch completion handler to avoid gateway conflicts
    this.stateMachine.transition({
      type: 'ENTER_QUEUE_CHOICE',
      userId,
      transcript,
    });

    this.stopWaitingLoop();
    await this.speakResponse('Send to inbox, or wait here?', { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleQueueChoiceResponse(transcript: string): Promise<void> {
    const choiceState = this.stateMachine.getQueueChoiceState();
    if (!choiceState) return;

    const { userId, transcript: originalTranscript } = choiceState;
    const specId = this.speculativeQueueItemId;

    const choice = matchQueueChoice(transcript);
    if (choice === 'queue') {
      // Already dispatched speculatively — just confirm
      this.ignoreProcessingUtterancesUntil = Date.now() + 2500;
      this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
      this.speculativeQueueItemId = null;

      if (specId) {
        // Already dispatched — play confirmation
        const activeChannel = this.router?.getActiveChannel();
        const displayName = activeChannel ? ((activeChannel as any).displayName || activeChannel.name) : 'inbox';
        await this.player.playEarcon('acknowledged');
        await this.speakResponse(`Queued to ${displayName}.`, { inbox: true });
        await this.speakInboxQueueStatus();
        await this.playReadyEarcon();
      } else {
        // No speculative dispatch (fallback) — dispatch now
        await this.handleQueueMode(userId, originalTranscript);
      }
    } else if (choice === 'silent') {
      // Already dispatched — set silentWait for auto-read
      this.ignoreProcessingUtterancesUntil = Date.now() + 2500;
      this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
      this.silentWait = true;
      this.speculativeQueueItemId = null;

      if (specId) {
        await this.player.playEarcon('acknowledged');
      } else {
        await this.handleSilentQueue(userId, originalTranscript);
      }
    } else if (choice === 'wait') {
      this.ignoreProcessingUtterancesUntil = Date.now() + 2500;
      this.speculativeQueueItemId = null;

      if (specId && this.queueState) {
        // Check if speculative response is already ready
        const readyItem = this.queueState.getReadyItems().find((i) => i.id === specId);
        if (readyItem) {
          // Instant response — already done
          this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
          this.queueState.markHeard(specId);
          this.responsePoller?.check();
          this.stopWaitingLoop();
          this.stateMachine.transition({ type: 'SPEAKING_STARTED' });
          await this.speakResponse(readyItem.responseText, { allowSummary: true, forceFull: false });
          this.stateMachine.transition({ type: 'SPEAKING_COMPLETE' });
          await this.playReadyEarcon();
        } else {
          // Not ready yet — register callback and start waiting loop
          this.stateMachine.transition({ type: 'PROCESSING_STARTED' });
          this.activeWaitQueueItemId = specId;
          this.pendingWaitCallback = (responseText: string) => {
            this.deliverWaitResponse(responseText);
          };
          await this.sleep(150);
          this.startWaitingLoop();
          // Return — callback will deliver response when ready
        }
      } else {
        // No speculative dispatch — fall back to synchronous wait
        this.stateMachine.transition({ type: 'PROCESSING_STARTED' });
        await this.sleep(150);
        this.startWaitingLoop();
        await this.handleWaitMode(userId, originalTranscript);
      }
    } else {
      // Try navigation commands — with or without wake word
      const navCommand = parseVoiceCommand(transcript, config.botName)
        ?? this.matchBareQueueCommand(transcript);
      if (navCommand && (navCommand.type === 'switch' || navCommand.type === 'list' || navCommand.type === 'default' || navCommand.type === 'dispatch')) {
        this.ignoreProcessingUtterancesUntil = Date.now() + 2500;
        console.log(`Queue choice: navigation (${navCommand.type}), already dispatched speculatively`);
        this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
        this.speculativeQueueItemId = null;

        if (!specId) {
          // No speculative dispatch — dispatch now before navigating
          await this.handleSilentQueue(userId, originalTranscript);
        }
        await this.handleVoiceCommand(navCommand, userId);
      } else {
        // Unrecognized — reprompt with error earcon (LLM continues in background)
        await this.repromptAwaiting();
        await this.playReadyEarcon();
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

    this.log(`**You:** ${transcript}`, channelName);
    this.session.appendUserMessage(userId, transcript, channelName);

    const item = this.queueState.enqueue({
      channel: channelName,
      displayName,
      sessionKey,
      userMessage: transcript,
    });

    this.dispatchToLLMFireAndForget(userId, transcript, item.id, {
      channelName,
      displayName,
      sessionKey,
      systemPrompt: this.router.getSystemPrompt(),
    });

    // One confirmation tone, then silence
    console.log('Silent queue: dispatched, playing single tone');
    this.stopWaitingLoop();
    void this.playFastCue('acknowledged');
  }

  private async speakInboxQueueStatus(): Promise<void> {
    if (!this.queueState) return;

    const ready = this.queueState.getReadyItems();
    const pending = this.queueState.getPendingItems();

    const readyByChannel = new Map<string, number>();
    for (const item of ready) {
      const label = item.displayName || item.channel;
      readyByChannel.set(label, (readyByChannel.get(label) ?? 0) + 1);
    }

    const readyParts: string[] = [];
    for (const [name, count] of readyByChannel.entries()) {
      readyParts.push(count > 1 ? `${count} in ${name}` : name);
    }

    const parts: string[] = [];
    if (ready.length > 0) {
      parts.push(`Ready now: ${readyParts.join(', ')}`);
    } else {
      parts.push('Zero ready');
    }
    if (pending.length > 0) {
      parts.push(`${pending.length} processing`);
    }

    await this.speakResponse(parts.join('. ') + '.', { inbox: true });
  }

  private async handleSwitchChoiceResponse(transcript: string): Promise<void> {
    const switchState = this.stateMachine.getSwitchChoiceState();
    if (!switchState) return;

    const { lastMessage } = switchState;

    const choice = matchSwitchChoice(transcript);
    if (choice === 'read') {
      this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
      await this.acknowledgeAwaitingChoice();
      // Read the full last message
      await this.speakResponse(lastMessage, { inbox: true });
      await this.playReadyEarcon();
    } else if (choice === 'prompt') {
      this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
      // Confirm with a ready earcon so user knows Watson is ready
      console.log('Switch choice: prompt');
      this.stopWaitingLoop();
      this.setPromptGrace(15_000);
      this.playReadyEarconSync();
    } else if (choice === 'cancel') {
      const effects = this.stateMachine.transition({ type: 'CANCEL_FLOW' });
      await this.applyEffects(effects);
      console.log('Switch choice: cancel');
      this.stopWaitingLoop();
    } else {
      // Allow navigation commands from switch-choice, with or without wake word.
      const navCommand = parseVoiceCommand(transcript, config.botName)
        ?? this.matchBareQueueCommand(transcript);
      if (
        navCommand &&
        (
          navCommand.type === 'switch' ||
          navCommand.type === 'list' ||
          navCommand.type === 'default' ||
          navCommand.type === 'inbox-check' ||
          navCommand.type === 'dispatch'
        )
      ) {
        console.log(`Switch choice: navigation (${navCommand.type})`);
        this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
        await this.handleVoiceCommand(navCommand);
        return;
      }

      // Unrecognized — reprompt with error earcon
      await this.repromptAwaiting();
      await this.playReadyEarcon();
    }
  }

  private dispatchToLLMFireAndForget(
    userId: string,
    transcript: string,
    queueItemId: string,
    target: {
      channelName: string;
      displayName: string;
      sessionKey: string;
      systemPrompt: string;
    },
  ): void {
    if (!this.router || !this.queueState) return;

    const channelName = target.channelName;
    const displayName = target.displayName;
    const sessionKey = target.sessionKey;
    const systemPrompt = target.systemPrompt;

    // Capture state we need before the async work
    const routerRef = this.router;
    const queueRef = this.queueState;
    const pollerRef = this.responsePoller;
    const gatewaySync = this.gatewaySync;
    const session = this.session;

    void (async () => {
      try {
        // Use the originating channel snapshot for history so switches that
        // happen while this item is processing do not cross-contaminate context.
        await routerRef.refreshHistory(channelName);
        const history = routerRef.getHistory(channelName);
        // Use sessionKey as LLM user identity so gateway chat session and
        // websocket sync injects target the same session namespace.
        const { response, history: updatedHistory } = await getResponse(sessionKey, transcript, {
          systemPrompt,
          history,
        });
        routerRef.setHistory(updatedHistory, channelName);

        // Generate summary (first sentence or first 100 chars)
        const summary = response.length > 100
          ? response.slice(0, 100) + '...'
          : response;

        queueRef.markReady(queueItemId, summary, response);
        console.log(`Queue item ${queueItemId} ready (channel: ${channelName})`);

        // Check for pending wait callback — deliver response directly
        if (this.pendingWaitCallback && this.activeWaitQueueItemId === queueItemId) {
          const cb = this.pendingWaitCallback;
          this.pendingWaitCallback = null;
          this.activeWaitQueueItemId = null;
          this.quietPendingWait = false;
          queueRef.markHeard(queueItemId);
          pollerRef?.check();

          // Log + session transcript
          this.log(`**${config.botName}:** ${response}`, channelName);
          session.appendAssistantMessage(response, channelName);

          // Sync to OpenClaw
          if (gatewaySync?.isConnected()) {
            try {
              console.log(`Gateway inject start queueItem=${queueItemId} label=voice-user channel=${channelName} session=${sessionKey}`);
              const ok = await gatewaySync.inject(sessionKey, transcript, 'voice-user');
              if (ok) {
                console.log(`Gateway inject ok queueItem=${queueItemId} label=voice-user channel=${channelName} session=${sessionKey}`);
              } else {
                console.warn(`Gateway inject failed queueItem=${queueItemId} label=voice-user channel=${channelName} session=${sessionKey} error=inject-returned-false`);
              }
            } catch (err: any) {
              console.warn(`Gateway inject failed queueItem=${queueItemId} label=voice-user channel=${channelName} session=${sessionKey} error=${err.message}`);
            }
            try {
              console.log(`Gateway inject start queueItem=${queueItemId} label=voice-assistant channel=${channelName} session=${sessionKey}`);
              const ok = await gatewaySync.inject(sessionKey, response, 'voice-assistant');
              if (ok) {
                console.log(`Gateway inject ok queueItem=${queueItemId} label=voice-assistant channel=${channelName} session=${sessionKey}`);
              } else {
                console.warn(`Gateway inject failed queueItem=${queueItemId} label=voice-assistant channel=${channelName} session=${sessionKey} error=inject-returned-false`);
              }
            } catch (err: any) {
              console.warn(`Gateway inject failed queueItem=${queueItemId} label=voice-assistant channel=${channelName} session=${sessionKey} error=${err.message}`);
            }

            if (this.inboxTracker?.isActive()) {
              const count = await this.getCurrentMessageCount(sessionKey);
              this.inboxTracker.markSeen(sessionKey, count);
            }
          }

          cb(response);
          return;
        }

        // Log + session transcript
        this.log(`**${config.botName}:** ${response}`, channelName);
        session.appendAssistantMessage(response, channelName);

        // Sync to OpenClaw
        if (gatewaySync?.isConnected()) {
          try {
            console.log(`Gateway inject start queueItem=${queueItemId} label=voice-user channel=${channelName} session=${sessionKey}`);
            const ok = await gatewaySync.inject(sessionKey, transcript, 'voice-user');
            if (ok) {
              console.log(`Gateway inject ok queueItem=${queueItemId} label=voice-user channel=${channelName} session=${sessionKey}`);
            } else {
              console.warn(`Gateway inject failed queueItem=${queueItemId} label=voice-user channel=${channelName} session=${sessionKey} error=inject-returned-false`);
            }
          } catch (err: any) {
            console.warn(`Gateway inject failed queueItem=${queueItemId} label=voice-user channel=${channelName} session=${sessionKey} error=${err.message}`);
          }
          try {
            console.log(`Gateway inject start queueItem=${queueItemId} label=voice-assistant channel=${channelName} session=${sessionKey}`);
            const ok = await gatewaySync.inject(sessionKey, response, 'voice-assistant');
            if (ok) {
              console.log(`Gateway inject ok queueItem=${queueItemId} label=voice-assistant channel=${channelName} session=${sessionKey}`);
            } else {
              console.warn(`Gateway inject failed queueItem=${queueItemId} label=voice-assistant channel=${channelName} session=${sessionKey} error=inject-returned-false`);
            }
          } catch (err: any) {
            console.warn(`Gateway inject failed queueItem=${queueItemId} label=voice-assistant channel=${channelName} session=${sessionKey} error=${err.message}`);
          }

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
          this.notifyIfIdle(`Response ready from ${displayName}.`);
        }
      } catch (err: any) {
        console.error(`Fire-and-forget LLM dispatch failed for ${queueItemId}: ${err.message}`);
        const failureText = 'I could not complete that request because the gateway connection failed. Please try again.';
        queueRef.markReady(queueItemId, 'Dispatch failed: gateway connection error.', failureText);
        pollerRef?.check();
        this.notifyIfIdle(`Dispatch failed for ${displayName}.`);
      }
    })();

    this.responsePoller?.check();
  }

  private async handleModeSwitch(mode: VoiceMode): Promise<void> {
    if (!this.queueState) {
      await this.speakResponse('Queue mode is not available.');
      return;
    }

    this.cancelPendingWait(`mode switch to ${mode}`);
    this.queueState.setMode(mode);

    // Keep inbox tracking active across modes so text-originated updates are
    // still discoverable via inbox-check in wait mode.
    if (this.inboxTracker && this.router) {
      const channels = this.router.getAllChannelSessionKeys();
      if (!this.inboxTracker.isActive()) {
        await this.inboxTracker.activate(channels);
      }
    }

    // Clear inbox flow if active when mode changes.
    if (this.stateMachine.getInboxFlowState()) {
      this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
    }

    const labels: Record<VoiceMode, string> = {
      wait: 'Wait mode. I will wait for each response before you can speak again.',
      queue: 'Inbox mode. Your messages will be dispatched and you can keep talking.',
      ask: 'Ask mode. I will ask you whether to inbox or wait for each message.',
    };
    await this.speakResponse(labels[mode], { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleGatedMode(enabled: boolean): Promise<void> {
    setGatedMode(enabled);
    const message = enabled
      ? "Gated mode. I'll only respond when you say Watson."
      : "Open mode. I'll respond to everything.";
    await this.speakResponse(message, { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleWakeCheck(): Promise<void> {
    // Simple "I'm here" handshake:
    // listening (already played upstream) -> ready, then allow one
    // immediate no-wake follow-up utterance.
    this.stopWaitingLoop();
    this.setPromptGrace(15_000);
    this.playReadyEarconSync();
  }

  private handlePause(): void {
    console.log('Pause command: stopping playback');
    this.player.stopPlayback('pause-command');
  }

  private async handleReplay(): Promise<void> {
    if (!this.lastSpokenText) {
      await this.speakResponse("I haven't said anything yet.");
      await this.playReadyEarcon();
      return;
    }
    console.log(`Replay: "${this.lastSpokenText.slice(0, 60)}..."`);
    await this.speakResponse(this.lastSpokenText, { isReplay: true });
    await this.playReadyEarcon();
  }

  private async handleHearFullMessage(): Promise<void> {
    const full = this.lastSpokenFullText || this.lastSpokenText;
    if (!full) {
      await this.speakResponse("I don't have a full message to read yet.");
      await this.playReadyEarcon();
      return;
    }
    console.log(`Hear full message: "${full.slice(0, 60)}..."`);
    await this.speakResponse(full, { isReplay: true, forceFull: true });
    await this.playReadyEarcon();
  }

  private async handleEarconTour(): Promise<void> {
    const tour: Array<{ name: EarconName; label: string }> = [
      { name: 'listening', label: 'listening' },
      { name: 'acknowledged', label: 'acknowledged' },
      { name: 'error', label: 'error' },
      { name: 'timeout-warning', label: 'timeout warning' },
      { name: 'cancelled', label: 'cancelled' },
      { name: 'ready', label: 'ready' },
      { name: 'busy', label: 'busy' },
      { name: 'gate-closed', label: 'gate closed' },
    ];

    await this.speakResponse('Starting earcon tour.', { inbox: true });
    for (const item of tour) {
      await this.speakResponse(`Earcon: ${item.label}.`, { inbox: true });
      await this.player.playEarcon(item.name);
      await this.sleep(120);
    }
    await this.speakResponse('Processing loop tone.', { inbox: true });
    this.player.playSingleTone();
    await this.sleep(3200);
    await this.speakResponse('Earcon tour complete.', { inbox: true });
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
          await this.speakResponse(`Zero ready. ${pending.length} processing.`, { inbox: true });
        } else {
          await this.speakResponse('Zero ready.', { inbox: true });
        }
        await this.playReadyEarcon();
        return;
      }

      // Store as inbox flow for "next" traversal via state machine
      this.stateMachine.transition({
        type: 'ENTER_INBOX_FLOW',
        items: activities,
        returnChannel: this.router.getActiveChannel().name,
      });

      const channelNames = activities.map((a) => a.displayName);
      const pending = this.queueState.getPendingItems();
      const pendingSuffix = pending.length > 0 ? ` ${pending.length} still processing.` : '';

      await this.speakResponse(
        `New activity in ${channelNames.join(', ')}.${pendingSuffix} Say next, done, or go to a channel.`,
        { inbox: true },
      );
      await this.playReadyEarcon();
      return;
    }

    // Fallback: queue-only check (wait mode or no inbox tracker)
    const ready = this.queueState.getReadyItems();
    const pending = this.queueState.getPendingItems();

    if (ready.length === 0 && pending.length === 0) {
      await this.speakResponse('Nothing new.');
      await this.playReadyEarcon();
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
    await this.playReadyEarcon();
  }

  private async handleInboxNext(): Promise<void> {
    if (!this.queueState) {
      await this.speakResponse('Queue mode is not available.', { inbox: true });
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
          returnChannel: this.router.getActiveChannel().name,
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
        const returnChannel = updatedFlow?.returnChannel;
        this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
        // Restore the channel the user was on before the inbox flow started
        await this.restoreChannel(returnChannel);
        parts.push("That's everything.");
      }

      const fullText = this.toSpokenText(parts.join(' '), 'Nothing new in the inbox.');
      await this.speakResponse(fullText, { inbox: true, allowSummary: true, forceFull: false });
      await this.playReadyEarcon();
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
      await this.playReadyEarcon();
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

    const fullText = this.toSpokenText(prefix + item.responseText + suffix, 'A response is ready.');
    await this.speakResponse(fullText, { inbox: true, allowSummary: true, forceFull: false });
    await this.playReadyEarcon();
  }

  private async handleInboxClear(): Promise<void> {
    if (!this.queueState) {
      await this.speakResponse('Queue mode is not available.');
      return;
    }

    const flowState = this.stateMachine.getInboxFlowState();
    if (!flowState || flowState.index >= flowState.items.length) {
      await this.speakResponse('Nothing to clear in the inbox.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    const remaining = flowState.items.slice(flowState.index) as ChannelActivity[];
    const sessionKeys = new Set(remaining.map((a) => a.sessionKey));

    // Mark queued ready items from remaining channels as heard.
    for (const item of this.queueState.getReadyItems()) {
      if (sessionKeys.has(item.sessionKey)) {
        this.queueState.markHeard(item.id);
      }
    }
    this.responsePoller?.check();

    // Mark text activity as seen for remaining channels.
    if (this.inboxTracker) {
      for (const activity of remaining) {
        const currentCount = await this.getCurrentMessageCount(activity.sessionKey);
        this.inboxTracker.markSeen(activity.sessionKey, currentCount);
      }
    }

    const returnChannel = flowState.returnChannel;
    this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
    await this.restoreChannel(returnChannel);
    const channelWord = remaining.length === 1 ? 'channel' : 'channels';
    await this.speakResponse(`Cleared ${remaining.length} ${channelWord} from the inbox.`, { inbox: true });
    await this.playReadyEarcon();
  }

  private async restoreChannel(channelName: string | null | undefined): Promise<void> {
    if (!channelName || !this.router) return;
    const active = this.router.getActiveChannel();
    if (active.name === channelName) return; // already there
    const result = await this.router.switchTo(channelName);
    if (result.success) {
      await this.onChannelSwitch();
      console.log(`Inbox flow: restored to ${result.displayName || channelName}`);
    }
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

  private clearInboxFlowIfActive(reason: string): void {
    if (this.stateMachine.getStateType() !== 'INBOX_FLOW') return;
    console.log(`Clearing inbox flow (${reason})`);
    this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
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
    const readyItems = this.getReadyItemsForSession(activity.sessionKey, activity.channelName);

    if (readyItems.length > 0) {
      parts.push(`Switched to ${activity.displayName}.`);
      for (const item of readyItems) {
        parts.push(this.toSpokenText(item.responseText, 'A response is ready.'));
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
    const normalized = input
      .replace(/[,.!?;:]+/g, ' ')
      .replace(/\bin-?box\b/g, 'inbox')
      .replace(/\bin\s+box\b/g, 'inbox')
      .replace(/\s+/g, ' ')
      .trim();
    const politeStripped = normalized
      .replace(/^(?:please\s+)?(?:can|could|would)\s+you\s+/, '')
      .replace(/^please\s+/, '')
      .trim();
    const navInput = politeStripped || normalized;

    // "next", "next one", "next response", "next message", "next channel", "done", "I'm done", "move on"
    if (/^(?:next(?:\s+(?:response|one|message|channel))?|(?:i'?m\s+)?done|i\s+am\s+done|move\s+on)$/.test(normalized)) {
      return { type: 'inbox-next' };
    }

    // "clear inbox", "clear the inbox", "mark inbox read", "clear all"
    if (/^(?:clear\s+(?:the\s+)?inbox|mark\s+(?:the\s+)?inbox\s+(?:as\s+)?read|mark\s+all\s+read|clear\s+all)$/.test(normalized)) {
      return { type: 'inbox-clear' };
    }

    // "read last message", "read the last message", "last message"
    if (/^(?:read\s+(?:the\s+)?last\s+message|last\s+message)$/.test(normalized)) {
      return { type: 'read-last-message' };
    }

    // "hear full message", "read full message", "full message"
    if (/^(?:hear|read|play)\s+(?:the\s+)?full\s+message$|^full\s+message$/.test(normalized)) {
      return { type: 'hear-full-message' };
    }

    // "dispatch to <channel> <payload>"
    const dispatchMatch = navInput.match(
      /^(?:dispatch|deliver|route)\s+(?:this(?:\s+message)?\s+)?(?:to|in|into)\s+(.+)$/,
    );
    if (dispatchMatch) {
      const body = dispatchMatch[1].trim();
      if (body) return { type: 'dispatch', body };
    }

    // "switch channels", "change channels", "list channels", "show channels"
    // Voice UX: map to inbox status instead of channel enumeration.
    if (/^(?:change|switch|list|show)\s+channels?$/.test(navInput)) {
      return { type: 'inbox-check' };
    }

    // "go to X", "switch to X", "switch channel to X", "move channels X"
    const switchMatch = navInput.match(/^(?:go|switch|change|move)(?:\s+channels?)?(?:\s+to)?\s+(.+)$/);
    if (switchMatch) {
      const target = switchMatch[1].trim().replace(/\s+channel$/, '').trim();
      if (/^(?:inbox|the\s+inbox|my\s+inbox)$/.test(target)) {
        return { type: 'inbox-check' };
      }
      if (/^(?:default|home|back)$/.test(target)) {
        return { type: 'default' };
      }
      if (!/^(?:inbox|queue|wait|ask)\s+mode$/.test(target)) {
        return { type: 'switch', channel: target };
      }
    }

    // "go back", "go home", "default", "back to inbox"
    if (/^(?:go\s+back|go\s+home|default|back\s+to\s+inbox|go\s+to\s+inbox)$/.test(navInput)) {
      return { type: 'default' };
    }

    // "inbox list", "inbox", "what do I have", "check inbox", "what's new", etc.
    if (
      /^(?:inbox(?:\s+list)?|what\s+do\s+(?:i|you)\s+have(?:\s+for\s+me)?|check\s+(?:the\s+)?(?:queue|inbox)|what'?s\s+(?:waiting|ready|new)|queue\s+status)$/.test(navInput) ||
      /\binbox\s+list\b/.test(navInput)
    ) {
      return { type: 'inbox-check' };
    }

    return null;
  }

  private buildSwitchConfirmation(displayName: string): string {
    const lastMsg = this.router?.getLastMessage();
    let text = `Switched to ${displayName}.`;
    if (lastMsg) {
      // Truncate long messages for TTS and guard non-string payloads
      const raw = this.toSpokenText((lastMsg as any).content, 'Message available.');
      const content = raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
      if (lastMsg.role === 'user') {
        text += ` You last said: ${content}`;
      } else {
        text += ` ${content}`;
      }
    }
    return text;
  }

  private async speakResponse(
    text: string,
    options?: { inbox?: boolean; isReplay?: boolean; allowSummary?: boolean; forceFull?: boolean },
  ): Promise<void> {
    const fullText = this.toSpokenText(text, '');
    const shouldSummarize = !!options?.allowSummary && !options?.forceFull;
    const spokenText = shouldSummarize
      ? await this.buildSummarySpeechText(fullText)
      : fullText;

    // Keep spoken summaries/prompts out of channel transcripts to avoid
    // duplicating content and to keep "read last message" aligned to real
    // channel messages.
    if (options?.inbox) {
      this.logToInbox(`**${config.botName}:** ${spokenText}`);
    }
    if (!options?.isReplay) {
      this.lastSpokenText = spokenText;
      this.lastSpokenFullText = fullText;
      this.lastSpokenWasSummary = spokenText !== fullText;
    }
    const ttsStream = await textToSpeechStream(spokenText);
    this.stopWaitingLoop();
    this.player.stopPlayback('speak-response-preempt');
    await this.player.playStream(ttsStream);
    this.lastPlaybackText = spokenText;
    this.lastPlaybackCompletedAt = Date.now();
    this.setGateGrace(5_000);
  }

  private shouldSummarizeForVoice(text: string): boolean {
    if (!text) return false;
    const normalized = text.trim();
    if (normalized.length < 450) return false;

    const lineCount = normalized.split('\n').filter((l) => l.trim().length > 0).length;
    const toolChatterHits = (normalized.match(
      /\b(?:let me|i(?:'m| am)\s+(?:going to|checking|looking|opening|searching|trying)|opening up the browser|found (?:the|an) item|adding it now|working on it)\b/gi,
    ) ?? []).length;

    return normalized.length >= 1100 || lineCount >= 10 || toolChatterHits >= 2;
  }

  private async summarizeForVoice(fullText: string): Promise<string | null> {
    const clipped = fullText.slice(0, 7000);
    const system = [
      'You summarize assistant output for spoken voice UX.',
      'Return plain text only, 2 to 4 short sentences.',
      'Include outcome first, key facts second, and any required next action.',
      'Exclude tool narration, thinking steps, and process chatter.',
      'Do not use markdown or bullets.',
    ].join(' ');

    try {
      const out = await quickCompletion(system, `Original response:\n${clipped}`, 140);
      const text = this.toSpokenText(out, '').replace(/\s+/g, ' ').trim();
      if (!text) return null;
      return text;
    } catch (err: any) {
      console.warn(`Voice summary failed: ${err.message}`);
      return null;
    }
  }

  private async buildSummarySpeechText(fullText: string): Promise<string> {
    if (!this.shouldSummarizeForVoice(fullText)) return fullText;
    const summary = await this.summarizeForVoice(fullText);
    if (!summary) {
      const fallback = fullText.length > 360 ? `${fullText.slice(0, 360)}...` : fullText;
      return `Summary. ${fallback} Say "hear full message" for full details.`;
    }
    return `Summary. ${summary} Say "hear full message" for full details.`;
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
    if (Date.now() < this.promptGraceUntil || Date.now() < this.gateGraceUntil) {
      console.log(`Idle notify skipped (grace window): "${message}"`);
      const until = Math.max(this.promptGraceUntil, this.gateGraceUntil);
      const delayMs = Math.max(120, until - Date.now() + 120);
      this.scheduleDeferredIdleNotify(message, delayMs);
      return;
    }
    // INBOX_FLOW is an "awaiting user" context; treat it as idle enough for
    // queue-ready notifications so responses don't get silently suppressed.
    const stateType = this.stateMachine.getStateType();
    const blockOnBusy = stateType !== 'IDLE' && stateType !== 'INBOX_FLOW';
    if (blockOnBusy || this.player.isPlaying()) {
      console.log(`Idle notify skipped (busy): "${message}"`);
      this.scheduleDeferredIdleNotify(message, 900);
      return;
    }
    if (this.idleNotifyInFlight) {
      console.log(`Idle notify deferred (in-flight): "${message}"`);
      this.scheduleDeferredIdleNotify(message, 900);
      return;
    }

    const existing = this.deferredIdleNotifyTimers.get(message);
    if (existing) {
      clearTimeout(existing);
      this.deferredIdleNotifyTimers.delete(message);
    }

    // If a ready item belongs to the currently active channel and we're idle,
    // read it directly instead of announcing "Response ready from <same channel>".
    if (this.shouldAutoReadReadyForActiveChannel(message)) {
      void this.readReadyForActiveChannel();
      return;
    }

    console.log(`Idle notify: "${message}"`);
    this.logToInbox(`**${config.botName}:** ${message}`);
    this.idleNotifyInFlight = true;

    textToSpeechStream(message)
      .then((stream) => {
        // Re-check idle — user may have started speaking while TTS was generating
        if (!this.isBusy() && !this.player.isPlaying()) {
          // Any fresh playback closes old grace windows. This prevents stale
          // ready-grace from allowing no-wake interruptions mid-notification.
          this.gateGraceUntil = 0;
          this.promptGraceUntil = 0;
          this.clearGraceTimer();
          this.player.playStream(stream)
            .then(async () => {
              this.lastPlaybackText = message;
              this.lastPlaybackCompletedAt = Date.now();
              // Make post-notification handoff explicit so "next" feels expected.
              await this.playReadyEarcon();
              this.idleNotifyInFlight = false;
            })
            .catch((err: any) => {
              console.warn(`Idle notify playback failed: ${err?.message ?? err}`);
              this.idleNotifyInFlight = false;
            });
        } else {
          this.idleNotifyInFlight = false;
          this.scheduleDeferredIdleNotify(message, 900);
        }
      })
      .catch((err) => {
        console.warn(`Idle notify TTS failed: ${err.message}`);
        this.idleNotifyInFlight = false;
        this.scheduleDeferredIdleNotify(message, 1200);
      });
  }

  private scheduleDeferredIdleNotify(message: string, delayMs: number): void {
    const existing = this.deferredIdleNotifyTimers.get(message);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.deferredIdleNotifyTimers.delete(message);
      this.notifyIfIdle(message);
    }, Math.max(120, delayMs));
    this.deferredIdleNotifyTimers.set(message, timer);
  }

  notifyDependencyIssue(type: 'stt' | 'tts', message: string): void {
    const now = Date.now();
    if (now < this.dependencyAlertCooldownUntil[type]) return;
    this.dependencyAlertCooldownUntil[type] = now + 10_000;
    console.warn(`Dependency issue [${type}]: ${message}`);
    this.logToInbox(`**${config.botName}:** ${message}`);
    void this.playFastCue('error');
  }

  private shouldAutoReadReadyForActiveChannel(message: string): boolean {
    if (!this.router || !this.queueState) return false;
    // Auto-read is a wait-mode behavior. In ask/queue (inbox) flows,
    // ready items should remain in inbox until the user explicitly pulls them.
    const modeGetter = (this.queueState as any)?.getMode;
    if (typeof modeGetter === 'function' && modeGetter.call(this.queueState) !== 'wait') return false;
    const m = message.match(/^Response ready from (.+)\.$/i);
    if (!m) return false;

    const announced = this.normalizeChannelLabel(m[1] || '');
    const active = this.router.getActiveChannel();
    const activeDisplay = this.normalizeChannelLabel((active as any).displayName || active.name);

    if (announced !== activeDisplay) return false;

    return this.queueState.getReadyByChannel(active.name) != null;
  }

  private async readReadyForActiveChannel(): Promise<void> {
    if (!this.router || !this.queueState) return;
    const active = this.router.getActiveChannel();
    const item = this.queueState.getReadyByChannel(active.name);
    if (!item) return;

    console.log(`Idle auto-read: consuming ready item from active channel ${item.displayName}`);
    this.queueState.markHeard(item.id);
    this.responsePoller?.check();

    try {
      if (this.isBusy() || this.player.isPlaying()) {
        console.log('Idle auto-read aborted (became busy before playback)');
        return;
      }
      this.stateMachine.transition({ type: 'SPEAKING_STARTED' });
      await this.speakResponse(item.responseText, { allowSummary: true, forceFull: false });
      this.stateMachine.transition({ type: 'SPEAKING_COMPLETE' });
      await this.playReadyEarcon();
    } catch (err: any) {
      console.warn(`Idle auto-read failed: ${err.message}`);
    }
  }

  private normalizeChannelLabel(value: string): string {
    return value.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, ' ');
  }

  private classifyDependencyIssue(error: any): { type: 'stt' | 'tts'; message: string } | null {
    const full = `${error?.message ?? ''} ${error?.cause?.message ?? ''}`.toLowerCase();
    if (!full.trim()) return null;

    if (full.includes('whisper local error') || full.includes('/inference') || full.includes('stt')) {
      return { type: 'stt', message: 'Speech recognition is unavailable right now.' };
    }
    if (full.includes('kokoro') || full.includes('tts') || full.includes('text-to-speech') || full.includes(':8880')) {
      return { type: 'tts', message: 'Voice output is unavailable right now.' };
    }
    if (full.includes('econnrefused') && config.whisperUrl) {
      return { type: 'stt', message: 'Speech recognition is unavailable right now.' };
    }
    return null;
  }

  private async inferVoiceCommandLLM(
    transcript: string,
    mode: VoiceMode,
    inGracePeriod: boolean,
  ): Promise<VoiceCommand | null> {
    const clipped = transcript.trim().slice(0, VoicePipeline.COMMAND_CLASSIFIER_MAX_CHARS);
    if (!clipped) return null;

    const system = [
      'Classify spoken assistant input as either a voice command or normal prompt.',
      'Return ONLY minified JSON with keys: intent, confidence, and optional fields channel, body, mode, enabled.',
      'intent must be one of:',
      'prompt,switch,dispatch,list,default,noise,delay,delay-adjust,settings,new-post,mode,inbox-check,inbox-next,inbox-clear,read-last-message,voice-status,voice-channel,gated-mode,wake-check,silent-wait,hear-full-message,pause,replay,earcon-tour',
      'confidence must be 0 to 1.',
      'Use prompt if uncertain.',
      'No markdown, no prose.',
    ].join(' ');

    const user = JSON.stringify({
      transcript: clipped,
      context: {
        mode,
        inGracePeriod,
        gated: getVoiceSettings().gated,
      },
      hints: [
        '"in box" means "inbox"',
        '"here full message" means "hear full message"',
      ],
    });

    let raw = '';
    try {
      raw = await quickCompletion(system, user, 120);
    } catch (err: any) {
      console.warn(`LLM command classifier failed: ${err.message}`);
      return null;
    }

    const parsed = this.extractJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    const intentRaw = String((parsed as any).intent || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
    const confidence = Number((parsed as any).confidence);
    if (!Number.isFinite(confidence)) return null;

    const wordCount = clipped.split(/\s+/).filter(Boolean).length;
    const threshold = wordCount <= 8 ? 0.72 : 0.88;
    if (confidence < threshold) return null;
    if (intentRaw === 'prompt' || intentRaw === '') return null;

    const channel = String((parsed as any).channel ?? (parsed as any).target ?? '').trim();
    const body = String((parsed as any).body ?? (parsed as any).message ?? (parsed as any).text ?? '').trim();
    const level = String((parsed as any).level ?? '').trim();
    const modeValue = String((parsed as any).mode ?? '').trim().toLowerCase();
    const enabledValue = (parsed as any).enabled;

    switch (intentRaw) {
      case 'switch':
        return channel ? { type: 'switch', channel } : null;
      case 'dispatch':
        return body ? { type: 'dispatch', body } : null;
      case 'list':
        // Voice UX: deprecate channel-list intent; treat as inbox status.
        return { type: 'inbox-check' };
      case 'default':
        return { type: 'default' };
      case 'noise':
        return (level || body) ? { type: 'noise', level: (level || body) } : null;
      case 'delay': {
        const digits = body.match(/\d+/)?.[0];
        if (!digits) return null;
        return { type: 'delay', value: parseInt(digits, 10) };
      }
      case 'delay-adjust':
        // Classifier may emit delay-adjust with a numeric body for phrases like
        // "set delay 500 milliseconds". Treat that as absolute delay.
        if (/\d/.test(body)) {
          const digits = body.match(/\d+/)?.[0];
          if (!digits) return null;
          return { type: 'delay', value: parseInt(digits, 10) };
        }
        if (/\blonger\b/.test(body)) return { type: 'delay-adjust', direction: 'longer' };
        if (/\bshorter\b/.test(body)) return { type: 'delay-adjust', direction: 'shorter' };
        return null;
      case 'settings':
        return { type: 'settings' };
      case 'new-post':
        return { type: 'new-post' };
      case 'mode': {
        const normalized = modeValue === 'inbox' ? 'queue' : modeValue;
        if (normalized === 'wait' || normalized === 'queue' || normalized === 'ask') {
          return { type: 'mode', mode: normalized };
        }
        return null;
      }
      case 'inbox-check':
        return { type: 'inbox-check' };
      case 'inbox-next':
        return { type: 'inbox-next' };
      case 'inbox-clear':
        return { type: 'inbox-clear' };
      case 'read-last-message':
        return { type: 'read-last-message' };
      case 'voice-status':
        return { type: 'voice-status' };
      case 'voice-channel':
        return { type: 'voice-channel' };
      case 'gated-mode': {
        if (typeof enabledValue === 'boolean') return { type: 'gated-mode', enabled: enabledValue };
        if (modeValue === 'on' || modeValue === 'enabled' || modeValue === 'gated') {
          return { type: 'gated-mode', enabled: true };
        }
        if (modeValue === 'off' || modeValue === 'disabled' || modeValue === 'open' || modeValue === 'ungated') {
          return { type: 'gated-mode', enabled: false };
        }
        return null;
      }
      case 'wake-check':
        return { type: 'wake-check' };
      case 'silent-wait':
        // Guard against noise/garbage transcripts being misclassified as silent-wait.
        if (!/\b(?:silent|quiet|silence|quietly|no tones?|stop tones?|wait quietly)\b/i.test(clipped)) {
          return null;
        }
        return { type: 'silent-wait' };
      case 'hear-full-message':
        return { type: 'hear-full-message' };
      case 'pause':
        return { type: 'pause' };
      case 'replay':
        return { type: 'replay' };
      case 'earcon-tour':
        return { type: 'earcon-tour' };
      default:
        return null;
    }
  }

  private extractJsonObject(raw: string): any | null {
    const text = raw.trim();
    if (!text) return null;
    const tryParse = (s: string): any | null => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    };

    const direct = tryParse(text);
    if (direct) return direct;

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return tryParse(text.slice(start, end + 1));
    }
    return null;
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

  private async playReadyEarcon(): Promise<void> {
    console.log(`${this.stamp()} Ready cue emitted (async) — opening grace window`);
    this.setGateGrace(VoicePipeline.READY_GRACE_MS);
    await this.playFastCue('ready');
  }

  private playReadyEarconSync(): void {
    console.log(`${this.stamp()} Ready cue emitted (sync) — opening grace window`);
    this.setGateGrace(VoicePipeline.READY_GRACE_MS);
    void this.playFastCue('ready');
  }

  private startWaitingLoop(delayMs = 0): void {
    if (this.player.isWaiting() && delayMs <= 0) return;
    if (this.waitingLoopTimer) {
      clearTimeout(this.waitingLoopTimer);
      this.waitingLoopTimer = null;
    }
    if (delayMs <= 0) {
      this.player.startWaitingLoop();
      return;
    }
    this.waitingLoopTimer = setTimeout(() => {
      this.waitingLoopTimer = null;
      this.player.startWaitingLoop();
    }, delayMs);
  }

  private stopWaitingLoop(): void {
    if (this.waitingLoopTimer) {
      clearTimeout(this.waitingLoopTimer);
      this.waitingLoopTimer = null;
    }
    this.player.stopWaitingLoop();
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async repromptAwaiting(): Promise<void> {
    const effects = this.stateMachine.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
    await this.applyEffects(effects);
  }

  private async acknowledgeAwaitingChoice(): Promise<void> {
    await this.playFastCue('acknowledged');
  }

  private fastCuePriority(name: EarconName): number {
    switch (name) {
      case 'listening':
        return 1;
      case 'acknowledged':
        return 2;
      case 'ready':
        return 3;
      default:
        return 4;
    }
  }

  private async playFastCue(name: EarconName): Promise<void> {
    const isFast = name === 'listening' || name === 'acknowledged' || name === 'ready';
    if (!isFast) {
      await this.player.playEarcon(name);
      return;
    }

    return await new Promise<void>((resolve) => {
      if (!this.fastCueTimer) {
        this.pendingFastCue = name;
        this.pendingFastCueResolvers = [resolve];
        this.fastCueTimer = setTimeout(() => {
          void this.flushFastCue();
        }, VoicePipeline.FAST_CUE_COALESCE_MS);
        return;
      }

      if (!this.pendingFastCue || this.fastCuePriority(name) >= this.fastCuePriority(this.pendingFastCue)) {
        this.pendingFastCue = name;
      }
      this.pendingFastCueResolvers.push(resolve);
    });
  }

  private async flushFastCue(): Promise<void> {
    const name = this.pendingFastCue;
    const resolvers = this.pendingFastCueResolvers;

    this.fastCueTimer = null;
    this.pendingFastCue = null;
    this.pendingFastCueResolvers = [];

    if (name) {
      await this.player.playEarcon(name);
    }
    for (const resolve of resolvers) {
      resolve();
    }
  }

  private clearFastCueQueue(): void {
    if (this.fastCueTimer) {
      clearTimeout(this.fastCueTimer);
      this.fastCueTimer = null;
    }
    const resolvers = this.pendingFastCueResolvers;
    this.pendingFastCue = null;
    this.pendingFastCueResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  private channelNamesMatch(input: string, name: string, displayName: string): boolean {
    const candidates = [name, displayName];
    const inputForms = this.channelMatchForms(input);

    for (const candidate of candidates) {
      const candidateForms = this.channelMatchForms(candidate);
      for (const q of inputForms) {
        for (const c of candidateForms) {
          if (!q || !c) continue;
          if (q === c) return true;
          if (q.includes(c) || c.includes(q)) return true;
        }
      }
    }

    return false;
  }

  private channelMatchForms(text: string): string[] {
    const base = text
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
    if (!base) return [''];

    // Possessive/plural tolerant form: "dollys chats" -> "dolly chat"
    const singularish = base
      .split(' ')
      .map((token) => {
        if (token.length <= 3) return token;
        if (token.endsWith('ss')) return token;
        if (token.endsWith('s')) return token.slice(0, -1);
        return token;
      })
      .join(' ');

    return singularish === base ? [base] : [base, singularish];
  }

  private toSpokenText(value: unknown, fallback = ''): string {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : fallback;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      const flat = value
        .map((v) => this.toSpokenText(v, ''))
        .filter((v) => v.length > 0)
        .join(' ');
      return flat.length > 0 ? flat : fallback;
    }
    if (value && typeof value === 'object') {
      try {
        const content = (value as any).content;
        if (typeof content === 'string' && content.trim().length > 0) {
          return content.trim();
        }
        const serialized = JSON.stringify(value);
        if (serialized && serialized !== '{}' && serialized !== '[]') {
          return serialized.length > 300 ? `${serialized.slice(0, 300)}...` : serialized;
        }
      } catch {
        // fall through to fallback
      }
    }
    return fallback;
  }

  private log(message: string, channelName?: string): void {
    const send = (channel: TextChannel) => {
      this.sendChunked(channel, message).catch((err) => {
        console.error('Failed to log to text channel:', err.message);
      });
    };

    if (this.router) {
      const target = channelName
        ? this.router.getLogChannelFor(channelName)
        : this.router.getLogChannel();
      target.then((channel) => {
        if (channel) send(channel);
      });
    } else if (this.logChannel) {
      send(this.logChannel);
    }
  }
}
