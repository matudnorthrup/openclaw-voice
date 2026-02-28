import { execFileSync } from 'node:child_process';
import { GatewaySync } from '../services/gateway-sync.js';
import {
  collectSessionHealthSnapshots,
  defaultAtlasDbPath,
  openAtlasDb,
  persistSessionHealthSnapshots,
  readLastRepairEventAt,
  readPreviousSnapshot,
  recordSessionRepairEvent,
  type SessionHealthSnapshot,
} from './session-observability.js';

type RepairCandidate = {
  channelId: string;
  reasons: string[];
  score: number;
  beforeSnapshotId: number | null;
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

function parseFloatWithDefault(raw: string | null | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function reasonScore(reason: string): number {
  if (reason === 'low-canonical-coverage') return 100;
  if (reason === 'missing-canonical') return 80;
  if (reason === 'openai-depth-growth') return 60;
  if (reason === 'severe-openai-depth') return 50;
  if (reason === 'resolved-alias') return 20;
  return 10;
}

function buildRepairReasons(
  snapshot: SessionHealthSnapshot,
  previous: { maxOpenAiDepth: number } | null,
  minCanonicalCoverage: number,
  depthTrigger: number,
): string[] {
  const reasons = new Set<string>();

  if (!snapshot.hasCanonical) {
    reasons.add('missing-canonical');
  }

  if (snapshot.canonicalCoverage != null && snapshot.canonicalCoverage < minCanonicalCoverage) {
    reasons.add('low-canonical-coverage');
  }

  if (snapshot.maxOpenAiDepth >= depthTrigger) {
    reasons.add('severe-openai-depth');
  }

  if (snapshot.maxOpenAiDepth > 1 && previous && snapshot.maxOpenAiDepth > previous.maxOpenAiDepth) {
    reasons.add('openai-depth-growth');
  }

  if (snapshot.resolvedKey !== snapshot.canonicalKey) {
    reasons.add('resolved-alias');
  }

  return Array.from(reasons);
}

function runRepairCommand(channelId: string, historyLimit: number, maxPerChannel: number): { ok: boolean; output: string } {
  const args = [
    'run',
    '-s',
    'session:repair-thread',
    '--',
    `--channel=${channelId}`,
    `--history-limit=${historyLimit}`,
    `--max-per-channel=${maxPerChannel}`,
  ];

  try {
    const output = execFileSync('npm', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5 * 60 * 1000,
    });
    return { ok: true, output: output.trim() };
  } catch (err: any) {
    const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
    const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
    const output = [stdout, stderr]
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join('\n');
    return { ok: false, output };
  }
}

async function run(): Promise<void> {
  const historyLimit = parseIntWithDefault(parseArg('history-limit') ?? process.env['SESSION_HEALTH_HISTORY_LIMIT'], 180);
  const repairHistoryLimit = parseIntWithDefault(parseArg('repair-history-limit') ?? process.env['SESSION_REPAIR_HISTORY_LIMIT'], 500);
  const maxPerChannel = parseIntWithDefault(parseArg('max-per-channel') ?? process.env['SESSION_REPAIR_MAX_PER_CHANNEL'], 300);
  const maxChannels = parseIntWithDefault(parseArg('max-channels') ?? process.env['SESSION_REPAIR_MAX_CHANNELS'], 5);
  const minCanonicalCoverage = parseFloatWithDefault(
    parseArg('min-canonical-coverage') ?? process.env['SESSION_HEALTH_MIN_CANONICAL_COVERAGE'],
    0.95,
  );
  const depthTrigger = parseIntWithDefault(parseArg('depth-trigger') ?? process.env['SESSION_REPAIR_DEPTH_TRIGGER'], 3);
  const cooldownMinutes = parseIntWithDefault(parseArg('cooldown-minutes') ?? process.env['SESSION_REPAIR_COOLDOWN_MINUTES'], 120);
  const onlyChannel = parseArg('channel') ?? process.env['SESSION_HEALTH_CHANNEL_ID'] ?? null;
  const dbPath = parseArg('db') ?? process.env['ATLAS_DB_PATH'] ?? defaultAtlasDbPath();
  const dryRun = process.argv.includes('--dry-run');

  const gateway = new GatewaySync();
  await gateway.connect();

  const db = openAtlasDb(dbPath);

  try {
    const { snapshots, summary } = await collectSessionHealthSnapshots(gateway, {
      historyLimit,
      onlyChannel,
      minCanonicalCoverage,
    });

    const persistedBefore = persistSessionHealthSnapshots(db, snapshots, {
      source: 'session:auto-repair:before',
    });

    const nowMs = Date.now();
    const cooldownMs = cooldownMinutes * 60_000;

    const candidates: RepairCandidate[] = [];
    for (const snapshot of snapshots) {
      if (snapshot.familySize <= 1) continue;

      const previous = readPreviousSnapshot(db, snapshot.channelId, snapshot.observedAtIso);
      const reasons = buildRepairReasons(snapshot, previous, minCanonicalCoverage, depthTrigger);
      if (reasons.length === 0) continue;

      const lastRepairAt = readLastRepairEventAt(db, snapshot.channelId);
      if (lastRepairAt != null && nowMs - lastRepairAt < cooldownMs) {
        const remainingMs = cooldownMs - (nowMs - lastRepairAt);
        console.log(
          `Auto-repair skip channel=${snapshot.channelId} reason=cooldown remainingMs=${remainingMs}`,
        );
        if (!dryRun) {
          recordSessionRepairEvent(db, {
            channelId: snapshot.channelId,
            action: 'session:repair-thread',
            status: 'skipped',
            triggerReason: reasons.join(','),
            beforeSnapshotId: persistedBefore.snapshotIdByChannel.get(snapshot.channelId) ?? null,
            details: { reason: 'cooldown', cooldownMinutes },
          });
        }
        continue;
      }

      const score = reasons.reduce((sum, reason) => sum + reasonScore(reason), 0);
      candidates.push({
        channelId: snapshot.channelId,
        reasons,
        score,
        beforeSnapshotId: persistedBefore.snapshotIdByChannel.get(snapshot.channelId) ?? null,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates.slice(0, maxChannels);

    console.log(`Auto-repair candidate summary: ${JSON.stringify({
      ...summary,
      candidates: candidates.length,
      selected: selected.length,
      dryRun,
      maxChannels,
      cooldownMinutes,
      minCanonicalCoverage,
      depthTrigger,
    })}`);

    let repaired = 0;
    let failed = 0;

    for (const candidate of selected) {
      console.log(
        `Auto-repair channel=${candidate.channelId} reasons=${candidate.reasons.join(',')} score=${candidate.score}${dryRun ? ' dry-run' : ''}`,
      );

      if (dryRun) continue;

      const started = Date.now();
      const repair = runRepairCommand(candidate.channelId, repairHistoryLimit, maxPerChannel);
      const durationMs = Date.now() - started;

      let afterSnapshotId: number | null = null;
      if (repair.ok) {
        repaired++;
        const after = await collectSessionHealthSnapshots(gateway, {
          historyLimit,
          onlyChannel: candidate.channelId,
          minCanonicalCoverage,
        });
        const persistedAfter = persistSessionHealthSnapshots(db, after.snapshots, {
          source: 'session:auto-repair:after',
        });
        afterSnapshotId = persistedAfter.snapshotIdByChannel.get(candidate.channelId) ?? null;
      } else {
        failed++;
      }

      recordSessionRepairEvent(db, {
        channelId: candidate.channelId,
        action: 'session:repair-thread',
        status: repair.ok ? 'success' : 'failed',
        triggerReason: candidate.reasons.join(','),
        beforeSnapshotId: candidate.beforeSnapshotId,
        afterSnapshotId,
        details: {
          durationMs,
          repairHistoryLimit,
          maxPerChannel,
          output: repair.output.slice(-4000),
        },
      });

      console.log(
        `Auto-repair result channel=${candidate.channelId} status=${repair.ok ? 'success' : 'failed'} durationMs=${durationMs}`,
      );
    }

    console.log(`Auto-repair summary: ${JSON.stringify({
      candidates: candidates.length,
      selected: selected.length,
      repaired,
      failed,
      dryRun,
    })}`);

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    db.close();
    gateway.destroy();
  }
}

run().catch((err) => {
  console.error(`Auto-repair failed: ${err?.message ?? err}`);
  process.exitCode = 1;
});
