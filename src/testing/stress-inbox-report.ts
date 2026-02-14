import { matchQueueChoice, matchSwitchChoice } from '../services/voice-commands.js';

type Mode = 'wait' | 'ask';
type UiState = 'IDLE' | 'AWAITING_QUEUE_CHOICE' | 'AWAITING_SWITCH_CHOICE' | 'INBOX_FLOW';

type QueueItem = {
  id: string;
  channel: string;
  status: 'pending' | 'ready';
};

type ScenarioResult = {
  id: string;
  passes: string[];
  breaks: string[];
};

class InboxFlowSimulator {
  mode: Mode = 'wait';
  state: UiState = 'IDLE';
  activeChannel = 'general';
  pendingWaitId: string | null = null;
  queuePromptItemId: string | null = null;
  inboxFlow: { channels: string[]; index: number } | null = null;
  private seq = 1;
  private readonly queue = new Map<string, QueueItem>();
  private readonly lastMessageByChannel: Record<string, string>;

  constructor(channels: Record<string, string>) {
    this.lastMessageByChannel = channels;
  }

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  say(transcript: string): string[] {
    const events: string[] = [];
    const normalized = transcript.trim().toLowerCase();

    if (this.state === 'AWAITING_QUEUE_CHOICE') {
      const choice = matchQueueChoice(transcript);
      if (choice === 'queue' || choice === 'silent') {
        this.state = 'IDLE';
        this.queuePromptItemId = null;
        events.push('ask:queued');
        return events;
      }
      if (choice === 'wait') {
        this.state = 'IDLE';
        if (this.queuePromptItemId) this.pendingWaitId = this.queuePromptItemId;
        this.queuePromptItemId = null;
        events.push('ask:wait');
        return events;
      }
      if (choice === 'cancel') {
        this.state = 'IDLE';
        this.queuePromptItemId = null;
        events.push('ask:cancel');
        return events;
      }
      const nav = normalized.match(/^(?:switch|go|change|move)\s+to\s+(.+)$/);
      if (nav) {
        this.state = 'IDLE';
        events.push('ask:nav');
        events.push(...this.switchTo(nav[1].trim()));
        return events;
      }
      events.push('ask:reprompt');
      return events;
    }

    if (this.state === 'AWAITING_SWITCH_CHOICE') {
      const choice = matchSwitchChoice(transcript);
      if (choice === 'read') {
        this.state = 'IDLE';
        events.push('switch:read');
        events.push('ready');
        return events;
      }
      if (choice === 'prompt') {
        this.state = 'IDLE';
        events.push('switch:prompt');
        events.push('ready');
        return events;
      }
      if (choice === 'cancel') {
        this.state = 'IDLE';
        events.push('switch:cancel');
        return events;
      }
      const nav = normalized.match(/^(?:switch|go|change|move)\s+to\s+(.+)$/);
      if (nav) {
        this.state = 'IDLE';
        events.push('switch:nav');
        events.push(...this.switchTo(nav[1].trim()));
        return events;
      }
      events.push('switch:reprompt');
      return events;
    }

    if (this.state === 'INBOX_FLOW') {
      if (/^(?:next|next response|next one|next message|next channel)$/.test(normalized)) {
        if (!this.inboxFlow || this.inboxFlow.index >= this.inboxFlow.channels.length) {
          this.state = 'IDLE';
          this.inboxFlow = null;
          events.push('inbox:next-none');
          return events;
        }
        const channel = this.inboxFlow.channels[this.inboxFlow.index++];
        this.activeChannel = channel;
        this.markHeard(channel);
        events.push(`inbox:next:${channel}`);
        if (this.inboxFlow.index >= this.inboxFlow.channels.length) {
          this.state = 'IDLE';
          this.inboxFlow = null;
          events.push('inbox:complete');
        }
        events.push('ready');
        return events;
      }
      if (/^(?:done|i'm done|im done|i am done|move on|skip)$/.test(normalized)) {
        this.state = 'IDLE';
        this.inboxFlow = null;
        events.push('inbox:done');
        events.push('ready');
        return events;
      }
      const nav = normalized.match(/^(?:switch|go|change|move)\s+to\s+(.+)$/);
      if (nav) {
        this.state = 'IDLE';
        this.inboxFlow = null;
        events.push('inbox:clear-nav');
        events.push(...this.switchTo(nav[1].trim()));
        return events;
      }
    }

    if (/^(?:inbox|inbox list|check inbox|check queue|what's new|whats new)$/.test(normalized)) {
      const channels = this.getReadyChannels();
      if (channels.length === 0) {
        events.push('inbox:empty');
        events.push('ready');
        return events;
      }
      this.state = 'INBOX_FLOW';
      this.inboxFlow = { channels, index: 0 };
      events.push(`inbox:list:${channels.join(',')}`);
      events.push('ready');
      return events;
    }

    const nav = normalized.match(/^(?:switch|go|change|move)\s+to\s+(.+)$/);
    if (nav) {
      this.cancelPendingWait(events);
      events.push(...this.switchTo(nav[1].trim()));
      return events;
    }

    if (/^(?:next|next response|next one|next message|next channel)$/.test(normalized)) {
      events.push('next:ignored');
      return events;
    }

    const id = `q${this.seq++}`;
    this.queue.set(id, { id, channel: this.activeChannel, status: 'pending' });
    events.push(`prompt:${id}:${this.activeChannel}`);

    if (this.mode === 'ask') {
      this.state = 'AWAITING_QUEUE_CHOICE';
      this.queuePromptItemId = id;
      events.push('ask:choice');
      events.push('ready');
    } else {
      this.pendingWaitId = id;
      events.push(`wait:${id}`);
    }
    return events;
  }

  complete(id: string): string[] {
    const events: string[] = [];
    const item = this.queue.get(id);
    if (!item) {
      events.push('complete:missing');
      return events;
    }
    item.status = 'ready';
    events.push(`complete:${id}:${item.channel}`);
    if (this.pendingWaitId === id) {
      this.pendingWaitId = null;
      events.push(`deliver:${id}`);
      events.push('ready');
    }
    return events;
  }

  getState(): UiState {
    return this.state;
  }

  getReadyChannels(): string[] {
    const out = new Set<string>();
    for (const q of this.queue.values()) if (q.status === 'ready') out.add(q.channel);
    return Array.from(out);
  }

  getReadyCount(): number {
    let count = 0;
    for (const q of this.queue.values()) if (q.status === 'ready') count++;
    return count;
  }

  getActiveChannel(): string {
    return this.activeChannel;
  }

  private switchTo(channel: string): string[] {
    const events: string[] = [];
    this.activeChannel = channel;
    events.push(`switch:${channel}`);
    if (this.lastMessageByChannel[channel]) {
      this.state = 'AWAITING_SWITCH_CHOICE';
      events.push('switch:choice');
      events.push('ready');
    } else {
      this.state = 'IDLE';
      events.push('ready');
    }
    return events;
  }

  private markHeard(channel: string): void {
    for (const [id, q] of this.queue.entries()) {
      if (q.channel === channel && q.status === 'ready') this.queue.delete(id);
    }
  }

  private cancelPendingWait(events: string[]): void {
    if (!this.pendingWaitId) return;
    events.push(`wait:cancel:${this.pendingWaitId}`);
    this.pendingWaitId = null;
  }
}

function mk(id: string, passes: string[], breaks: string[]): ScenarioResult {
  return { id, passes: passes.filter(Boolean), breaks: breaks.filter(Boolean) };
}

const scenarios: Array<() => ScenarioResult> = [
  () => {
    const s = new InboxFlowSimulator({ general: 'msg' });
    const log = s.say('inbox');
    return mk('i01-inbox-empty', [log.includes('inbox:empty') ? 'empty reported' : ''], [log.includes('inbox:empty') ? '' : 'empty not reported']);
  },
  () => {
    const s = new InboxFlowSimulator({ general: 'msg' });
    s.setMode('ask'); s.say('prompt'); s.say('send to inbox'); s.complete('q1');
    const log = s.say('inbox');
    return mk('i02-inbox-has-general', [log.includes('inbox:list:general') ? 'general listed' : ''], [log.includes('inbox:list:general') ? '' : 'general not listed']);
  },
  () => {
    const s = new InboxFlowSimulator({ general: 'msg' });
    s.setMode('ask'); s.say('prompt'); s.say('send to inbox'); s.complete('q1'); s.say('inbox');
    const log = s.say('next');
    return mk('i03-next-consumes-general', [log.includes('inbox:next:general') ? 'next consumed general' : ''], [log.includes('inbox:next:general') ? '' : 'next did not consume general']);
  },
  () => {
    const s = new InboxFlowSimulator({ general: 'msg' });
    s.setMode('ask'); s.say('prompt'); s.say('send to inbox'); s.complete('q1'); s.say('inbox'); s.say('next');
    return mk('i04-next-completes-flow', [s.getState() === 'IDLE' ? 'flow returned idle' : ''], [s.getState() === 'IDLE' ? '' : 'flow not idle']);
  },
  () => {
    const s = new InboxFlowSimulator({ general: 'msg' });
    s.setMode('ask'); s.say('prompt'); s.say('send to inbox'); s.complete('q1'); s.say('inbox');
    const log = s.say('done');
    return mk('i05-done-exits-flow', [log.includes('inbox:done') ? 'done exits flow' : ''], [log.includes('inbox:done') ? '' : 'done failed']);
  },
  () => {
    const s = new InboxFlowSimulator({ general: 'msg', nutrition: 'msg' });
    s.setMode('ask'); s.say('prompt'); s.say('send to inbox'); s.complete('q1'); s.say('inbox');
    const log = s.say('switch to nutrition');
    return mk('i06-switch-clears-inbox-flow', [log.includes('inbox:clear-nav') ? 'nav clears flow' : ''], [log.includes('inbox:clear-nav') ? '' : 'nav did not clear flow']);
  },
  () => {
    const s = new InboxFlowSimulator({ general: 'msg' });
    const log = s.say('next');
    return mk('i07-next-ignored-outside', [log.includes('next:ignored') ? 'next ignored' : ''], [log.includes('next:ignored') ? '' : 'next not ignored']);
  },
  () => {
    const s = new InboxFlowSimulator({ general: 'msg' });
    s.setMode('wait'); s.say('prompt');
    const log = s.say('inbox');
    return mk('i08-pending-not-in-inbox', [log.includes('inbox:empty') ? 'pending excluded from inbox' : ''], [log.includes('inbox:empty') ? '' : 'pending incorrectly in inbox']);
  },
  () => {
    const s = new InboxFlowSimulator({ general: 'msg' });
    s.setMode('wait'); s.say('prompt'); s.complete('q1');
    const log = s.say('inbox');
    return mk('i09-ready-visible-after-complete', [log.includes('inbox:list:general') ? 'ready visible' : ''], [log.includes('inbox:list:general') ? '' : 'ready not visible']);
  },
  () => {
    const s = new InboxFlowSimulator({ general: 'msg', nutrition: 'msg' });
    s.setMode('ask');
    s.say('prompt a'); s.say('send to inbox'); s.complete('q1');
    s.say('switch to nutrition'); s.say('new prompt'); s.say('prompt b'); s.say('send to inbox'); s.complete('q2');
    const log = s.say('inbox');
    return mk('i10-multi-channel-list', [log.includes('inbox:list:general,nutrition') || log.includes('inbox:list:nutrition,general') ? 'both channels listed' : ''], [log.includes('inbox:list:general,nutrition') || log.includes('inbox:list:nutrition,general') ? '' : 'both channels not listed']);
  },
  () => {
    const s = new InboxFlowSimulator({ general: 'msg', nutrition: 'msg' });
    s.setMode('ask');
    s.say('prompt a'); s.say('send to inbox'); s.complete('q1');
    s.say('switch to nutrition'); s.say('new prompt'); s.say('prompt b'); s.say('send to inbox'); s.complete('q2');
    s.say('inbox'); s.say('next'); s.say('next');
    return mk('i11-drain-clears-ready', [s.getReadyCount() === 0 ? 'drain clears ready queue' : ''], [s.getReadyCount() === 0 ? '' : 'ready queue not cleared']);
  },
  () => {
    const s = new InboxFlowSimulator({ general: 'msg' });
    s.setMode('ask'); s.say('prompt'); s.say('send to inbox'); s.complete('q1');
    s.say('inbox'); s.say('done');
    return mk('i12-done-does-not-consume', [s.getReadyCount() === 1 ? 'done leaves item unread' : ''], [s.getReadyCount() === 1 ? '' : 'done consumed items unexpectedly']);
  },
  () => {
    const s = new InboxFlowSimulator({ general: 'msg' });
    s.setMode('ask'); s.say('prompt'); s.say('send to inbox'); s.complete('q1');
    s.say('inbox'); s.say('done');
    const log = s.say('inbox');
    return mk('i13-reopen-after-done', [log.includes('inbox:list:general') ? 'reopen shows unread item' : ''], [log.includes('inbox:list:general') ? '' : 'reopen lost unread item']);
  },
  () => {
    const s = new InboxFlowSimulator({ general: 'msg', nutrition: 'msg' });
    s.setMode('ask'); s.say('prompt'); s.say('send to inbox'); s.complete('q1'); s.say('inbox');
    s.say('switch to nutrition'); s.say('new prompt'); s.say('prompt2'); s.say('send to inbox'); s.complete('q2');
    const log = s.say('inbox');
    const listed = log.find((e) => e.startsWith('inbox:list:')) ?? '';
    return mk(
      'i14-rebuild-after-nav',
      [listed.includes('nutrition') ? 'inbox rebuild includes new nutrition ready item' : ''],
      [listed.includes('nutrition') ? '' : 'inbox rebuild missing nutrition ready item'],
    );
  },
  () => {
    const s = new InboxFlowSimulator({ general: 'msg' });
    s.setMode('ask'); s.say('prompt'); s.say('send to inbox'); s.complete('q1');
    s.say('inbox'); s.say('next');
    const log = s.say('inbox');
    return mk('i15-inbox-empty-after-consume', [log.includes('inbox:empty') ? 'inbox empty after consume' : ''], [log.includes('inbox:empty') ? '' : 'inbox not empty after consume']);
  },
  () => {
    const s = new InboxFlowSimulator({ general: 'msg', nutrition: 'msg' });
    s.setMode('ask');
    s.say('switch to nutrition');
    s.say('new prompt');
    s.say('prompt');
    s.say('send to inbox');
    s.complete('q1');
    s.say('inbox');
    s.say('next');
    return mk(
      'i16-inbox-next-stays-on-read-channel',
      [s.getActiveChannel() === 'nutrition' ? 'stays on read channel after final next' : ''],
      [s.getActiveChannel() === 'nutrition' ? '' : `unexpected channel after next: ${s.getActiveChannel()}`],
    );
  },
];

function main(): void {
  let breakCount = 0;
  for (const run of scenarios) {
    const result = run();
    console.log(`\nScenario: ${result.id}`);
    for (const p of result.passes) console.log(`  PASS: ${p}`);
    for (const b of result.breaks) {
      console.log(`  BREAK: ${b}`);
      breakCount++;
    }
    console.log(result.breaks.length === 0 ? '  RESULT: clean' : `  RESULT: ${result.breaks.length} issue(s)`);
  }
  console.log(`\nInbox stress report complete: ${breakCount} break finding(s).`);
}

main();
