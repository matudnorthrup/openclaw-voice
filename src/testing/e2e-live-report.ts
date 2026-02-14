import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../config.js';
import { GatewaySync } from '../services/gateway-sync.js';
import { ChannelRouter } from '../services/channel-router.js';
import { getResponse } from '../services/claude.js';

type CheckResult = {
  id: string;
  ok: boolean;
  detail: string;
};

class MemoryQueueState {
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

  enqueue(params: { channel: string; displayName: string; sessionKey: string; userMessage: string }) {
    const id = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  markReady(id: string, summary: string, responseText: string): void {
    const it = this.items.find((x) => x.id === id);
    if (!it) return;
    it.status = 'ready';
    it.summary = summary;
    it.responseText = responseText;
  }

  getReadyItems() {
    return this.items.filter((x) => x.status === 'ready');
  }

  getPendingItems() {
    return this.items.filter((x) => x.status === 'pending');
  }

  getSnapshots(): Record<string, number> {
    return { ...this.snapshots };
  }

  setSnapshots(snapshots: Record<string, number>): void {
    this.snapshots = { ...snapshots };
  }

  clearSnapshots(): void {
    this.snapshots = {};
  }
}

async function loginClient(): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Discord login timeout after 15s')), 15_000);
    client.once('clientReady', () => {
      clearTimeout(timeout);
      resolve();
    });
    client.login(config.discordToken).catch((err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return client;
}

async function runAudioProbe(results: CheckResult[]): Promise<void> {
  const runAudio = process.env['E2E_AUDIO'] !== 'false';
  if (!runAudio) {
    results.push({ id: 'audio-probe', ok: true, detail: 'Skipped (E2E_AUDIO=false)' });
    return;
  }

  const { transcribe } = await import('../services/whisper.js');
  const { textToSpeechStream } = await import('../services/tts.js');

  const fixtureDir = path.join(__dirname, '../../test/fixtures');
  const fixturePath = path.join(fixtureDir, 'e2e-live-hello.wav');
  if (!existsSync(fixtureDir)) mkdirSync(fixtureDir, { recursive: true });
  if (!existsSync(fixturePath)) {
    try {
      execSync(`say -o "${fixturePath}" --data-format=LEI16@48000 "Hello Watson integration test"`, { timeout: 10_000 });
    } catch {
      results.push({ id: 'audio-probe', ok: true, detail: 'Skipped (macOS say unavailable)' });
      return;
    }
  }

  try {
    const wav = readFileSync(fixturePath);
    const transcript = await transcribe(wav);
    if (!transcript || transcript.trim().length === 0) {
      results.push({ id: 'audio-probe', ok: false, detail: 'Whisper returned empty transcript' });
      return;
    }
    const ttsStream = await textToSpeechStream('Integration probe response.');
    let bytes = 0;
    for await (const chunk of ttsStream) {
      bytes += Buffer.from(chunk).length;
      if (bytes > 120) break;
    }
    results.push({
      id: 'audio-probe',
      ok: bytes > 120,
      detail: bytes > 120 ? `STT+TTS ok (transcript="${transcript.slice(0, 40)}", bytes=${bytes})` : 'TTS stream too small',
    });
  } catch (err: any) {
    results.push({ id: 'audio-probe', ok: false, detail: `Audio probe failed: ${err.message}` });
  }
}

async function main(): Promise<void> {
  const results: CheckResult[] = [];
  const gateway = new GatewaySync();
  let client: Client | null = null;

  try {
    client = await loginClient();
    results.push({ id: 'discord-connect', ok: true, detail: `Connected as ${client.user?.tag}` });

    const guild = client.guilds.cache.get(config.discordGuildId) ?? await client.guilds.fetch(config.discordGuildId);
    results.push({ id: 'discord-guild', ok: true, detail: `Guild resolved: ${guild.name}` });

    await gateway.connect();
    results.push({ id: 'gateway-connect', ok: gateway.isConnected(), detail: gateway.isConnected() ? 'Gateway connected' : 'Gateway not connected' });

    const router = new ChannelRouter(guild, gateway);
    const allChannels = router.listChannels();
    const channelA = process.env['E2E_CHANNEL_A'] || 'default';
    const channelB = process.env['E2E_CHANNEL_B'] || 'nutrition';

    results.push({
      id: 'router-channel-presence',
      ok: allChannels.some((c) => c.name === channelA) && allChannels.some((c) => c.name === channelB),
      detail: `A=${channelA} B=${channelB} available=${allChannels.map((c) => c.name).join(', ')}`,
    });

    const swA = await router.switchTo(channelA);
    const swB = await router.switchTo(channelB);
    results.push({ id: 'router-switch-a', ok: swA.success, detail: swA.success ? `Switched ${channelA}` : (swA.error || 'switch failed') });
    results.push({ id: 'router-switch-b', ok: swB.success, detail: swB.success ? `Switched ${channelB}` : (swB.error || 'switch failed') });

    const promptA = `[e2e:${Date.now()}] one sentence status ping for ${channelA}`;
    await router.switchTo(channelA);
    await router.refreshHistory();
    const histA = router.getHistory();
    const { response: respA, history: updatedA } = await getResponse(`e2e:${channelA}`, promptA, {
      systemPrompt: router.getSystemPrompt(),
      history: histA,
    });
    router.setHistory(updatedA);
    const keyA = router.getActiveSessionKey();
    const injectUser = await gateway.inject(keyA, promptA, 'voice-user');
    const injectAssistant = await gateway.inject(keyA, respA, 'voice-assistant');
    let hasPromptA = false;
    for (let i = 0; i < 5; i++) {
      const histCheckA = await gateway.getHistory(keyA, 40);
      hasPromptA = (histCheckA?.messages ?? []).some(
        (m) => typeof m.content === 'string' && m.content.includes(promptA),
      );
      if (hasPromptA) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const injectOk = Boolean(injectUser && injectAssistant);
    results.push({
      id: 'gateway-roundtrip-a',
      ok: injectOk || hasPromptA,
      detail: injectOk
        ? `Inject RPC succeeded for ${keyA}`
        : hasPromptA
          ? `Prompt observed in history for ${keyA}`
          : `Inject did not confirm and prompt not observed in ${keyA}`,
    });

    const queueState = new MemoryQueueState();
    const { InboxTracker } = await import('../services/inbox-tracker.js');
    const inbox = new InboxTracker(queueState as any, gateway);
    const channelsForInbox = router.getAllChannelSessionKeys();
    await inbox.activate(channelsForInbox);

    const itemA = queueState.enqueue({
      channel: channelA,
      displayName: swA.displayName || channelA,
      sessionKey: keyA,
      userMessage: promptA,
    });
    queueState.markReady(itemA.id, respA.slice(0, 80), respA);

    const activities = await inbox.checkInbox(channelsForInbox);
    const foundA = activities.some((a) => a.sessionKey === keyA && a.queuedReadyCount > 0);
    results.push({ id: 'inbox-ready-detect', ok: foundA, detail: foundA ? 'InboxTracker saw queued ready item' : 'InboxTracker missed queued ready item' });

    await router.switchTo(channelB);
    const keyB = router.getActiveSessionKey();
    queueState.enqueue({
      channel: channelB,
      displayName: swB.displayName || channelB,
      sessionKey: keyB,
      userMessage: 'pending-item',
    });
    const activities2 = await inbox.checkInbox(channelsForInbox);
    const pendingSurfacedAsReady = activities2.some((a) => a.queuedReadyCount > 1);
    results.push({
      id: 'inbox-pending-not-ready',
      ok: !pendingSurfacedAsReady,
      detail: !pendingSurfacedAsReady ? 'Pending did not appear as ready' : 'Pending item incorrectly appeared as ready',
    });

    await runAudioProbe(results);
  } catch (err: any) {
    results.push({ id: 'fatal', ok: false, detail: err?.message || String(err) });
  } finally {
    gateway.destroy();
    if (client) {
      try {
        await client.destroy();
      } catch {
        // noop
      }
    }
  }

  let failures = 0;
  for (const r of results) {
    const status = r.ok ? 'PASS' : 'FAIL';
    if (!r.ok) failures++;
    console.log(`${status} ${r.id} - ${r.detail}`);
  }

  console.log(`\nLive E2E summary: ${results.length - failures} passed, ${failures} failed.`);
  if (failures > 0) process.exitCode = 1;
}

void main();
