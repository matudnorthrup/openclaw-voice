/**
 * Layer 7: New Post Flow Tests
 *
 * Verifies the two-step guided forum post creation:
 *   forum → title → create (title used as activation body)
 * Plus cancel at each step, timeout, post-timeout prompt guard,
 * forum not found, no forums, and creation failure.
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

const forums = [
  { id: 'forum-1', name: 'bugs' },
  { id: 'forum-2', name: 'features' },
];

function makeRouter() {
  return {
    getActiveChannel: vi.fn(() => ({ name: 'walmart', displayName: 'Walmart' })),
    getActiveSessionKey: vi.fn(() => 'agent:main:discord:channel:walmart'),
    getSystemPrompt: vi.fn(() => 'system prompt'),
    refreshHistory: vi.fn(async () => {}),
    getHistory: vi.fn(() => []),
    setHistory: vi.fn(),
    listChannels: vi.fn(() => [{ name: 'walmart', displayName: 'Walmart' }]),
    getLogChannel: vi.fn(async () => null),
    getLogChannelFor: vi.fn(async () => null),
    getLastMessage: vi.fn(() => null),
    getLastMessageFresh: vi.fn(async () => null),
    getAllChannelSessionKeys: vi.fn(() => []),
    findForumChannel: vi.fn((input: string) => {
      return forums.find((f) => f.name === input) ?? null;
    }),
    listForumChannels: vi.fn(() => forums),
    getForumThreads: vi.fn(async () => []),
    switchTo: vi.fn(async () => ({ success: true, displayName: 'Walmart' })),
    switchToDefault: vi.fn(async () => ({ success: true, displayName: 'Walmart' })),
    createForumPost: vi.fn(async (_forumId: string, _title: string, _body: string) => ({
      success: true,
      forumName: 'bugs',
      threadId: 'thread-123',
    })),
  };
}

function makeQueueState() {
  return {
    getMode: vi.fn(() => 'wait' as const),
    setMode: vi.fn(),
    enqueue: vi.fn(() => ({ id: 'q-1' })),
    markReady: vi.fn(),
    markHeard: vi.fn(),
    getReadyItems: vi.fn(() => []),
    getPendingItems: vi.fn(() => []),
    getNextReady: vi.fn(() => null),
    getReadyByChannel: vi.fn(() => null),
    getSnapshots: vi.fn(() => ({})),
    setSnapshots: vi.fn(),
    clearSnapshots: vi.fn(),
  };
}

function makePipeline(opts: { noForums?: boolean } = {}) {
  const pipeline = new VoicePipeline({} as any);
  const router = makeRouter();
  if (opts.noForums) {
    router.listForumChannels.mockReturnValue([]);
  }

  pipeline.setRouter(router as any);
  pipeline.setQueueState(makeQueueState() as any);
  pipeline.setResponsePoller({ check: vi.fn() } as any);

  return { pipeline, router };
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

describe('Layer 7: New Post Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    earconHistory.length = 0;
    playerCalls.length = 0;
    voiceSettings = { gated: true, silenceThreshold: 0.01, silenceDuration: 1500 };
    transcribeImpl = async () => '';
    getResponseImpl = async () => ({ response: 'LLM response.', history: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 7.1: Full happy path ────────────────────────────────────────────

  it('7.1 — full happy path: forum → title → post created', async () => {
    const { pipeline, router } = makePipeline();

    // Step 1: Start new post flow
    await simulateUtterance(pipeline, 'Watson, create a new post');
    expect(getState(pipeline)).toBe('NEW_POST_FLOW');
    expect(playerCalls).toContain('playStream'); // "Which forum?"

    // Step 2: Name the forum
    await simulateUtterance(pipeline, 'bugs');
    expect(getState(pipeline)).toBe('NEW_POST_FLOW');
    expect(earconHistory).toContain('acknowledged');

    earconHistory.length = 0;
    playerCalls.length = 0;

    // Step 3: Give the title — creates post immediately (title used as activation body)
    await simulateUtterance(pipeline, 'Fix the login page');

    expect(router.createForumPost).toHaveBeenCalledWith(
      'forum-1',
      'Fix the login page',
      'Fix the login page',
    );
    expect(earconHistory).toContain('acknowledged');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 7.2: Cancel at forum step ───────────────────────────────────────

  it('7.2 — cancel at forum step exits flow', async () => {
    const { pipeline } = makePipeline();

    await simulateUtterance(pipeline, 'Watson, create a new post');
    expect(getState(pipeline)).toBe('NEW_POST_FLOW');

    earconHistory.length = 0;
    playerCalls.length = 0;

    await simulateUtterance(pipeline, 'cancel');

    expect(earconHistory).toContain('cancelled');
    expect(playerCalls).toContain('playStream'); // "Cancelled."
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 7.3: Cancel at title step ───────────────────────────────────────

  it('7.3 — cancel at title step exits flow', async () => {
    const { pipeline } = makePipeline();

    await simulateUtterance(pipeline, 'Watson, create a new post');
    await simulateUtterance(pipeline, 'bugs');
    expect(getState(pipeline)).toBe('NEW_POST_FLOW');

    earconHistory.length = 0;

    await simulateUtterance(pipeline, 'nevermind');

    expect(earconHistory).toContain('cancelled');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 7.5: Timeout at forum step ──────────────────────────────────────

  it('7.5 — timeout at forum step cancels flow', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { pipeline } = makePipeline();

    await simulateUtterance(pipeline, 'Watson, create a new post');
    expect(getState(pipeline)).toBe('NEW_POST_FLOW');

    earconHistory.length = 0;
    playerCalls.length = 0;

    // Advance past the new-post-forum timeout (30s from contract)
    await vi.advanceTimersByTimeAsync(30_100);

    expect(earconHistory).toContain('cancelled');
    expect(playerCalls).toContain('playStream'); // timeout text
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
    vi.useRealTimers();
  });

  // ── 7.7: Forum name not found ──────────────────────────────────────

  it('7.7 — forum name not found reprompts', async () => {
    const { pipeline, router } = makePipeline();
    router.findForumChannel.mockReturnValue(null);

    await simulateUtterance(pipeline, 'Watson, create a new post');
    expect(getState(pipeline)).toBe('NEW_POST_FLOW');

    earconHistory.length = 0;
    playerCalls.length = 0;

    await simulateUtterance(pipeline, 'nonexistent forum');

    // Should reprompt — still in NEW_POST_FLOW
    expect(playerCalls).toContain('playStream'); // "I couldn't find..."
    expect(getState(pipeline)).toBe('NEW_POST_FLOW');

    pipeline.stop();
  });

  // ── 7.8: No forums available ────────────────────────────────────────

  it('7.8 — no forums available speaks error and returns to IDLE', async () => {
    const { pipeline } = makePipeline({ noForums: true });

    await simulateUtterance(pipeline, 'Watson, create a new post');

    expect(playerCalls).toContain('playStream'); // "No forum channels available."
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 7.9: Creation failure ──────────────────────────────────────────

  it('7.9 — forum post creation failure speaks error', async () => {
    const { pipeline, router } = makePipeline();
    router.createForumPost.mockResolvedValue({ success: false, error: 'Permission denied' });

    // Go through full flow (forum → title triggers creation)
    await simulateUtterance(pipeline, 'Watson, create a new post');
    await simulateUtterance(pipeline, 'bugs');

    earconHistory.length = 0;
    playerCalls.length = 0;

    await simulateUtterance(pipeline, 'Fix login');

    expect(router.createForumPost).toHaveBeenCalled();
    expect(playerCalls).toContain('playStream'); // error message
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 7.6: Post-timeout prompt guard ──────────────────────────────────

  it('7.6 — utterance after timeout is blocked by prompt guard', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { pipeline } = makePipeline();

    await simulateUtterance(pipeline, 'Watson, create a new post');
    expect(getState(pipeline)).toBe('NEW_POST_FLOW');

    // Trigger timeout
    await vi.advanceTimersByTimeAsync(30_100);
    expect(getState(pipeline)).toBe('IDLE');

    earconHistory.length = 0;
    playerCalls.length = 0;

    // Speak within the 8s prompt guard window
    await simulateUtterance(pipeline, 'Watson, some follow up message');
    await vi.advanceTimersByTimeAsync(100);

    // Should have played error earcon (prompt guard active)
    expect(earconHistory).toContain('error');
    expect(playerCalls).toContain('playStream'); // "Post creation timed out..."
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
    vi.useRealTimers();
  });
});
