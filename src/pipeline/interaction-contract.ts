import type { PipelineState } from './pipeline-state.js';

export type InteractionContractId =
  | 'channel-selection'
  | 'queue-choice'
  | 'switch-choice'
  | 'new-post-forum'
  | 'new-post-title'
  | 'new-post-body';

export interface InteractionContract {
  id: InteractionContractId;
  defaultTimeoutMs: number;
  repromptText: string;
  timeoutText: string;
  acceptedIntents: readonly string[];
  feedbackOnRecognized: 'acknowledged';
  readyCueAfterHandling: true;
}

export const INTERACTION_CONTRACTS: Record<InteractionContractId, InteractionContract> = {
  'channel-selection': {
    id: 'channel-selection',
    defaultTimeoutMs: 15_000,
    repromptText: 'Say a number or channel name, or cancel.',
    timeoutText: 'Selection timed out. You can try again.',
    acceptedIntents: ['select-number', 'select-name', 'cancel'],
    feedbackOnRecognized: 'acknowledged',
    readyCueAfterHandling: true,
  },
  'queue-choice': {
    id: 'queue-choice',
    defaultTimeoutMs: 20_000,
    repromptText: 'Say send to inbox, wait here, or cancel.',
    timeoutText: 'Choice timed out.',
    acceptedIntents: ['inbox', 'wait', 'silent', 'cancel', 'navigate'],
    feedbackOnRecognized: 'acknowledged',
    readyCueAfterHandling: true,
  },
  'switch-choice': {
    id: 'switch-choice',
    defaultTimeoutMs: 30_000,
    repromptText: 'Say last message, new prompt, or cancel.',
    timeoutText: 'Switch choice timed out.',
    acceptedIntents: ['read', 'prompt', 'cancel'],
    feedbackOnRecognized: 'acknowledged',
    readyCueAfterHandling: true,
  },
  'new-post-forum': {
    id: 'new-post-forum',
    defaultTimeoutMs: 30_000,
    repromptText: 'Say a forum name, or cancel.',
    timeoutText: 'New post flow timed out.',
    acceptedIntents: ['forum-name', 'cancel'],
    feedbackOnRecognized: 'acknowledged',
    readyCueAfterHandling: true,
  },
  'new-post-title': {
    id: 'new-post-title',
    defaultTimeoutMs: 30_000,
    repromptText: 'Say the title, or cancel.',
    timeoutText: 'New post flow timed out.',
    acceptedIntents: ['title', 'cancel'],
    feedbackOnRecognized: 'acknowledged',
    readyCueAfterHandling: true,
  },
  'new-post-body': {
    id: 'new-post-body',
    defaultTimeoutMs: 60_000,
    repromptText: 'Say the prompt, or cancel.',
    timeoutText: 'New post flow timed out.',
    acceptedIntents: ['body', 'cancel'],
    feedbackOnRecognized: 'acknowledged',
    readyCueAfterHandling: true,
  },
};

export function getInteractionContractById(id: InteractionContractId): InteractionContract {
  return INTERACTION_CONTRACTS[id];
}

export function getInteractionContractForState(state: PipelineState): InteractionContract | null {
  switch (state.type) {
    case 'AWAITING_CHANNEL_SELECTION':
      return INTERACTION_CONTRACTS['channel-selection'];
    case 'AWAITING_QUEUE_CHOICE':
      return INTERACTION_CONTRACTS['queue-choice'];
    case 'AWAITING_SWITCH_CHOICE':
      return INTERACTION_CONTRACTS['switch-choice'];
    case 'NEW_POST_FLOW':
      if (state.step === 'forum') return INTERACTION_CONTRACTS['new-post-forum'];
      if (state.step === 'title') return INTERACTION_CONTRACTS['new-post-title'];
      return INTERACTION_CONTRACTS['new-post-body'];
    default:
      return null;
  }
}
