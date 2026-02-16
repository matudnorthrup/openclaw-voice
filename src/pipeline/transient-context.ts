/**
 * Centralized transient state for the voice pipeline.
 *
 * Groups ~20 scattered mutable value fields that should be reset together
 * when the pipeline stops, stall-watchdog fires, or a hard reset occurs.
 *
 * Timer handles are NOT included here — they live on VoicePipeline and are
 * cleared via clearAllTimers().
 */
export interface TransientContext {
  // Playback tracking
  lastSpokenText: string;
  lastSpokenFullText: string;
  lastSpokenWasSummary: boolean;
  lastPlaybackText: string;
  lastPlaybackCompletedAt: number;

  // Wait state
  silentWait: boolean;
  pendingWaitCallback: ((responseText: string) => void) | null;
  activeWaitQueueItemId: string | null;
  speculativeQueueItemId: string | null;
  quietPendingWait: boolean;
  deferredWaitResponseText: string | null;

  // Grace periods
  gateGraceUntil: number;
  promptGraceUntil: number;

  // Cooldowns / flags
  rejectRepromptInFlight: boolean;
  rejectRepromptCooldownUntil: number;
  ignoreProcessingUtterancesUntil: number;
  failedWakeCueCooldownUntil: number;
  missedWakeAnalysisInFlight: boolean;
  newPostTimeoutPromptGuardUntil: number;
  dependencyAlertCooldownUntil: Record<'stt' | 'tts', number>;
  idleNotifyInFlight: boolean;
}

export function createTransientContext(): TransientContext {
  return {
    lastSpokenText: '',
    lastSpokenFullText: '',
    lastSpokenWasSummary: false,
    lastPlaybackText: '',
    lastPlaybackCompletedAt: 0,
    silentWait: false,
    pendingWaitCallback: null,
    activeWaitQueueItemId: null,
    speculativeQueueItemId: null,
    quietPendingWait: false,
    deferredWaitResponseText: null,
    gateGraceUntil: 0,
    promptGraceUntil: 0,
    rejectRepromptInFlight: false,
    rejectRepromptCooldownUntil: 0,
    ignoreProcessingUtterancesUntil: 0,
    failedWakeCueCooldownUntil: 0,
    missedWakeAnalysisInFlight: false,
    newPostTimeoutPromptGuardUntil: 0,
    dependencyAlertCooldownUntil: { stt: 0, tts: 0 },
    idleNotifyInFlight: false,
  };
}

export function resetTransientContext(ctx: TransientContext): void {
  ctx.lastSpokenText = '';
  ctx.lastSpokenFullText = '';
  ctx.lastSpokenWasSummary = false;
  ctx.lastPlaybackText = '';
  ctx.lastPlaybackCompletedAt = 0;
  ctx.silentWait = false;
  ctx.pendingWaitCallback = null;
  ctx.activeWaitQueueItemId = null;
  ctx.speculativeQueueItemId = null;
  ctx.quietPendingWait = false;
  ctx.deferredWaitResponseText = null;
  ctx.gateGraceUntil = 0;
  ctx.promptGraceUntil = 0;
  ctx.rejectRepromptInFlight = false;
  ctx.rejectRepromptCooldownUntil = 0;
  ctx.ignoreProcessingUtterancesUntil = 0;
  ctx.failedWakeCueCooldownUntil = 0;
  ctx.missedWakeAnalysisInFlight = false;
  ctx.newPostTimeoutPromptGuardUntil = 0;
  ctx.dependencyAlertCooldownUntil = { stt: 0, tts: 0 };
  ctx.idleNotifyInFlight = false;
}
