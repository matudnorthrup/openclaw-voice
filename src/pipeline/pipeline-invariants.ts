import type { PipelineStateType } from './pipeline-state.js';

export interface InvariantContext {
  stateType: PipelineStateType;
  hasStateMachineTimers: boolean;
  isPlayerPlaying: boolean;
  isPlayerWaiting: boolean;
  waitingLoopTimerActive: boolean;
  deferredWaitRetryTimerActive: boolean;
  pendingWaitCallback: boolean;
}

export interface InvariantViolation {
  label: string;
  context: string;
  timestamp: number;
}

export function checkPipelineInvariants(ctx: InvariantContext): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const now = Date.now();

  // 1. AWAITING/NEW_POST_FLOW state but no state machine timeout timer active
  const awaitingStates: PipelineStateType[] = [
    'AWAITING_CHANNEL_SELECTION',
    'AWAITING_QUEUE_CHOICE',
    'AWAITING_SWITCH_CHOICE',
    'NEW_POST_FLOW',
  ];
  if (awaitingStates.includes(ctx.stateType) && !ctx.hasStateMachineTimers) {
    violations.push({
      label: 'awaiting-no-timers',
      context: `state=${ctx.stateType} hasStateMachineTimers=false`,
      timestamp: now,
    });
  }

  // 2. SPEAKING state but audio player not playing and not waiting
  if (ctx.stateType === 'SPEAKING' && !ctx.isPlayerPlaying && !ctx.isPlayerWaiting) {
    violations.push({
      label: 'speaking-no-audio',
      context: `state=SPEAKING isPlaying=false isWaiting=false`,
      timestamp: now,
    });
  }

  // 3. IDLE + waitingLoopTimer active + no pendingWaitCallback (stale waiting loop)
  if (ctx.stateType === 'IDLE' && ctx.waitingLoopTimerActive && !ctx.pendingWaitCallback) {
    violations.push({
      label: 'idle-stale-waiting-loop',
      context: `state=IDLE waitingLoopTimer=active pendingWaitCallback=false`,
      timestamp: now,
    });
  }

  // 4. IDLE + deferredWaitRetryTimer active + no pendingWaitCallback (stale retry)
  if (ctx.stateType === 'IDLE' && ctx.deferredWaitRetryTimerActive && !ctx.pendingWaitCallback) {
    violations.push({
      label: 'idle-stale-deferred-retry',
      context: `state=IDLE deferredWaitRetryTimer=active pendingWaitCallback=false`,
      timestamp: now,
    });
  }

  for (const v of violations) {
    console.warn(`Pipeline invariant violation: ${v.label} — ${v.context}`);
  }

  return violations;
}
