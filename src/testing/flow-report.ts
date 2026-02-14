import { InteractionFlowHarness, type HarnessEvent } from './interaction-flow-harness.js';

type Scenario = {
  id: string;
  run: () => HarnessEvent[];
  validate: (events: HarnessEvent[]) => string[];
};

function hasEvent(events: HarnessEvent[], expected: Partial<HarnessEvent>): boolean {
  return events.some((ev) => {
    for (const [k, v] of Object.entries(expected)) {
      if ((ev as any)[k] !== v) return false;
    }
    return true;
  });
}

const scenarios: Scenario[] = [
  {
    id: 'queue-choice-reprompt-then-wait',
    run: () => {
      const h = new InteractionFlowHarness();
      h.enterQueueChoice('u1', 'hello');
      h.clearEvents();
      h.sendTranscript('maybe');
      h.sendTranscript('wait here');
      const events = h.getEvents();
      h.destroy();
      return events;
    },
    validate: (events) => {
      const errors: string[] = [];
      if (!hasEvent(events, { type: 'earcon', name: 'error' })) errors.push('missing error earcon');
      if (!hasEvent(events, { type: 'recognized', intent: 'wait' })) errors.push('missing wait recognition');
      if (!hasEvent(events, { type: 'ready' })) errors.push('missing ready cue');
      return errors;
    },
  },
  {
    id: 'gated-reject-outside-grace',
    run: () => {
      const h = new InteractionFlowHarness();
      h.setGatedMode(true);
      h.clearEvents();
      h.sendTranscript('what is new');
      const events = h.getEvents();
      h.destroy();
      return events;
    },
    validate: (events) => {
      const errors: string[] = [];
      if (!hasEvent(events, { type: 'rejected', reason: 'gated-no-wake' })) {
        errors.push('expected gated rejection');
      }
      return errors;
    },
  },
  {
    id: 'gated-accept-during-ready-grace',
    run: () => {
      const h = new InteractionFlowHarness();
      h.setGatedMode(true);
      h.playReadyCue(5_000);
      h.clearEvents();
      h.sendTranscript('what is new');
      const events = h.getEvents();
      h.destroy();
      return events;
    },
    validate: (events) => {
      const errors: string[] = [];
      if (!hasEvent(events, { type: 'recognized', intent: 'prompt' })) {
        errors.push('expected prompt acceptance during grace');
      }
      if (!hasEvent(events, { type: 'speak', text: 'Simulated assistant response.' })) {
        errors.push('missing simulated response');
      }
      return errors;
    },
  },
];

function main(): void {
  let failed = 0;
  for (const scenario of scenarios) {
    const events = scenario.run();
    const errors = scenario.validate(events);
    if (errors.length === 0) {
      console.log(`PASS ${scenario.id}`);
      continue;
    }
    failed++;
    console.log(`FAIL ${scenario.id}`);
    for (const err of errors) {
      console.log(`  - ${err}`);
    }
  }

  if (failed > 0) {
    console.log(`\n${failed} scenario(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${scenarios.length} scenarios passed.`);
  }
}

main();
