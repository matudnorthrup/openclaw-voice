import type { EarconName } from '../audio/earcons.js';
import type { ChannelOption } from '../services/voice-commands.js';
import { getInteractionContractById, getInteractionContractForState } from './interaction-contract.js';

// ─── State types ────────────────────────────────────────────────────────────

export type PipelineStateType =
  | 'IDLE'
  | 'TRANSCRIBING'
  | 'PROCESSING'
  | 'SPEAKING'
  | 'AWAITING_CHANNEL_SELECTION'
  | 'AWAITING_QUEUE_CHOICE'
  | 'AWAITING_SWITCH_CHOICE'
  | 'NEW_POST_FLOW'
  | 'INBOX_FLOW';

export interface IdleState {
  type: 'IDLE';
}

export interface TranscribingState {
  type: 'TRANSCRIBING';
}

export interface ProcessingState {
  type: 'PROCESSING';
}

export interface SpeakingState {
  type: 'SPEAKING';
}

export interface AwaitingChannelSelectionState {
  type: 'AWAITING_CHANNEL_SELECTION';
  options: ChannelOption[];
  enteredAt: number;
  timeoutMs: number;
  warningFired: boolean;
}

export interface AwaitingQueueChoiceState {
  type: 'AWAITING_QUEUE_CHOICE';
  userId: string;
  transcript: string;
  enteredAt: number;
  timeoutMs: number;
  warningFired: boolean;
}

export interface AwaitingSwitchChoiceState {
  type: 'AWAITING_SWITCH_CHOICE';
  lastMessage: string;
  enteredAt: number;
  timeoutMs: number;
  warningFired: boolean;
}

export interface NewPostFlowState {
  type: 'NEW_POST_FLOW';
  step: 'forum' | 'title' | 'body';
  forumId?: string;
  forumName?: string;
  title?: string;
  enteredAt: number;
  timeoutMs: number;
  warningFired: boolean;
}

export interface InboxFlowState {
  type: 'INBOX_FLOW';
  items: any[]; // ChannelActivity[]
  index: number;
  returnChannel: string | null; // channel name to restore when flow ends
}

export type PipelineState =
  | IdleState
  | TranscribingState
  | ProcessingState
  | SpeakingState
  | AwaitingChannelSelectionState
  | AwaitingQueueChoiceState
  | AwaitingSwitchChoiceState
  | NewPostFlowState
  | InboxFlowState;

// ─── Transition effects ─────────────────────────────────────────────────────

export type TransitionEffect =
  | { type: 'earcon'; name: EarconName }
  | { type: 'speak'; text: string }
  | { type: 'stop-playback' }
  | { type: 'start-waiting-loop' }
  | { type: 'stop-waiting-loop' };

// ─── Events the pipeline sends to the state machine ────────────────────────

export type PipelineEvent =
  | { type: 'UTTERANCE_RECEIVED' }
  | { type: 'TRANSCRIPT_READY'; transcript: string }
  | { type: 'PROCESSING_STARTED' }
  | { type: 'PROCESSING_COMPLETE' }
  | { type: 'SPEAKING_STARTED' }
  | { type: 'SPEAKING_COMPLETE' }
  | { type: 'ENTER_CHANNEL_SELECTION'; options: ChannelOption[]; timeoutMs?: number }
  | { type: 'ENTER_QUEUE_CHOICE'; userId: string; transcript: string; timeoutMs?: number }
  | { type: 'ENTER_SWITCH_CHOICE'; lastMessage: string; timeoutMs?: number }
  | { type: 'ENTER_NEW_POST_FLOW'; step: 'forum' | 'title' | 'body'; forumId?: string; forumName?: string; title?: string; timeoutMs?: number }
  | { type: 'NEW_POST_ADVANCE'; step: 'forum' | 'title' | 'body'; forumId?: string; forumName?: string; title?: string; timeoutMs?: number }
  | { type: 'ENTER_INBOX_FLOW'; items: any[]; returnChannel?: string | null }
  | { type: 'INBOX_ADVANCE' }
  | { type: 'AWAITING_INPUT_RECEIVED'; recognized: boolean }
  | { type: 'TIMEOUT_CHECK' }
  | { type: 'CANCEL_FLOW' }
  | { type: 'RETURN_TO_IDLE' };

// ─── Timeout configuration ─────────────────────────────────────────────────

const DEFAULT_WARNING_BEFORE_MS = 5_000;

// ─── State machine ─────────────────────────────────────────────────────────

export class PipelineStateMachine {
  private state: PipelineState = { type: 'IDLE' };
  private bufferedUtterances: { userId: string; wavBuffer: Buffer; durationMs: number }[] = [];
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private warningTimer: ReturnType<typeof setTimeout> | null = null;
  private onTimeout: ((effects: TransitionEffect[]) => void) | null = null;
  private static readonly MAX_BUFFERED_UTTERANCES = 3;

  getState(): PipelineState {
    return this.state;
  }

  getStateType(): PipelineStateType {
    return this.state.type;
  }

  /**
   * Buffer an utterance that arrived during PROCESSING or SPEAKING.
   * The pipeline should re-process it when returning to IDLE.
   */
  bufferUtterance(userId: string, wavBuffer: Buffer, durationMs: number): void {
    if (this.bufferedUtterances.length >= PipelineStateMachine.MAX_BUFFERED_UTTERANCES) {
      this.bufferedUtterances.shift();
    }
    this.bufferedUtterances.push({ userId, wavBuffer, durationMs });
  }

  getBufferedUtterance(): { userId: string; wavBuffer: Buffer; durationMs: number } | null {
    return this.bufferedUtterances.shift() ?? null;
  }

  hasBufferedUtterance(): boolean {
    return this.bufferedUtterances.length > 0;
  }

  /**
   * Register a callback for timeout/warning effects (earcons + speech).
   * Called when an AWAITING state times out or needs a warning.
   */
  setTimeoutHandler(handler: (effects: TransitionEffect[]) => void): void {
    this.onTimeout = handler;
  }

  /**
   * Process an event and return the effects the pipeline should apply.
   */
  transition(event: PipelineEvent): TransitionEffect[] {
    const effects: TransitionEffect[] = [];

    switch (event.type) {
      case 'UTTERANCE_RECEIVED':
        return this.handleUtteranceReceived(effects);

      case 'TRANSCRIPT_READY':
        // Only transition from TRANSCRIBING — don't overwrite AWAITING states
        if (this.state.type === 'TRANSCRIBING') {
          this.state = { type: 'PROCESSING' };
        }
        return effects;

      case 'PROCESSING_STARTED':
        this.clearTimers(); // Clear any AWAITING state timers
        this.state = { type: 'PROCESSING' };
        return effects;

      case 'PROCESSING_COMPLETE':
        this.state = { type: 'IDLE' };
        return effects;

      case 'SPEAKING_STARTED':
        this.state = { type: 'SPEAKING' };
        return effects;

      case 'SPEAKING_COMPLETE':
        this.state = { type: 'IDLE' };
        return effects;

      case 'ENTER_CHANNEL_SELECTION': {
        this.clearTimers();
        const contract = getInteractionContractById('channel-selection');
        const timeoutMs = event.timeoutMs ?? contract.defaultTimeoutMs;
        this.state = {
          type: 'AWAITING_CHANNEL_SELECTION',
          options: event.options,
          enteredAt: Date.now(),
          timeoutMs,
          warningFired: false,
        };
        this.scheduleTimers(timeoutMs, contract.timeoutText);
        return effects;
      }

      case 'ENTER_QUEUE_CHOICE': {
        this.clearTimers();
        const contract = getInteractionContractById('queue-choice');
        const timeoutMs = event.timeoutMs ?? contract.defaultTimeoutMs;
        this.state = {
          type: 'AWAITING_QUEUE_CHOICE',
          userId: event.userId,
          transcript: event.transcript,
          enteredAt: Date.now(),
          timeoutMs,
          warningFired: false,
        };
        this.scheduleTimers(timeoutMs, contract.timeoutText);
        return effects;
      }

      case 'ENTER_SWITCH_CHOICE': {
        this.clearTimers();
        const contract = getInteractionContractById('switch-choice');
        const timeoutMs = event.timeoutMs ?? contract.defaultTimeoutMs;
        this.state = {
          type: 'AWAITING_SWITCH_CHOICE',
          lastMessage: event.lastMessage,
          enteredAt: Date.now(),
          timeoutMs,
          warningFired: false,
        };
        this.scheduleTimers(timeoutMs, contract.timeoutText);
        return effects;
      }

      case 'ENTER_NEW_POST_FLOW': {
        this.clearTimers();
        const contract = getInteractionContractById(
          event.step === 'forum' ? 'new-post-forum' : event.step === 'title' ? 'new-post-title' : 'new-post-body',
        );
        const timeoutMs = event.timeoutMs ?? contract.defaultTimeoutMs;
        this.state = {
          type: 'NEW_POST_FLOW',
          step: event.step,
          forumId: event.forumId,
          forumName: event.forumName,
          title: event.title,
          enteredAt: Date.now(),
          timeoutMs,
          warningFired: false,
        };
        this.scheduleTimers(timeoutMs, contract.timeoutText);
        return effects;
      }

      case 'NEW_POST_ADVANCE': {
        this.clearTimers();
        const contract = getInteractionContractById(
          event.step === 'forum' ? 'new-post-forum' : event.step === 'title' ? 'new-post-title' : 'new-post-body',
        );
        const timeoutMs = event.timeoutMs ?? contract.defaultTimeoutMs;
        this.state = {
          type: 'NEW_POST_FLOW',
          step: event.step,
          forumId: event.forumId,
          forumName: event.forumName,
          title: event.title,
          enteredAt: Date.now(),
          timeoutMs,
          warningFired: false,
        };
        this.scheduleTimers(timeoutMs, contract.timeoutText);
        return effects;
      }

      case 'ENTER_INBOX_FLOW':
        this.clearTimers();
        this.state = {
          type: 'INBOX_FLOW',
          items: event.items,
          index: 0,
          returnChannel: event.returnChannel ?? null,
        };
        return effects;

      case 'INBOX_ADVANCE':
        if (this.state.type === 'INBOX_FLOW') {
          this.state = {
            ...this.state,
            index: this.state.index + 1,
          };
        }
        return effects;

      case 'AWAITING_INPUT_RECEIVED':
        if (!event.recognized && this.isAwaitingState()) {
          effects.push({ type: 'earcon', name: 'error' });
          effects.push({ type: 'speak', text: this.getRepromptText() });
          this.resetAwaitingTimers();
        }
        return effects;

      case 'TIMEOUT_CHECK':
        return this.checkTimeouts();

      case 'CANCEL_FLOW':
        this.clearTimers();
        effects.push({ type: 'earcon', name: 'cancelled' });
        this.state = { type: 'IDLE' };
        return effects;

      case 'RETURN_TO_IDLE':
        this.clearTimers();
        this.state = { type: 'IDLE' };
        return effects;
    }

    return effects;
  }

  /**
   * Handle an utterance arriving: if busy, buffer and produce busy earcon.
   */
  private handleUtteranceReceived(effects: TransitionEffect[]): TransitionEffect[] {
    if (this.isAwaitingState()) {
      // User is responding to a prompt; pause timeout timers while capture/STT runs.
      this.clearTimers();
      return effects;
    }

    if (this.state.type === 'PROCESSING') {
      effects.push({ type: 'earcon', name: 'busy' });
      return effects;
    }

    if (this.state.type === 'SPEAKING') {
      effects.push({ type: 'stop-playback' });
      effects.push({ type: 'earcon', name: 'busy' });
      return effects;
    }

    if (this.state.type === 'IDLE') {
      this.state = { type: 'TRANSCRIBING' };
    }

    return effects;
  }

  /**
   * Check if any AWAITING state has timed out or needs a warning.
   * Returns effects to apply. Called periodically by the pipeline or by internal timers.
   */
  private checkTimeouts(): TransitionEffect[] {
    const effects: TransitionEffect[] = [];
    const s = this.state;

    if (!this.isAwaitingState()) return effects;

    const awaiting = s as AwaitingChannelSelectionState | AwaitingQueueChoiceState | AwaitingSwitchChoiceState | NewPostFlowState;
    const elapsed = Date.now() - awaiting.enteredAt;
    const remaining = awaiting.timeoutMs - elapsed;

    if (remaining <= 0) {
      // Timed out
      effects.push({ type: 'earcon', name: 'cancelled' });
      this.state = { type: 'IDLE' };
      this.clearTimers();
    } else if (remaining <= DEFAULT_WARNING_BEFORE_MS && !awaiting.warningFired) {
      // Warning
      effects.push({ type: 'earcon', name: 'timeout-warning' });
      awaiting.warningFired = true;
    }

    return effects;
  }

  /**
   * Whether the current state is an AWAITING state with timeout tracking.
   */
  isAwaitingState(): boolean {
    return (
      this.state.type === 'AWAITING_CHANNEL_SELECTION' ||
      this.state.type === 'AWAITING_QUEUE_CHOICE' ||
      this.state.type === 'AWAITING_SWITCH_CHOICE' ||
      this.state.type === 'NEW_POST_FLOW'
    );
  }

  /**
   * Get the reprompt text for the current AWAITING state.
   */
  getRepromptText(): string {
    const contract = getInteractionContractForState(this.state);
    return contract?.repromptText ?? '';
  }

  /**
   * Get inbox flow state for the pipeline to use.
   */
  getInboxFlowState(): { items: any[]; index: number; returnChannel: string | null } | null {
    if (this.state.type !== 'INBOX_FLOW') return null;
    return { items: this.state.items, index: this.state.index, returnChannel: this.state.returnChannel };
  }

  /**
   * Get the new-post flow data.
   */
  getNewPostFlowState(): NewPostFlowState | null {
    if (this.state.type !== 'NEW_POST_FLOW') return null;
    return this.state;
  }

  /**
   * Get queue choice state data.
   */
  getQueueChoiceState(): AwaitingQueueChoiceState | null {
    if (this.state.type !== 'AWAITING_QUEUE_CHOICE') return null;
    return this.state;
  }

  /**
   * Get switch choice state data.
   */
  getSwitchChoiceState(): AwaitingSwitchChoiceState | null {
    if (this.state.type !== 'AWAITING_SWITCH_CHOICE') return null;
    return this.state;
  }

  /**
   * Get channel selection state data.
   */
  getChannelSelectionState(): AwaitingChannelSelectionState | null {
    if (this.state.type !== 'AWAITING_CHANNEL_SELECTION') return null;
    return this.state;
  }

  /**
   * Schedule warning and timeout timers for the current AWAITING state.
   */
  private scheduleTimers(timeoutMs: number, timeoutMessage: string): void {
    this.clearTimers();

    const warningMs = Math.max(0, timeoutMs - DEFAULT_WARNING_BEFORE_MS);

    this.warningTimer = setTimeout(() => {
      const effects: TransitionEffect[] = [];
      if (this.isAwaitingState()) {
        effects.push({ type: 'earcon', name: 'timeout-warning' });
        const s = this.state as any;
        if ('warningFired' in s) s.warningFired = true;
      }
      if (effects.length > 0) {
        this.onTimeout?.(effects);
      }
    }, warningMs);

    this.timeoutTimer = setTimeout(() => {
      const effects: TransitionEffect[] = [];
      effects.push({ type: 'earcon', name: 'cancelled' });
      effects.push({ type: 'speak', text: timeoutMessage });
      this.state = { type: 'IDLE' };
      this.clearTimers();
      this.onTimeout?.(effects);
    }, timeoutMs);
  }

  /**
   * Clear all active timers.
   */
  clearTimers(): void {
    if (this.warningTimer) {
      clearTimeout(this.warningTimer);
      this.warningTimer = null;
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private getTimeoutMessageForCurrentState(): string {
    const contract = getInteractionContractForState(this.state);
    return contract?.timeoutText ?? 'Choice timed out.';
  }

  private resetAwaitingTimers(): void {
    if (!this.isAwaitingState()) return;
    const timeoutMs = (this.state as AwaitingChannelSelectionState | AwaitingQueueChoiceState | AwaitingSwitchChoiceState | NewPostFlowState).timeoutMs;
    (this.state as AwaitingChannelSelectionState | AwaitingQueueChoiceState | AwaitingSwitchChoiceState | NewPostFlowState).enteredAt = Date.now();
    (this.state as AwaitingChannelSelectionState | AwaitingQueueChoiceState | AwaitingSwitchChoiceState | NewPostFlowState).warningFired = false;
    this.scheduleTimers(timeoutMs, this.getTimeoutMessageForCurrentState());
  }

  /**
   * Clean up when pipeline is stopped.
   */
  destroy(): void {
    this.clearTimers();
    this.bufferedUtterances = [];
    this.state = { type: 'IDLE' };
  }
}
