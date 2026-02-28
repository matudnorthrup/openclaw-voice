import { GatewaySync, type ChatMessage } from '../services/gateway-sync.js';
import {
  canonicalSessionKeyForChannel,
  groupSessionFamilies,
  toBackfillableMessage,
  type BackfillableMessage,
} from './session-split-utils.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

function summarizeKey(key: string): string {
  const depth = GatewaySync.countOpenAiUserPrefixes(key);
  return depth > 0 ? `${key} (openaiDepth=${depth})` : key;
}

type ArchiveIndexEntry = {
  sessionId?: string;
  sessionFile?: string;
};

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
    console.warn(`Backfill: failed to parse archive index ${indexPath}: ${err?.message ?? err}`);
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

async function run(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run') || process.env['DRY_RUN'] === '1';
  const historyLimit = parseIntWithDefault(parseArg('history-limit') ?? process.env['BACKFILL_HISTORY_LIMIT'], 320);
  const maxPerChannel = parseIntWithDefault(parseArg('max-per-channel') ?? process.env['BACKFILL_MAX_PER_CHANNEL'], 120);
  const onlyChannel = parseArg('channel') ?? process.env['BACKFILL_CHANNEL_ID'] ?? null;
  const useArchive = !process.argv.includes('--no-archive') && process.env['BACKFILL_USE_ARCHIVE'] !== '0';
  const archiveIndexPath = parseArg('sessions-json')
    ?? process.env['OPENCLAW_SESSIONS_JSON']
    ?? join(homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');

  const gateway = new GatewaySync();
  await gateway.connect();

  try {
    const sessions = await gateway.listSessions();
    if (!sessions || sessions.length === 0) {
      console.log('Backfill: no sessions available from gateway');
      return;
    }

    const families = groupSessionFamilies(sessions);
    const archiveBySessionKey = useArchive ? loadArchiveIndex(archiveIndexPath) : new Map<string, string>();
    if (useArchive) {
      console.log(`Backfill archive source: ${archiveIndexPath} entries=${archiveBySessionKey.size}`);
    }
    const channelIds = Array.from(families.keys())
      .filter((id) => !onlyChannel || id === onlyChannel)
      .sort();

    let splitFamilies = 0;
    let candidateMessages = 0;
    let injectedCanonical = 0;
    let mirroredTotal = 0;
    let failedInjects = 0;

    for (const channelId of channelIds) {
      const family = families.get(channelId) ?? [];
      if (family.length <= 1) continue;
      splitFamilies++;

      const canonical = canonicalSessionKeyForChannel(channelId);
      const targetKey = family.includes(canonical) ? canonical : family[0]!;

      const allMessages = new Map<string, (ChatMessage & { timestamp?: number })[]>();
      for (const key of family) {
        const result = await gateway.getHistoryExact(key, historyLimit);
        const base = (result?.messages ?? []) as (ChatMessage & { timestamp?: number })[];

        if (useArchive) {
          const archivedFile = archiveBySessionKey.get(key);
          const archived = archivedFile ? readArchiveMessages(archivedFile) : [];
          allMessages.set(key, [...base, ...archived]);
        } else {
          allMessages.set(key, base);
        }
      }

      const canonicalMessages = allMessages.get(targetKey) ?? [];
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

      const missingCapped = missing.length > maxPerChannel
        ? missing.slice(-maxPerChannel)
        : missing;

      candidateMessages += missingCapped.length;

      console.log(
        `Backfill channel=${channelId} family=${family.length} canonical="${summarizeKey(targetKey)}" missing=${missing.length} applying=${missingCapped.length}${dryRun ? ' dry-run' : ''}${useArchive ? ' source=gateway+archive' : ' source=gateway'}`,
      );

      if (dryRun || missingCapped.length === 0) continue;

      for (const entry of missingCapped) {
        const injected = await gateway.inject(targetKey, entry.text, entry.label);
        if (!injected) {
          failedInjects++;
          continue;
        }

        injectedCanonical++;
        canonicalSignatures.add(entry.signature);

        mirroredTotal += await gateway.mirrorInjectToSessionFamily(
          targetKey,
          entry.text,
          entry.label,
          { excludeSessionKeys: [injected.sessionKey] },
        );
      }
    }

    console.log(
      `Backfill summary: splitFamilies=${splitFamilies} candidates=${candidateMessages} injectedCanonical=${injectedCanonical} mirrored=${mirroredTotal} failed=${failedInjects} dryRun=${dryRun}`,
    );
  } finally {
    gateway.destroy();
  }
}

run().catch((err) => {
  console.error(`Backfill failed: ${err?.message ?? err}`);
  process.exitCode = 1;
});
