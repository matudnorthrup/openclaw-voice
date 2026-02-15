import { matchQueueChoice, matchSwitchChoice } from '../services/voice-commands.js';

type Mode = 'wait' | 'ask' | 'queue';
type UiState = 'IDLE' | 'AWAITING_QUEUE_CHOICE' | 'AWAITING_SWITCH_CHOICE' | 'INBOX_FLOW';

type QueueItem = {
  id: string;
  channel: string;
  prompt: string;
  status: 'pending' | 'ready';
};

type ScenarioResult = {
  id: string;
  passes: string[];
  breaks: string[];
};

class OverlapFlowSimulator {
  mode: Mode = 'wait';
  state: UiState = 'IDLE';
  activeChannel = 'general';
  pendingWaitId: string | null = null;
  switchChoiceLastMessage: string | null = null;
  switchPromptCount = 0;
  queuePromptItemId: string | null = null;
  inboxFlow: { channels: string[]; index: number } | null = null;
  private seq = 1;
  private readonly queue = new Map<string, QueueItem>();
  private readonly lastMessageByChannel: Record<string, string>;
  private gated = false;

  constructor(channels: Record<string, string>) {
    this.lastMessageByChannel = channels;
  }

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  setGated(enabled: boolean): void {
    this.gated = enabled;
  }

  say(transcript: string): string[] {
    const events: string[] = [];
    const normalized = transcript.trim().toLowerCase();

    if (this.state === 'INBOX_FLOW') {
      if (/^(?:next|next response|next one|next message|next channel)$/.test(normalized)) {
        if (!this.inboxFlow || this.inboxFlow.index >= this.inboxFlow.channels.length) {
          this.state = 'IDLE';
          this.inboxFlow = null;
          events.push('inbox-next:none');
          return events;
        }
        const channel = this.inboxFlow.channels[this.inboxFlow.index++];
        this.activeChannel = channel;
        this.markChannelReadyAsHeard(channel);
        events.push(`inbox-next:read:${channel}`);
        if (this.inboxFlow.index >= this.inboxFlow.channels.length) {
          this.state = 'IDLE';
          this.inboxFlow = null;
          events.push('inbox-flow:complete');
        }
        events.push('ready');
        return events;
      }

      if (/^(?:done|i'm done|im done|i am done|skip|move on)$/.test(normalized)) {
        this.state = 'IDLE';
        this.inboxFlow = null;
        events.push('inbox-flow:done');
        events.push('ready');
        return events;
      }

      const navMatch = normalized.match(/^(?:hey\s+watson,\s*)?(?:switch|go|change|move)\s+to\s+(.+)$/);
      if (navMatch) {
        this.state = 'IDLE';
        this.inboxFlow = null;
        events.push('inbox-flow:cleared-on-nav');
        events.push(...this.switchTo(navMatch[1].trim()));
        return events;
      }
    }

    if (this.state === 'AWAITING_QUEUE_CHOICE') {
      const choice = matchQueueChoice(transcript);
      if (choice === 'queue' || choice === 'silent') {
        this.state = 'IDLE';
        this.queuePromptItemId = null;
        events.push('queue-choice:accepted->queued');
        return events;
      }
      if (choice === 'wait') {
        this.state = 'IDLE';
        if (this.queuePromptItemId) {
          this.pendingWaitId = this.queuePromptItemId;
        }
        this.queuePromptItemId = null;
        events.push('queue-choice:accepted->wait');
        return events;
      }
      if (choice === 'cancel') {
        this.state = 'IDLE';
        this.queuePromptItemId = null;
        events.push('queue-choice:cancelled');
        return events;
      }

      const navMatch = transcript.toLowerCase().match(/^(?:hey\s+watson,\s*)?(?:switch|go|change|move)\s+to\s+(.+)$/);
      if (navMatch) {
        const target = navMatch[1].trim();
        this.state = 'IDLE';
        events.push('queue-choice:navigation');
        events.push(...this.switchTo(target));
        return events;
      }

      events.push('queue-choice:reprompt');
      return events;
    }

    if (this.state === 'AWAITING_SWITCH_CHOICE') {
      const choice = matchSwitchChoice(transcript);
      if (choice === 'read') {
        this.state = 'IDLE';
        events.push('switch-choice:read');
        events.push('ready');
        return events;
      }
      if (choice === 'prompt') {
        this.state = 'IDLE';
        this.switchPromptCount++;
        events.push('switch-choice:prompt');
        events.push('ready');
        return events;
      }
      if (choice === 'cancel') {
        this.state = 'IDLE';
        events.push('switch-choice:cancel');
        return events;
      }

      const navMatch = transcript.toLowerCase().match(/^(?:hey\s+watson,\s*)?(?:switch|go|change|move)\s+to\s+(.+)$/);
      if (navMatch) {
        this.state = 'IDLE';
        events.push('switch-choice:navigation');
        events.push(...this.switchTo(navMatch[1].trim()));
        return events;
      }
      events.push('switch-choice:reprompt');
      return events;
    }

    const switchMatch = transcript.toLowerCase().match(/^(?:hey\s+watson,\s*)?(?:switch|go|change|move)\s+to\s+(.+)$/);
    if (switchMatch) {
      this.cancelPendingWait(events, 'nav');
      events.push(...this.switchTo(switchMatch[1].trim()));
      return events;
    }

    if (/^(?:hey\s+watson,\s*)?(?:inbox|inbox list|check inbox|check queue|what's new|whats new)$/.test(normalized)) {
      const channels = this.getReadyChannels();
      if (channels.length === 0) {
        events.push('inbox-check:empty');
        events.push('ready');
        return events;
      }
      this.state = 'INBOX_FLOW';
      this.inboxFlow = { channels, index: 0 };
      events.push(`inbox-check:${channels.join(',')}`);
      events.push('ready');
      return events;
    }

    if (/^(?:next|next response|next one|next message|next channel)$/.test(normalized)) {
      events.push('next:ignored-not-in-inbox-flow');
      return events;
    }

    if (this.gated && this.pendingWaitId && !/^hey\s+watson\b/i.test(transcript.trim())) {
      events.push('gated-pending-wait:rejected-no-wake');
      return events;
    }

    events.push(...this.prompt(transcript));
    return events;
  }

  complete(itemId: string): string[] {
    const events: string[] = [];
    const item = this.queue.get(itemId);
    if (!item) {
      events.push('complete:missing-item');
      return events;
    }

    item.status = 'ready';
    events.push(`complete:${itemId}:ready:${item.channel}`);

    if (this.pendingWaitId === itemId) {
      this.pendingWaitId = null;
      item.status = 'ready';
      events.push(`deliver:${itemId}:spoken`);
      events.push('ready');
      return events;
    }

    // In queue mode, if idle and still in the same channel, auto-read instead
    // of announcing readiness.
    if (this.mode === 'queue' && this.state === 'IDLE' && item.channel === this.activeChannel) {
      events.push(`auto-read:${itemId}:${item.channel}`);
      this.queue.delete(itemId);
      events.push('ready');
      return events;
    }

    // Mirrors current runtime risk: if system is not idle (menu active or waiting on another callback),
    // idle notify is skipped and not retried.
    if (this.state !== 'IDLE' || this.pendingWaitId) {
      events.push(`notify:${itemId}:dropped-busy`);
      return events;
    }

    events.push(`notify:${itemId}:spoken`);
    return events;
  }

  getQueueItemStatus(itemId: string): 'pending' | 'ready' | 'missing' {
    const item = this.queue.get(itemId);
    return item?.status ?? 'missing';
  }

  getState(): UiState {
    return this.state;
  }

  getActiveChannel(): string {
    return this.activeChannel;
  }

  getPendingWaitId(): string | null {
    return this.pendingWaitId;
  }

  getReadyCount(): number {
    let count = 0;
    for (const item of this.queue.values()) {
      if (item.status === 'ready') count++;
    }
    return count;
  }

  getPendingCount(): number {
    let count = 0;
    for (const item of this.queue.values()) {
      if (item.status === 'pending') count++;
    }
    return count;
  }

  private prompt(text: string): string[] {
    const events: string[] = [];
    const itemId = this.newQueueItem(this.activeChannel, text);
    events.push(`prompt:${itemId}:${this.activeChannel}`);

    if (this.mode === 'wait') {
      this.pendingWaitId = itemId;
      events.push(`wait-callback:${itemId}`);
      return events;
    }

    if (this.mode === 'queue') {
      events.push(`queue-dispatch:${itemId}`);
      return events;
    }

    this.state = 'AWAITING_QUEUE_CHOICE';
    this.queuePromptItemId = itemId;
    events.push(`ask-choice:${itemId}`);
    events.push('ready');
    return events;
  }

  private switchTo(targetChannel: string): string[] {
    const events: string[] = [];
    this.activeChannel = targetChannel;
    events.push(`switch:${targetChannel}`);

    if (this.lastMessageByChannel[targetChannel]) {
      this.state = 'AWAITING_SWITCH_CHOICE';
      this.switchChoiceLastMessage = this.lastMessageByChannel[targetChannel];
      events.push('switch-choice:prompted');
      events.push('ready');
      return events;
    }

    this.state = 'IDLE';
    events.push('ready');
    return events;
  }

  private cancelPendingWait(events: string[], reason: string): void {
    if (!this.pendingWaitId) return;
    events.push(`pending-wait-cancelled:${this.pendingWaitId}:${reason}`);
    this.pendingWaitId = null;
  }

  private newQueueItem(channel: string, prompt: string): string {
    const id = `q${this.seq++}`;
    this.queue.set(id, { id, channel, prompt, status: 'pending' });
    return id;
  }

  private getReadyChannels(): string[] {
    const channels = new Set<string>();
    for (const item of this.queue.values()) {
      if (item.status === 'ready') channels.add(item.channel);
    }
    return Array.from(channels);
  }

  private markChannelReadyAsHeard(channel: string): void {
    for (const item of this.queue.values()) {
      if (item.channel === channel && item.status === 'ready') {
        this.queue.delete(item.id);
      }
    }
  }
}

const scenarios: Array<() => ScenarioResult> = [
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message', nutrition: 'Nutrition last message' });
    sim.setMode('wait');
    const log: string[] = [];
    log.push(...sim.say('first prompt in general'));
    log.push(...sim.say('switch to nutrition'));
    log.push(...sim.say('new prompt'));
    log.push(...sim.say('second prompt in nutrition'));
    log.push(...sim.complete('q1'));
    log.push(...sim.complete('q2'));
    return {
      id: '01-wait-overlap-switch-then-new-prompt',
      passes: [
        log.includes('pending-wait-cancelled:q1:nav') ? 'pending wait cancelled on nav' : '',
        log.includes('deliver:q2:spoken') ? 'latest wait prompt delivered' : '',
        sim.getQueueItemStatus('q1') === 'ready' ? 'older prompt retained as ready' : '',
      ].filter(Boolean),
      breaks: [
        !log.includes('pending-wait-cancelled:q1:nav') ? 'missing pending-wait cancel on nav' : '',
        !log.includes('deliver:q2:spoken') ? 'latest wait prompt not delivered' : '',
        sim.getQueueItemStatus('q1') !== 'ready' ? 'older prompt not retained as ready' : '',
      ].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message', nutrition: 'Nutrition last message' });
    sim.setMode('ask');
    const log: string[] = [];
    log.push(...sim.say('first prompt in general'));
    log.push(...sim.say('switch to nutrition'));
    log.push(...sim.complete('q1'));
    log.push(...sim.say('last message'));
    return {
      id: '02-ask-navigation-with-overlap-completion',
      passes: [
        log.includes('queue-choice:navigation') ? 'ask-choice allows navigation' : '',
        sim.getQueueItemStatus('q1') === 'ready' ? 'speculative ready retained' : '',
      ].filter(Boolean),
      breaks: [
        !log.includes('queue-choice:navigation') ? 'ask-choice navigation failed' : '',
        sim.getQueueItemStatus('q1') !== 'ready' ? 'speculative completion not retained' : '',
      ].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message', nutrition: 'Nutrition last message' });
    const log: string[] = [];
    log.push(...sim.say('switch to nutrition'));
    log.push(...sim.say('switch to inbox'));
    return {
      id: '03-switch-choice-navigation',
      passes: [log.includes('switch-choice:navigation') ? 'switch-choice navigation accepted' : ''].filter(Boolean),
      breaks: [!log.includes('switch-choice:navigation') ? 'switch-choice navigation rejected' : ''].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message', nutrition: 'Nutrition last message' });
    sim.setMode('ask');
    const log: string[] = [];
    log.push(...sim.say('first prompt in general'));
    log.push(...sim.say('send to inbox'));
    log.push(...sim.complete('q1'));
    log.push(...sim.say('inbox'));
    log.push(...sim.say('next'));
    log.push(...sim.say('switch to nutrition'));
    log.push(...sim.say('new prompt'));
    log.push(...sim.say('second prompt in nutrition'));
    log.push(...sim.say('send to inbox'));
    log.push(...sim.complete('q2'));
    log.push(...sim.say('inbox'));
    return {
      id: '04-inbox-next-switch-prompt-inbox-cycle',
      passes: [
        log.includes('inbox-next:read:general') && log.includes('inbox-flow:complete') ? 'first inbox cycle clean' : '',
        log.includes('switch:nutrition') && log.includes('switch-choice:prompted') ? 'post-inbox switch enters switch-choice' : '',
        log.includes('inbox-check:nutrition') ? 'second inbox sees nutrition ready' : '',
      ].filter(Boolean),
      breaks: [
        !(log.includes('inbox-next:read:general') && log.includes('inbox-flow:complete')) ? 'first inbox cycle failed' : '',
        !(log.includes('switch:nutrition') && log.includes('switch-choice:prompted')) ? 'post-inbox switch flow failed' : '',
        !log.includes('inbox-check:nutrition') ? 'second inbox missing nutrition ready' : '',
      ].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message' });
    sim.setMode('wait');
    sim.say('long running prompt');
    const log = sim.say('inbox');
    return {
      id: '05-wait-inbox-empty-while-pending',
      passes: [log.includes('inbox-check:empty') ? 'inbox empty while pending' : ''].filter(Boolean),
      breaks: [!log.includes('inbox-check:empty') ? 'expected empty inbox while pending' : ''].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message' });
    sim.setMode('wait');
    sim.say('prompt');
    sim.complete('q1');
    const log = sim.say('inbox');
    return {
      id: '06-wait-inbox-shows-ready-after-complete',
      passes: [log.includes('inbox-check:general') ? 'inbox surfaces ready general item' : ''].filter(Boolean),
      breaks: [!log.includes('inbox-check:general') ? 'ready item not visible in inbox' : ''].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message' });
    const log = sim.say('next');
    return {
      id: '07-next-outside-inbox-flow',
      passes: [log.includes('next:ignored-not-in-inbox-flow') ? 'next ignored outside inbox flow' : ''].filter(Boolean),
      breaks: [!log.includes('next:ignored-not-in-inbox-flow') ? 'next handling outside inbox flow drifted' : ''].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ nutrition: 'Nutrition last message' });
    sim.say('switch to nutrition');
    const log = sim.say('last message');
    return {
      id: '08-switch-choice-read',
      passes: [log.includes('switch-choice:read') ? 'read accepted in switch-choice' : ''].filter(Boolean),
      breaks: [!log.includes('switch-choice:read') ? 'read failed in switch-choice' : ''].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ nutrition: 'Nutrition last message' });
    sim.say('switch to nutrition');
    const log = sim.say('new prompt');
    return {
      id: '09-switch-choice-new-prompt',
      passes: [log.includes('switch-choice:prompt') ? 'new prompt accepted in switch-choice' : ''].filter(Boolean),
      breaks: [!log.includes('switch-choice:prompt') ? 'new prompt failed in switch-choice' : ''].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ nutrition: 'Nutrition last message' });
    sim.say('switch to nutrition');
    const log = sim.say('cancel');
    return {
      id: '10-switch-choice-cancel',
      passes: [log.includes('switch-choice:cancel') ? 'cancel accepted in switch-choice' : ''].filter(Boolean),
      breaks: [!log.includes('switch-choice:cancel') ? 'cancel failed in switch-choice' : ''].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ nutrition: 'Nutrition last message' });
    sim.say('switch to nutrition');
    const log = sim.say('blabla');
    return {
      id: '11-switch-choice-reprompt',
      passes: [log.includes('switch-choice:reprompt') ? 'unknown phrase reprompted in switch-choice' : ''].filter(Boolean),
      breaks: [!log.includes('switch-choice:reprompt') ? 'switch-choice did not reprompt unknown phrase' : ''].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message' });
    sim.setMode('ask');
    sim.say('prompt');
    const log = sim.say('send to inbox');
    return {
      id: '12-ask-choice-send-to-inbox',
      passes: [log.includes('queue-choice:accepted->queued') ? 'send to inbox accepted' : ''].filter(Boolean),
      breaks: [!log.includes('queue-choice:accepted->queued') ? 'send to inbox not accepted' : ''].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message' });
    sim.setMode('ask');
    sim.say('prompt');
    const log = sim.say('wait here');
    return {
      id: '13-ask-choice-wait',
      passes: [
        log.includes('queue-choice:accepted->wait') ? 'wait accepted' : '',
        sim.getPendingWaitId() === 'q1' ? 'pending wait callback captured' : '',
      ].filter(Boolean),
      breaks: [
        !log.includes('queue-choice:accepted->wait') ? 'wait not accepted' : '',
        sim.getPendingWaitId() !== 'q1' ? 'pending wait callback missing' : '',
      ].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message' });
    sim.setMode('ask');
    sim.say('prompt');
    const log = sim.say('silent');
    return {
      id: '14-ask-choice-silent',
      passes: [log.includes('queue-choice:accepted->queued') ? 'silent resolves to queued branch' : ''].filter(Boolean),
      breaks: [!log.includes('queue-choice:accepted->queued') ? 'silent did not route to queued branch' : ''].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message' });
    sim.setMode('ask');
    sim.say('prompt');
    const log = sim.say('cancel');
    return {
      id: '15-ask-choice-cancel',
      passes: [log.includes('queue-choice:cancelled') ? 'cancel exits ask-choice' : ''].filter(Boolean),
      breaks: [!log.includes('queue-choice:cancelled') ? 'cancel failed in ask-choice' : ''].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message' });
    sim.setMode('ask');
    sim.say('prompt');
    const log = sim.say('unclear');
    return {
      id: '16-ask-choice-reprompt',
      passes: [log.includes('queue-choice:reprompt') ? 'unknown ask-choice reprompted' : ''].filter(Boolean),
      breaks: [!log.includes('queue-choice:reprompt') ? 'ask-choice did not reprompt unknown phrase' : ''].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message' });
    sim.setMode('ask');
    sim.say('prompt');
    const log = sim.say('inbox');
    return {
      id: '17-ask-choice-inbox-alias',
      passes: [log.includes('queue-choice:accepted->queued') ? 'inbox alias accepted as queue choice' : ''].filter(Boolean),
      breaks: [!log.includes('queue-choice:accepted->queued') ? 'inbox alias failed in ask-choice' : ''].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message' });
    sim.setMode('ask');
    sim.say('prompt');
    sim.say('send to inbox');
    sim.complete('q1');
    sim.say('inbox');
    const log = sim.say('done');
    return {
      id: '18-inbox-flow-done',
      passes: [
        log.includes('inbox-flow:done') ? 'done exits inbox flow' : '',
        sim.getState() === 'IDLE' ? 'state returned to IDLE' : '',
      ].filter(Boolean),
      breaks: [
        !log.includes('inbox-flow:done') ? 'done not handled in inbox flow' : '',
        sim.getState() !== 'IDLE' ? 'state not IDLE after done' : '',
      ].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message', nutrition: 'Nutrition last message' });
    sim.setMode('ask');
    sim.say('prompt');
    sim.say('send to inbox');
    sim.complete('q1');
    sim.say('inbox');
    const log = sim.say('switch to nutrition');
    return {
      id: '19-inbox-flow-switch-clears',
      passes: [
        log.includes('inbox-flow:cleared-on-nav') ? 'inbox flow cleared on nav' : '',
        log.includes('switch:nutrition') ? 'navigation executed' : '',
      ].filter(Boolean),
      breaks: [
        !log.includes('inbox-flow:cleared-on-nav') ? 'inbox flow not cleared on nav' : '',
        !log.includes('switch:nutrition') ? 'navigation not executed from inbox flow' : '',
      ].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message', nutrition: 'Nutrition last message' });
    sim.setMode('ask');
    sim.say('prompt');
    sim.say('send to inbox');
    sim.say('switch to nutrition');
    sim.say('new prompt');
    sim.say('prompt 2');
    sim.say('send to inbox');
    sim.complete('q1');
    sim.complete('q2');
    const log: string[] = [];
    log.push(...sim.say('inbox'));
    log.push(...sim.say('next'));
    log.push(...sim.say('next'));
    return {
      id: '20-inbox-next-drains-multiple-channels',
      passes: [
        log.includes('inbox-next:read:general') ? 'first next reads general' : '',
        log.includes('inbox-next:read:nutrition') ? 'second next reads nutrition' : '',
        log.includes('inbox-flow:complete') ? 'inbox flow completes after drain' : '',
      ].filter(Boolean),
      breaks: [
        !log.includes('inbox-next:read:general') ? 'missing general read in drain' : '',
        !log.includes('inbox-next:read:nutrition') ? 'missing nutrition read in drain' : '',
        !log.includes('inbox-flow:complete') ? 'inbox flow did not complete after drain' : '',
      ].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message' });
    const log = sim.say('inbox');
    const next = sim.say('next');
    return {
      id: '21-inbox-empty-then-next',
      passes: [
        log.includes('inbox-check:empty') ? 'empty inbox reported' : '',
        next.includes('next:ignored-not-in-inbox-flow') ? 'next ignored when no inbox flow' : '',
      ].filter(Boolean),
      breaks: [
        !log.includes('inbox-check:empty') ? 'empty inbox not reported' : '',
        !next.includes('next:ignored-not-in-inbox-flow') ? 'next behavior wrong after empty inbox' : '',
      ].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message', nutrition: 'Nutrition last message' });
    sim.setMode('ask');
    sim.say('prompt');
    sim.say('switch to nutrition');
    const log = sim.say('new prompt');
    return {
      id: '22-ask-nav-into-switch-choice-prompt',
      passes: [
        log.includes('switch-choice:prompt') ? 'switch-choice prompt selected after ask-nav' : '',
        sim.getState() === 'IDLE' ? 'state returns idle after prompt choice' : '',
      ].filter(Boolean),
      breaks: [
        !log.includes('switch-choice:prompt') ? 'switch-choice prompt failed after ask-nav' : '',
        sim.getState() !== 'IDLE' ? 'state not idle after prompt choice' : '',
      ].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message' });
    sim.setMode('wait');
    sim.say('prompt a');
    sim.say('switch to general');
    sim.say('new prompt');
    sim.say('prompt b');
    sim.complete('q1');
    sim.complete('q2');
    const log: string[] = [];
    log.push(...sim.say('inbox'));
    log.push(...sim.say('next'));
    return {
      id: '23-wait-multiple-ready-same-channel',
      passes: [
        log.includes('inbox-check:general') ? 'inbox contains general ready' : '',
        log.includes('inbox-next:read:general') ? 'next reads general' : '',
      ].filter(Boolean),
      breaks: [
        !log.includes('inbox-check:general') ? 'inbox missing general ready' : '',
        !log.includes('inbox-next:read:general') ? 'next missing general read' : '',
      ].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ general: 'General last message', nutrition: 'Nutrition last message' });
    sim.setMode('ask');
    sim.say('prompt');
    const log = sim.say('switch to nutrition');
    return {
      id: '24-queue-choice-nav-enters-switch-choice',
      passes: [
        log.includes('queue-choice:navigation') ? 'queue-choice accepted navigation' : '',
        log.includes('switch-choice:prompted') ? 'navigation entered switch-choice in target channel' : '',
      ].filter(Boolean),
      breaks: [
        !log.includes('queue-choice:navigation') ? 'queue-choice failed navigation' : '',
        !log.includes('switch-choice:prompted') ? 'target switch-choice not prompted after navigation' : '',
      ].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ nutrition: 'Nutrition last message', inbox: 'Inbox last message' });
    sim.say('switch to nutrition');
    sim.say('switch to inbox');
    const log = sim.say('last message');
    return {
      id: '25-switch-choice-nav-chain',
      passes: [
        sim.getActiveChannel() === 'inbox' ? 'active channel updated through navigation chain' : '',
        log.includes('switch-choice:read') ? 'read works after chained switch-choice navigation' : '',
      ].filter(Boolean),
      breaks: [
        sim.getActiveChannel() !== 'inbox' ? 'active channel not updated through nav chain' : '',
        !log.includes('switch-choice:read') ? 'read failed after chained navigation' : '',
      ].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ planning: 'Planning last message' });
    sim.setMode('queue');
    const log: string[] = [];
    log.push(...sim.say('planning prompt'));
    log.push(...sim.complete('q1'));
    return {
      id: '26-queue-ready-active-channel-auto-read',
      passes: [
        log.includes('auto-read:q1:general') || log.includes('auto-read:q1:planning')
          ? 'ready in active channel auto-reads'
          : '',
      ].filter(Boolean),
      breaks: [
        log.includes('notify:q1:spoken') ? 'announced ready instead of auto-reading active channel item' : '',
        !(log.includes('auto-read:q1:general') || log.includes('auto-read:q1:planning'))
          ? 'missing auto-read for active-channel ready item'
          : '',
      ].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ planning: 'Planning last message' });
    sim.setMode('wait');
    sim.setGated(true);
    const log: string[] = [];
    log.push(...sim.say('planning prompt'));
    log.push(...sim.say('you')); // accidental noise/misfire while wait pending
    return {
      id: '27-gated-pending-wait-rejects-no-wake-noise',
      passes: [
        log.includes('gated-pending-wait:rejected-no-wake')
          ? 'pending-wait accidental utterance rejected without wake word'
          : '',
      ].filter(Boolean),
      breaks: [
        !log.includes('gated-pending-wait:rejected-no-wake')
          ? 'pending-wait accidental utterance was not rejected in gated mode'
          : '',
      ].filter(Boolean),
    };
  },
  () => {
    const sim = new OverlapFlowSimulator({ planning: 'Planning last message', nutrition: 'Nutrition last message' });
    sim.setMode('wait');
    const log: string[] = [];
    sim.activeChannel = 'planning';
    log.push(...sim.say('planning prompt'));
    log.push(...sim.say('switch to nutrition'));
    log.push(...sim.complete('q1'));
    return {
      id: '28-wait-origin-channel-stable-across-switch',
      passes: [
        log.includes('prompt:q1:planning') ? 'prompt queued in planning' : '',
        log.includes('complete:q1:ready:planning') ? 'completion retained planning origin' : '',
      ].filter(Boolean),
      breaks: [
        !log.includes('prompt:q1:planning') ? 'prompt not queued in planning origin' : '',
        !log.includes('complete:q1:ready:planning') ? 'completion channel drifted after switch' : '',
      ].filter(Boolean),
    };
  },
];

function main(): void {
  let breakCount = 0;
  for (const run of scenarios) {
    const result = run();
    console.log(`\nScenario: ${result.id}`);
    for (const p of result.passes) {
      console.log(`  PASS: ${p}`);
    }
    for (const b of result.breaks) {
      console.log(`  BREAK: ${b}`);
      breakCount++;
    }
    if (result.breaks.length === 0) {
      console.log('  RESULT: clean');
    } else {
      console.log(`  RESULT: ${result.breaks.length} issue(s)`);
    }
  }

  console.log(`\nStress report complete: ${breakCount} break finding(s).`);
}

main();
