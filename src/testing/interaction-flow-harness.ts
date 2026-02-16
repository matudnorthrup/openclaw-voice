import {
  PipelineStateMachine,
  type PipelineEvent,
  type PipelineStateType,
  type TransitionEffect,
} from '../pipeline/pipeline-state.js';
import {
  matchChannelSelection,
  matchQueueChoice,
  matchSwitchChoice,
  matchesWakeWord,
  parseVoiceCommand,
  type VoiceCommand,
  type ChannelOption,
} from '../services/voice-commands.js';

export type HarnessEvent =
  | { type: 'state'; state: PipelineStateType }
  | { type: 'earcon'; name: string }
  | { type: 'speak'; text: string }
  | { type: 'ready' }
  | { type: 'recognized'; intent: string }
  | { type: 'unrecognized'; transcript: string }
  | { type: 'rejected'; transcript: string; reason: 'gated-no-wake' };

/**
 * Deterministic simulator for interaction-contract flows.
 * It intentionally avoids Discord/audio IO and only validates
 * state transitions, recognized intents, and feedback sequencing.
 */
export class InteractionFlowHarness {
  private static readonly DEFAULT_READY_GRACE_MS = 5_000;
  private readonly botName: string;
  private readonly sm: PipelineStateMachine;
  private readonly events: HarnessEvent[] = [];
  private gated = false;
  private gateGraceUntil = 0;

  constructor(botName = 'Watson') {
    this.botName = botName;
    this.sm = new PipelineStateMachine();
    this.sm.setTimeoutHandler((effects) => this.applyEffects(effects));
    this.recordState();
  }

  destroy(): void {
    this.sm.destroy();
  }

  getState(): PipelineStateType {
    return this.sm.getStateType();
  }

  setGatedMode(enabled: boolean): void {
    this.gated = enabled;
  }

  playReadyCue(graceMs = InteractionFlowHarness.DEFAULT_READY_GRACE_MS): void {
    this.gateGraceUntil = Date.now() + graceMs;
    this.events.push({ type: 'ready' });
  }

  isInReadyGraceWindow(): boolean {
    return Date.now() < this.gateGraceUntil;
  }

  getEvents(): HarnessEvent[] {
    return [...this.events];
  }

  clearEvents(): void {
    this.events.length = 0;
  }

  enterQueueChoice(userId = 'u1', transcript = 'hello'): void {
    this.transition({
      type: 'ENTER_QUEUE_CHOICE',
      userId,
      transcript,
    });
  }

  enterSwitchChoice(lastMessage: string): void {
    this.transition({
      type: 'ENTER_SWITCH_CHOICE',
      lastMessage,
    });
  }

  enterChannelSelection(options: ChannelOption[]): void {
    this.transition({
      type: 'ENTER_CHANNEL_SELECTION',
      options,
    });
  }

  sendTranscript(transcript: string): void {
    this.transition({ type: 'UTTERANCE_RECEIVED' });

    const state = this.sm.getStateType();
    if (state === 'AWAITING_QUEUE_CHOICE') {
      this.handleQueueChoice(transcript);
      return;
    }
    if (state === 'AWAITING_SWITCH_CHOICE') {
      this.handleSwitchChoice(transcript);
      return;
    }
    if (state === 'AWAITING_CHANNEL_SELECTION') {
      this.handleChannelSelection(transcript);
      return;
    }

    this.handleGeneralTurn(transcript);
  }

  private handleGeneralTurn(transcript: string): void {
    const hasWakeWord = matchesWakeWord(transcript, this.botName);
    const inReadyGrace = this.isInReadyGraceWindow();

    if (this.gated && !inReadyGrace && !hasWakeWord) {
      this.events.push({ type: 'rejected', transcript, reason: 'gated-no-wake' });
      this.transition({ type: 'RETURN_TO_IDLE' });
      return;
    }

    const cmd = parseVoiceCommand(transcript, this.botName);
    if (cmd) {
      const resolved = this.resolveDoneCommandForContext(cmd, transcript);
      this.events.push({ type: 'recognized', intent: resolved.type });
      this.transition({ type: 'RETURN_TO_IDLE' });
      if (resolved.type !== 'wake-check') {
        this.events.push({ type: 'earcon', name: 'acknowledged' });
      }
      this.playReadyCue();
      return;
    }

    this.events.push({ type: 'recognized', intent: 'prompt' });
    this.transition({ type: 'PROCESSING_STARTED' });
    this.transition({ type: 'PROCESSING_COMPLETE' });
    this.events.push({ type: 'earcon', name: 'acknowledged' });
    this.events.push({ type: 'speak', text: 'Simulated assistant response.' });
    this.playReadyCue();
  }

  private handleQueueChoice(transcript: string): void {
    const parsed = matchQueueChoice(transcript);
    if (parsed === 'queue' || parsed === 'wait' || parsed === 'silent' || parsed === 'cancel') {
      this.events.push({ type: 'recognized', intent: parsed });
      this.transition({ type: 'RETURN_TO_IDLE' });
      this.events.push({ type: 'earcon', name: 'acknowledged' });
      this.playReadyCue();
      return;
    }

    const cmd = parseVoiceCommand(transcript, this.botName);
    if (cmd && (cmd.type === 'switch' || cmd.type === 'list' || cmd.type === 'default')) {
      this.events.push({ type: 'recognized', intent: cmd.type });
      this.transition({ type: 'RETURN_TO_IDLE' });
      this.events.push({ type: 'earcon', name: 'acknowledged' });
      this.playReadyCue();
      return;
    }

    this.events.push({ type: 'unrecognized', transcript });
    this.applyEffects(this.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false }));
    this.events.push({ type: 'ready' });
  }

  private handleSwitchChoice(transcript: string): void {
    const choice = matchSwitchChoice(transcript);
    if (!choice) {
      const cmd = parseVoiceCommand(transcript, this.botName);
      if (
        cmd &&
        (
          cmd.type === 'switch' ||
          cmd.type === 'list' ||
          cmd.type === 'default' ||
          cmd.type === 'inbox-check'
        )
      ) {
        this.events.push({ type: 'recognized', intent: cmd.type });
        this.transition({ type: 'RETURN_TO_IDLE' });
        this.events.push({ type: 'earcon', name: 'acknowledged' });
        this.playReadyCue();
        return;
      }

      this.events.push({ type: 'unrecognized', transcript });
      this.applyEffects(this.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false }));
      this.events.push({ type: 'ready' });
      return;
    }

    this.events.push({ type: 'recognized', intent: choice });
    const switchState = this.sm.getSwitchChoiceState();
    this.transition({ type: 'RETURN_TO_IDLE' });
    this.events.push({ type: 'earcon', name: 'acknowledged' });
    if (choice === 'read' && switchState?.lastMessage) {
      this.events.push({ type: 'speak', text: switchState.lastMessage });
    }
    this.playReadyCue();
  }

  private handleChannelSelection(transcript: string): void {
    const sel = this.sm.getChannelSelectionState();
    if (!sel) return;

    const matched = matchChannelSelection(transcript, sel.options);
    if (!matched) {
      this.events.push({ type: 'unrecognized', transcript });
      this.applyEffects(this.transition({ type: 'AWAITING_INPUT_RECEIVED', recognized: false }));
      this.events.push({ type: 'ready' });
      return;
    }

    this.events.push({ type: 'recognized', intent: `channel:${matched.name}` });
    this.transition({ type: 'RETURN_TO_IDLE' });
    this.events.push({ type: 'earcon', name: 'acknowledged' });
    this.playReadyCue();
  }

  private transition(event: PipelineEvent): TransitionEffect[] {
    const effects = this.sm.transition(event);
    this.applyEffects(effects);
    this.recordState();
    return effects;
  }

  private applyEffects(effects: TransitionEffect[]): void {
    for (const effect of effects) {
      if (effect.type === 'earcon') {
        this.events.push({ type: 'earcon', name: effect.name });
      } else if (effect.type === 'speak') {
        this.events.push({ type: 'speak', text: effect.text });
      }
    }
  }

  private recordState(): void {
    this.events.push({ type: 'state', state: this.sm.getStateType() });
  }

  private resolveDoneCommandForContext(cmd: VoiceCommand, transcript: string): VoiceCommand {
    if (cmd.type !== 'inbox-next') return cmd;
    if (this.sm.getInboxFlowState()) return cmd;

    const input = transcript.trim().toLowerCase().replace(/[.!?,]+$/, '');
    const wakePrefix = this.botName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const donePattern = new RegExp(
      `^(?:(?:hey|hello),?\\s+)?${wakePrefix}[,.]?\\s*(?:done|(?:i'?m|i\\s+am)\\s+done)$|^(?:done|(?:i'?m|i\\s+am)\\s+done)$`,
      'i',
    );
    if (donePattern.test(input)) {
      return { type: 'default' } as const;
    }
    return cmd;
  }
}
