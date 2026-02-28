import { GatewaySync } from '../services/gateway-sync.js';
import {
  collectSessionHealthSnapshots,
  defaultAtlasDbPath,
  openAtlasDb,
  persistSessionHealthSnapshots,
} from './session-observability.js';

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

function parseFloatWithDefault(raw: string | null | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function run(): Promise<void> {
  const historyLimit = parseIntWithDefault(parseArg('history-limit') ?? process.env['SESSION_HEALTH_HISTORY_LIMIT'], 180);
  const onlyChannel = parseArg('channel') ?? process.env['SESSION_HEALTH_CHANNEL_ID'] ?? null;
  const minCanonicalCoverage = parseFloatWithDefault(
    parseArg('min-canonical-coverage') ?? process.env['SESSION_HEALTH_MIN_CANONICAL_COVERAGE'],
    0.85,
  );
  const dbPath = parseArg('db') ?? process.env['ATLAS_DB_PATH'] ?? defaultAtlasDbPath();
  const source = parseArg('source') ?? process.env['SESSION_HEALTH_SOURCE'] ?? 'session:health';
  const dryRun = process.argv.includes('--dry-run');

  const gateway = new GatewaySync();
  await gateway.connect();

  try {
    const { snapshots, summary } = await collectSessionHealthSnapshots(gateway, {
      historyLimit,
      onlyChannel,
      minCanonicalCoverage,
    });

    for (const snapshot of snapshots) {
      if (snapshot.familySize <= 1) continue;
      const coverage = snapshot.canonicalCoverage == null
        ? 'n/a'
        : snapshot.canonicalCoverage.toFixed(2);
      const flags = snapshot.flags.length > 0 ? snapshot.flags.join(',') : 'none';
      console.log(
        `Session observability channel=${snapshot.channelId} family=${snapshot.familySize} canonical=${snapshot.canonicalKey} target=${snapshot.coverageTargetKey} coverage=${coverage} depth=${snapshot.maxOpenAiDepth} flags=${flags}`,
      );
    }

    let insertedSnapshots = 0;
    let insertedMembers = 0;

    if (!dryRun) {
      const db = openAtlasDb(dbPath);
      try {
        const persisted = persistSessionHealthSnapshots(db, snapshots, { source });
        insertedSnapshots = persisted.insertedSnapshots;
        insertedMembers = persisted.insertedMembers;
      } finally {
        db.close();
      }
    }

    console.log(`Session observability summary: ${JSON.stringify({
      ...summary,
      observedChannels: snapshots.length,
      persisted: !dryRun,
      insertedSnapshots,
      insertedMembers,
      dbPath,
      source,
    })}`);

    if (summary.lowCoverage > 0) {
      process.exitCode = 2;
    }
  } finally {
    gateway.destroy();
  }
}

run().catch((err) => {
  console.error(`Session observability failed: ${err?.message ?? err}`);
  process.exitCode = 1;
});
