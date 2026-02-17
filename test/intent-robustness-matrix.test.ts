import { describe, expect, it } from 'vitest';
import { matchQueueChoice, matchSwitchChoice } from '../src/services/voice-commands.js';

describe('Intent robustness matrix', () => {
  it('queue-choice variants resolve consistently', () => {
    const cases: Array<{ transcript: string; expected: ReturnType<typeof matchQueueChoice> }> = [
      { transcript: 'inbox', expected: 'queue' },
      { transcript: 'in box', expected: 'queue' },
      { transcript: 'send to inbox', expected: 'queue' },
      { transcript: 'queue', expected: 'queue' },
      { transcript: 'cue', expected: 'queue' },
      { transcript: 'yes', expected: 'queue' },
      { transcript: 'wait', expected: 'wait' },
      { transcript: 'wait here', expected: 'wait' },
      { transcript: 'weight', expected: 'wait' },
      { transcript: 'wheat', expected: 'wait' },
      { transcript: 'way', expected: 'wait' },
      { transcript: 'nope', expected: 'wait' },
      { transcript: 'silent', expected: 'silent' },
      { transcript: 'quietly', expected: 'silent' },
      { transcript: 'cancel', expected: 'cancel' },
      { transcript: 'never mind', expected: 'cancel' },
      { transcript: 'ignore that', expected: 'cancel' },
      { transcript: 'inbox wait', expected: null },
    ];

    for (const c of cases) {
      expect(matchQueueChoice(c.transcript), `queue-choice: "${c.transcript}"`).toBe(c.expected);
    }
  });

  it('switch-choice variants resolve consistently', () => {
    const cases: Array<{ transcript: string; expected: ReturnType<typeof matchSwitchChoice> }> = [
      { transcript: 'last message', expected: 'read' },
      { transcript: 'read', expected: 'read' },
      { transcript: 'read it back', expected: 'read' },
      { transcript: 'reed', expected: 'read' },
      { transcript: 'red', expected: 'read' },
      { transcript: 'yes', expected: 'read' },
      { transcript: 'new prompt', expected: 'prompt' },
      { transcript: 'new message', expected: 'prompt' },
      { transcript: 'prompt', expected: 'prompt' },
      { transcript: 'frompt', expected: 'prompt' },
      { transcript: 'romped', expected: 'prompt' },
      { transcript: 'skip', expected: 'prompt' },
      { transcript: 'cancel', expected: 'cancel' },
      { transcript: 'never mind', expected: 'cancel' },
      { transcript: 'nothing', expected: 'cancel' },
      { transcript: 'hmm', expected: null },
    ];

    for (const c of cases) {
      expect(matchSwitchChoice(c.transcript), `switch-choice: "${c.transcript}"`).toBe(c.expected);
    }
  });
});
