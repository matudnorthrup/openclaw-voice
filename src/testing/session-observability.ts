import { homedir } from 'node:os';
import { join } from 'node:path';
import { GatewaySync, type ChatMessage } from '../services/gateway-sync.js';
import {
  canonicalSessionKeyForChannel,
  groupSessionFamilies,
  extractMessageLabel,
  extractMessageText,
  toBackfillableMessage,
} from './session-split-utils.js';

type DbRunResult = {
  lastInsertRowid?: number | bigint;
};

type DbStmt = {
  run: (...args: unknown[]) => DbRunResult;
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
};

type AtlasDb = {
  pragma: (sql: string) => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => DbStmt;
  transaction: <T>(fn: () => T) => () => T;
  close: () => void;
};

export interface SessionFamilyMemberHealth {
  sessionKey: string;
  openAiDepth: number;
  messageCount: number;
  labeledCount: number;
  unlabeledCount: number;
  isCanonical: boolean;
}

export interface SessionHealthSnapshot {
  observedAtIso: string;
  channelId: string;
  canonicalKey: string;
  coverageTargetKey: string;
  resolvedKey: string;
  familySize: number;
  maxOpenAiDepth: number;
  hasCanonical: boolean;
  canonicalCoverage: number | null;
  labeledMessages: number;
  unlabeledMessages: number;
  flags: string[];
  familyMembers: SessionFamilyMemberHealth[];
}

export interface CollectSessionHealthOptions {
  historyLimit: number;
  onlyChannel?: string | null;
  minCanonicalCoverage: number;
}

export interface PersistSessionHealthOptions {
  source?: string;
}

export interface PersistSessionHealthResult {
  insertedSnapshots: number;
  insertedMembers: number;
  snapshotIdByChannel: Map<string, number>;
}

export interface SessionHealthSummary {
  totalChannelFamilies: number;
  splitFamilies: number;
  nestedFamilies: number;
  missingCanonicalFamilies: number;
  lowCoverage: number;
  maxOpenAiDepth: number;
  minCanonicalCoverage: number;
}

export interface SessionRepairEventRecord {
  channelId: string;
  action: string;
  status: 'success' | 'failed' | 'skipped' | 'dry-run';
  triggerReason: string;
  beforeSnapshotId?: number | null;
  afterSnapshotId?: number | null;
  details?: Record<string, unknown>;
}

export interface PreviousSnapshot {
  id: number;
  observedAt: string;
  maxOpenAiDepth: number;
  canonicalCoverage: number | null;
  hasCanonical: boolean;
}

export function defaultAtlasDbPath(): string {
  return join(homedir(), 'atlas', 'atlas.db');
}

export function openAtlasDb(dbPath = defaultAtlasDbPath()): AtlasDb {
  const betterSqlitePath = join(homedir(), 'atlas', 'node_modules', 'better-sqlite3');
  const BetterSqlite3 = require(betterSqlitePath) as new (path: string) => AtlasDb;
  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function ensureSessionObservabilitySchema(db: AtlasDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      channel_id TEXT NOT NULL,
      canonical_key TEXT,
      coverage_target_key TEXT,
      resolved_key TEXT,
      family_size INTEGER NOT NULL DEFAULT 0,
      max_openai_depth INTEGER NOT NULL DEFAULT 0,
      has_canonical INTEGER NOT NULL DEFAULT 0,
      canonical_coverage REAL,
      labeled_messages INTEGER NOT NULL DEFAULT 0,
      unlabeled_messages INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'session:health',
      meta TEXT DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_session_health_channel_time
      ON session_health_snapshots(channel_id, observed_at DESC);

    CREATE TABLE IF NOT EXISTS session_family_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES session_health_snapshots(id) ON DELETE CASCADE,
      session_key TEXT NOT NULL,
      openai_depth INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER,
      labeled_count INTEGER,
      unlabeled_count INTEGER,
      is_canonical INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_session_family_snapshot
      ON session_family_members(snapshot_id);

    CREATE TABLE IF NOT EXISTS session_repair_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
      channel_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger_reason TEXT,
      before_snapshot_id INTEGER,
      after_snapshot_id INTEGER,
      details TEXT DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_session_repair_channel_time
      ON session_repair_events(channel_id, occurred_at DESC);
  `);
}

export async function collectSessionHealthSnapshots(
  gateway: GatewaySync,
  options: CollectSessionHealthOptions,
): Promise<{ snapshots: SessionHealthSnapshot[]; summary: SessionHealthSummary }> {
  const sessions = await gateway.listSessions();
  const families = groupSessionFamilies(sessions ?? []);

  const channelIds = Array.from(families.keys())
    .filter((id) => !options.onlyChannel || id === options.onlyChannel)
    .sort();

  const observedAtIso = new Date().toISOString();
  const snapshots: SessionHealthSnapshot[] = [];

  let splitFamilies = 0;
  let nestedFamilies = 0;
  let missingCanonicalFamilies = 0;
  let lowCoverage = 0;
  let maxOpenAiDepth = 0;

  for (const channelId of channelIds) {
    const family = families.get(channelId) ?? [];
    if (family.length === 0) continue;

    const canonicalKey = canonicalSessionKeyForChannel(channelId);
    const hasCanonical = family.includes(canonicalKey);
    const coverageTargetKey = hasCanonical ? canonicalKey : family[0]!;
    const resolvedKey = gateway.getResolvedSessionKey(canonicalKey);

    if (family.length > 1) splitFamilies++;
    if (!hasCanonical) missingCanonicalFamilies++;

    const familyDepth = Math.max(...family.map((key) => GatewaySync.countOpenAiUserPrefixes(key)));
    maxOpenAiDepth = Math.max(maxOpenAiDepth, familyDepth);
    if (familyDepth > 1) nestedFamilies++;

    const signatureByKey = new Map<string, Set<string>>();
    const union = new Set<string>();
    const members: SessionFamilyMemberHealth[] = [];

    for (const key of family) {
      const result = await gateway.getHistoryExact(key, options.historyLimit);
      const messages = (result?.messages ?? []) as (ChatMessage & { timestamp?: number })[];

      let labeledCount = 0;
      let unlabeledCount = 0;
      const signatures = new Set<string>();

      for (let i = 0; i < messages.length; i++) {
        const message = messages[i]!;
        const raw = extractMessageText(message.content);
        const label = extractMessageLabel(message, raw);
        if (label) {
          labeledCount++;
        } else {
          unlabeledCount++;
        }

        const entry = toBackfillableMessage(message, i + 1);
        if (!entry) continue;
        signatures.add(entry.signature);
        union.add(entry.signature);
      }

      signatureByKey.set(key, signatures);
      members.push({
        sessionKey: key,
        openAiDepth: GatewaySync.countOpenAiUserPrefixes(key),
        messageCount: messages.length,
        labeledCount,
        unlabeledCount,
        isCanonical: key === canonicalKey,
      });
    }

    const canonicalCoverage = union.size > 0
      ? (signatureByKey.get(coverageTargetKey)?.size ?? 0) / union.size
      : null;

    if (canonicalCoverage !== null && canonicalCoverage < options.minCanonicalCoverage) {
      lowCoverage++;
    }

    const labeledMessages = members.reduce((sum, m) => sum + m.labeledCount, 0);
    const unlabeledMessages = members.reduce((sum, m) => sum + m.unlabeledCount, 0);

    const flags: string[] = [];
    if (!hasCanonical) flags.push('missing-canonical');
    if (familyDepth > 1) flags.push('nested-openai-user');
    if (canonicalCoverage !== null && canonicalCoverage < options.minCanonicalCoverage) {
      flags.push('low-canonical-coverage');
    }
    if (resolvedKey !== canonicalKey) flags.push('resolved-alias');

    snapshots.push({
      observedAtIso,
      channelId,
      canonicalKey,
      coverageTargetKey,
      resolvedKey,
      familySize: family.length,
      maxOpenAiDepth: familyDepth,
      hasCanonical,
      canonicalCoverage,
      labeledMessages,
      unlabeledMessages,
      flags,
      familyMembers: members,
    });
  }

  return {
    snapshots,
    summary: {
      totalChannelFamilies: channelIds.length,
      splitFamilies,
      nestedFamilies,
      missingCanonicalFamilies,
      lowCoverage,
      maxOpenAiDepth,
      minCanonicalCoverage: options.minCanonicalCoverage,
    },
  };
}

export function persistSessionHealthSnapshots(
  db: AtlasDb,
  snapshots: SessionHealthSnapshot[],
  options?: PersistSessionHealthOptions,
): PersistSessionHealthResult {
  ensureSessionObservabilitySchema(db);

  const insertSnapshot = db.prepare(`
    INSERT INTO session_health_snapshots (
      observed_at,
      channel_id,
      canonical_key,
      coverage_target_key,
      resolved_key,
      family_size,
      max_openai_depth,
      has_canonical,
      canonical_coverage,
      labeled_messages,
      unlabeled_messages,
      source,
      meta
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMember = db.prepare(`
    INSERT INTO session_family_members (
      snapshot_id,
      session_key,
      openai_depth,
      message_count,
      labeled_count,
      unlabeled_count,
      is_canonical
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const snapshotIdByChannel = new Map<string, number>();
  let insertedSnapshots = 0;
  let insertedMembers = 0;

  const tx = db.transaction(() => {
    for (const snapshot of snapshots) {
      const snapshotMeta = JSON.stringify({ flags: snapshot.flags });
      const row = insertSnapshot.run(
        snapshot.observedAtIso,
        snapshot.channelId,
        snapshot.canonicalKey,
        snapshot.coverageTargetKey,
        snapshot.resolvedKey,
        snapshot.familySize,
        snapshot.maxOpenAiDepth,
        snapshot.hasCanonical ? 1 : 0,
        snapshot.canonicalCoverage,
        snapshot.labeledMessages,
        snapshot.unlabeledMessages,
        options?.source ?? 'session:health',
        snapshotMeta,
      );

      const snapshotIdRaw = row.lastInsertRowid;
      const snapshotId = typeof snapshotIdRaw === 'bigint'
        ? Number(snapshotIdRaw)
        : Number(snapshotIdRaw ?? 0);

      insertedSnapshots++;
      if (snapshotId > 0) {
        snapshotIdByChannel.set(snapshot.channelId, snapshotId);
      }

      for (const member of snapshot.familyMembers) {
        insertMember.run(
          snapshotId,
          member.sessionKey,
          member.openAiDepth,
          member.messageCount,
          member.labeledCount,
          member.unlabeledCount,
          member.isCanonical ? 1 : 0,
        );
        insertedMembers++;
      }
    }
  });

  tx();
  return { insertedSnapshots, insertedMembers, snapshotIdByChannel };
}

export function readPreviousSnapshot(
  db: AtlasDb,
  channelId: string,
  observedAtIso: string,
): PreviousSnapshot | null {
  const row = db.prepare(`
    SELECT id, observed_at, max_openai_depth, canonical_coverage, has_canonical
    FROM session_health_snapshots
    WHERE channel_id = ? AND observed_at < ?
    ORDER BY observed_at DESC
    LIMIT 1
  `).get(channelId, observedAtIso);

  if (!row) return null;
  return {
    id: Number(row['id']),
    observedAt: String(row['observed_at']),
    maxOpenAiDepth: Number(row['max_openai_depth'] ?? 0),
    canonicalCoverage: row['canonical_coverage'] == null ? null : Number(row['canonical_coverage']),
    hasCanonical: Number(row['has_canonical'] ?? 0) === 1,
  };
}

export function readLastRepairEventAt(db: AtlasDb, channelId: string): number | null {
  const row = db.prepare(`
    SELECT occurred_at
    FROM session_repair_events
    WHERE channel_id = ?
    ORDER BY occurred_at DESC
    LIMIT 1
  `).get(channelId);
  if (!row) return null;

  const occurredAt = Date.parse(String(row['occurred_at']));
  return Number.isFinite(occurredAt) ? occurredAt : null;
}

export function recordSessionRepairEvent(db: AtlasDb, event: SessionRepairEventRecord): void {
  ensureSessionObservabilitySchema(db);
  db.prepare(`
    INSERT INTO session_repair_events (
      channel_id,
      action,
      status,
      trigger_reason,
      before_snapshot_id,
      after_snapshot_id,
      details
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.channelId,
    event.action,
    event.status,
    event.triggerReason,
    event.beforeSnapshotId ?? null,
    event.afterSnapshotId ?? null,
    JSON.stringify(event.details ?? {}),
  );
}
