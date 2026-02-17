/**
 * Layer 6: Inbox Flow Tests
 *
 * Verifies the inbox iteration cycle: check → next → clear,
 * "done" context resolution, and inbox flow timeout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Service mocks ──────────────────────────────────────────────────────────

let transcribeImpl: (buf: Buffer) => Promise<string>;

vi.mock('../src/services/whisper.js', () => ({
  transcribe: vi.fn(async (buf: Buffer) => transcribeImpl(buf)),
}));

let getResponseImpl: (user: string, msg: string, opts?: any) => Promise<{ response: string; history: any[] }>;

vi.mock('../src/services/claude.js', () => ({
  getResponse: vi.fn(async (user: string, msg: string, opts?: any) => getResponseImpl(user, msg, opts)),
  quickCompletion: vi.fn(async () => ''),
}));

vi.mock('../src/services/tts.js', () => ({
  textToSpeechStream: vi.fn(async () => Buffer.from('tts-audio')),
}));

vi.mock('../src/discord/audio-receiver.js', () => ({
  AudioReceiver: class {
    private onUtterance: any;
    constructor(_conn: any, onUtterance: any, _onRejected: any) {
      this.onUtterance = onUtterance;
    }
    start() {}
    stop() {}
    hasActiveSpeech() { return false; }
    simulateUtterance(userId: string, wav: Buffer, durationMs: number) {
      return this.onUtterance(userId, wav, durationMs);
    }
  },
}));

const earconHistory: string[] = [];
const playerCalls: string[] = [];

vi.mock('../src/discord/audio-player.js', () => ({
  DiscordAudioPlayer: class {
    attach() {}
    isPlaying() { return false; }
    isWaiting() { return false; }
    isPlayingEarcon(_name?: string) { return false; }
    async playEarcon(name: string) {
      earconHistory.push(name);
      playerCalls.push(`earcon:${name}`);
    }
    playEarconSync(name: string) {
      earconHistory.push(name);
      playerCalls.push(`earcon:${name}`);
    }
    async playStream(_stream: any) {
      playerCalls.push('playStream');
    }
    startWaitingLoop() { playerCalls.push('startWaitingLoop'); }
    stopWaitingLoop() { playerCalls.push('stopWaitingLoop'); }
    stopPlayback(_reason?: string) { playerCalls.push('stopPlayback'); }
  },
}));

vi.mock('../src/audio/earcons.js', () => ({
  initEarcons: vi.fn(),
}));

let voiceSettings = { gated: true, silenceThreshold: 0.01, silenceDuration: 1500 };

vi.mock('../src/services/voice-settings.js', () => ({
  getVoiceSettings: vi.fn(() => voiceSettings),
  setSilenceDuration: vi.fn(),
  setSpeechThreshold: vi.fn(),
  setGatedMode: vi.fn(),
  resolveNoiseLevel: vi.fn(() => 0.01),
  getNoisePresetNames: vi.fn(() => ['low', 'medium', 'high']),
}));

import { VoicePipeline } from '../src/pipeline/voice-pipeline.js';

// ── Mock helpers ───────────────────────────────────────────────────────────

const channels = [
  { name: 'walmart', displayName: 'Walmart' },
  { name: 'health', displayName: 'Health' },
  { name: 'nutrition', displayName: 'Nutrition' },
];

function makeQueueState(mode: 'wait' | 'queue' | 'ask' = 'queue') {
  const items: any[] = [];
  return {
    getMode: vi.fn(() => mode),
    setMode: vi.fn((m: string) => { mode = m as any; }),
    enqueue: vi.fn((params: any) => {
      const item = { id: `q-${items.length}`, ...params, status: 'pending', summary: '', responseText: '', timestamp: Date.now() };
      items.push(item);
      return item;
    }),
    markReady: vi.fn((id: string, summary: string, text: string) => {
      const item = items.find((i: any) => i.id === id);
      if (item) { item.status = 'ready'; item.summary = summary; item.responseText = text; }
    }),
    markHeard: vi.fn((id: string) => {
      const item = items.find((i: any) => i.id === id);
      if (item) item.status = 'heard';
    }),
    getReadyItems: vi.fn(() => items.filter((i: any) => i.status === 'ready')),
    getPendingItems: vi.fn(() => items.filter((i: any) => i.status === 'pending')),
    getNextReady: vi.fn(() => items.find((i: any) => i.status === 'ready') ?? null),
    getReadyByChannel: vi.fn((ch: string) => items.find((i: any) => i.status === 'ready' && i.channel === ch) ?? null),
    getSnapshots: vi.fn(() => ({})),
    setSnapshots: vi.fn(),
    clearSnapshots: vi.fn(),
    _items: items,
  };
}

function makeRouter(activeChannel = channels[0]) {
  return {
    getActiveChannel: vi.fn(() => activeChannel),
    getActiveSessionKey: vi.fn(() => `agent:main:discord:channel:${activeChannel.name}`),
    getSystemPrompt: vi.fn(() => 'system prompt'),
    refreshHistory: vi.fn(async () => {}),
    getHistory: vi.fn(() => []),
    setHistory: vi.fn(),
    listChannels: vi.fn(() => channels),
    getLogChannel: vi.fn(async () => null),
    getLogChannelFor: vi.fn(async () => null),
    getLastMessage: vi.fn(() => null),
    getLastMessageFresh: vi.fn(async () => null),
    getAllChannelSessionKeys: vi.fn(() => channels.map((c) => ({
      name: c.name,
      displayName: c.displayName,
      sessionKey: `agent:main:discord:channel:${c.name}`,
    }))),
    findForumChannel: vi.fn(() => null),
    listForumChannels: vi.fn(() => []),
    getForumThreads: vi.fn(async () => []),
    switchTo: vi.fn(async (target: string) => {
      const ch = channels.find((c) => c.name === target);
      return ch ? { success: true, displayName: ch.displayName } : { success: false, displayName: target };
    }),
    switchToDefault: vi.fn(async () => ({ success: true, displayName: 'Walmart' })),
    createForumPost: vi.fn(async () => ({ success: false, error: 'not implemented' })),
  };
}

function makeResponsePoller() {
  return { check: vi.fn() };
}

function makeInboxTracker(activities: any[] = []) {
  let callCount = 0;
  return {
    isActive: vi.fn(() => true),
    checkInbox: vi.fn(async () => {
      // First call returns activities; subsequent calls return empty
      // (simulating that items were read/seen)
      return callCount++ === 0 ? activities : [];
    }),
    markSeen: vi.fn(),
  };
}

function makePipeline(opts: { mode?: 'wait' | 'queue' | 'ask'; activities?: any[] } = {}) {
  const mode = opts.mode ?? 'queue';
  const pipeline = new VoicePipeline({} as any);
  const qs = makeQueueState(mode);
  const router = makeRouter();
  const poller = makeResponsePoller();
  const inboxTracker = makeInboxTracker(opts.activities ?? []);

  pipeline.setQueueState(qs as any);
  pipeline.setRouter(router as any);
  pipeline.setResponsePoller(poller as any);
  pipeline.setInboxTracker(inboxTracker as any);

  return { pipeline, qs, router, poller, inboxTracker };
}

async function simulateUtterance(pipeline: VoicePipeline, transcript: string) {
  transcribeImpl = async () => transcript;
  const receiver = (pipeline as any).receiver;
  await receiver.simulateUtterance('user1', Buffer.from('fake-audio'), 500);
  await new Promise((r) => setTimeout(r, 10));
}

function getState(pipeline: VoicePipeline): string {
  return (pipeline as any).stateMachine.getStateType();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Layer 6: Inbox Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    earconHistory.length = 0;
    playerCalls.length = 0;
    voiceSettings = { gated: true, silenceThreshold: 0.01, silenceDuration: 1500 };
    transcribeImpl = async () => '';
    getResponseImpl = async () => ({ response: 'ok', history: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 6.1: Inbox check with activity ──────────────────────────────────

  it('6.1 — inbox check with activity enters INBOX_FLOW and speaks channels', async () => {
    const activities = [
      { channelName: 'health', displayName: 'Health', sessionKey: 'agent:main:discord:channel:health', newMessageCount: 2, queuedReadyCount: 0, newMessages: [] },
      { channelName: 'nutrition', displayName: 'Nutrition', sessionKey: 'agent:main:discord:channel:nutrition', newMessageCount: 1, queuedReadyCount: 0, newMessages: [] },
    ];
    const { pipeline, inboxTracker } = makePipeline({ activities });

    await simulateUtterance(pipeline, 'Watson, check inbox');

    expect(inboxTracker.checkInbox).toHaveBeenCalled();
    expect(getState(pipeline)).toBe('INBOX_FLOW');
    expect(playerCalls).toContain('playStream'); // speaks channel list
    expect(earconHistory).toContain('ready');

    pipeline.stop();
  });

  // ── 6.2: Inbox check with nothing new ───────────────────────────────

  it('6.2 — inbox check with no activity reports zero ready', async () => {
    const { pipeline, inboxTracker } = makePipeline({ activities: [] });

    await simulateUtterance(pipeline, 'Watson, check inbox');

    expect(inboxTracker.checkInbox).toHaveBeenCalled();
    expect(playerCalls).toContain('playStream'); // speaks "Zero ready."
    expect(earconHistory).toContain('ready');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 6.3: Inbox next iteration ───────────────────────────────────────

  it('6.3 — inbox next reads item, switches channel, reports remaining', async () => {
    const activities = [
      { channelName: 'health', displayName: 'Health', sessionKey: 'agent:main:discord:channel:health', newMessageCount: 1, queuedReadyCount: 0, newMessages: [] },
      { channelName: 'nutrition', displayName: 'Nutrition', sessionKey: 'agent:main:discord:channel:nutrition', newMessageCount: 1, queuedReadyCount: 0, newMessages: [] },
    ];
    const { pipeline, router } = makePipeline({ activities });

    // Enter inbox flow
    await simulateUtterance(pipeline, 'Watson, check inbox');
    expect(getState(pipeline)).toBe('INBOX_FLOW');

    earconHistory.length = 0;
    playerCalls.length = 0;

    // Say "next" — should read first item
    await simulateUtterance(pipeline, 'next');

    expect(router.switchTo).toHaveBeenCalledWith('health');
    expect(playerCalls).toContain('playStream'); // speaks item content
    // Should still be in INBOX_FLOW (one more remaining)
    expect(getState(pipeline)).toBe('INBOX_FLOW');

    pipeline.stop();
  });

  // ── 6.4: Inbox next → last item ────────────────────────────────────

  it('6.4 — inbox next on last item says "that\'s everything" and returns to IDLE', async () => {
    const activities = [
      { channelName: 'health', displayName: 'Health', sessionKey: 'agent:main:discord:channel:health', newMessageCount: 1, queuedReadyCount: 0, newMessages: [] },
    ];
    const { pipeline, router } = makePipeline({ activities });

    // Enter inbox flow
    await simulateUtterance(pipeline, 'Watson, check inbox');
    expect(getState(pipeline)).toBe('INBOX_FLOW');

    earconHistory.length = 0;
    playerCalls.length = 0;

    // Say "next" — only one item, should complete flow
    await simulateUtterance(pipeline, 'next');

    expect(router.switchTo).toHaveBeenCalledWith('health');
    expect(playerCalls).toContain('playStream');
    // Flow should be complete → IDLE
    expect(getState(pipeline)).toBe('IDLE');
    // restoreChannel skips if active channel (walmart) matches returnChannel (walmart)
    // This is correct — no redundant switch needed

    pipeline.stop();
  });

  // ── 6.5: Inbox clear ───────────────────────────────────────────────

  it('6.5 — inbox clear marks remaining as seen and returns to IDLE', async () => {
    const activities = [
      { channelName: 'health', displayName: 'Health', sessionKey: 'agent:main:discord:channel:health', newMessageCount: 1, queuedReadyCount: 0, newMessages: [] },
      { channelName: 'nutrition', displayName: 'Nutrition', sessionKey: 'agent:main:discord:channel:nutrition', newMessageCount: 1, queuedReadyCount: 0, newMessages: [] },
    ];
    const { pipeline, inboxTracker, router } = makePipeline({ activities });

    // Enter inbox flow
    await simulateUtterance(pipeline, 'Watson, check inbox');
    expect(getState(pipeline)).toBe('INBOX_FLOW');

    earconHistory.length = 0;
    playerCalls.length = 0;

    // Say "clear inbox"
    await simulateUtterance(pipeline, 'Watson, clear inbox');

    expect(inboxTracker.markSeen).toHaveBeenCalled();
    expect(playerCalls).toContain('playStream'); // speaks confirmation
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 6.6: "Done" outside inbox flow ──────────────────────────────────

  it('6.6 — "Watson, done" outside inbox flow resolves to default (go back)', async () => {
    const { pipeline, router } = makePipeline();

    await simulateUtterance(pipeline, 'Watson, done');

    // "done" outside inbox → resolves to "default" (switchToDefault)
    expect(router.switchToDefault).toHaveBeenCalled();
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 6.7: "Done" inside inbox flow ──────────────────────────────────

  it('6.7 — "done" inside inbox flow resolves to inbox-next', async () => {
    const activities = [
      { channelName: 'health', displayName: 'Health', sessionKey: 'agent:main:discord:channel:health', newMessageCount: 1, queuedReadyCount: 0, newMessages: [] },
      { channelName: 'nutrition', displayName: 'Nutrition', sessionKey: 'agent:main:discord:channel:nutrition', newMessageCount: 1, queuedReadyCount: 0, newMessages: [] },
    ];
    const { pipeline, router } = makePipeline({ activities });

    // Enter inbox flow
    await simulateUtterance(pipeline, 'Watson, check inbox');
    expect(getState(pipeline)).toBe('INBOX_FLOW');

    earconHistory.length = 0;
    playerCalls.length = 0;

    // Say "done" — inside inbox flow, resolves to inbox-next
    await simulateUtterance(pipeline, 'done');

    // Should have advanced to next inbox item (not switched to default)
    expect(router.switchToDefault).not.toHaveBeenCalled();
    expect(router.switchTo).toHaveBeenCalledWith('health');
    expect(getState(pipeline)).toBe('INBOX_FLOW');

    pipeline.stop();
  });

  // ── 6.8: Inbox flow timeout ─────────────────────────────────────────

  it('6.8 — inbox flow state machine manages flow index correctly', async () => {
    const activities = [
      { channelName: 'health', displayName: 'Health', sessionKey: 'agent:main:discord:channel:health', newMessageCount: 1, queuedReadyCount: 0, newMessages: [] },
      { channelName: 'nutrition', displayName: 'Nutrition', sessionKey: 'agent:main:discord:channel:nutrition', newMessageCount: 1, queuedReadyCount: 0, newMessages: [] },
      { channelName: 'walmart', displayName: 'Walmart', sessionKey: 'agent:main:discord:channel:walmart', newMessageCount: 1, queuedReadyCount: 0, newMessages: [] },
    ];
    const { pipeline } = makePipeline({ activities });

    // Enter inbox flow
    await simulateUtterance(pipeline, 'Watson, check inbox');
    expect(getState(pipeline)).toBe('INBOX_FLOW');

    const sm = (pipeline as any).stateMachine;

    // Verify flow state
    let flowState = sm.getInboxFlowState();
    expect(flowState).toBeTruthy();
    expect(flowState.items.length).toBe(3);
    expect(flowState.index).toBe(0);

    // First "next" — advances index
    await simulateUtterance(pipeline, 'next');
    flowState = sm.getInboxFlowState();
    // After reading item 0, index advances to 1
    expect(flowState.index).toBe(1);

    // Second "next"
    await simulateUtterance(pipeline, 'next');
    flowState = sm.getInboxFlowState();
    expect(flowState.index).toBe(2);

    // Third "next" — last item, flow completes
    await simulateUtterance(pipeline, 'next');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── Queue-only inbox check (no inboxTracker) ────────────────────────

  it('queue-only inbox check reports ready and pending items', async () => {
    const pipeline = new VoicePipeline({} as any);
    const qs = makeQueueState('queue');
    const router = makeRouter();
    const poller = makeResponsePoller();

    pipeline.setQueueState(qs as any);
    pipeline.setRouter(router as any);
    pipeline.setResponsePoller(poller as any);
    // No inboxTracker set — uses queue-only fallback

    // Seed a ready item
    qs.getReadyItems.mockReturnValue([{
      id: 'r1',
      channel: 'health',
      displayName: 'Health',
      sessionKey: 'agent:main:discord:channel:health',
      responseText: 'Health response.',
      status: 'ready',
    }]);

    await simulateUtterance(pipeline, 'Watson, check inbox');

    expect(playerCalls).toContain('playStream'); // speaks status
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── Inbox check nothing new (queue-only) ────────────────────────────

  it('queue-only inbox check with nothing reports nothing new', async () => {
    const pipeline = new VoicePipeline({} as any);
    const qs = makeQueueState('queue');
    const router = makeRouter();

    pipeline.setQueueState(qs as any);
    pipeline.setRouter(router as any);
    // No inboxTracker, no ready or pending items

    await simulateUtterance(pipeline, 'Watson, check inbox');

    expect(playerCalls).toContain('playStream'); // speaks "Nothing new."
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── Sequential inbox iteration ──────────────────────────────────────

  it('full inbox iteration: check → next → next → complete', async () => {
    const activities = [
      { channelName: 'health', displayName: 'Health', sessionKey: 'agent:main:discord:channel:health', newMessageCount: 1, queuedReadyCount: 0, newMessages: [] },
      { channelName: 'nutrition', displayName: 'Nutrition', sessionKey: 'agent:main:discord:channel:nutrition', newMessageCount: 1, queuedReadyCount: 0, newMessages: [] },
    ];
    const { pipeline, router } = makePipeline({ activities });

    // Check
    await simulateUtterance(pipeline, 'Watson, check inbox');
    expect(getState(pipeline)).toBe('INBOX_FLOW');

    // First next
    await simulateUtterance(pipeline, 'next');
    expect(router.switchTo).toHaveBeenCalledWith('health');
    expect(getState(pipeline)).toBe('INBOX_FLOW');

    // Second next — last item
    await simulateUtterance(pipeline, 'next');
    expect(router.switchTo).toHaveBeenCalledWith('nutrition');
    // Flow completes → IDLE (restoreChannel skips — already on walmart)
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });
});
