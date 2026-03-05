import { VoiceConnection } from '@discordjs/voice';
import { TextChannel } from 'discord.js';
import { AudioReceiver } from '../discord/audio-receiver.js';
import { DiscordAudioPlayer } from '../discord/audio-player.js';
import { transcribe, type StreamingPartialEvent } from '../services/whisper.js';
import { getResponse, quickCompletion } from '../services/claude.js';
import { textToSpeechStream } from '../services/tts.js';
import { SessionTranscript } from '../services/session-transcript.js';
import { config } from '../config.js';
import { sanitizeAssistantResponse } from '../services/assistant-sanitizer.js';
import { parseVoiceCommand, matchesWakeWord, extractFromWakeWord, matchChannelSelection, matchQueueChoice, matchSwitchChoice, type VoiceCommand, type ChannelOption } from '../services/voice-commands.js';
import { getVoiceSettings, setSilenceDuration, setSpeechThreshold, setGatedMode, setEndpointingMode, setIndicateTimeoutMs, resolveNoiseLevel, getNoisePresetNames, type EndpointingMode } from '../services/voice-settings.js';
import { PipelineStateMachine, type TransitionEffect, type PipelineEvent } from './pipeline-state.js';
import { checkPipelineInvariants, type InvariantContext } from './pipeline-invariants.js';
import { createTransientContext, resetTransientContext, type TransientContext } from './transient-context.js';
import { createHealthCounters, type HealthCounters, type HealthSnapshot } from '../services/health-snapshot.js';
import { initEarcons, type EarconName } from '../audio/earcons.js';
import type { ChannelRouter } from '../services/channel-router.js';
import type { GatewaySync } from '../services/gateway-sync.js';
import type { QueueState } from '../services/queue-state.js';
import type { ResponsePoller } from '../services/response-poller.js';
import type { VoiceMode } from '../services/queue-state.js';
import type { InboxTracker, ChannelActivity } from '../services/inbox-tracker.js';

type IdleNotificationKind = 'generic' | 'response-ready' | 'text-activity';

interface IdleNotificationOptions {
  kind?: IdleNotificationKind;
  sessionKey?: string;
  stamp?: number;
  dedupeKey?: string;
}

interface QueuedIdleNotification {
  key: string;
  message: string;
  kind: IdleNotificationKind;
  sessionKey: string | null;
  stamp: number | null;
  retries: number;
}

type IdleNotificationStage = 'enqueued' | 'deduped' | 'deferred' | 'dropped' | 'delivered';

export interface IdleNotificationEvent {
  at: number;
  stage: IdleNotificationStage;
  kind: IdleNotificationKind;
  key: string;
  sessionKey: string | null;
  reason: string | null;
  retries: number;
  message: string;
  queueDepth: number;
}

export interface IdleNotificationDiagnostics {
  queueDepth: number;
  processing: boolean;
  inFlight: boolean;
  recentEvents: IdleNotificationEvent[];
}

export class VoicePipeline {
  private static readonly READY_GRACE_MS = 5_000;
  private static readonly FOLLOWUP_PROMPT_GRACE_MS = 15_000;
  // Absorb Discord/VAD timing jitter at the ready->speak handoff.
  private static readonly READY_HANDOFF_TOLERANCE_MS = 600;
  // Rejected-audio reprompts are useful for brief misses, but noisy long chunks
  // create chaotic beep loops in guided flows.
  private static readonly MAX_REJECTED_REPROMPT_MS = 2200;
  private static readonly PROCESSING_LOOP_START_DELAY_MS = 350;
  private static readonly FAST_CUE_COALESCE_MS = 220;
  private static readonly COMMAND_CLASSIFIER_MAX_CHARS = 420;
  private static readonly NEW_POST_TIMEOUT_PROMPT_GUARD_MS = 8_000;
  private static readonly GATE_CLOSE_CUE_HOLDOFF_MS = 320;
  private static readonly INDICATE_TIMEOUT_ACTIVE_SPEECH_GRACE_MS = 1200;
  private static readonly STANDALONE_CODE_WAKE_TOKENS = [
    'whiskeyfoxtrot',
    'whiskeydelta',
    'whiskyfoxtrot',
    'whiskydelta',
  ];

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

  // Centralized transient state (reset on stop/stall)
  private ctx: TransientContext = createTransientContext();

  // Timer handles (cleared via clearAllTimers)
  private waitingLoopTimer: NodeJS.Timeout | null = null;
  private fastCueTimer: NodeJS.Timeout | null = null;
  private pendingFastCue: EarconName | null = null;
  private pendingFastCueResolvers: Array<() => void> = [];
  private graceExpiryTimer: NodeJS.Timeout | null = null;
  private gateCloseCueTimer: NodeJS.Timeout | null = null;
  private indicateCaptureTimer: NodeJS.Timeout | null = null;
  private deferredWaitRetryTimer: NodeJS.Timeout | null = null;
  private idleNotifyTimer: NodeJS.Timeout | null = null;
  private idleNotifyQueue: QueuedIdleNotification[] = [];
  private idleNotifyByKey = new Map<string, QueuedIdleNotification>();
  private idleNotifyProcessing = false;
  private idleNotifyEvents: IdleNotificationEvent[] = [];
  private static readonly IDLE_NOTIFY_EVENT_LIMIT = 80;

  // Classifier state
  private lastClassifierTimedOut = false;

  // Inbox background poll — detects text-originated messages in inbox mode
  private inboxPollTimer: NodeJS.Timeout | null = null;
  private static readonly INBOX_POLL_INTERVAL_MS = 60_000;
  private inboxPollInFlight = false;
  // Track last-notified stamp per channel to avoid repeat notifications
  private inboxPollNotifiedStamps = new Map<string, number>();
  // Tracks channels with recent voice dispatches — suppress inbox "new message"
  // notifications during the cool-down to avoid echo responses from the text agent.
  private recentVoiceDispatchChannels = new Map<string, number>();
  private static readonly VOICE_DISPATCH_COOLDOWN_MS = 120_000;

  // Stall watchdog
  private stallWatchdogTimer: NodeJS.Timeout | null = null;
  private lastTransitionAt = Date.now();
  private stallWatchdogFires = 0;
  private static readonly STALL_WATCHDOG_MS = 60_000;

  // Health counters
  private counters: HealthCounters = createHealthCounters();
  private readonly startedAt = Date.now();

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

  private shouldRunCommandClassifier(transcript: string): boolean {
    const input = transcript.trim();
    if (!input) return false;
    const words = input.split(/\s+/).filter(Boolean);
    // Long freeform utterances are overwhelmingly prompts; skip classifier to
    // avoid delaying acknowledgement on normal channel prompts.
    if (words.length >= 9 && !this.seemsCommandLikeForMissedWakeLLM(input)) {
      return false;
    }
    return true;
  }

  private async maybeCueMissedWakeFromLLM(transcript: string, mode: VoiceMode, inGracePeriod: boolean): Promise<void> {
    if (this.ctx.missedWakeAnalysisInFlight) return;
    if (!this.seemsCommandLikeForMissedWakeLLM(transcript)) return;
    this.ctx.missedWakeAnalysisInFlight = true;
    try {
      const inferred = await this.inferVoiceCommandLLM(transcript, mode, inGracePeriod);
      if (!inferred) return;
      const now = Date.now();
      if (now < this.ctx.failedWakeCueCooldownUntil) return;
      this.ctx.failedWakeCueCooldownUntil = now + 1500;
      console.log(`Missed wake inferred by LLM (intent=${inferred.type}) — emitting error earcon`);
      void this.playFastCue('error');
    } finally {
      this.ctx.missedWakeAnalysisInFlight = false;
    }
  }

  private cueFailedWakeIfNeeded(transcript: string): void {
    if (!this.shouldCueFailedWake(transcript)) return;
    const now = Date.now();
    if (now < this.ctx.failedWakeCueCooldownUntil) return;
    this.ctx.failedWakeCueCooldownUntil = now + 1500;
    console.log('Failed-wake guard: emitting error earcon');
    void this.playFastCue('error');
  }

  private getReadyItemsForSession(sessionKey: string, channelName?: string) {
    return this.queueState?.getReadyItems().filter(
      (item) => item.sessionKey === sessionKey || (!!channelName && item.channel === channelName),
    ) ?? [];
  }

  private rememberSwitchAlias(phrase: string): void {
    if (!this.router) return;
    const rememberAlias = (this.router as unknown as {
      rememberSwitchAlias?: (spoken: string, channelId: string, displayName: string) => void;
    }).rememberSwitchAlias;
    if (!rememberAlias) return;

    const active = this.router.getActiveChannel();
    const channelId = active?.channelId;
    if (!channelId) return;
    const displayName = active.displayName || active.name || channelId;
    rememberAlias.call(this.router, phrase, channelId, displayName);
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
    if (!this.ctx.lastPlaybackText || !this.ctx.lastPlaybackCompletedAt) return false;
    if (Date.now() - this.ctx.lastPlaybackCompletedAt > 15_000) return false;

    const spoken = this.normalizeForEcho(this.ctx.lastPlaybackText);
    const heard = this.normalizeForEcho(transcript);
    if (!spoken || !heard) return false;
    if (heard.length < 8) return false;
    if (heard.split(' ').length < 2) return false;

    return spoken.includes(heard);
  }

  private usesIndicateEndpoint(mode: VoiceMode, gatedMode: boolean): boolean {
    const endpointingMode = getVoiceSettings().endpointingMode ?? 'silence';
    const supportedMode = mode === 'wait' || mode === 'queue' || mode === 'ask';
    return endpointingMode === 'indicate' && gatedMode && supportedMode;
  }

  private shouldUseStreamingTranscription(): boolean {
    const s = getVoiceSettings();
    return Boolean(s.audioProcessing === 'local' && s.sttStreamingEnabled);
  }

  private onStreamingPartialTranscript(userId: string, event: StreamingPartialEvent): void {
    const text = event.text.trim();
    if (!text || this.isNonLexicalTranscript(text)) return;
    const clipped = text.length > 120 ? `${text.slice(0, 120)}...` : text;
    console.log(
      `Whisper partial ${event.chunkIndex + 1}/${event.totalChunks} from ${userId}: "${clipped}" (${event.elapsedMs}ms)`,
    );
  }

  private partialCommandKey(command: VoiceCommand): string {
    // Stable key for repeated partial evidence settlement.
    return JSON.stringify(command);
  }

  private shouldSettlePartialCommand(command: VoiceCommand, hits: number): boolean {
    if (command.type === 'pause') return true;
    switch (command.type) {
      case 'read-last-message':
      case 'hear-full-message':
      case 'voice-status':
      case 'voice-channel':
      case 'what-channel':
      case 'settings':
        return hits >= 1;
      default:
        return hits >= 2;
    }
  }

  private classifyIndicateDirectiveTranscript(
    transcript: string,
  ): { kind: 'close' | 'cancel'; reason: 'wake-close' | 'wake-empty' | 'wake-cancel' | 'standalone-code'; stripped: string } | null {
    const hasWakeWord = matchesWakeWord(transcript, config.botName);
    const stripped = hasWakeWord ? this.stripLeadingWakePhrase(transcript) : transcript.trim();
    const normalizedStripped = this.normalizeClosePhrase(stripped);
    const standaloneCodeWake = this.isStandaloneCodeWakePhrase(stripped);

    if (hasWakeWord && this.isCancelIntent(stripped)) {
      return { kind: 'cancel', reason: 'wake-cancel', stripped };
    }

    if (hasWakeWord && normalizedStripped.length === 0) {
      return { kind: 'close', reason: 'wake-empty', stripped };
    }

    if (hasWakeWord && this.isIndicateCloseCommand(stripped)) {
      return { kind: 'close', reason: 'wake-close', stripped };
    }

    if (!hasWakeWord && standaloneCodeWake) {
      return { kind: 'close', reason: 'standalone-code', stripped };
    }

    return null;
  }

  private isIndicateDirectiveTranscript(transcript: string): boolean {
    return this.classifyIndicateDirectiveTranscript(transcript) !== null;
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private normalizeClosePhrase(text: string): string {
    return text
      .toLowerCase()
      .replace(/'/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private stripLeadingWakePhrase(transcript: string): string {
    const extracted = extractFromWakeWord(transcript, config.botName);
    const source = (extracted ?? transcript).trim();
    const trigger = new RegExp(
      `^(?:(?:hey|hello),?\\s+)?${this.escapeRegex(config.botName)}[,.]?\\s*`,
      'i',
    );
    return source.replace(trigger, '').trim();
  }

  private getIndicateClosePhrases(): string[] {
    const raw = getVoiceSettings().indicateCloseWords ?? [];
    const normalized = raw
      .map((word) => this.normalizeClosePhrase(word))
      .filter((word) => word.length > 0);
    return Array.from(new Set(normalized));
  }

  private isIndicateCloseCommand(strippedWakeCommand: string): boolean {
    const normalized = this.normalizeClosePhrase(strippedWakeCommand);
    if (!normalized) return false;
    const closePhrases = this.getIndicateClosePhrases();
    return closePhrases.includes(normalized);
  }

  private isStandaloneCodeWakePhrase(input: string): boolean {
    const normalized = this.normalizeClosePhrase(input);
    if (!normalized) return false;
    const token = normalized.replace(/\s+/g, '');
    if (VoicePipeline.STANDALONE_CODE_WAKE_TOKENS.includes(token)) return true;

    const words = normalized.split(' ').filter(Boolean);
    if (words.length < 2) return false;
    const last = words[words.length - 1];
    const secondLast = words.length > 1 ? words[words.length - 2] : '';
    const splitFoxtrot = secondLast === 'fox' && last === 'trot';
    const endsWithCode = last === 'foxtrot' || splitFoxtrot || last === 'delta';
    if (!endsWithCode) return false;

    const prefixWords = splitFoxtrot ? words.slice(0, -2) : words.slice(0, -1);
    if (prefixWords.length === 0) return false;
    const prefix = prefixWords.join(' ');

    // Whisper sometimes hears "whiskey" as "what is key" near phrase boundaries.
    return /^(?:what(?:s| is)?\s+)?(?:whiskey|whisky|key)$/.test(prefix);
  }

  private armIndicateCaptureTimeout(): void {
    if (!this.ctx.indicateCaptureActive) return;
    const configured = getVoiceSettings().indicateTimeoutMs;
    const timeoutMs = Number.isFinite(configured) ? Math.max(3000, configured) : 20000;
    this.clearIndicateCaptureTimer();
    this.indicateCaptureTimer = setTimeout(() => {
      void this.onIndicateCaptureTimeout();
    }, timeoutMs);
  }

  private async onIndicateCaptureTimeout(): Promise<void> {
    this.indicateCaptureTimer = null;
    if (!this.ctx.indicateCaptureActive) return;
    const now = Date.now();
    const recentSpeechStart = this.receiver.getLastSpeechStartedAt();
    const speechRecentlyStarted = recentSpeechStart > 0
      && now - recentSpeechStart < VoicePipeline.INDICATE_TIMEOUT_ACTIVE_SPEECH_GRACE_MS;
    if (this.receiver.hasActiveSpeech() || speechRecentlyStarted) {
      console.log('Indicate capture timeout deferred (active speech detected)');
      this.armIndicateCaptureTimeout();
      return;
    }
    const segments = this.ctx.indicateCaptureSegments
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    const captured = segments.join(' ').trim();
    this.clearIndicateCapture('timeout');
    if (!captured) return;
    if (segments.length === 1 && this.isLikelyAccidentalIndicateSeed(captured)) {
      console.log('Indicate capture timed out with likely accidental short seed — cleared silently');
      return;
    }
    const closeHint = this.getIndicateClosePhrases()[0] || "I'm done";
    console.log('Indicate capture timed out waiting for close phrase');
    await this.speakResponse(
      `I timed out waiting for the end command. Say ${config.botName} and try again, then say ${config.botName}, ${closeHint}.`,
      { inbox: true },
    );
    await this.playReadyEarcon();
  }

  private startIndicateCapture(initialSegment: string): void {
    const segment = initialSegment.trim();
    this.ctx.indicateCaptureActive = true;
    this.ctx.indicateCaptureSegments = segment ? [segment] : [];
    this.ctx.indicateCaptureStartedAt = Date.now();
    this.ctx.indicateCaptureLastSegmentAt = this.ctx.indicateCaptureStartedAt;
    this.armIndicateCaptureTimeout();
    console.log(`Indicate capture started${segment ? ` (seed=${segment.length} chars)` : ''}`);
  }

  private appendIndicateCaptureSegment(segment: string): void {
    const cleaned = segment.trim();
    if (cleaned.length > 0) {
      this.ctx.indicateCaptureSegments.push(cleaned);
      this.ctx.indicateCaptureLastSegmentAt = Date.now();
      console.log(
        `Indicate capture append (${this.ctx.indicateCaptureSegments.length} segments, +${cleaned.length} chars)`,
      );
    }
    this.armIndicateCaptureTimeout();
  }

  private isLikelyAccidentalIndicateSeed(transcript: string): boolean {
    const normalized = this.normalizeClosePhrase(transcript);
    if (!normalized) return true;
    const words = normalized.split(' ').filter(Boolean);
    // One tiny trailing fragment ("message", "okay", etc.) is usually VAD/STT
    // spillover, not an intentional indicate capture body.
    return words.length <= 1 && normalized.length <= 12;
  }

  private flushIndicateCapture(reason: string): string {
    const transcript = this.ctx.indicateCaptureSegments
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .join(' ')
      .trim();
    this.clearIndicateCapture(reason);
    return transcript;
  }

  private async consumeIndicateCaptureUtterance(
    transcript: string,
  ): Promise<{
    action: 'continue' | 'finalize' | 'cancel' | 'command';
    transcript?: string;
    command?: VoiceCommand;
    commandTranscript?: string;
  }> {
    const hasWakeWord = matchesWakeWord(transcript, config.botName);
    const stripped = hasWakeWord ? this.stripLeadingWakePhrase(transcript) : transcript.trim();
    const standaloneCodeWake = this.isStandaloneCodeWakePhrase(stripped);
    const normalizedStripped = this.normalizeClosePhrase(stripped);

    // Command path: close/cancel only when wake-prefixed, mirroring start gate.
    if (hasWakeWord && this.isCancelIntent(stripped)) {
      this.clearIndicateCapture('cancel-intent');
      await this.speakResponse('Cancelled.', { inbox: true });
      await this.playReadyEarcon();
      return { action: 'cancel' };
    }

    if (hasWakeWord && (normalizedStripped.length === 0 || this.isIndicateCloseCommand(stripped))) {
      const finalized = this.flushIndicateCapture('close-phrase');
      if (!finalized) {
        await this.speakResponse(
          `I heard the end command but no message. Say ${config.botName} and try again.`,
          { inbox: true },
        );
        await this.playReadyEarcon();
        return { action: 'cancel' };
      }
      console.log(`Indicate capture finalized (${finalized.length} chars)`);
      return { action: 'finalize', transcript: finalized };
    }

    // Command precedence while indicate capture is active:
    // wake-prefixed commands should interrupt capture and execute now
    // instead of being appended into dictation.
    if (hasWakeWord) {
      const wakeCommand = parseVoiceCommand(transcript, config.botName);
      if (wakeCommand && wakeCommand.type !== 'wake-check') {
        this.clearIndicateCapture(`wake-command:${wakeCommand.type}`);
        console.log(`Indicate capture interrupted by wake command: ${wakeCommand.type}`);
        return {
          action: 'command',
          command: wakeCommand,
          commandTranscript: transcript,
        };
      }
    }

    // Allow high-confidence bare playback commands to interrupt active indicate
    // capture without wake word. Keep this list narrow to avoid dictation
    // phrases being misread as navigation commands.
    if (!hasWakeWord) {
      const bareCommand = this.matchBareQueueCommand(stripped);
      if (bareCommand && (bareCommand.type === 'read-last-message' || bareCommand.type === 'hear-full-message')) {
        this.clearIndicateCapture(`bare-command:${bareCommand.type}`);
        console.log(`Indicate capture interrupted by bare command: ${bareCommand.type}`);
        return {
          action: 'command',
          command: bareCommand,
          commandTranscript: stripped,
        };
      }
    }

    // Radio-code override for experimentation: allow specific standalone codes
    // to close indicate capture without a wake prefix.
    if (!hasWakeWord && standaloneCodeWake) {
      const finalized = this.flushIndicateCapture('standalone-code-close');
      if (!finalized) {
        await this.speakResponse('I heard the close code but no message content.', { inbox: true });
        await this.playReadyEarcon();
        return { action: 'cancel' };
      }
      console.log(`Indicate capture finalized via standalone code (${finalized.length} chars)`);
      return { action: 'finalize', transcript: finalized };
    }

    // If user says a close/cancel phrase without wake word, ignore it so we
    // don't accidentally append command words into the prompt body.
    if (!hasWakeWord && !standaloneCodeWake && (this.isIndicateCloseCommand(stripped) || this.isCancelIntent(stripped))) {
      console.log('Indicate capture: ignoring non-wake close/cancel phrase');
      return { action: 'continue' };
    }

    // Content path: anything else is treated as dictation, including wake-prefixed text.
    this.appendIndicateCaptureSegment(stripped);
    return { action: 'continue' };
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

    // If mode is already queue/ask (persisted from previous session), start the
    // background inbox poll immediately so text-originated messages get detected.
    const mode = this.queueState?.getMode();
    if (mode === 'queue' || mode === 'ask') {
      this.startInboxPoll();
    }
  }

  async onChannelSwitch(): Promise<void> {
    // Discard any deferred wait response from the previous channel — it belongs
    // to the old context and would be confusing if delivered after the switch.
    this.clearDeferredWaitRetry();

    if (this.router) {
      const routerLogChannel = await this.router.getLogChannel();
      if (routerLogChannel) {
        this.logChannel = routerLogChannel;
      }
      const activeSessionKey = this.router.getActiveSessionKey();
      this.dropIdleNotifications(
        (item) => item.kind === 'text-activity' && item.sessionKey === activeSessionKey,
        'channel-switch',
      );
    }
  }

  start(): void {
    this.receiver.start();
    console.log('Voice pipeline started');
  }

  stop(): void {
    this.receiver.stop();
    this.clearAllTimers();
    this.player.stopPlayback('pipeline-stop');
    resetTransientContext(this.ctx);
    this.stateMachine.destroy();
    console.log('Voice pipeline stopped');
  }

  private clearAllTimers(): void {
    this.clearFastCueQueue();
    this.clearGraceTimer();
    this.clearIndicateCapture('clear-all-timers');
    this.clearDeferredWaitRetry();
    if (this.waitingLoopTimer) {
      clearTimeout(this.waitingLoopTimer);
      this.waitingLoopTimer = null;
    }
    this.player.stopWaitingLoop();
    if (this.stallWatchdogTimer) {
      clearTimeout(this.stallWatchdogTimer);
      this.stallWatchdogTimer = null;
    }
    this.clearIdleNotificationQueue();
    this.stopInboxPoll();
  }

  private clearIndicateCaptureTimer(): void {
    if (this.indicateCaptureTimer) {
      clearTimeout(this.indicateCaptureTimer);
      this.indicateCaptureTimer = null;
    }
  }

  private clearIndicateCapture(reason: string): void {
    this.clearIndicateCaptureTimer();
    if (!this.ctx.indicateCaptureActive && this.ctx.indicateCaptureSegments.length === 0) return;
    console.log(`Indicate capture cleared (${reason})`);
    this.ctx.indicateCaptureActive = false;
    this.ctx.indicateCaptureSegments = [];
    this.ctx.indicateCaptureStartedAt = 0;
    this.ctx.indicateCaptureLastSegmentAt = 0;
  }

  private transitionAndResetWatchdog(event: PipelineEvent): TransitionEffect[] {
    const effects = this.stateMachine.transition(event);
    this.resetStallWatchdog();
    return effects;
  }

  private resetStallWatchdog(): void {
    this.lastTransitionAt = Date.now();
    if (this.stallWatchdogTimer) {
      clearTimeout(this.stallWatchdogTimer);
    }
    this.stallWatchdogTimer = setTimeout(
      () => this.onStallWatchdogFired(),
      VoicePipeline.STALL_WATCHDOG_MS,
    );
  }

  private onStallWatchdogFired(): void {
    this.stallWatchdogTimer = null;
    const stateType = this.stateMachine.getStateType();
    if (stateType === 'IDLE') {
      // Re-arm for next cycle
      this.resetStallWatchdog();
      return;
    }

    // Active playback is not a stall — long TTS responses are legitimate
    // regardless of state (voice commands speak while in PROCESSING).
    if (this.player.isPlaying() || this.player.isWaiting()) {
      this.resetStallWatchdog();
      return;
    }

    this.stallWatchdogFires++;
    this.counters.stallWatchdogFires++;
    const ageMs = Date.now() - this.lastTransitionAt;
    console.warn(
      `Stall watchdog fired: state=${stateType} age=${ageMs}ms fires=${this.stallWatchdogFires} — force-resetting to IDLE`,
    );

    this.clearAllTimers();
    resetTransientContext(this.ctx);
    this.player.stopPlayback('stall-watchdog');
    this.stateMachine.transition({ type: 'RETURN_TO_IDLE' });
    void this.player.playEarcon('error');
    this.resetStallWatchdog();
  }

  private getInvariantContext(): InvariantContext {
    return {
      stateType: this.stateMachine.getStateType(),
      hasStateMachineTimers: this.stateMachine.hasActiveTimers(),
      isPlayerPlaying: this.player.isPlaying(),
      isPlayerWaiting: this.player.isWaiting(),
      waitingLoopTimerActive: this.waitingLoopTimer !== null,
      deferredWaitRetryTimerActive: this.deferredWaitRetryTimer !== null,
      pendingWaitCallback: this.ctx.pendingWaitCallback !== null,
    };
  }

  isPlaying(): boolean {
    return this.player.isPlaying();
  }

  getHealthSnapshot(): HealthSnapshot {
    const stateType = this.stateMachine.getStateType();
    return {
      pipelineState: stateType,
      pipelineStateAge: Date.now() - this.lastTransitionAt,
      uptime: Date.now() - this.startedAt,
      mode: (this.queueState?.getMode() ?? 'wait') as string,
      activeChannel: this.router?.getActiveChannel()?.name ?? null,
      queueReady: this.queueState?.getReadyItems().length ?? 0,
      queuePending: this.queueState?.getPendingItems().length ?? 0,
      gatewayConnected: this.gatewaySync?.isConnected() ?? false,
      gatewayQueueDepth: this.gatewaySync?.getQueueDepth() ?? 0,
      idleNotificationQueueDepth: this.idleNotifyQueue.length,
      idleNotificationProcessing: this.idleNotifyProcessing,
      idleNotificationInFlight: this.ctx.idleNotifyInFlight,
      dependencies: { whisper: 'unknown', tts: 'unknown' },
      counters: { ...this.counters },
    };
  }

  getCounters(): HealthCounters {
    return this.counters;
  }

  getIdleNotificationDiagnostics(limit = 8): IdleNotificationDiagnostics {
    const max = Math.max(1, Math.min(limit, VoicePipeline.IDLE_NOTIFY_EVENT_LIMIT));
    const recentEvents = this.idleNotifyEvents.slice(-max).map((event) => ({ ...event }));
    return {
      queueDepth: this.idleNotifyQueue.length,
      processing: this.idleNotifyProcessing,
      inFlight: this.ctx.idleNotifyInFlight,
      recentEvents,
    };
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
      this.ctx.newPostTimeoutPromptGuardUntil = Date.now() + VoicePipeline.NEW_POST_TIMEOUT_PROMPT_GUARD_MS;
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
    this.counters.utterancesProcessed++;
    // Clear stale speculative queue item (safety net for timeout edge case)
    if (this.ctx.speculativeQueueItemId && !this.stateMachine.getQueueChoiceState()) {
      this.ctx.speculativeQueueItemId = null;
    }

    const stateAtStart = this.stateMachine.getStateType();
    const isSpeakingAtStart = stateAtStart === 'SPEAKING';
    const gatedMode = getVoiceSettings().gated;
    const modeAtCapture = this.queueState?.getMode() ?? 'wait';
    const indicateEndpointAtCapture = this.usesIndicateEndpoint(modeAtCapture, gatedMode);
    const nowAtCapture = Date.now();
    const utteranceStartEstimate = nowAtCapture - Math.max(0, durationMs);
    const graceFromGateAtCapture =
      nowAtCapture < this.ctx.gateGraceUntil ||
      utteranceStartEstimate < (this.ctx.gateGraceUntil + VoicePipeline.READY_HANDOFF_TOLERANCE_MS);
    const graceFromPromptAtCapture =
      nowAtCapture < this.ctx.promptGraceUntil ||
      utteranceStartEstimate < (this.ctx.promptGraceUntil + VoicePipeline.READY_HANDOFF_TOLERANCE_MS);

    // Interrupt TTS playback if user speaks — but don't kill the waiting tone
    const wasPlayingResponse = this.player.isPlaying() && !this.player.isWaiting();

    // Open mode: interrupt immediately. Gated mode: defer until after transcription.
    if (wasPlayingResponse && !gatedMode) {
      console.log('User spoke during playback — interrupting');
      this.player.stopPlayback('speech-during-playback-open-mode');
    }

    const gatedInterrupt = wasPlayingResponse && gatedMode;
    // Allow gated interrupts during PROCESSING too — inbox item readback and
    // voice command responses play TTS while in PROCESSING state, not SPEAKING.
    const gatedSpeakingProbe = gatedInterrupt && (isSpeakingAtStart || stateAtStart === 'PROCESSING');
    const gateClosedCueInterrupt = gatedInterrupt && this.player.isPlayingEarcon('gate-closed');
    let keepCurrentState = false;
    let playedListeningEarly = false;
    let partialWakeWordDetected = false;
    let partialPlaybackStoppedByPartial = false;
    let partialWakeCommandDetected: VoiceCommand | null = null;
    let partialWakeCommandTranscript = '';
    const partialCommandEvidence = new Map<string, number>();
    let partialIndicateDirective:
      { kind: 'close' | 'cancel'; reason: 'wake-close' | 'wake-empty' | 'wake-cancel' | 'standalone-code'; transcript: string } | null | undefined;
    let partialIndicateDirectiveHits = 0;
    let partialIndicateDirectiveKey = '';

    // Check if busy — buffer utterance instead of silently dropping
    if (this.isProcessing() && !gatedSpeakingProbe) {
      if (Date.now() < this.ctx.ignoreProcessingUtterancesUntil) {
        console.log('Ignoring utterance during short post-choice debounce window');
        return;
      }
      // If TTS is actively playing during PROCESSING (e.g. voice command
      // response, speakResponse), any captured audio is speaker bleed or
      // ambient noise — not intentional user input.  Discard it rather than
      // buffering, because replaying it after grace opens produces gibberish
      // prompts.
      if (this.player.isPlaying()) {
        console.log('Discarding utterance captured during active TTS playback (PROCESSING)');
        return;
      }
      console.log('Already processing — buffering utterance');
      const effects = this.transitionAndResetWatchdog({ type: 'UTTERANCE_RECEIVED' });
      this.stateMachine.bufferUtterance(userId, wavBuffer, durationMs);
      await this.applyEffects(effects);
      return;
    }

    // Transition to TRANSCRIBING
    if (!gatedSpeakingProbe) {
      this.transitionAndResetWatchdog({ type: 'UTTERANCE_RECEIVED' });
    }

    // For AWAITING states, play listening earcon immediately — no wake word needed,
    // so we know this is a valid interaction before STT even runs
    const stateType = this.stateMachine.getStateType();
    if (this.stateMachine.isAwaitingState() && !indicateEndpointAtCapture) {
      // Play immediately here (no fast-cue coalescing) so it can't fire late and
      // preempt a near-immediate spoken command response.
      void this.player.playEarcon('listening');
      playedListeningEarly = true;
    } else if (
      gatedMode
      && (graceFromGateAtCapture || graceFromPromptAtCapture)
      && !indicateEndpointAtCapture
    ) {
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
      if (!gatedMode && !isAwaiting && modeAtCapture === 'wait') {
        this.startWaitingLoop();
      }

      // Step 1: Speech-to-text
      const settings = getVoiceSettings();
      let transcript = await transcribe(
        wavBuffer,
        this.shouldUseStreamingTranscription()
          ? {
            enablePartials: true,
            chunkMs: settings.sttStreamingChunkMs,
            minChunkMs: settings.sttStreamingMinChunkMs,
            overlapMs: settings.sttStreamingOverlapMs,
            maxChunks: settings.sttStreamingMaxChunks,
            onPartial: (event) => {
              this.onStreamingPartialTranscript(userId, event);
              const partialText = event.text.trim();
              if (!partialText) return;

              const partialCmd = parseVoiceCommand(partialText, config.botName);
              const partialHasWake = partialCmd !== null || matchesWakeWord(partialText, config.botName);
              if (partialHasWake) {
                partialWakeWordDetected = true;
              }
              if (partialCmd && partialCmd.type !== 'wake-check') {
                const key = this.partialCommandKey(partialCmd);
                const hits = (partialCommandEvidence.get(key) ?? 0) + 1;
                partialCommandEvidence.set(key, hits);
                if (this.shouldSettlePartialCommand(partialCmd, hits)) {
                  partialWakeCommandDetected = partialCmd;
                  partialWakeCommandTranscript = partialText;
                }
              }

              if (indicateEndpointAtCapture && this.ctx.indicateCaptureActive) {
                const directive = this.classifyIndicateDirectiveTranscript(partialText);
                if (directive) {
                  const directiveKey = `${directive.kind}:${directive.reason}:${this.normalizeClosePhrase(directive.stripped)}`;
                  if (directiveKey === partialIndicateDirectiveKey) {
                    partialIndicateDirectiveHits += 1;
                  } else {
                    partialIndicateDirectiveKey = directiveKey;
                    partialIndicateDirectiveHits = 1;
                  }
                  const settleHits = directive.reason === 'wake-empty' ? 2 : 1;
                  if (partialIndicateDirectiveHits >= settleHits) {
                    partialIndicateDirective = {
                      kind: directive.kind,
                      reason: directive.reason,
                      transcript: partialText,
                    };
                  }
                }
              }

              // During active playback, partials should only preempt on an explicit
              // wake-word command, not wake-check alone.
              const partialInterruptCommand =
                partialCmd && partialCmd.type !== 'wake-check'
                  ? partialCmd
                  : null;
              if (!gatedMode || !wasPlayingResponse || !partialInterruptCommand || partialPlaybackStoppedByPartial) return;
              if (this.player.isPlaying() && !this.player.isWaiting()) {
                console.log(`Gated interrupt: command confirmed by streaming partial (${partialInterruptCommand.type})`);
                this.player.stopPlayback('speech-during-playback-gated-partial-command');
                partialPlaybackStoppedByPartial = true;
              }
            },
          }
          : undefined,
      );
      if (!transcript || transcript.trim().length === 0) {
        if (partialWakeCommandDetected && partialWakeCommandTranscript) {
          transcript = partialWakeCommandTranscript;
          const clipped = transcript.length > 120 ? `${transcript.slice(0, 120)}...` : transcript;
          console.log(`Using streaming partial command transcript fallback: "${clipped}"`);
        } else {
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
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
          return;
        }
      }

      if (this.isNonLexicalTranscript(transcript)) {
        console.log(`Non-lexical transcript ignored: "${transcript}"`);
        this.stopWaitingLoop();
        if (this.stateMachine.isAwaitingState()) {
          await this.playReadyEarcon();
        } else if (gatedSpeakingProbe) {
          keepCurrentState = true;
        } else {
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
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
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        }
        return;
      }

      this.transitionAndResetWatchdog({ type: 'TRANSCRIPT_READY', transcript });

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
        await this.handleNewPostStep(transcript);
        const totalMs = Date.now() - pipelineStart;
        console.log(`Voice command (new-post flow) complete: ${totalMs}ms total`);
        return;
      }

      // Gate check: in gated mode, discard utterances that don't start with the wake word
      // Grace period: skip gate for 5s after Watson finishes speaking
      // While a wait callback is pending, require wake word in gated mode.
      // Grace windows are intended for explicit "your turn" handoffs, not
      // background processing where accidental noises can cause interruptions.
      const mode = modeAtCapture;
      const indicateEnabled = this.usesIndicateEndpoint(mode, gatedMode);
      const inInboxFlow = this.stateMachine.getStateType() === 'INBOX_FLOW';
      if (!indicateEnabled && this.ctx.indicateCaptureActive) {
        this.clearIndicateCapture('mode-disabled');
      }

      let indicateFinalized = false;
      if (indicateEnabled && this.ctx.indicateCaptureActive) {
        if (
          partialIndicateDirective
          && !this.isIndicateDirectiveTranscript(transcript)
        ) {
          transcript = partialIndicateDirective.transcript;
          const clipped = transcript.length > 120 ? `${transcript.slice(0, 120)}...` : transcript;
          console.log(
            `Using streaming partial indicate ${partialIndicateDirective.kind} fallback (${partialIndicateDirective.reason}): "${clipped}"`,
          );
        }

        const indicateResult = await this.consumeIndicateCaptureUtterance(transcript);
        if (indicateResult.action === 'continue') {
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
          return;
        }
        if (indicateResult.action === 'cancel') {
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
          return;
        }
        if (indicateResult.action === 'command' && indicateResult.command) {
          await this.playFastCue('listening');
          const resolvedCommand = this.resolveDoneCommandForContext(
            indicateResult.command,
            indicateResult.commandTranscript ?? transcript,
          );
          await this.handleVoiceCommand(resolvedCommand, userId);
          const totalMs = Date.now() - pipelineStart;
          console.log(`Voice command (indicate capture) complete: ${totalMs}ms total`);
          return;
        }
        transcript = indicateResult.transcript ?? '';
        indicateFinalized = true;
      }

      const allowGraceBypass = this.ctx.pendingWaitCallback === null;
      const standaloneCodeWake = indicateFinalized ? false : this.isStandaloneCodeWakePhrase(transcript);
      const hasWakeWord = indicateFinalized
        ? true
        : (matchesWakeWord(transcript, config.botName) || standaloneCodeWake);
      const effectiveWakeWord = hasWakeWord || partialWakeWordDetected;
      const inGracePeriod = indicateFinalized
        ? true
        : (
          allowGraceBypass &&
          (
            graceFromGateAtCapture ||
            graceFromPromptAtCapture ||
            Date.now() < (this.ctx.gateGraceUntil + VoicePipeline.READY_HANDOFF_TOLERANCE_MS) ||
            Date.now() < (this.ctx.promptGraceUntil + VoicePipeline.READY_HANDOFF_TOLERANCE_MS)
          )
        );
      const interruptGraceEligible = indicateFinalized || (allowGraceBypass && (graceFromGateAtCapture || graceFromPromptAtCapture));

      // By design in gated mode, interrupting active playback must include wake word.
      if (gatedInterrupt && !effectiveWakeWord && !gateClosedCueInterrupt && !interruptGraceEligible) {
        console.log(`Gated interrupt rejected (wake word required): "${transcript}"`);
        if (gatedSpeakingProbe) {
          keepCurrentState = true;
        } else {
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        }
        return;
      }
      if (gatedMode && !inGracePeriod && !effectiveWakeWord) {
        if (gatedInterrupt) {
          console.log(`Gated: discarded interrupt "${transcript}"`);
          // Don't stop playback — Watson keeps talking
          if (gatedSpeakingProbe) {
            keepCurrentState = true;
          } else {
            this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
          }
          this.cueFailedWakeIfNeeded(transcript);
        } else if (this.ctx.pendingWaitCallback) {
          console.log(`Gated: discarded "${transcript}" (wait processing continues)`);
          this.cueFailedWakeIfNeeded(transcript);
          void this.maybeCueMissedWakeFromLLM(transcript, mode, inGracePeriod);
          // Don't stop waiting loop — pending wait callback is active
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        } else if (mode !== 'wait' || inInboxFlow) {
          // In queue/ask mode, allow bare navigation commands (next, inbox check,
          // etc.) through the gate without requiring the wake word. In INBOX_FLOW
          // this also applies while mode is wait, so navigation stays hands-free.
          const bareCommand = this.matchBareQueueCommand(transcript);
          if (bareCommand) {
            const resolved = this.resolveDoneCommandForContext(bareCommand, transcript);
            const bypassLabel = inInboxFlow && mode === 'wait' ? 'inbox-flow bare command' : `${mode} mode bare command`;
            console.log(`Gate bypass (${bypassLabel}): ${resolved.type}`);
            await this.playFastCue('listening');
            await this.handleVoiceCommand(resolved, userId);
            return;
          } else {
            const contextLabel = inInboxFlow && mode === 'wait' ? 'inbox-flow' : `${mode} mode`;
            console.log(`Gated: discarded "${transcript}" (no bare command match in ${contextLabel})`);
            if (this.looksLikeBareCommandAttempt(transcript)) {
              const now = Date.now();
              if (now >= this.ctx.failedWakeCueCooldownUntil) {
                this.ctx.failedWakeCueCooldownUntil = now + 1500;
                console.log('Failed command attempt without wake word: emitting error earcon');
                void this.playFastCue('error');
              }
            } else {
              this.cueFailedWakeIfNeeded(transcript);
              void this.maybeCueMissedWakeFromLLM(transcript, mode, inGracePeriod);
            }
            this.stopWaitingLoop();
            this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
            return;
          }
        } else {
          console.log(`Gated: discarded "${transcript}"`);
          if (this.looksLikeBareCommandAttempt(transcript)) {
            const now = Date.now();
            if (now >= this.ctx.failedWakeCueCooldownUntil) {
              this.ctx.failedWakeCueCooldownUntil = now + 1500;
              console.log('Failed command attempt without wake word: emitting error earcon');
              void this.playFastCue('error');
            }
          } else {
            this.cueFailedWakeIfNeeded(transcript);
            void this.maybeCueMissedWakeFromLLM(transcript, mode, inGracePeriod);
          }
          this.stopWaitingLoop();
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        }
        return;
      }

      // Strip preamble when wake word was found mid-transcript (Whisper artifact)
      if (hasWakeWord) {
        const extracted = extractFromWakeWord(transcript, config.botName);
        if (extracted && extracted.length < transcript.trim().length) {
          console.log(`Wake word found mid-transcript, stripped preamble: "${extracted.slice(0, 100)}${extracted.length > 100 ? '...' : ''}"`);
          transcript = extracted;
        }
      }

      const parsedCommand = parseVoiceCommand(transcript, config.botName);
      const preParsedCommand: VoiceCommand | null = parsedCommand
        ?? partialWakeCommandDetected
        ?? (standaloneCodeWake ? { type: 'wake-check' } : null);
      const bareCommandInGrace = !effectiveWakeWord && inGracePeriod
        ? this.matchBareQueueCommand(transcript)
        : null;
      const indicateStartEligible = hasWakeWord || inGracePeriod;
      if (indicateEnabled && !indicateFinalized && indicateStartEligible && !this.ctx.indicateCaptureActive) {
        const shouldStartFromWake = hasWakeWord && (!preParsedCommand || preParsedCommand.type === 'wake-check');
        const shouldStartFromGrace = !hasWakeWord && inGracePeriod && !bareCommandInGrace;
        if (shouldStartFromWake || shouldStartFromGrace) {
          const seed = shouldStartFromWake
            ? (
              preParsedCommand?.type === 'wake-check'
                ? ''
                : this.stripLeadingWakePhrase(transcript)
            )
            : transcript.trim();
          this.startIndicateCapture(seed);
          if (preParsedCommand?.type === 'wake-check') {
            this.stopWaitingLoop();
            this.playReadyEarconSync();
          }
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
          return;
        }
      }
      const suppressListeningCue = preParsedCommand?.type === 'wake-check';

      // Valid interaction confirmed — play listening earcon and wait for it to finish
      this.clearGraceTimer();
      if (!playedListeningEarly && !suppressListeningCue) {
        await this.playFastCue('listening');
      }
      if (graceFromPromptAtCapture || Date.now() < this.ctx.promptGraceUntil) {
        this.ctx.promptGraceUntil = 0;
      }

      // Gated mode: passed gate check — start waiting loop now
      // Skip in ask mode — no LLM processing, Watson just speaks "Inbox, or wait?"
      if (gatedMode) {
        if (inGracePeriod && !effectiveWakeWord) {
          console.log('Gate grace period: processing without wake word');
        }
        if (gatedInterrupt) {
          if (partialPlaybackStoppedByPartial) {
            // Playback was already stopped by partial STT; preserve the
            // interrupt semantics without issuing another stop.
          } else if (gateClosedCueInterrupt && !effectiveWakeWord) {
            console.log('Gated interrupt: allowing speech over gate-closed cue');
            this.player.stopPlayback('speech-over-gate-closed-cue');
          } else if (!effectiveWakeWord && interruptGraceEligible) {
            console.log('Gated interrupt: accepted during ready handoff grace');
            this.player.stopPlayback('speech-during-playback-gated-grace');
          } else {
            console.log('Gated interrupt: wake word confirmed, interrupting playback');
            this.player.stopPlayback('speech-during-playback-gated-wake');
          }
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
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
      if (!indicateFinalized && (mode !== 'wait' || inGracePeriod)) {
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
      const allowLlmInference = !(gatedInterrupt && !effectiveWakeWord);
      const runClassifier = allowLlmInference && this.shouldRunCommandClassifier(transcript);
      if (allowLlmInference && !runClassifier) {
        console.log('Skipping LLM command classifier for likely prompt utterance');
      }
      this.lastClassifierTimedOut = false;
      const inferredCommand = runClassifier
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

      // Guard: discard likely-noise utterances that reached the prompt handler
      // without wake word.  When the classifier timed out we have zero signal —
      // short fragments are almost certainly filler ("Bye", "Mm", half-sentences).
      // Even without a timeout, single-word non-commands are never useful prompts.
      if (!effectiveWakeWord) {
        const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
        const threshold = this.lastClassifierTimedOut ? 5 : 2;
        if (wordCount < threshold) {
          console.log(
            `Discarding short non-command utterance (${wordCount} words, classifierTimeout=${this.lastClassifierTimedOut}): "${transcript.trim()}"`,
          );
          void this.playFastCue('error');
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
          return;
        }
      }

      if (Date.now() < this.ctx.newPostTimeoutPromptGuardUntil) {
        const remainingMs = this.ctx.newPostTimeoutPromptGuardUntil - Date.now();
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

      this.transitionAndResetWatchdog({ type: 'PROCESSING_STARTED' });
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
      this.counters.errors++;
      const dependencyIssue = this.classifyDependencyIssue(error);
      if (dependencyIssue) {
        if (dependencyIssue.type === 'stt') this.counters.sttFailures++;
        if (dependencyIssue.type === 'tts') this.counters.ttsFailures++;
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
        this.transitionAndResetWatchdog({ type: 'PROCESSING_COMPLETE' });
      }

      // Run invariant checks
      const violations = checkPipelineInvariants(this.getInvariantContext());
      this.counters.invariantViolations += violations.length;

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
    // Suppress noise-triggered reprompts during the grace window after a ready cue.
    // The earcon itself can cause echo/noise that gets picked up as a short utterance,
    // leading to confusing error + reprompt sequences before the user has a chance to speak.
    const now = Date.now();
    if (now < this.ctx.gateGraceUntil || now < this.ctx.promptGraceUntil) {
      console.log(`Rejected audio ignored during grace window from ${userId} (${durationMs}ms) [gateGrace=${this.ctx.gateGraceUntil - now}ms promptGrace=${this.ctx.promptGraceUntil - now}ms]`);
      return;
    }
    // Secondary guard: suppress noise that arrives shortly after any playback
    // finishes. Earcon echo and ambient noise from TTS can trigger false
    // rejections before the user has had time to speak. The grace window
    // above handles the normal case, but edge-case timing (noise captured
    // during TTS when grace was cleared, callback arriving just after grace
    // is re-set) can slip through. A 2-second post-playback cooldown
    // catches these stragglers.
    const POST_PLAYBACK_REJECT_COOLDOWN_MS = 2_000;
    if (this.ctx.lastPlaybackCompletedAt > 0 && now - this.ctx.lastPlaybackCompletedAt < POST_PLAYBACK_REJECT_COOLDOWN_MS) {
      console.log(`Rejected audio ignored (post-playback cooldown, ${now - this.ctx.lastPlaybackCompletedAt}ms since playback) from ${userId} (${durationMs}ms)`);
      return;
    }
    if (durationMs > VoicePipeline.MAX_REJECTED_REPROMPT_MS) {
      console.log(`Rejected audio ignored (too long for reprompt) from ${userId} (${durationMs}ms)`);
      return;
    }
    if (this.ctx.rejectRepromptInFlight) return;
    if (Date.now() < this.ctx.rejectRepromptCooldownUntil) return;

    this.ctx.rejectRepromptInFlight = true;
    this.ctx.rejectRepromptCooldownUntil = Date.now() + 5000;
    console.log(`Rejected low-confidence audio during ${st} from ${userId} (${durationMs}ms)`);

    void (async () => {
      try {
        const effects = this.transitionAndResetWatchdog({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
        await this.applyEffects(effects);
        await this.playReadyEarcon();
      } finally {
        this.ctx.rejectRepromptInFlight = false;
      }
    })();
  }

  private async handleVoiceCommand(command: VoiceCommand, userId = 'voice-user'): Promise<void> {
    this.counters.commandsRecognized++;
    // Any explicit command means user intent is clear; clear transient post-timeout guard.
    this.ctx.newPostTimeoutPromptGuardUntil = 0;
    this.ctx.followupPromptGraceUntil = 0;
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
      case 'indicate-timeout':
        await this.handleIndicateTimeout(command.valueMs);
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
      case 'endpoint-mode':
        await this.handleEndpointMode(command.mode);
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

    this.transitionAndResetWatchdog({
      type: 'ENTER_NEW_POST_FLOW',
      step: 'forum',
    });

    await this.speakResponse('Which forum?');
    await this.playReadyEarcon();
  }

  private async handleNewPostStep(transcript: string): Promise<void> {
    const flowState = this.stateMachine.getNewPostFlowState();
    if (!flowState || !this.router) return;

    const { step } = flowState;

    if (step === 'forum') {
      const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');

      // Check for cancel
      if (this.isCancelIntent(input)) {
        const effects = this.transitionAndResetWatchdog({ type: 'CANCEL_FLOW' });
        await this.applyEffects(effects);
        await this.speakResponse('Cancelled.');
        return;
      }

      // Check for list channels request
      if (/\b(?:list|show|what are|which)\b.*\b(?:channel|channels|forum|forums|options)\b/.test(input) || /\b(?:list)\b/.test(input)) {
        const forums = this.router.listForumChannels();
        const names = forums.map((f) => f.name).join(', ');
        await this.repromptAwaiting();
        await this.speakResponse(`Available forums: ${names}. Which one?`);
        await this.playReadyEarcon();
        return;
      }

      const match = this.router.findForumChannel(input);
      if (!match) {
        await this.repromptAwaiting();
        await this.speakResponse(`I couldn't find a forum matching "${transcript}". Try again, or say cancel.`);
        await this.playReadyEarcon();
        return;
      }

      this.transitionAndResetWatchdog({
        type: 'NEW_POST_ADVANCE',
        step: 'title',
        forumId: match.id,
        forumName: match.name,
      });

      await this.player.playEarcon('acknowledged');
      await this.speakResponse(`Got it, ${match.name}. What should the post be called?`);
      await this.playReadyEarcon();
      return;
    }

    if (step === 'title') {
      const input = transcript.trim().replace(/[.!?]+$/, '');

      if (this.isCancelIntent(input)) {
        const effects = this.transitionAndResetWatchdog({ type: 'CANCEL_FLOW' });
        await this.applyEffects(effects);
        await this.speakResponse('Cancelled.');
        return;
      }

      const { forumId, forumName } = flowState;

      // Use a generic activation body that invites the agent to respond
      // quickly, bootstrapping the gateway session. The natural latency of
      // TTS confirmation + the user formulating their prompt gives the agent
      // time to reply before the first real voice interaction arrives.
      const activationBody = 'New voice thread. Let me know when you\'re ready.';
      const result = await this.router.createForumPost(forumId!, input, activationBody);
      if (result.success) {
        await this.onChannelSwitch();
        console.log(`Created forum post "${input}" in ${result.forumName}, switched to thread ${result.threadId}`);
        // Suppress notifications BEFORE any playback so the activation
        // body response can't slip through during the TTS await gap.
        this.setPromptGrace(15_000);
        await this.player.playEarcon('acknowledged');
        await this.speakResponse(`Created ${input} in ${forumName}. Go ahead.`);
        // Return to IDLE only after all confirmation audio is queued so
        // deferred notifications can't sneak in during post creation.
        this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        await this.playReadyEarcon();
      } else {
        this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        console.warn(`Forum post creation failed: ${result.error}`);
        await this.speakResponse(`Sorry, I couldn't create the post. ${result.error}`);
      }
    }
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
      const fuzzyMatches = allChannels.filter((c) => this.channelNamesMatch(channelName, c.name, c.displayName));

      // If multiple fuzzy matches, prefer an exact name match
      let match: typeof allChannels[number] | undefined;
      if (fuzzyMatches.length === 1) {
        match = fuzzyMatches[0];
      } else if (fuzzyMatches.length > 1) {
        const inputNorm = channelName.trim().toLowerCase();
        match = fuzzyMatches.find(
          (c) => c.name.toLowerCase() === inputNorm || c.displayName.toLowerCase() === inputNorm,
        );
        // No exact match among multiple fuzzy hits → fall through to LLM disambiguation
      }

      // Atlas-backed phrase memory: resolve previously successful spoken aliases
      // before invoking slower dynamic/LLM matching.
      if (!match) {
        const lookupAlias = (this.router as unknown as {
          lookupSwitchAlias?: (query: string) => Promise<{ channelId: string; displayName: string } | null>;
        }).lookupSwitchAlias;
        const cachedAlias = lookupAlias
          ? await lookupAlias.call(this.router, channelName)
          : null;
        if (cachedAlias) {
          console.log(`Alias cache match: "${channelName}" → ${cachedAlias.channelId}`);
          const aliasResult = await this.router.switchTo(cachedAlias.channelId);
          if (aliasResult.success) {
            await this.onChannelSwitch();
            this.rememberSwitchAlias(channelName);
            const displayName = aliasResult.displayName || cachedAlias.displayName || channelName;
            await this.speakResponse(`Switched to ${displayName}.`, { inbox: true });
            await this.playReadyEarcon();
            this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
            return;
          }
        }
      }

      // Fallback: scan guild sendable channels/threads directly by name so
      // non-static channels can resolve without waiting on LLM matching.
      if (!match) {
        const findDirectChannel = (this.router as unknown as {
          findSendableChannelByName?: (query: string) => Promise<{ id: string; displayName: string } | null>;
        }).findSendableChannelByName;
        const directMatch = findDirectChannel
          ? await findDirectChannel.call(this.router, channelName)
          : null;
        if (directMatch) {
          console.log(`Direct guild channel match: "${channelName}" → ${directMatch.id}`);
          const directResult = await this.router.switchTo(directMatch.id);
          if (directResult.success) {
            await this.onChannelSwitch();
            this.rememberSwitchAlias(channelName);
            const displayName = directResult.displayName || directMatch.displayName || channelName;
            await this.speakResponse(`Switched to ${displayName}.`, { inbox: true });
            await this.playReadyEarcon();
            this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
            return;
          }
        }
      }

      // LLM fallback: if string matching failed or was ambiguous, ask the utility model (include forum threads)
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
                this.rememberSwitchAlias(channelName);
                const displayName = threadResult.displayName || llmResult.best.displayName;
                await this.speakResponse(`Switched to ${displayName}.`, { inbox: true });
                await this.playReadyEarcon();
                this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
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

            this.transitionAndResetWatchdog({
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
        this.rememberSwitchAlias(channelName);
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
                this.transitionAndResetWatchdog({ type: 'INBOX_ADVANCE' });
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
          this.markInboxSessionSeen(sessionKey, currentCount);
        }
      } else {
        responseText = `I couldn't find a channel called ${channelName}.`;
      }

      await this.speakResponse(responseText, { inbox: true });
      await this.playReadyEarcon();
      if (result.success) {
        this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
      }
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

      const signal = AbortSignal.timeout(3000);
      const result = await quickCompletion(
        `You are a channel matcher. Given a list of channels and a user description, rank the top matches.
Reply in this exact format:
- If one channel is a clear match: BEST: channel_name
- If 2-3 channels could match: OPTIONS: channel1, channel2, channel3
- If nothing matches: NONE
Use channel names (the part before the colon). Do not explain.`,
        `Channels:\n${channelList}\n\nUser wants: "${userPhrase}"`,
        120,
        signal,
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
    this.transitionAndResetWatchdog({
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
    this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
    await this.acknowledgeAwaitingChoice();

    const result = await this.router.switchTo(selected.name);
    if (result.success) {
      await this.onChannelSwitch();
      await this.speakResponse(this.buildSwitchConfirmation(result.displayName || selected.displayName));
      await this.playReadyEarcon();
      this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
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
      await this.playReadyEarcon();
      this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
    } else {
      await this.speakResponse("I couldn't switch to the default channel.");
      await this.playReadyEarcon();
    }
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

  private async handleIndicateTimeout(valueMs: number): Promise<void> {
    const clamped = Math.max(10_000, Math.min(60 * 60 * 1000, valueMs));
    setIndicateTimeoutMs(clamped);
    if (this.ctx.indicateCaptureActive) {
      this.armIndicateCaptureTimeout();
    }
    const timeoutLabel = clamped % 60_000 === 0
      ? `${clamped / 60_000} minute${clamped === 60_000 ? '' : 's'}`
      : `${Math.round(clamped / 1000)} seconds`;
    await this.speakResponse(`Indicate timeout set to ${timeoutLabel}.`);
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
    const closeCommands = s.indicateCloseWords ?? [];
    const streamingText = s.sttStreamingEnabled
      ? `Streaming transcription: on, ${s.sttStreamingChunkMs} millisecond chunks.`
      : 'Streaming transcription: off.';
    const endpointText = s.endpointingMode === 'indicate'
      ? `Endpointing: indicate. End command examples: ${
        closeCommands.length > 0
          ? closeCommands.slice(0, 2).map((c) => `${config.botName}, ${c}`).join(' or ')
          : `${config.botName}, I'm done`
      }, or just ${config.botName}. Timeout: ${Math.round(s.indicateTimeoutMs / 1000)} seconds.`
      : 'Endpointing: silence.';
    await this.speakResponse(
      `Audio processing: ${s.audioProcessing}. ` +
      `${endpointText} ` +
      `${streamingText} ` +
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

    // Notification diagnostics
    const notifyQueue = this.idleNotifyQueue.length;
    if (
      notifyQueue > 0
      || this.counters.idleNotificationsDelivered > 0
      || this.counters.idleNotificationsDropped > 0
    ) {
      parts.push(
        `Notifications: ${notifyQueue} queued, ${this.counters.idleNotificationsDelivered} delivered, ${this.counters.idleNotificationsDropped} dropped.`,
      );
    }

    // Voice settings
    const s = getVoiceSettings();
    const presetMap: Record<number, string> = { 300: 'low', 500: 'medium', 800: 'high' };
    const noiseLabel = presetMap[s.speechThreshold] ?? String(s.speechThreshold);
    parts.push(`Noise: ${noiseLabel}. Delay: ${s.silenceDurationMs} milliseconds.`);
    parts.push(`Audio: ${s.audioProcessing}.`);
    if (s.endpointingMode === 'indicate') {
      parts.push(`Endpointing: indicate (${Math.round(s.indicateTimeoutMs / 1000)} second timeout).`);
    } else {
      parts.push('Endpointing: silence.');
    }
    if (s.sttStreamingEnabled) {
      parts.push(`Streaming STT: on (${s.sttStreamingChunkMs} millisecond chunks).`);
    } else {
      parts.push('Streaming STT: off.');
    }

    // Gateway connection
    const gwState = this.gatewaySync?.getConnectionState?.() ?? 'disconnected';
    parts.push(`Gateway: ${gwState}.`);

    // Error count
    if (this.counters.errors > 0) {
      parts.push(`${this.counters.errors} errors since start.`);
    }

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
    await this.speakResponse(raw, { inbox: true, allowSummary: true, isChannelMessage: true });
    await this.playReadyEarcon();
    // Start follow-up grace after the ready cue so long readbacks don't
    // consume the entire window before the user can respond.
    this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
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
    const matches = all.filter((c) => this.channelNamesMatch(channelQuery, c.name, c.displayName));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const inputNorm = channelQuery.trim().toLowerCase();
      return matches.find(
        (c) => c.name.toLowerCase() === inputNorm || c.displayName.toLowerCase() === inputNorm,
      ) ?? matches[0]; // For dispatch, prefer exact match but fall back to first if none
    }
    return null;
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
    if (this.ctx.pendingWaitCallback) {
      console.log(`Cancelling pending wait (${reason})`);
      this.ctx.pendingWaitCallback = null;
      this.ctx.activeWaitQueueItemId = null;
      this.ctx.quietPendingWait = false;
      this.stopWaitingLoop();
      // Queue item stays as pending/ready — shows up in inbox
    }
  }

  private async handleSilentWait(): Promise<void> {
    if (!this.ctx.pendingWaitCallback) {
      await this.speakResponse('Nothing is processing right now.', { inbox: true });
      await this.playReadyEarcon();
      return;
    }

    this.ctx.quietPendingWait = true;
    this.stopWaitingLoop();
    console.log('Silent wait enabled for active processing item');
  }

  private deliverWaitResponse(responseText: string): void {
    void (async () => {
      try {
        this.stopWaitingLoop();
        this.player.stopPlayback('wait-response-delivery');
        if (!this.isBusy() || this.player.isWaiting()) {
          this.transitionAndResetWatchdog({ type: 'SPEAKING_STARTED' });
          await this.speakResponse(responseText, { allowSummary: true, forceFull: false, isChannelMessage: true });
          this.transitionAndResetWatchdog({ type: 'SPEAKING_COMPLETE' });
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
    this.ctx.deferredWaitResponseText = responseText;
    if (this.deferredWaitRetryTimer) return;
    this.deferredWaitRetryTimer = setInterval(() => {
      if (!this.ctx.deferredWaitResponseText) {
        this.clearDeferredWaitRetry();
        return;
      }
      if (this.isBusy() || this.player.isPlaying()) {
        return;
      }
      const text = this.ctx.deferredWaitResponseText;
      this.ctx.deferredWaitResponseText = null;
      this.clearDeferredWaitRetry();
      this.deliverWaitResponse(text);
    }, 700);
  }

  private clearDeferredWaitRetry(): void {
    if (this.deferredWaitRetryTimer) {
      clearInterval(this.deferredWaitRetryTimer);
      this.deferredWaitRetryTimer = null;
    }
    this.ctx.deferredWaitResponseText = null;
  }

  private sawRecentSpeechStart(): boolean {
    const lastStartAt = this.receiver.getLastSpeechStartedAt();
    if (lastStartAt <= 0) return false;
    return Date.now() - lastStartAt <= VoicePipeline.READY_HANDOFF_TOLERANCE_MS;
  }

  private shouldSuppressGateClosedCue(): boolean {
    if (this.receiver.hasActiveSpeech()) return true;
    if (this.sawRecentSpeechStart()) return true;
    return false;
  }

  private setGateGrace(ms: number): void {
    this.clearGateCloseCueTimer();
    this.ctx.gateGraceUntil = Date.now() + ms;
    this.scheduleGraceExpiry();
  }

  private setPromptGrace(ms: number): void {
    this.clearGateCloseCueTimer();
    this.ctx.promptGraceUntil = Date.now() + ms;
    this.scheduleGraceExpiry();
  }

  private allowFollowupPromptGrace(ms: number): void {
    this.ctx.followupPromptGraceUntil = Date.now() + Math.max(0, ms);
  }

  private scheduleGraceExpiry(): void {
    if (this.graceExpiryTimer) {
      clearTimeout(this.graceExpiryTimer);
      this.graceExpiryTimer = null;
    }
    if (!getVoiceSettings().gated) return;
    const latestGrace = Math.max(this.ctx.gateGraceUntil, this.ctx.promptGraceUntil);
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
    this.clearGateCloseCueTimer();
  }

  private clearGateCloseCueTimer(): void {
    if (this.gateCloseCueTimer) {
      clearTimeout(this.gateCloseCueTimer);
      this.gateCloseCueTimer = null;
    }
  }

  private onGraceExpired(): void {
    if (!getVoiceSettings().gated) return;
    if (this.ctx.pendingWaitCallback) return;
    if (this.ctx.indicateCaptureActive) return;
    if (this.isBusy() || this.player.isPlaying()) return;
    const latestGrace = Math.max(this.ctx.gateGraceUntil, this.ctx.promptGraceUntil);
    if (latestGrace > Date.now()) return;
    if (this.shouldSuppressGateClosedCue()) {
      console.log(`${this.stamp()} Grace period expired during active speech — suppressing gate-closed cue`);
      return;
    }
    this.clearGateCloseCueTimer();
    this.gateCloseCueTimer = setTimeout(() => {
      this.gateCloseCueTimer = null;
      if (!getVoiceSettings().gated) return;
      if (this.ctx.pendingWaitCallback) return;
      if (this.ctx.indicateCaptureActive) return;
      if (this.isBusy() || this.player.isPlaying()) return;
      const graceNow = Math.max(this.ctx.gateGraceUntil, this.ctx.promptGraceUntil);
      if (graceNow > Date.now()) return;
      if (this.shouldSuppressGateClosedCue()) {
        console.log(`${this.stamp()} Grace period expired during active speech (holdoff) — suppressing gate-closed cue`);
        return;
      }
      console.log(`${this.stamp()} Grace period expired — gate closed`);
      void this.playFastCue('gate-closed');
    }, VoicePipeline.GATE_CLOSE_CUE_HOLDOFF_MS);
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
      this.ctx.activeWaitQueueItemId = item.id;
      this.ctx.quietPendingWait = false;
      this.ctx.pendingWaitCallback = (responseText: string) => {
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
    const responseText = this.sanitizeAssistantOutput(response, `wait-fallback:${channelName ?? 'default'}`);

    this.log(`**${config.botName}:** ${responseText}`, channelName);
    this.session.appendAssistantMessage(responseText, channelName);

    await this.persistVoiceExchange({
      sessionKey: this.router?.getActiveSessionKey() ?? null,
      channelName: channelName ?? 'default',
      transcript,
      response: responseText,
      source: 'wait-fallback',
    });

    this.stopWaitingLoop();
    this.transitionAndResetWatchdog({ type: 'SPEAKING_STARTED' });
    await this.speakResponse(responseText, { allowSummary: true, forceFull: false, isChannelMessage: true });
    this.transitionAndResetWatchdog({ type: 'SPEAKING_COMPLETE' });
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
      this.transitionAndResetWatchdog({
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

    this.ctx.speculativeQueueItemId = item.id;
    this.dispatchToLLMFireAndForget(userId, transcript, item.id, {
      channelName,
      displayName,
      sessionKey,
      systemPrompt: this.router.getSystemPrompt(),
    });

    // Enter choice state and prompt user — LLM works in parallel
    // OpenClaw sync happens in the dispatch completion handler to avoid gateway conflicts
    this.transitionAndResetWatchdog({
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
    const specId = this.ctx.speculativeQueueItemId;

    const choice = matchQueueChoice(transcript);
    if (choice === 'queue') {
      // Already dispatched speculatively — just confirm
      this.ctx.ignoreProcessingUtterancesUntil = Date.now() + 2500;
      this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
      this.ctx.speculativeQueueItemId = null;

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
      this.ctx.ignoreProcessingUtterancesUntil = Date.now() + 2500;
      this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
      this.ctx.silentWait = true;
      this.ctx.speculativeQueueItemId = null;

      if (specId) {
        await this.player.playEarcon('acknowledged');
      } else {
        await this.handleSilentQueue(userId, originalTranscript);
      }
    } else if (choice === 'wait') {
      this.ctx.ignoreProcessingUtterancesUntil = Date.now() + 2500;
      this.ctx.speculativeQueueItemId = null;

      if (specId && this.queueState) {
        // Check if speculative response is already ready
        const readyItem = this.queueState.getReadyItems().find((i) => i.id === specId);
        if (readyItem) {
          // Instant response — already done
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
          this.queueState.markHeard(specId);
          this.responsePoller?.check();
          this.stopWaitingLoop();
          this.transitionAndResetWatchdog({ type: 'SPEAKING_STARTED' });
          await this.speakResponse(readyItem.responseText, { allowSummary: true, forceFull: false, isChannelMessage: true });
          this.transitionAndResetWatchdog({ type: 'SPEAKING_COMPLETE' });
          await this.playReadyEarcon();
        } else {
          // Not ready yet — register callback and start waiting loop
          this.transitionAndResetWatchdog({ type: 'PROCESSING_STARTED' });
          this.ctx.activeWaitQueueItemId = specId;
          this.ctx.pendingWaitCallback = (responseText: string) => {
            this.deliverWaitResponse(responseText);
          };
          await this.sleep(150);
          this.startWaitingLoop();
          // Return — callback will deliver response when ready
        }
      } else {
        // No speculative dispatch — fall back to synchronous wait
        this.transitionAndResetWatchdog({ type: 'PROCESSING_STARTED' });
        await this.sleep(150);
        this.startWaitingLoop();
        await this.handleWaitMode(userId, originalTranscript);
      }
    } else {
      // Try navigation commands — with or without wake word
      const navCommand = parseVoiceCommand(transcript, config.botName)
        ?? this.matchBareQueueCommand(transcript);
      if (navCommand && (navCommand.type === 'switch' || navCommand.type === 'list' || navCommand.type === 'default' || navCommand.type === 'dispatch')) {
        this.ctx.ignoreProcessingUtterancesUntil = Date.now() + 2500;
        console.log(`Queue choice: navigation (${navCommand.type}), already dispatched speculatively`);
        this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        this.ctx.speculativeQueueItemId = null;

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
      this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
      await this.acknowledgeAwaitingChoice();
      // Read the full last message
      await this.speakResponse(lastMessage, { inbox: true });
      await this.playReadyEarcon();
    } else if (choice === 'prompt') {
      this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
      // Confirm with a ready earcon so user knows Watson is ready
      console.log('Switch choice: prompt');
      this.stopWaitingLoop();
      this.setPromptGrace(15_000);
      this.playReadyEarconSync();
    } else if (choice === 'cancel') {
      const effects = this.transitionAndResetWatchdog({ type: 'CANCEL_FLOW' });
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
        this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
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
    this.counters.llmDispatches++;

    const channelName = target.channelName;
    const displayName = target.displayName;
    const sessionKey = target.sessionKey;
    const systemPrompt = target.systemPrompt;

    // Capture state we need before the async work
    const routerRef = this.router;
    const queueRef = this.queueState;
    const pollerRef = this.responsePoller;
    const session = this.session;

    // Set cool-down BEFORE the LLM call so inbox poll ignores any messages
    // created in this gateway session during processing (getResponse creates
    // unlabeled chat API messages that would otherwise trigger notifications).
    this.recentVoiceDispatchChannels.set(sessionKey, Date.now());

    void (async () => {
      try {
        // Use the originating channel snapshot for history so switches that
        // happen while this item is processing do not cross-contaminate context.
        await routerRef.refreshHistory(channelName);
        const history = routerRef.getHistory(channelName);
        // Always use the logical channel session key for completions. getResponse
        // normalizes/guards against recursive openai-user key nesting.
        const { response, history: updatedHistory } = await getResponse(sessionKey, transcript, {
          systemPrompt,
          history,
        });
        const safeResponse = this.sanitizeAssistantOutput(response, `queue-item:${queueItemId}:${channelName}`);
        if (updatedHistory.length > 0 && updatedHistory[updatedHistory.length - 1]?.role === 'assistant') {
          updatedHistory[updatedHistory.length - 1] = {
            role: 'assistant',
            content: safeResponse,
          };
        }
        routerRef.setHistory(updatedHistory, channelName);

        // Generate summary (first sentence or first 100 chars)
        const summary = safeResponse.length > 100
          ? safeResponse.slice(0, 100) + '...'
          : safeResponse;

        queueRef.markReady(queueItemId, summary, safeResponse);
        console.log(`Queue item ${queueItemId} ready (channel: ${channelName})`);

        // Check for pending wait callback — deliver response directly
        if (this.ctx.pendingWaitCallback && this.ctx.activeWaitQueueItemId === queueItemId) {
          const cb = this.ctx.pendingWaitCallback;
          this.ctx.pendingWaitCallback = null;
          this.ctx.activeWaitQueueItemId = null;
          this.ctx.quietPendingWait = false;
          queueRef.markHeard(queueItemId);
          pollerRef?.check();

          // Log + session transcript
          this.log(`**${config.botName}:** ${safeResponse}`, channelName);
          session.appendAssistantMessage(safeResponse, channelName);

          await this.persistVoiceExchange({
            sessionKey,
            channelName,
            transcript,
            response: safeResponse,
            queueItemId,
          });

          cb(safeResponse);
          return;
        }

        // Log + session transcript
        this.log(`**${config.botName}:** ${safeResponse}`, channelName);
        session.appendAssistantMessage(safeResponse, channelName);

        await this.persistVoiceExchange({
          sessionKey,
          channelName,
          transcript,
          response: safeResponse,
          queueItemId,
        });

        pollerRef?.check();

        // Silent wait: auto-read the full response instead of a brief notification
        if (this.ctx.silentWait) {
          this.ctx.silentWait = false;
          queueRef.markHeard(queueItemId);
          pollerRef?.check();
          this.notifyIfIdle(safeResponse);
        } else {
          // Notify user if idle
          this.notifyIfIdle(`Response ready from ${displayName}.`, {
            kind: 'response-ready',
            sessionKey,
          });
        }
      } catch (err: any) {
        console.error(`Fire-and-forget LLM dispatch failed for ${queueItemId}: ${err.message}`);
        // Clear pending wait state so the pipeline doesn't get stuck forever
        this.cancelPendingWait(`dispatch failed: ${err.message}`);

        // Classify the error for a useful spoken message
        const msg = err.message?.toLowerCase() ?? '';
        const isNetwork = msg.includes('fetch failed') || msg.includes('econnrefused')
          || msg.includes('timeout') || msg.includes('enotfound');

        // Mark the queue item ready with an explicit failure message so the user
        // can discover the error via inbox flow or next-item navigation.
        const failureSummary = isNetwork
          ? 'Dispatch failed: gateway connection error.'
          : 'Dispatch failed: gateway error.';
        const failureText = isNetwork
          ? 'I could not complete that request because the gateway connection failed. Please try again.'
          : 'I could not complete that request because the gateway returned an error. Please try again.';
        queueRef.markReady(queueItemId, failureSummary, failureText);
        pollerRef?.check();

        const reason = isNetwork
          ? 'A network error occurred.'
          : `The gateway returned an error.`;
        const spokenError = `Sorry, that didn't go through. ${reason} You may need to repeat that.`;

        // Speak the failure directly — the user is actively waiting
        this.stopWaitingLoop();
        this.player.stopPlayback('dispatch-failure');
        try {
          this.transitionAndResetWatchdog({ type: 'SPEAKING_STARTED' });
          await this.speakResponse(spokenError);
          this.transitionAndResetWatchdog({ type: 'SPEAKING_COMPLETE' });
          await this.playReadyEarcon();
        } catch {
          // Last resort: fall back to idle notify
          this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        }
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
      this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
    }

    const labels: Record<VoiceMode, string> = {
      wait: 'Wait mode. I will wait for each response before you can speak again.',
      queue: 'Inbox mode. Your messages will be dispatched and you can keep talking.',
      ask: 'Ask mode. I will ask you whether to inbox or wait for each message.',
    };
    await this.speakResponse(labels[mode], { inbox: true });
    await this.playReadyEarcon();

    // Start/stop background inbox poll based on mode
    if (mode === 'queue' || mode === 'ask') {
      this.startInboxPoll();
    } else {
      this.stopInboxPoll();
    }
  }

  private startInboxPoll(): void {
    if (this.inboxPollTimer) return;
    this.inboxPollTimer = setInterval(() => void this.pollInboxForTextActivity(), VoicePipeline.INBOX_POLL_INTERVAL_MS);
    console.log(`Inbox background poll started (every ${VoicePipeline.INBOX_POLL_INTERVAL_MS / 1000}s)`);
  }

  private stopInboxPoll(): void {
    let stopped = false;
    if (this.inboxPollTimer) {
      clearInterval(this.inboxPollTimer);
      this.inboxPollTimer = null;
      stopped = true;
    }
    this.inboxPollInFlight = false;
    this.inboxPollNotifiedStamps.clear();
    this.dropIdleNotifications((item) => item.kind === 'text-activity', 'poll-stop');
    if (stopped) console.log('Inbox background poll stopped');
  }

  private async pollInboxForTextActivity(): Promise<void> {
    if (!this.inboxTracker?.isActive() || !this.router) return;
    if (this.inboxPollInFlight) return;
    this.inboxPollInFlight = true;

    try {
      const channels = this.router.getAllChannelSessionKeys();
      const activities = await this.inboxTracker.checkInbox(channels);

      const now = Date.now();
      for (const activity of activities) {
        // Only notify for channels with new gateway messages (text-originated).
        // Voice-originated responses are handled by ResponsePoller's onReady callback.
        if (activity.newMessageCount > 0 && activity.queuedReadyCount === 0) {
          // Skip channels with recent voice dispatches — the text agent often
          // generates echo responses to voice-injected messages, which look like
          // "new" text messages but aren't useful to the user.
          const lastDispatch = this.recentVoiceDispatchChannels.get(activity.sessionKey) ?? 0;
          if (now - lastDispatch < VoicePipeline.VOICE_DISPATCH_COOLDOWN_MS) continue;

          // Deduplicate: only notify once per channel until a genuinely NEW message
          // arrives.  Use Date.now() as fallback when messages lack timestamps so
          // the dedup still works.
          const lastNotified = this.inboxPollNotifiedStamps.get(activity.sessionKey) ?? 0;
          const rawStamp = activity.newMessages.length > 0
            ? Math.max(...activity.newMessages.map((m: any) => m.timestamp ?? 0))
            : 0;
          const snapshotBaseline = this.queueState?.getSnapshots()[activity.sessionKey] ?? 0;
          const fallbackStamp = snapshotBaseline > 0
            ? snapshotBaseline + Math.max(1, activity.newMessageCount)
            : now;
          const effectiveStamp = rawStamp > 0 ? rawStamp : fallbackStamp;
          if (effectiveStamp <= lastNotified) continue;

          this.inboxPollNotifiedStamps.set(activity.sessionKey, effectiveStamp);
          this.notifyIfIdle(`New message in ${activity.displayName}.`, {
            kind: 'text-activity',
            sessionKey: activity.sessionKey,
            stamp: effectiveStamp,
          });
        }
      }
    } catch (err: any) {
      console.warn(`Inbox background poll error: ${err.message}`);
    } finally {
      this.inboxPollInFlight = false;
    }
  }

  private async handleGatedMode(enabled: boolean): Promise<void> {
    setGatedMode(enabled);
    if (!enabled) {
      this.clearIndicateCapture('gated-disabled');
    }
    const message = enabled
      ? "Gated mode. I'll only respond when you say Watson."
      : "Open mode. I'll respond to everything.";
    await this.speakResponse(message, { inbox: true });
    await this.playReadyEarcon();
  }

  private async handleEndpointMode(mode: EndpointingMode): Promise<void> {
    setEndpointingMode(mode);
    if (mode !== 'indicate') {
      this.clearIndicateCapture('endpoint-mode-silence');
    }

    if (mode === 'indicate') {
      await this.speakResponse('Indicate mode ready.', { inbox: true });
    } else {
      await this.speakResponse('Silence endpointing mode enabled.', { inbox: true });
    }
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
    if (!this.ctx.lastSpokenText) {
      await this.speakResponse("I haven't said anything yet.");
      await this.playReadyEarcon();
      return;
    }
    console.log(`Replay: "${this.ctx.lastSpokenText.slice(0, 60)}..."`);
    await this.speakResponse(this.ctx.lastSpokenText, { isReplay: true });
    await this.playReadyEarcon();
  }

  private async handleHearFullMessage(): Promise<void> {
    // If we have a stored channel message, read its full version
    if (this.ctx.lastSpokenIsChannelMessage) {
      const full = this.ctx.lastSpokenFullText || this.ctx.lastSpokenText;
      if (full) {
        console.log(`Hear full message (stored): "${full.slice(0, 60)}..."`);
        await this.speakResponse(full, { isReplay: true, forceFull: true });
        await this.playReadyEarcon();
        this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
        return;
      }
    }

    // No channel message stored (e.g. after a channel switch) — fetch the last
    // message from the active channel and read it in full.
    if (this.router) {
      const lastMsg = await this.router.getLastMessageFresh();
      if (lastMsg) {
        const content = lastMsg.role === 'user'
          ? `You last said: ${lastMsg.content}`
          : this.toSpokenText(lastMsg.content, 'Message available.');
        console.log(`Hear full message (fetched): "${content.slice(0, 60)}..."`);
        await this.speakResponse(content, { inbox: true, forceFull: true, isChannelMessage: true });
        await this.playReadyEarcon();
        this.allowFollowupPromptGrace(VoicePipeline.FOLLOWUP_PROMPT_GRACE_MS);
        return;
      }
    }

    await this.speakResponse("I don't have a full message to read yet.");
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
      this.transitionAndResetWatchdog({
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
      this.transitionAndResetWatchdog({ type: 'INBOX_ADVANCE' });
    } else if (this.inboxTracker?.isActive() && this.router) {
      // Mark current channel as seen BEFORE fresh check so it doesn't re-appear
      const currentSessionKey = this.router.getActiveSessionKey();
      const currentCount = await this.getCurrentMessageCount(currentSessionKey);
      this.markInboxSessionSeen(currentSessionKey, currentCount);

      // Fresh check if flow is exhausted or not started
      const channels = this.router.getAllChannelSessionKeys();
      const activities = await this.inboxTracker.checkInbox(channels);
      if (activities.length > 0) {
        this.transitionAndResetWatchdog({
          type: 'ENTER_INBOX_FLOW',
          items: activities,
          returnChannel: this.router.getActiveChannel().name,
        });
        this.transitionAndResetWatchdog({ type: 'INBOX_ADVANCE' });
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
        this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
        // Restore the channel the user was on before the inbox flow started
        await this.restoreChannel(returnChannel);
        parts.push("That's everything.");
      }

      const fullText = this.toSpokenText(parts.join(' '), 'Nothing new in the inbox.');
      await this.speakResponse(fullText, { inbox: true, allowSummary: true, forceFull: false, isChannelMessage: true });
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
    await this.speakResponse(fullText, { inbox: true, allowSummary: true, forceFull: false, isChannelMessage: true });
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
        this.markInboxSessionSeen(activity.sessionKey, currentCount);
      }
    }

    const returnChannel = flowState.returnChannel;
    this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
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
    this.transitionAndResetWatchdog({ type: 'RETURN_TO_IDLE' });
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
    } else if (activity.newMessages.length > 1) {
      // Multiple new messages — read them all via formatForTTS
      parts.push(`Switched to ${activity.displayName}.`);
      const formatted = this.inboxTracker!.formatForTTS(activity.newMessages);
      if (formatted) {
        parts.push(formatted);
      }
    } else {
      // Single or no new messages — brief context from last message
      parts.push(this.buildSwitchConfirmation(activity.displayName));
    }

    // Mark this channel as seen
    if (this.inboxTracker) {
      const currentCount = await this.getCurrentMessageCount(activity.sessionKey);
      console.log(`InboxTracker: markSeen ${activity.channelName} (${activity.sessionKey}) count=${currentCount}`);
      this.markInboxSessionSeen(activity.sessionKey, currentCount);
    }

    return parts;
  }

  private async getCurrentMessageCount(sessionKey: string): Promise<number> {
    if (!this.gatewaySync?.isConnected()) return 0;
    const result = await this.gatewaySync.getHistory(sessionKey, 80);
    const messages = result?.messages ?? [];
    if (messages.length === 0) return 0;
    const last = messages[messages.length - 1] as any;
    return typeof last?.timestamp === 'number' && Number.isFinite(last.timestamp)
      ? last.timestamp
      : messages.length;
  }

  private markInboxSessionSeen(sessionKey: string, stamp: number): void {
    if (!this.inboxTracker) return;
    this.inboxTracker.markSeen(sessionKey, stamp);
    this.dropIdleNotifications(
      (item) => item.kind === 'text-activity' && item.sessionKey === sessionKey,
      'mark-seen',
    );
    const lastNotified = this.inboxPollNotifiedStamps.get(sessionKey) ?? 0;
    if (stamp > lastNotified) {
      this.inboxPollNotifiedStamps.set(sessionKey, stamp);
    }
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

    // "next", "next one", "next response", "next message", "next channel", "done", "I'm done", "move on", "skip", "skip it", "skip this"
    if (/^(?:next(?:\s+(?:response|one|message|channel))?|(?:i'?m\s+)?done|i\s+am\s+done|move\s+on|skip(?:\s+(?:it|this(?:\s+one)?))?)$/.test(normalized)) {
      return { type: 'inbox-next' };
    }

    // "clear inbox", "clear the inbox", "mark inbox read", "clear all"
    if (/^(?:clear\s+(?:the\s+)?inbox|mark\s+(?:the\s+)?inbox\s+(?:as\s+)?read|mark\s+all\s+read|clear\s+all)$/.test(normalized)) {
      return { type: 'inbox-clear' };
    }

    // "read last message", "read the/my last message", "last message", "my last message"
    if (/^(?:read\s+(?:(?:the|my)\s+)?last\s+message|(?:(?:the|my)\s+)?last\s+message)$/.test(normalized)) {
      return { type: 'read-last-message' };
    }

    // "hear full message", "here full message" (STT homophone), "read full message", "full message"
    // "hear full message", "here full message" (STT homophone), "hear fullness" (STT misheard), "read full message", "full message"
    if (/^(?:hear|here|read|play)\s+(?:(?:the|a|an)\s+)?full(?:ness|\s+message)$|^full\s+message$/.test(normalized)) {
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
    // Also handle STT noise: "we go to X", "let's go to X", bare "to X"
    const switchMatch = navInput.match(/^(?:(?:we|let'?s)\s+)?(?:go|switch|which|scratch|change|move)(?:\s+channels?)?(?:\s+to)?\s+(.+)$/)
      ?? navInput.match(/^to\s+(.+)$/);
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
      /^(?:inbox(?:\s+(?:list|status|check))?|what\s+do\s+(?:i|you)\s+have(?:\s+for\s+me)?|check\s+(?:the\s+)?(?:queue|inbox)|what'?s\s+(?:waiting|ready|new)|queue\s+status)$/.test(navInput) ||
      /\binbox\s+(?:list|status|check)\b/.test(navInput)
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
    options?: { inbox?: boolean; isReplay?: boolean; allowSummary?: boolean; forceFull?: boolean; isChannelMessage?: boolean },
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
      this.ctx.lastSpokenText = spokenText;
      this.ctx.lastSpokenFullText = fullText;
      this.ctx.lastSpokenWasSummary = spokenText !== fullText;
      this.ctx.lastSpokenIsChannelMessage = !!options?.isChannelMessage;
    }
    const ttsStream = await textToSpeechStream(spokenText);
    this.stopWaitingLoop();
    this.player.stopPlayback('speak-response-preempt');
    // Close any stale grace windows so the gate is closed during playback.
    // Only wake-word interrupts should stop active TTS; grace reopens after.
    this.ctx.gateGraceUntil = 0;
    this.ctx.promptGraceUntil = 0;
    this.clearGraceTimer();
    await this.player.playStream(ttsStream);
    this.ctx.lastPlaybackText = spokenText;
    this.ctx.lastPlaybackCompletedAt = Date.now();
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

    const shouldSummarize = normalized.length >= 1800 || lineCount >= 20 || toolChatterHits >= 4;
    console.log(`[summary-check] len=${normalized.length} lines=${lineCount} chatter=${toolChatterHits} → ${shouldSummarize ? 'SUMMARIZE' : 'FULL'}`);
    return shouldSummarize;
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

  private trackIdleNotificationEvent(
    stage: IdleNotificationStage,
    item: Pick<QueuedIdleNotification, 'key' | 'kind' | 'sessionKey' | 'retries' | 'message'>,
    reason?: string,
  ): void {
    switch (stage) {
      case 'enqueued':
        this.counters.idleNotificationsEnqueued += 1;
        break;
      case 'deduped':
        this.counters.idleNotificationsDeduped += 1;
        break;
      case 'deferred':
        this.counters.idleNotificationsDeferred += 1;
        break;
      case 'dropped':
        this.counters.idleNotificationsDropped += 1;
        break;
      case 'delivered':
        this.counters.idleNotificationsDelivered += 1;
        break;
      default:
        break;
    }

    const preview = item.message.replace(/\s+/g, ' ').trim().slice(0, 160);
    this.idleNotifyEvents.push({
      at: Date.now(),
      stage,
      kind: item.kind,
      key: item.key,
      sessionKey: item.sessionKey,
      reason: reason ?? null,
      retries: item.retries,
      message: preview,
      queueDepth: this.idleNotifyQueue.length,
    });

    if (this.idleNotifyEvents.length > VoicePipeline.IDLE_NOTIFY_EVENT_LIMIT) {
      this.idleNotifyEvents.splice(0, this.idleNotifyEvents.length - VoicePipeline.IDLE_NOTIFY_EVENT_LIMIT);
    }
  }

  notifyIfIdle(message: string, options: IdleNotificationOptions = {}): void {
    const kind = options.kind ?? 'generic';
    const key = this.buildIdleNotificationKey(message, kind, options);
    const existing = this.idleNotifyByKey.get(key);

    if (existing) {
      existing.message = message;
      existing.kind = kind;
      if (options.sessionKey) existing.sessionKey = options.sessionKey;
      if (typeof options.stamp === 'number' && Number.isFinite(options.stamp)) {
        existing.stamp = existing.stamp == null ? options.stamp : Math.max(existing.stamp, options.stamp);
      }
      this.trackIdleNotificationEvent('deduped', existing, 'merged-with-existing-key');
    } else {
      const item: QueuedIdleNotification = {
        key,
        message,
        kind,
        sessionKey: options.sessionKey ?? null,
        stamp: typeof options.stamp === 'number' && Number.isFinite(options.stamp) ? options.stamp : null,
        retries: 0,
      };
      this.idleNotifyQueue.push(item);
      this.idleNotifyByKey.set(key, item);
      this.trackIdleNotificationEvent('enqueued', item);
    }

    this.scheduleIdleNotificationProcessing(0);
  }

  private buildIdleNotificationKey(message: string, kind: IdleNotificationKind, options: IdleNotificationOptions): string {
    if (options.dedupeKey) return options.dedupeKey;
    if ((kind === 'response-ready' || kind === 'text-activity') && options.sessionKey) {
      return `${kind}:${options.sessionKey}`;
    }
    return `${kind}:${message}`;
  }

  private clearIdleNotificationQueue(): void {
    if (this.idleNotifyTimer) {
      clearTimeout(this.idleNotifyTimer);
      this.idleNotifyTimer = null;
    }
    this.idleNotifyQueue = [];
    this.idleNotifyByKey.clear();
  }

  private dropIdleNotifications(predicate: (item: QueuedIdleNotification) => boolean, reason = 'filtered'): void {
    const headBefore = this.idleNotifyQueue[0]?.key ?? null;
    const droppedItems: QueuedIdleNotification[] = [];
    this.idleNotifyQueue = this.idleNotifyQueue.filter((item) => {
      if (predicate(item)) {
        droppedItems.push(item);
        return false;
      }
      return true;
    });
    for (const item of droppedItems) {
      this.idleNotifyByKey.delete(item.key);
      this.trackIdleNotificationEvent('dropped', item, reason);
    }
    if (droppedItems.length === 0) return;

    if (this.idleNotifyQueue.length === 0) {
      if (this.idleNotifyTimer) {
        clearTimeout(this.idleNotifyTimer);
        this.idleNotifyTimer = null;
      }
      return;
    }

    // If the queue head changed while a deferred timer was pending, reschedule
    // immediately so the next item isn't blocked by the old head's backoff.
    const headAfter = this.idleNotifyQueue[0]?.key ?? null;
    if (this.idleNotifyTimer && headBefore !== headAfter) {
      clearTimeout(this.idleNotifyTimer);
      this.idleNotifyTimer = null;
      this.scheduleIdleNotificationProcessing(0);
    }
  }

  private scheduleIdleNotificationProcessing(delayMs: number): void {
    if (this.idleNotifyTimer) clearTimeout(this.idleNotifyTimer);
    this.idleNotifyTimer = setTimeout(() => {
      this.idleNotifyTimer = null;
      void this.processIdleNotificationQueue();
    }, Math.max(120, delayMs));
  }

  private dequeueIdleNotification(key: string): void {
    this.idleNotifyByKey.delete(key);
    this.idleNotifyQueue = this.idleNotifyQueue.filter((item) => item.key !== key);
  }

  private recordIdleNotificationDeferral(item: QueuedIdleNotification, reason: string): void {
    this.trackIdleNotificationEvent('deferred', item, reason);
    if (item.retries <= 1 || item.retries % 10 === 0) {
      console.log(`Idle notify deferred (${reason}, attempt ${item.retries}): "${item.message}"`);
    }
  }

  private async processIdleNotificationQueue(): Promise<void> {
    if (this.idleNotifyProcessing) return;
    this.idleNotifyProcessing = true;

    try {
      while (true) {
        while (this.idleNotifyQueue.length > 0 && !this.idleNotifyByKey.has(this.idleNotifyQueue[0]!.key)) {
          this.idleNotifyQueue.shift();
        }
        const next = this.idleNotifyQueue[0];
        if (!next) return;

        if (this.isIdleNotificationStale(next)) {
          console.log(`Idle notify dropped (stale): "${next.message}"`);
          this.trackIdleNotificationEvent('dropped', next, 'stale-before-delivery');
          this.dequeueIdleNotification(next.key);
          continue;
        }

        const deferral = this.idleNotificationDeferral();
        if (deferral) {
          if ('drop' in deferral) {
            console.log(`Idle notify skipped (${deferral.reason}): "${next.message.slice(0, 60)}..."`);
            this.trackIdleNotificationEvent('dropped', next, deferral.reason);
            this.dequeueIdleNotification(next.key);
            continue;
          }
          next.retries += 1;
          this.recordIdleNotificationDeferral(next, deferral.reason);
          this.scheduleIdleNotificationProcessing(deferral.delayMs);
          return;
        }

        const result = await this.deliverIdleNotification(next);
        if (result.status === 'delivered') {
          this.trackIdleNotificationEvent('delivered', next, result.reason);
          this.dequeueIdleNotification(next.key);
          continue;
        }
        if (result.status === 'dropped') {
          this.trackIdleNotificationEvent('dropped', next, result.reason);
          this.dequeueIdleNotification(next.key);
          continue;
        }

        next.retries += 1;
        this.recordIdleNotificationDeferral(next, result.reason);
        this.scheduleIdleNotificationProcessing(result.delayMs);
        return;
      }
    } finally {
      this.idleNotifyProcessing = false;
    }
  }

  private idleNotificationDeferral():
    { delayMs: number; reason: string } | { drop: true; reason: string } | null {
    if (this.ctx.silentWait) {
      return { drop: true, reason: 'silent wait' };
    }

    if (this.ctx.indicateCaptureActive) {
      return { delayMs: 1200, reason: 'indicate capture active' };
    }

    if (Date.now() < this.ctx.promptGraceUntil || Date.now() < this.ctx.gateGraceUntil) {
      const until = Math.max(this.ctx.promptGraceUntil, this.ctx.gateGraceUntil);
      return {
        delayMs: Math.max(120, until - Date.now() + 120),
        reason: 'grace window',
      };
    }

    // Wait-mode dispatches are fire-and-forget — the state machine goes back
    // to IDLE while the LLM is still processing. Treat this as busy so
    // notifications don't play on top of pending response delivery.
    if (this.ctx.pendingWaitCallback) {
      return { delayMs: 2000, reason: 'pending wait' };
    }

    // INBOX_FLOW is user-interactive and should not be interrupted by background notifications.
    const stateType = this.stateMachine.getStateType();
    const blockOnBusy = stateType !== 'IDLE';
    if (blockOnBusy || this.player.isPlaying()) {
      return {
        delayMs: this.player.isPlaying() ? 5000 : 900,
        reason: this.player.isPlaying() ? 'active playback' : `busy state ${stateType}`,
      };
    }
    if (this.ctx.idleNotifyInFlight) {
      return { delayMs: 900, reason: 'in-flight' };
    }
    if (this.receiver.hasActiveSpeech()) {
      return { delayMs: 1500, reason: 'active speech' };
    }
    return null;
  }

  private isIdleNotificationStale(item: QueuedIdleNotification): boolean {
    if (item.kind === 'text-activity') {
      if (!item.sessionKey || item.stamp == null || !this.queueState) return false;
      const snapshots = this.queueState.getSnapshots();
      const baseline = snapshots[item.sessionKey] ?? 0;
      return baseline >= item.stamp;
    }

    if (item.kind === 'response-ready' && this.queueState) {
      const ready = this.queueState.getReadyItems();
      if (item.sessionKey) {
        return !ready.some((r) => r.sessionKey === item.sessionKey);
      }
      const match = item.message.match(/^Response ready from (.+)\.$/i);
      if (!match) return false;
      const announced = this.normalizeChannelLabel(match[1] || '');
      return !ready.some((r) => this.normalizeChannelLabel(r.displayName) === announced);
    }

    return false;
  }

  private typeSafeIdleDeliveryResult(
    status: 'delivered' | 'dropped' | 'deferred',
    reason: string,
    delayMs?: number,
  ): { status: 'delivered'; reason: string } | { status: 'dropped'; reason: string } | { status: 'deferred'; reason: string; delayMs: number } {
    if (status === 'deferred') {
      return { status, reason, delayMs: Math.max(120, delayMs ?? 900) };
    }
    return { status, reason };
  }

  private async deliverIdleNotification(item: QueuedIdleNotification):
    Promise<{ status: 'delivered'; reason: string } | { status: 'dropped'; reason: string } | { status: 'deferred'; reason: string; delayMs: number }> {
    const message = item.message;

    if (this.isIdleNotificationStale(item)) {
      return this.typeSafeIdleDeliveryResult('dropped', 'stale-before-delivery');
    }

    if (this.ctx.indicateCaptureActive) {
      return this.typeSafeIdleDeliveryResult('deferred', 'indicate capture active before delivery', 1200);
    }

    // If a ready item belongs to the currently active channel and we're idle,
    // read it directly instead of announcing "Response ready from <same channel>".
    if (this.shouldAutoReadReadyForActiveChannel(message)) {
      await this.readReadyForActiveChannel();
      return this.typeSafeIdleDeliveryResult('delivered', 'auto-read-active-channel');
    }

    if (item.retries > 0) {
      console.log(`Idle notify: "${message}" (after ${item.retries} retries)`);
    } else {
      console.log(`Idle notify: "${message}"`);
    }
    this.logToInbox(`**${config.botName}:** ${message}`);
    this.ctx.idleNotifyInFlight = true;

    try {
      let stream: any;
      try {
        stream = await textToSpeechStream(message);
      } catch (err: any) {
        console.warn(`Idle notify TTS failed: ${err.message}`);
        return this.typeSafeIdleDeliveryResult('deferred', 'tts failure', 1200);
      }

      // Re-check idle — user may have started speaking while TTS was generating.
      if (this.isIdleNotificationStale(item)) {
        return this.typeSafeIdleDeliveryResult('dropped', 'stale-before-playback');
      }
      if (this.isBusy() || this.player.isPlaying() || this.receiver.hasActiveSpeech() || this.ctx.indicateCaptureActive) {
        return this.typeSafeIdleDeliveryResult('deferred', 'became busy before playback', 900);
      }

      // Any fresh playback closes old grace windows. This prevents stale
      // ready-grace from allowing no-wake interruptions mid-notification.
      this.ctx.gateGraceUntil = 0;
      this.ctx.promptGraceUntil = 0;
      this.clearGraceTimer();

      try {
        await this.player.playStream(stream);
      } catch (err: any) {
        console.warn(`Idle notify playback failed: ${err?.message ?? err}`);
        return this.typeSafeIdleDeliveryResult('deferred', 'playback failure', 900);
      }

      this.ctx.lastPlaybackText = message;
      this.ctx.lastPlaybackCompletedAt = Date.now();
      await this.playReadyEarcon();
      return this.typeSafeIdleDeliveryResult('delivered', 'spoken');
    } finally {
      this.ctx.idleNotifyInFlight = false;
    }
  }

  notifyDependencyIssue(type: 'stt' | 'tts', message: string): void {
    const now = Date.now();
    if (now < this.ctx.dependencyAlertCooldownUntil[type]) return;
    this.ctx.dependencyAlertCooldownUntil[type] = now + 10_000;
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
      this.transitionAndResetWatchdog({ type: 'SPEAKING_STARTED' });
      await this.speakResponse(item.responseText, { allowSummary: true, forceFull: false, isChannelMessage: true });
      this.transitionAndResetWatchdog({ type: 'SPEAKING_COMPLETE' });
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
      'prompt,switch,dispatch,list,default,noise,delay,delay-adjust,settings,new-post,mode,inbox-check,inbox-next,inbox-clear,read-last-message,voice-status,voice-channel,gated-mode,endpoint-mode,wake-check,silent-wait,hear-full-message,pause,replay,earcon-tour',
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
        '"here full message" or "hear fullness" means "hear full message"',
      ],
    });

    let raw = '';
    try {
      // AbortSignal.timeout cancels the actual HTTP fetch after 1400ms instead
      // of leaving an orphaned connection hanging (the old Promise.race approach).
      const signal = AbortSignal.timeout(1400);
      raw = await quickCompletion(system, user, 120, signal);
    } catch (err: any) {
      const msg = err.message ?? '';
      const isTimeout = msg.includes('timeout') || msg.includes('aborted') || err.name === 'TimeoutError';
      console.warn(`LLM command classifier failed: ${msg}`);
      if (isTimeout) {
        this.lastClassifierTimedOut = true;
      }
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
      case 'endpoint-mode': {
        if (modeValue === 'indicate' || modeValue === 'manual') {
          return { type: 'endpoint-mode', mode: 'indicate' };
        }
        if (modeValue === 'silence' || modeValue === 'auto' || modeValue === 'automatic') {
          return { type: 'endpoint-mode', mode: 'silence' };
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

  private async persistVoiceExchange(params: {
    sessionKey: string | null;
    channelName: string;
    transcript: string;
    response: string;
    queueItemId?: string;
    source?: string;
  }): Promise<void> {
    const gatewaySync = this.gatewaySync;
    if (!gatewaySync || !params.sessionKey) return;

    const keyInfo = params.queueItemId
      ? `queueItem=${params.queueItemId}`
      : `source=${params.source ?? 'unknown'}`;

    const syncMessage = async (content: string, label: 'voice-user' | 'voice-assistant'): Promise<void> => {
      try {
        console.log(`Gateway inject start ${keyInfo} label=${label} channel=${params.channelName} session=${params.sessionKey}`);
        const injected = await gatewaySync.inject(params.sessionKey!, content, label);
        if (injected) {
          console.log(
            `Gateway inject ok ${keyInfo} label=${label} channel=${params.channelName} session=${params.sessionKey} delivered=${injected.sessionKey}`,
          );
          const mirrored = await gatewaySync.mirrorInjectToSessionFamily(
            params.sessionKey!,
            content,
            label,
            { excludeSessionKeys: [injected.sessionKey] },
          );
          if (mirrored > 0) {
            console.log(
              `Gateway mirror inject ok ${keyInfo} label=${label} channel=${params.channelName} session=${params.sessionKey} mirrored=${mirrored}`,
            );
          }
        } else {
          console.warn(
            `Gateway inject failed ${keyInfo} label=${label} channel=${params.channelName} session=${params.sessionKey} error=inject-returned-false`,
          );
        }
      } catch (err: any) {
        console.warn(
          `Gateway inject failed ${keyInfo} label=${label} channel=${params.channelName} session=${params.sessionKey} error=${err.message}`,
        );
      }
    };

    await syncMessage(params.transcript, 'voice-user');
    await syncMessage(params.response, 'voice-assistant');

    // Refresh cool-down so it covers text-agent echo responses.
    this.recentVoiceDispatchChannels.set(params.sessionKey, Date.now());
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
    const effects = this.transitionAndResetWatchdog({ type: 'AWAITING_INPUT_RECEIVED', recognized: false });
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

    const compactBase = base.replace(/\s+/g, '');
    const compactSingularish = singularish.replace(/\s+/g, '');

    const forms = new Set<string>([base, singularish, compactBase, compactSingularish].filter(Boolean));
    return Array.from(forms);
  }

  private sanitizeAssistantOutput(text: string, context: string): string {
    const cleaned = sanitizeAssistantResponse(text);
    if (cleaned !== text.trim()) {
      console.warn(`Sanitized assistant output (${context}) removed=${Math.max(0, text.trim().length - cleaned.length)}`);
    }
    if (cleaned.length > 0) return cleaned;
    console.warn(`Assistant output empty after sanitization (${context})`);
    return 'I had trouble formatting that response. Please ask again.';
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
