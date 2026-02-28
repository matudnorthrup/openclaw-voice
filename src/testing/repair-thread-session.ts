import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { GatewaySync, type ChatMessage } from '../services/gateway-sync.js';
import {
  canonicalSessionKeyForChannel,
  groupSessionFamilies,
  toBackfillableMessage,
  type BackfillableMessage,
} from './session-split-utils.js';

dotenv.config();

type ArchiveIndexEntry = {
  sessionId?: string;
  sessionFile?: string;
};

type RepairOptions = {
  channelId: string;
  historyLimit: number;
  maxPerChannel: number;
  dryRun: boolean;
  useArchive: boolean;
  archiveIndexPath: string;
};

type RepairPlan = {
  family: string[];
  canonicalKey: string;
  missing: BackfillableMessage[];
  missingCapped: BackfillableMessage[];
  unionSize: number;
  canonicalCoverage: number;
};

type DiscordChannelInfo = {
  id: string;
  name?: string;
};

function parseArg(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function parseIntWithDefault(raw: string | null | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function loadArchiveIndex(indexPath: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!existsSync(indexPath)) return result;
  const indexDir = dirname(indexPath);

  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, ArchiveIndexEntry>;
    for (const [sessionKey, entry] of Object.entries(parsed)) {
      if (!entry) continue;

      const candidates: string[] = [];
      if (typeof entry.sessionFile === 'string' && entry.sessionFile.endsWith('.jsonl')) {
        candidates.push(entry.sessionFile);
      }
      if (typeof entry.sessionId === 'string' && entry.sessionId.length > 0) {
        candidates.push(join(indexDir, `${entry.sessionId}.jsonl`));
        candidates.push(join(homedir(), '.openclaw', 'agents', 'main', 'sessions', `${entry.sessionId}.jsonl`));
      }

      const resolved = candidates.find((file) => existsSync(file));
      if (!resolved) continue;
      result.set(sessionKey, resolved);
    }
  } catch (err: any) {
    console.warn(`Repair: failed to parse archive index ${indexPath}: ${err?.message ?? err}`);
  }

  return result;
}

function readArchiveMessages(sessionFile: string): (ChatMessage & { timestamp?: number })[] {
  if (!existsSync(sessionFile)) return [];

  const messages: (ChatMessage & { timestamp?: number })[] = [];
  const lines = readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);

  for (const line of lines) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.type !== 'message' || !parsed?.message) continue;
    const role = parsed.message.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;

    const messageTs = typeof parsed.message.timestamp === 'number'
      ? parsed.message.timestamp
      : (typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : undefined);

    messages.push({
      role,
      content: parsed.message.content,
      label: typeof parsed.message.label === 'string' ? parsed.message.label : undefined,
      timestamp: Number.isFinite(messageTs) ? messageTs : undefined,
    });
  }

  return messages;
}

async function fetchDiscordChannelInfo(channelId: string, token: string): Promise<DiscordChannelInfo | null> {
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) return null;
    const payload = await res.json() as any;
    if (!payload || typeof payload.id !== 'string') return null;
    return {
      id: payload.id,
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
  } catch {
    return null;
  }
}

async function resolveChannelIdFromThreadName(
  threadName: string,
  channelIds: string[],
  discordToken: string,
): Promise<string> {
  const exactMatches: DiscordChannelInfo[] = [];
  const fuzzyMatches: DiscordChannelInfo[] = [];
  const normalizedNeedle = normalizeName(threadName);

  for (const channelId of channelIds) {
    const info = await fetchDiscordChannelInfo(channelId, discordToken);
    if (!info?.name) continue;

    const normalizedName = normalizeName(info.name);
    if (normalizedName === normalizedNeedle) {
      exactMatches.push(info);
      continue;
    }
    if (normalizedName.includes(normalizedNeedle) || normalizedNeedle.includes(normalizedName)) {
      fuzzyMatches.push(info);
    }
  }

  if (exactMatches.length === 1) return exactMatches[0]!.id;
  if (exactMatches.length > 1) {
    const details = exactMatches.map((m) => `${m.name} (${m.id})`).join(', ');
    throw new Error(`Multiple exact thread matches for "${threadName}": ${details}. Use --channel=<id>.`);
  }
  if (fuzzyMatches.length === 1) return fuzzyMatches[0]!.id;
  if (fuzzyMatches.length > 1) {
    const details = fuzzyMatches.map((m) => `${m.name} (${m.id})`).join(', ');
    throw new Error(`Multiple fuzzy thread matches for "${threadName}": ${details}. Use --channel=<id>.`);
  }

  throw new Error(`No split channel matched thread name "${threadName}". Use --channel=<id>.`);
}

async function buildRepairPlan(
  gateway: GatewaySync,
  options: RepairOptions,
  family: string[],
): Promise<RepairPlan> {
  const archiveBySessionKey = options.useArchive ? loadArchiveIndex(options.archiveIndexPath) : new Map<string, string>();
  const canonicalKey = family.includes(canonicalSessionKeyForChannel(options.channelId))
    ? canonicalSessionKeyForChannel(options.channelId)
    : family[0]!;

  const allMessages = new Map<string, (ChatMessage & { timestamp?: number })[]>();
  for (const key of family) {
    const result = await gateway.getHistoryExact(key, options.historyLimit);
    const base = (result?.messages ?? []) as (ChatMessage & { timestamp?: number })[];
    if (options.useArchive) {
      const archivedFile = archiveBySessionKey.get(key);
      const archived = archivedFile ? readArchiveMessages(archivedFile) : [];
      allMessages.set(key, [...base, ...archived]);
    } else {
      allMessages.set(key, base);
    }
  }

  const canonicalMessages = allMessages.get(canonicalKey) ?? [];
  const canonicalSignatures = new Set<string>();
  for (let i = 0; i < canonicalMessages.length; i++) {
    const entry = toBackfillableMessage(canonicalMessages[i]!, i + 1);
    if (entry) canonicalSignatures.add(entry.signature);
  }

  const mergedBySignature = new Map<string, BackfillableMessage>();
  for (const key of family) {
    const messages = allMessages.get(key) ?? [];
    for (let i = 0; i < messages.length; i++) {
      const entry = toBackfillableMessage(messages[i]!, i + 1);
      if (!entry) continue;
      const existing = mergedBySignature.get(entry.signature);
      if (!existing || entry.stamp < existing.stamp) {
        mergedBySignature.set(entry.signature, entry);
      }
    }
  }

  const missing = Array.from(mergedBySignature.values())
    .filter((entry) => !canonicalSignatures.has(entry.signature))
    .sort((a, b) => a.stamp - b.stamp);

  const missingCapped = missing.length > options.maxPerChannel
    ? missing.slice(-options.maxPerChannel)
    : missing;

  const unionSize = mergedBySignature.size;
  const canonicalCoverage = unionSize === 0
    ? 1
    : (unionSize - missing.length) / unionSize;

  return {
    family,
    canonicalKey,
    missing,
    missingCapped,
    unionSize,
    canonicalCoverage,
  };
}

function parseOptions(channelIds: string[], discordToken: string): Promise<RepairOptions> {
  const dryRun = process.argv.includes('--dry-run') || process.env['DRY_RUN'] === '1';
  const historyLimit = parseIntWithDefault(parseArg('history-limit') ?? process.env['BACKFILL_HISTORY_LIMIT'], 500);
  const maxPerChannel = parseIntWithDefault(parseArg('max-per-channel') ?? process.env['BACKFILL_MAX_PER_CHANNEL'], 200);
  const useArchive = !process.argv.includes('--no-archive') && process.env['BACKFILL_USE_ARCHIVE'] !== '0';
  const archiveIndexPath = parseArg('sessions-json')
    ?? process.env['OPENCLAW_SESSIONS_JSON']
    ?? join(homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');

  const explicitChannel = parseArg('channel') ?? process.env['BACKFILL_CHANNEL_ID'] ?? null;
  const threadName = parseArg('thread') ?? process.env['BACKFILL_THREAD_NAME'] ?? null;

  if (explicitChannel) {
    return Promise.resolve({
      channelId: explicitChannel,
      historyLimit,
      maxPerChannel,
      dryRun,
      useArchive,
      archiveIndexPath,
    });
  }

  if (!threadName) {
    throw new Error('Missing target. Use --channel=<discordChannelId> or --thread=<thread name>.');
  }

  return resolveChannelIdFromThreadName(threadName, channelIds, discordToken).then((resolvedChannelId) => ({
    channelId: resolvedChannelId,
    historyLimit,
    maxPerChannel,
    dryRun,
    useArchive,
    archiveIndexPath,
  }));
}

async function run(): Promise<void> {
  const discordToken = process.env['DISCORD_TOKEN'];
  if (!discordToken) {
    throw new Error('Missing DISCORD_TOKEN');
  }

  const gateway = new GatewaySync();
  await gateway.connect();

  try {
    const sessions = await gateway.listSessions();
    if (!sessions || sessions.length === 0) {
      console.log('Repair: no sessions available from gateway');
      return;
    }

    const families = groupSessionFamilies(sessions);
    const channelIds = Array.from(families.keys()).sort();
    const options = await parseOptions(channelIds, discordToken);
    const family = families.get(options.channelId) ?? [];

    if (family.length <= 1) {
      console.log(`Repair: channel=${options.channelId} has no split family (sessions=${family.length})`);
      return;
    }

    if (options.useArchive) {
      console.log(`Repair archive source: ${options.archiveIndexPath}`);
    }

    const before = await buildRepairPlan(gateway, options, family);
    console.log(
      `Repair preflight channel=${options.channelId} family=${before.family.length} canonical="${before.canonicalKey}" coverage=${before.canonicalCoverage.toFixed(2)} union=${before.unionSize} missing=${before.missing.length} applying=${before.missingCapped.length}${options.dryRun ? ' dry-run' : ''}`,
    );

    if (options.dryRun || before.missingCapped.length === 0) {
      console.log(`Repair summary: injectedCanonical=0 mirrored=0 failed=0 dryRun=${options.dryRun}`);
      return;
    }

    let injectedCanonical = 0;
    let mirrored = 0;
    let failed = 0;

    for (const entry of before.missingCapped) {
      const injected = await gateway.inject(before.canonicalKey, entry.text, entry.label);
      if (!injected) {
        failed++;
        continue;
      }
      injectedCanonical++;
      mirrored += await gateway.mirrorInjectToSessionFamily(
        before.canonicalKey,
        entry.text,
        entry.label,
        { excludeSessionKeys: [injected.sessionKey] },
      );
    }

    const after = await buildRepairPlan(gateway, options, family);
    console.log(`Repair summary: injectedCanonical=${injectedCanonical} mirrored=${mirrored} failed=${failed} dryRun=false`);
    console.log(
      `Repair verify channel=${options.channelId} coverage=${after.canonicalCoverage.toFixed(2)} missing=${after.missing.length}`,
    );

    if (after.missing.length > 0) {
      process.exitCode = 2;
    }
  } finally {
    gateway.destroy();
  }
}

run().catch((err) => {
  console.error(`Repair failed: ${err?.message ?? err}`);
  process.exitCode = 1;
});
