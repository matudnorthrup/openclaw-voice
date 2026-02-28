import { GatewaySync, type ChatMessage } from '../services/gateway-sync.js';
import {
  canonicalSessionKeyForChannel,
  groupSessionFamilies,
  toBackfillableMessage,
} from './session-split-utils.js';

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

async function run(): Promise<void> {
  const historyLimit = parseIntWithDefault(parseArg('history-limit') ?? process.env['SESSION_HEALTH_HISTORY_LIMIT'], 180);
  const onlyChannel = parseArg('channel') ?? process.env['SESSION_HEALTH_CHANNEL_ID'] ?? null;
  const minCanonicalCoverage = Number.parseFloat(
    parseArg('min-canonical-coverage') ?? process.env['SESSION_HEALTH_MIN_CANONICAL_COVERAGE'] ?? '0.85',
  );

  const gateway = new GatewaySync();
  await gateway.connect();

  try {
    const sessions = await gateway.listSessions();
    if (!sessions || sessions.length === 0) {
      console.log('Session health: no sessions available');
      return;
    }

    const families = groupSessionFamilies(sessions);
    const channelIds = Array.from(families.keys())
      .filter((id) => !onlyChannel || id === onlyChannel)
      .sort();

    let splitFamilies = 0;
    let nestedFamilies = 0;
    let maxDepth = 0;
    let lowCoverage = 0;
    let checkedFamilies = 0;

    for (const channelId of channelIds) {
      const family = families.get(channelId) ?? [];
      const familyDepth = Math.max(...family.map((key) => GatewaySync.countOpenAiUserPrefixes(key)));
      maxDepth = Math.max(maxDepth, familyDepth);

      if (family.length <= 1) continue;
      splitFamilies++;
      if (familyDepth > 1) nestedFamilies++;

      const canonical = canonicalSessionKeyForChannel(channelId);
      const targetKey = family.includes(canonical) ? canonical : family[0]!;

      const signatureByKey = new Map<string, Set<string>>();
      const union = new Set<string>();

      for (const key of family) {
        const result = await gateway.getHistoryExact(key, historyLimit);
        const messages = (result?.messages ?? []) as (ChatMessage & { timestamp?: number })[];
        const set = new Set<string>();
        for (let i = 0; i < messages.length; i++) {
          const entry = toBackfillableMessage(messages[i]!, i + 1);
          if (!entry) continue;
          set.add(entry.signature);
          union.add(entry.signature);
        }
        signatureByKey.set(key, set);
      }

      if (union.size === 0) continue;
      checkedFamilies++;

      const canonicalCoverage = (signatureByKey.get(targetKey)?.size ?? 0) / union.size;
      const coverageParts = family
        .map((key) => {
          const c = (signatureByKey.get(key)?.size ?? 0) / union.size;
          const depth = GatewaySync.countOpenAiUserPrefixes(key);
          const short = key.length > 72 ? `${key.slice(0, 69)}...` : key;
          return `${short} depth=${depth} coverage=${c.toFixed(2)}`;
        })
        .join(' | ');

      const flag = canonicalCoverage < minCanonicalCoverage ? 'LOW' : 'OK';
      if (flag === 'LOW') lowCoverage++;

      console.log(
        `Session health channel=${channelId} family=${family.length} canonical=${targetKey} canonicalCoverage=${canonicalCoverage.toFixed(2)} union=${union.size} status=${flag}`,
      );
      console.log(`  ${coverageParts}`);
    }

    const summary = {
      totalChannelFamilies: channelIds.length,
      splitFamilies,
      nestedFamilies,
      checkedFamilies,
      lowCoverage,
      maxOpenAiDepth: maxDepth,
      minCanonicalCoverage,
    };

    console.log(`Session health summary: ${JSON.stringify(summary)}`);

    if (lowCoverage > 0) {
      process.exitCode = 2;
    }
  } finally {
    gateway.destroy();
  }
}

run().catch((err) => {
  console.error(`Session health check failed: ${err?.message ?? err}`);
  process.exitCode = 1;
});
