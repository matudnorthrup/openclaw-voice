import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../config.js';
import { joinChannel, leaveChannel } from '../discord/voice-connection.js';
import { VoicePipeline } from '../pipeline/voice-pipeline.js';
import { ChannelRouter } from '../services/channel-router.js';
import { GatewaySync } from '../services/gateway-sync.js';
import { setGatedMode } from '../services/voice-settings.js';

type Check = { id: string; ok: boolean; detail: string };

class InMemoryQueueState {
  private mode: 'wait' | 'queue' | 'ask' = 'wait';
  private items: Array<{
    id: string;
    channel: string;
    displayName: string;
    sessionKey: string;
    userMessage: string;
    summary: string;
    responseText: string;
    timestamp: number;
    status: 'pending' | 'ready' | 'heard';
  }> = [];
  private snapshots: Record<string, number> = {};

  getMode() { return this.mode; }
  setMode(mode: 'wait' | 'queue' | 'ask') { this.mode = mode; }
  enqueue(params: { channel: string; displayName: string; sessionKey: string; userMessage: string }) {
    const id = `vq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item = {
      id,
      channel: params.channel,
      displayName: params.displayName,
      sessionKey: params.sessionKey,
      userMessage: params.userMessage,
      summary: '',
      responseText: '',
      timestamp: Date.now(),
      status: 'pending' as const,
    };
    this.items.push(item);
    return item;
  }
  markReady(id: string, summary: string, responseText: string) {
    const it = this.items.find((i) => i.id === id);
    if (!it) return;
    it.status = 'ready';
    it.summary = summary;
    it.responseText = responseText;
  }
  markHeard(id: string) {
    const it = this.items.find((i) => i.id === id);
    if (!it) return;
    it.status = 'heard';
  }
  getReadyItems() { return this.items.filter((i) => i.status === 'ready'); }
  getPendingItems() { return this.items.filter((i) => i.status === 'pending'); }
  getNextReady() { return this.items.find((i) => i.status === 'ready') ?? null; }
  getReadyByChannel(channel: string) { return this.items.find((i) => i.status === 'ready' && i.channel === channel) ?? null; }
  getSnapshots() { return { ...this.snapshots }; }
  setSnapshots(s: Record<string, number>) { this.snapshots = { ...s }; }
  clearSnapshots() { this.snapshots = {}; }
  getHeardCount() { return this.items.filter((i) => i.status === 'heard').length; }
}

async function waitFor(cond: () => boolean, timeoutMs: number, intervalMs = 200): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function getWavFor(text: string): { wav: Buffer; durationMs: number } {
  const fixtureDir = path.join(__dirname, '../../test/fixtures/e2e-voice-loop');
  if (!existsSync(fixtureDir)) mkdirSync(fixtureDir, { recursive: true });
  const safe = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  const file = path.join(fixtureDir, `${safe || 'utt'}.wav`);
  if (!existsSync(file)) {
    const escaped = text.replace(/"/g, '\\"');
    execSync(`say -o "${file}" --data-format=LEI16@48000 "${escaped}"`, { timeout: 15_000 });
  }
  const wav = readFileSync(file);
  const pcmBytes = Math.max(0, wav.length - 44);
  const durationMs = Math.max(250, Math.round((pcmBytes / 2 / 48000) * 1000));
  return { wav, durationMs };
}

async function injectSpeech(pipeline: VoicePipeline, text: string): Promise<void> {
  const { wav, durationMs } = getWavFor(text);
  await (pipeline as any).handleUtterance('e2e-voice-user', wav, durationMs);
}

function forceIdle(pipeline: VoicePipeline): void {
  const p: any = pipeline;
  try { p.cancelPendingWait?.('e2e force idle'); } catch {}
  try { p.stateMachine?.transition?.({ type: 'RETURN_TO_IDLE' }); } catch {}
  try { p.stopWaitingLoop?.(); } catch {}
  try { p.player?.stopPlayback?.(); } catch {}
}

async function main(): Promise<void> {
  const checks: Check[] = [];
  const gateway = new GatewaySync();
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const switchChannelId = process.env['E2E_SWITCH_CHANNEL_ID'] || '1472052914267619473'; // openclaw-testing
  const utilityChannelId = process.env['E2E_UTILITY_CHANNEL_ID'] || '1471563603625775124'; // voice-utility
  const forumPostId = process.env['E2E_FORUM_POST_ID'] || '1471584556107956307';

  let pipeline: VoicePipeline | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Discord login timeout')), 20_000);
      client.once('clientReady', () => { clearTimeout(timeout); resolve(); });
      client.login(config.discordToken).catch((err) => { clearTimeout(timeout); reject(err); });
    });
    checks.push({ id: 'discord-login', ok: true, detail: `Connected as ${client.user?.tag}` });

    const guild = client.guilds.cache.get(config.discordGuildId) ?? await client.guilds.fetch(config.discordGuildId);
    const connection = await joinChannel(config.discordVoiceChannelId, guild.id, guild.voiceAdapterCreator);
    checks.push({ id: 'voice-join', ok: true, detail: `Joined voice ${config.discordVoiceChannelId}` });

    await gateway.connect();
    checks.push({ id: 'gateway-connect', ok: gateway.isConnected(), detail: gateway.isConnected() ? 'Connected' : 'Not connected' });

    const router = new ChannelRouter(guild, gateway);
    const queueState = new InMemoryQueueState();
    setGatedMode(false); // keep deterministic for automated utterance injection
    queueState.setMode('wait');

    pipeline = new VoicePipeline(connection);
    pipeline.setRouter(router);
    pipeline.setGatewaySync(gateway);
    pipeline.setQueueState(queueState as any);
    // Do not start live receiver in this runner; injected utterances drive the same pipeline path
    // without relying on host Opus decoder availability.

    // Scenario 1: direct switch by channel id (voice command)
    await injectSpeech(pipeline, `Hey Watson, switch to ${switchChannelId}`);
    const switched = await waitFor(() => router.getActiveChannel().name === `id:${switchChannelId}`, 20_000);
    checks.push({
      id: 'voice-switch-channel-id',
      ok: switched,
      detail: switched ? `Active ${router.getActiveChannel().name}` : `Active ${router.getActiveChannel().name}`,
    });

    // Scenario 2: switch-choice supports navigation
    await injectSpeech(pipeline, `Hey Watson, switch to ${utilityChannelId}`);
    const switchChoiceNav = await waitFor(() => router.getActiveChannel().name === `id:${utilityChannelId}`, 20_000);
    checks.push({
      id: 'switch-choice-navigation-live',
      ok: switchChoiceNav,
      detail: switchChoiceNav ? `Navigated to ${router.getActiveChannel().name}` : 'Navigation from switch-choice failed',
    });
    forceIdle(pipeline);

    // Scenario 3: wait overlap — prompt then switch during processing
    queueState.setMode('wait');
    const p1 = injectSpeech(pipeline, 'Give me a quick integration status update for this channel.');
    await new Promise((r) => setTimeout(r, 300));
    const p2 = injectSpeech(pipeline, `Hey Watson, switch to ${forumPostId}`);
    await Promise.all([p1, p2]);
    const overlapSwitch = await waitFor(() => router.getActiveChannel().name === `id:${forumPostId}`, 70_000);
    const readyCountAfterOverlap = queueState.getReadyItems().length;
    checks.push({
      id: 'wait-overlap-prompt-then-switch',
      ok: overlapSwitch,
      detail: overlapSwitch
        ? `Switched during overlap; ready=${readyCountAfterOverlap}, pending=${queueState.getPendingItems().length}`
        : `Switch did not land; active=${router.getActiveChannel().name}`,
    });
    forceIdle(pipeline);

    // Scenario 4: ask mode queue choice and inbox retrieval
    queueState.setMode('ask');
    await injectSpeech(pipeline, 'Summarize this channel in one short sentence.');
    await injectSpeech(pipeline, 'send to inbox');
    const readySeen = await waitFor(() => queueState.getReadyItems().length > 0, 35_000);
    const readyBeforeInboxNext = queueState.getReadyItems().length;
    const heardBeforeInboxNext = queueState.getHeardCount();
    checks.push({
      id: 'ask-send-to-inbox-ready',
      ok: readySeen,
      detail: readySeen ? `ready=${queueState.getReadyItems().length}` : `pending=${queueState.getPendingItems().length}`,
    });

    await injectSpeech(pipeline, 'Hey Watson, inbox');
    await injectSpeech(pipeline, 'Hey Watson, next');
    const heardAfterNext = await waitFor(() => {
      const readyNow = queueState.getReadyItems().length;
      const heardNow = queueState.getHeardCount();
      return readyNow < readyBeforeInboxNext || heardNow > heardBeforeInboxNext;
    }, 20_000);
    checks.push({
      id: 'inbox-next-consumes-ready',
      ok: heardAfterNext,
      detail: heardAfterNext
        ? `ready ${readyBeforeInboxNext}->${queueState.getReadyItems().length}, heard ${heardBeforeInboxNext}->${queueState.getHeardCount()}`
        : `no consume signal (ready ${readyBeforeInboxNext}->${queueState.getReadyItems().length}, heard ${heardBeforeInboxNext}->${queueState.getHeardCount()})`,
    });
  } catch (err: any) {
    checks.push({ id: 'fatal', ok: false, detail: err?.message || String(err) });
  } finally {
    if (pipeline) {
      try { pipeline.stop(); } catch {}
    }
    try { gateway.destroy(); } catch {}
    try { leaveChannel(); } catch {}
    try { await client.destroy(); } catch {}
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.id} - ${c.detail}`);
  }
  console.log(`\nVoice loop E2E summary: ${checks.length - failed} passed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

void main();
