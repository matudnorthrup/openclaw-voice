import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Guild, ChannelType, TextChannel, ForumChannel, type GuildBasedChannel } from 'discord.js';
import { WATSON_SYSTEM_PROMPT } from '../prompts/watson-system.js';
import { config } from '../config.js';
import type { Message } from './claude.js';
import { GatewaySync, type ChatMessage } from './gateway-sync.js';
import { isGatewayMetadataWrapper, sanitizeAssistantResponse } from './assistant-sanitizer.js';

const SENDABLE_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

interface ChannelDef {
  displayName: string;
  channelId: string;
  topicPrompt: string | null;
  sessionKey?: string;
  inboxExclude?: boolean;
}

const channels = JSON.parse(
  readFileSync(resolve(__dirname, '../channels.json'), 'utf-8'),
) as Record<string, ChannelDef>;

type DbRunResult = { lastInsertRowid?: number | bigint };

type DbStmt = {
  run: (...args: unknown[]) => DbRunResult;
  all?: (...args: unknown[]) => Record<string, unknown>[];
};

type AliasDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => DbStmt;
  close: () => void;
};

export class ChannelRouter {
  private guild: Guild;
  private activeChannelName = 'default';
  private historyMap = new Map<string, Message[]>();
  private resolvedChannels = new Map<string, TextChannel>();
  private gatewaySync: GatewaySync | null = null;
  private lastAccessed = new Map<string, number>();
  private aliasDb: AliasDb | null = null;
  private aliasStmtUpsert: DbStmt | null = null;
  private aliasStmtFindExact: DbStmt | null = null;
  private aliasReady = false;

  constructor(guild: Guild, gatewaySync?: GatewaySync) {
    this.guild = guild;
    this.gatewaySync = gatewaySync ?? null;
    this.initAliasCache();
  }

  destroy(): void {
    if (this.aliasDb) {
      try {
        this.aliasDb.close();
      } catch {
        // Best effort shutdown.
      }
      this.aliasDb = null;
    }
    this.aliasStmtUpsert = null;
    this.aliasStmtFindExact = null;
    this.aliasReady = false;
  }

  listChannels(): { name: string; displayName: string; active: boolean }[] {
    return Object.entries(channels).map(([name, def]) => ({
      name,
      displayName: def.displayName,
      active: name === this.activeChannelName,
    }));
  }

  getActiveChannel(): { name: string } & ChannelDef {
    const def = channels[this.activeChannelName] || channels['default'];
    return { name: this.activeChannelName, ...def };
  }

  getRecentChannels(limit: number): { name: string; displayName: string }[] {
    const active = this.activeChannelName;
    const allNames = Object.keys(channels).filter((n) => n !== active);

    // Sort by last accessed (most recent first), unvisited channels keep definition order at the end
    allNames.sort((a, b) => {
      const aTime = this.lastAccessed.get(a) ?? 0;
      const bTime = this.lastAccessed.get(b) ?? 0;
      if (aTime && bTime) return bTime - aTime;
      if (aTime) return -1;
      if (bTime) return 1;
      return 0; // preserve definition order for unvisited
    });

    return allNames.slice(0, limit).map((name) => ({
      name,
      displayName: channels[name].displayName,
    }));
  }

  getLastMessage(channelName?: string): { role: string; content: string } | null {
    const name = channelName ?? this.activeChannelName;
    const history = this.historyMap.get(name);
    if (!history || history.length === 0) return null;
    return history[history.length - 1];
  }

  async getLastMessageFresh(channelName?: string): Promise<{ role: string; content: string } | null> {
    const name = channelName ?? this.activeChannelName;
    const fromDiscord = await this.getLastMessageFromDiscord(name);
    if (fromDiscord) return fromDiscord;
    return this.getLastMessage(name);
  }

  getSystemPrompt(): string {
    const active = this.getActiveChannel();
    if (!active.topicPrompt) {
      return WATSON_SYSTEM_PROMPT;
    }
    return `${WATSON_SYSTEM_PROMPT}\n\n---\n\nTopic context for this channel:\n${active.topicPrompt}`;
  }

  getSystemPromptFor(channelName: string): string {
    const def = channels[channelName];
    if (!def?.topicPrompt) {
      return WATSON_SYSTEM_PROMPT;
    }
    return `${WATSON_SYSTEM_PROMPT}\n\n---\n\nTopic context for this channel:\n${def.topicPrompt}`;
  }

  async getLogChannel(): Promise<TextChannel | null> {
    return this.getLogChannelFor(this.activeChannelName);
  }

  async getLogChannelFor(channelName: string): Promise<TextChannel | null> {
    const def = channels[channelName] || channels['default'];
    const channelId = def?.channelId || config.logChannelId;
    if (!channelId) return null;

    // Check our resolved cache first (handles threads/forum posts)
    const cached = this.resolvedChannels.get(channelId);
    if (cached) return cached;

    // Try guild cache, then fetch
    const resolved = await this.resolveChannel(channelId);
    if (resolved) {
      this.resolvedChannels.set(channelId, resolved);
      return resolved;
    }

    // Fall back to default log channel
    if (def?.channelId && config.logChannelId) {
      const fallback = await this.resolveChannel(config.logChannelId);
      if (fallback) return fallback;
    }

    return null;
  }

  private async resolveChannel(channelId: string): Promise<TextChannel | null> {
    // Guild channel cache
    let ch = this.guild.channels.cache.get(channelId);

    // Guild fetch (works for text channels)
    if (!ch) {
      try {
        ch = await this.guild.channels.fetch(channelId) ?? undefined;
      } catch {
        // Not a guild channel — might be a thread
      }
    }

    // Thread fetch via client (threads aren't always in guild.channels)
    if (!ch) {
      try {
        const clientCh = await this.guild.client.channels.fetch(channelId);
        if (clientCh && SENDABLE_TYPES.has(clientCh.type)) {
          return clientCh as TextChannel;
        }
      } catch {
        // Channel not accessible
      }
    }

    if (ch && SENDABLE_TYPES.has(ch.type)) {
      return ch as TextChannel;
    }

    return null;
  }

  async refreshHistory(channelName?: string): Promise<void> {
    const name = channelName ?? this.activeChannelName;
    const seeded = await this.seedHistory(name);
    if (seeded.length === 0) return;

    const existing = this.historyMap.get(name) || [];

    // Defensive: if the gateway returned drastically fewer messages than we
    // already have locally, the session was likely truncated by another process
    // (e.g. the text-chat gateway).  In that case, merge: keep our local
    // history and append any genuinely new messages from the gateway tail.
    if (existing.length > 0 && seeded.length < existing.length * 0.5) {
      const newTail = this.findNewTailMessages(existing, seeded);
      if (newTail.length > 0) {
        console.log(`refreshHistory(${name}): gateway returned ${seeded.length} msgs (local has ${existing.length}) — appending ${newTail.length} new tail messages`);
        this.historyMap.set(name, [...existing, ...newTail]);
      } else {
        console.log(`refreshHistory(${name}): gateway returned ${seeded.length} msgs (local has ${existing.length}) — keeping local history (no new messages)`);
      }
      return;
    }

    this.historyMap.set(name, seeded);
  }

  /**
   * Given our existing local history and a (possibly truncated) gateway seed,
   * return messages from the gateway seed that aren't already in our local copy.
   * Matches by content to handle label differences.
   */
  private findNewTailMessages(existing: Message[], seeded: Message[]): Message[] {
    if (seeded.length === 0) return [];

    // Build a set of content fingerprints from the last N existing messages
    const lookback = Math.min(existing.length, 40);
    const existingFingerprints = new Set<string>();
    for (let i = existing.length - lookback; i < existing.length; i++) {
      existingFingerprints.add(`${existing[i].role}:${existing[i].content.slice(0, 120)}`);
    }

    // Walk the seeded messages and collect any that aren't in our local history
    const newMessages: Message[] = [];
    for (const msg of seeded) {
      const fp = `${msg.role}:${msg.content.slice(0, 120)}`;
      if (!existingFingerprints.has(fp)) {
        newMessages.push(msg);
      }
    }
    return newMessages;
  }

  getHistory(channelName?: string): Message[] {
    const name = channelName ?? this.activeChannelName;
    return this.historyMap.get(name) || [];
  }

  setHistory(history: Message[], channelName?: string): void {
    const name = channelName ?? this.activeChannelName;
    this.historyMap.set(name, history);
  }

  async switchTo(name: string): Promise<{ success: boolean; error?: string; historyCount: number; displayName?: string }> {
    // Check if it's a known channel name
    if (channels[name]) {
      this.activeChannelName = name;

      // Always re-seed from OpenClaw to pick up new text messages
      const seeded = await this.seedHistory(name);
      this.historyMap.set(name, seeded);

      this.lastAccessed.set(name, Date.now());
      const historyCount = this.historyMap.get(name)?.length || 0;
      console.log(`Switched to channel: ${name} (${historyCount} history messages)`);
      return { success: true, historyCount, displayName: channels[name].displayName };
    }

    // Try as a raw channel ID, spoken numeric ID (with commas/spaces), or <#id> mention
    const channelId = name.replace(/^<#(\d+)>$/, '$1');
    const normalizedChannelId = channelId.replace(/[,\s]/g, '');
    if (/^\d+$/.test(normalizedChannelId)) {
      return this.switchToAdhoc(normalizedChannelId);
    }

    return { success: false, error: `Unknown channel: \`${name}\`. Use \`!channels\` to see available channels, or pass a channel ID.`, historyCount: 0 };
  }

  private async switchToAdhoc(channelId: string): Promise<{ success: boolean; error?: string; historyCount: number; displayName?: string }> {
    // Use resolveChannel which handles threads via client.channels.fetch
    const resolved = await this.resolveChannel(channelId);
    if (!resolved) {
      return { success: false, error: `Could not find sendable channel \`${channelId}\`.`, historyCount: 0 };
    }

    const displayName = 'name' in resolved ? (resolved as any).name as string : channelId;

    // Cache the resolved channel immediately
    this.resolvedChannels.set(channelId, resolved);

    // Register as a dynamic channel entry
    const key = `id:${channelId}`;
    channels[key] = {
      displayName: `#${displayName}`,
      channelId,
      topicPrompt: `This is the #${displayName} channel. Use recent conversation history for context.`,
    };

    this.activeChannelName = key;

    // Always re-seed from OpenClaw to pick up new text messages
    const seeded = await this.seedHistory(key);
    this.historyMap.set(key, seeded);

    this.lastAccessed.set(key, Date.now());
    const historyCount = this.historyMap.get(key)?.length || 0;
    console.log(`Switched to ad-hoc channel: #${displayName} / type=${resolved.type} (${historyCount} history messages)`);
    return { success: true, historyCount, displayName: `#${displayName}` };
  }

  switchToDefault(): Promise<{ success: boolean; error?: string; historyCount: number; displayName?: string }> {
    return this.switchTo('default');
  }

  async refreshAliasCache(): Promise<void> {
    if (!this.aliasReady || !this.aliasStmtUpsert) return;

    let seeded = 0;
    for (const [name, def] of Object.entries(channels)) {
      if (!def.channelId) continue;
      seeded += this.upsertAliasForms(name, def.channelId, def.displayName, 3);
      seeded += this.upsertAliasForms(def.displayName, def.channelId, def.displayName, 3);
    }

    try {
      const fetched = await this.guild.channels.fetch();
      for (const ch of fetched.values()) {
        if (!ch || !SENDABLE_TYPES.has(ch.type) || !('name' in ch) || typeof ch.name !== 'string') continue;
        const displayName = `#${ch.name}`;
        seeded += this.upsertAliasForms(ch.name, ch.id, displayName, 2);
      }
    } catch (err: any) {
      console.warn(`Alias cache guild refresh failed: ${err.message}`);
    }

    try {
      const activeThreads = await this.guild.channels.fetchActiveThreads();
      for (const thread of activeThreads.threads.values()) {
        const displayName = `#${thread.name}`;
        seeded += this.upsertAliasForms(thread.name, thread.id, displayName, 2);
      }
    } catch {
      // Optional; some guilds may not allow this.
    }

    if (seeded > 0) {
      console.log(`Alias cache refreshed (${seeded} alias forms)`);
    }
  }

  async lookupSwitchAlias(query: string): Promise<{ channelId: string; displayName: string } | null> {
    if (!this.aliasReady || !this.aliasStmtFindExact || typeof this.aliasStmtFindExact.all !== 'function') return null;
    const forms = this.channelSearchForms(query).slice(0, 4);
    if (forms.length === 0) return null;
    while (forms.length < 4) {
      forms.push(forms[forms.length - 1] || '');
    }

    const rows = this.aliasStmtFindExact.all(...forms) as Array<{
      channelId?: string;
      displayName?: string;
      hits?: number;
      lastUsedAt?: string;
    }>;
    for (const row of rows) {
      const channelId = String(row.channelId ?? '').trim();
      if (!channelId) continue;
      const resolved = await this.resolveChannel(channelId);
      if (!resolved) continue;
      const displayName = row.displayName && row.displayName.trim().length > 0
        ? row.displayName
        : ('name' in resolved ? `#${(resolved as any).name as string}` : `#${channelId}`);
      return { channelId, displayName };
    }
    return null;
  }

  rememberSwitchAlias(phrase: string, channelId: string, displayName: string): void {
    if (!this.aliasReady || !this.aliasStmtUpsert) return;
    this.upsertAliasForms(phrase, channelId, displayName, 1);
  }

  async findSendableChannelByName(query: string): Promise<{ id: string; displayName: string } | null> {
    const candidates = new Map<string, { id: string; name: string; score: number }>();

    const consider = (channel: GuildBasedChannel | null | undefined): void => {
      if (!channel || !SENDABLE_TYPES.has(channel.type)) return;
      if (!('name' in channel) || typeof channel.name !== 'string') return;
      const channelName = channel.name.trim();
      if (!channelName) return;

      const score = this.channelSearchScore(query, channelName);
      if (score <= 0) return;

      const previous = candidates.get(channel.id);
      if (!previous || score > previous.score) {
        candidates.set(channel.id, { id: channel.id, name: channelName, score });
      }
    };

    for (const ch of this.guild.channels.cache.values()) {
      consider(ch as GuildBasedChannel);
    }

    try {
      const fetched = await this.guild.channels.fetch();
      for (const ch of fetched.values()) {
        if (ch) consider(ch as GuildBasedChannel);
      }
    } catch {
      // Best-effort fallback only; cache may still be sufficient.
    }

    try {
      const activeThreads = await this.guild.channels.fetchActiveThreads();
      for (const thread of activeThreads.threads.values()) {
        consider(thread as unknown as GuildBasedChannel);
      }
    } catch {
      // Ignore; forum/thread listing can be permission-limited.
    }

    const best = [...candidates.values()]
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.name.length - b.name.length;
      })[0];

    if (!best) return null;
    return { id: best.id, displayName: `#${best.name}` };
  }

  private channelSearchScore(query: string, candidate: string): number {
    const queryForms = this.channelSearchForms(query);
    const candidateForms = this.channelSearchForms(candidate);

    let best = 0;
    for (const q of queryForms) {
      for (const c of candidateForms) {
        if (!q || !c) continue;
        if (q === c) {
          best = Math.max(best, 100);
          continue;
        }
        if (q.startsWith(c) || c.startsWith(q)) {
          best = Math.max(best, 85);
          continue;
        }
        if (q.includes(c) || c.includes(q)) {
          best = Math.max(best, 70);
        }
      }
    }
    return best;
  }

  private channelSearchForms(text: string): string[] {
    const base = text
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
    if (!base) return [''];

    const singularish = base
      .split(' ')
      .map((token) => {
        if (token.length <= 3) return token;
        if (token.endsWith('ss')) return token;
        if (token.endsWith('s')) return token.slice(0, -1);
        return token;
      })
      .join(' ');

    const compactBase = base.replace(/\s+/g, '');
    const compactSingularish = singularish.replace(/\s+/g, '');
    const spacedHyphenSplit = base.replace(/-/g, ' ');
    return Array.from(new Set([base, singularish, compactBase, compactSingularish, spacedHyphenSplit].filter(Boolean)));
  }

  private initAliasCache(): void {
    const db = this.openAliasDb();
    if (!db) return;
    this.aliasDb = db;
    this.aliasDb.exec(`
      CREATE TABLE IF NOT EXISTS voice_channel_aliases (
        normalized_alias TEXT NOT NULL,
        raw_alias TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (normalized_alias, channel_id)
      );

      CREATE INDEX IF NOT EXISTS idx_voice_channel_aliases_channel
        ON voice_channel_aliases(channel_id);

      CREATE INDEX IF NOT EXISTS idx_voice_channel_aliases_last_used
        ON voice_channel_aliases(last_used_at DESC);
    `);
    this.aliasStmtUpsert = this.aliasDb.prepare(`
      INSERT INTO voice_channel_aliases (normalized_alias, raw_alias, channel_id, display_name, hits, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(normalized_alias, channel_id) DO UPDATE SET
        raw_alias = excluded.raw_alias,
        display_name = excluded.display_name,
        hits = voice_channel_aliases.hits + excluded.hits,
        last_used_at = datetime('now')
    `);
    this.aliasStmtFindExact = this.aliasDb.prepare(`
      SELECT channel_id AS channelId, display_name AS displayName, hits, last_used_at AS lastUsedAt
      FROM voice_channel_aliases
      WHERE normalized_alias IN (?, ?, ?, ?)
      ORDER BY hits DESC, last_used_at DESC
      LIMIT 10
    `);
    this.aliasReady = true;
  }

  private openAliasDb(): AliasDb | null {
    const home = process.env['HOME'];
    if (!home) return null;
    const dbPath = process.env['ATLAS_DB_PATH'] || `${home}/atlas/atlas.db`;
    try {
      const sqlite = require('node:sqlite') as { DatabaseSync: new (path: string) => AliasDb };
      const db = new sqlite.DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA foreign_keys = ON;');
      return db;
    } catch {
      // Fall through to external better-sqlite3 path for older runtimes.
    }

    const modulePath = `${home}/atlas/node_modules/better-sqlite3`;
    try {
      const BetterSqlite3 = require(modulePath) as new (path: string) => AliasDb;
      const db = new BetterSqlite3(dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA foreign_keys = ON;');
      return db;
    } catch (err: any) {
      console.warn(`Alias cache disabled: ${err.message}`);
      return null;
    }
  }

  private upsertAliasForms(
    phrase: string,
    channelId: string,
    displayName: string,
    hits: number,
  ): number {
    if (!this.aliasReady || !this.aliasStmtUpsert) return 0;
    const raw = phrase.trim();
    if (!raw || !channelId.trim()) return 0;
    const forms = this.channelSearchForms(raw);
    for (const normalized of forms) {
      this.aliasStmtUpsert.run(normalized, raw, channelId, displayName, hits);
    }
    return forms.length;
  }

  listForumChannels(): { name: string; id: string }[] {
    return this.guild.channels.cache
      .filter((ch): ch is ForumChannel => ch.type === ChannelType.GuildForum)
      .map((f) => ({ name: f.name, id: f.id }));
  }

  findForumChannel(query: string): { name: string; id: string } | null {
    const forums = this.listForumChannels();
    const lower = query.toLowerCase().trim();
    const normalizedQuery = this.normalizeForumMatch(lower);

    const direct = forums.find((f) => f.name.toLowerCase() === lower)
      ?? forums.find((f) => f.name.toLowerCase().includes(lower))
      ?? forums.find((f) => lower.includes(f.name.toLowerCase()));
    if (direct) return direct;

    // Normalize separators and filler terms so "open claw forum" can match
    // names like "openclaw-forum" or "openclaw".
    return forums.find((f) => {
      const candidate = this.normalizeForumMatch(f.name);
      return candidate === normalizedQuery
        || candidate.includes(normalizedQuery)
        || normalizedQuery.includes(candidate);
    }) ?? null;
  }

  private normalizeForumMatch(input: string): string {
    return input
      .toLowerCase()
      .replace(/\b(?:forum|forums|channel|topic|thread|post|the|my)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, '');
  }

  async createForumPost(forumId: string, title: string, body: string): Promise<{ success: boolean; error?: string; threadId?: string; forumName?: string }> {
    const forum = this.guild.channels.cache.get(forumId) as ForumChannel | undefined;
    if (!forum || forum.type !== ChannelType.GuildForum) {
      return { success: false, error: `Forum channel ${forumId} not found.` };
    }

    try {
      let threadName = title;
      if (threadName.length > 100) threadName = threadName.slice(0, 97) + '...';
      const content = body.charAt(0).toUpperCase() + body.slice(1);

      const thread = await forum.threads.create({
        name: threadName,
        message: { content },
      });

      await this.switchTo(thread.id);

      console.log(`Created forum post "${title}" in #${forum.name} (thread ${thread.id})`);
      return { success: true, threadId: thread.id, forumName: forum.name };
    } catch (err: any) {
      return { success: false, error: `Failed to create thread: ${err.message}` };
    }
  }

  async getForumThreads(): Promise<{ name: string; displayName: string; threadId: string }[]> {
    const forums = this.guild.channels.cache.filter(
      (ch): ch is ForumChannel => ch.type === ChannelType.GuildForum,
    );

    const results: { name: string; displayName: string; threadId: string }[] = [];
    for (const forum of forums.values()) {
      try {
        const active = await forum.threads.fetchActive();
        for (const thread of active.threads.values()) {
          results.push({
            name: `id:${thread.id}`,
            displayName: `${thread.name} (in ${forum.name})`,
            threadId: thread.id,
          });
        }
      } catch (err: any) {
        console.warn(`Failed to fetch threads from forum ${forum.name}: ${err.message}`);
      }
    }
    return results;
  }

  clearActiveHistory(): void {
    this.historyMap.delete(this.activeChannelName);
    console.log(`Cleared history for channel: ${this.activeChannelName}`);
  }

  getAllChannelSessionKeys(): { name: string; displayName: string; sessionKey: string }[] {
    const result: { name: string; displayName: string; sessionKey: string }[] = [];
    let hasDefault = false;
    for (const [name, def] of Object.entries(channels)) {
      if (!def.channelId && !def.sessionKey) continue;
      if (def.inboxExclude) continue;
      if (name === 'default') hasDefault = true;
      const sessionKey = def.sessionKey
        || (def.channelId ? GatewaySync.sessionKeyForChannel(def.channelId) : GatewaySync.defaultSessionKey);
      result.push({ name, displayName: def.displayName, sessionKey });
    }
    if (!hasDefault) {
      result.push({
        name: 'default',
        displayName: channels['default']?.displayName || 'General',
        sessionKey: GatewaySync.defaultSessionKey,
      });
    }
    return result;
  }

  getActiveSessionKey(): string {
    const def = channels[this.activeChannelName];
    if (def?.sessionKey) return def.sessionKey;
    if (def?.channelId) return GatewaySync.sessionKeyForChannel(def.channelId);
    return GatewaySync.defaultSessionKey;
  }

  getSessionKeyFor(channelName: string): string {
    const def = channels[channelName];
    if (def?.sessionKey) return def.sessionKey;
    if (def?.channelId) return GatewaySync.sessionKeyForChannel(def.channelId);
    return GatewaySync.defaultSessionKey;
  }

  private async seedHistory(name: string): Promise<Message[]> {
    const def = channels[name];

    // Try OpenClaw first
    if (this.gatewaySync?.isConnected() && def) {
      const sessionKey = def.sessionKey
        || (def.channelId ? GatewaySync.sessionKeyForChannel(def.channelId) : GatewaySync.defaultSessionKey);

      const result = await this.gatewaySync.getHistory(sessionKey, 40);
      if (result && result.messages.length > 0) {
        const messages = this.convertOpenClawMessages(result.messages);
        console.log(`Seeded ${messages.length} messages from OpenClaw session ${sessionKey}`);
        return messages;
      }
    }

    // Fall back to Discord history
    return this.seedHistoryFromDiscord(name);
  }

  private convertOpenClawMessages(clawMessages: ChatMessage[]): Message[] {
    const messages: Message[] = [];
    for (const msg of clawMessages) {
      // Skip system messages
      if (msg.role === 'system') continue;

      const rawContent = this.extractTextContent(msg.content);
      if (!rawContent) continue;
      if (isGatewayMetadataWrapper(rawContent)) continue;

      const label = this.extractMessageLabel(msg, rawContent);
      const mappedRole = this.mapLabelToRole(label);
      const role: 'user' | 'assistant' | null = mappedRole
        ?? (msg.role === 'user' || msg.role === 'assistant' ? msg.role : null);
      if (!role) continue;

      let content = this.normalizeDiscordMessageContent(rawContent);
      if (!content) continue;

      // Defensive cleanup for assistant contamination like:
      // "answer ... [voice-user] transcript ... [voice-assistant] answer"
      if (role === 'assistant') {
        content = sanitizeAssistantResponse(content);
        if (!content) continue;
      }

      messages.push({ role, content });
    }
    return messages;
  }

  /** Normalize content that may be a string or Anthropic-style content blocks. */
  private extractTextContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((b: any) => b.type === 'text' && b.text)
        .map((b: any) => b.text)
        .join('');
    }
    return String(content);
  }

  private async seedHistoryFromDiscord(name: string): Promise<Message[]> {
    const def = channels[name];
    if (!def || !def.channelId) return [];

    const textChannel = await this.resolveChannel(def.channelId);
    if (!textChannel) return [];

    // Cache for getLogChannel
    this.resolvedChannels.set(def.channelId, textChannel);

    try {
      const fetched = await textChannel.messages.fetch({ limit: 50 });
      const messages: Message[] = [];

      // Discord returns newest first, reverse to chronological order
      const sorted = [...fetched.values()].reverse();

      for (const msg of sorted) {
        const content = this.normalizeDiscordMessageContent(msg.content);
        if (!content.trim()) continue;

        if (msg.author.bot) {
          // Bot-posted messages with **You:** prefix are user transcripts
          // logged by the voice pipeline — attribute them to the user role
          // so the LLM sees the correct conversation structure.
          const isUserTranscript = /^\*\*You:\*\*/i.test(msg.content);
          messages.push({ role: isUserTranscript ? 'user' : 'assistant', content });
        } else {
          messages.push({ role: 'user', content });
        }
      }

      console.log(`Seeded ${messages.length} messages from #${name} Discord history`);
      return messages;
    } catch (err: any) {
      console.error(`Failed to seed history from #${name}:`, err.message);
      return [];
    }
  }

  private async getLastMessageFromDiscord(name: string): Promise<Message | null> {
    const def = channels[name];
    if (!def?.channelId) return null;

    const textChannel = await this.resolveChannel(def.channelId);
    if (!textChannel) return null;

    this.resolvedChannels.set(def.channelId, textChannel);

    try {
      const fetched = await textChannel.messages.fetch({ limit: 10 });
      // Collect consecutive messages with the same ROLE (newest first)
      // to reassemble responses split across multiple Discord messages.
      // We break on role change, not just author change, because the voice
      // pipeline posts both **You:** transcripts and **Watson:** responses
      // from the same bot account.
      let firstRole: 'user' | 'assistant' | null = null;
      const parts: string[] = [];
      for (const msg of fetched.values()) {
        const content = this.normalizeDiscordMessageContent(msg.content);
        if (!content.trim()) continue;
        const isUserTranscript = msg.author.bot && /^\*\*You:\*\*/i.test(msg.content);
        const isHumanUser = !msg.author.bot;
        const role: 'user' | 'assistant' = (isUserTranscript || isHumanUser) ? 'user' : 'assistant';
        if (firstRole === null) {
          firstRole = role;
          parts.push(content);
        } else if (role === firstRole) {
          // Same role continuation — collect (these are older, so prepend)
          parts.unshift(content);
        } else {
          break;
        }
      }
      if (parts.length === 0 || !firstRole) return null;
      return { role: firstRole, content: parts.join('\n\n') };
    } catch (err: any) {
      console.error(`Failed to fetch last Discord message from #${name}:`, err.message);
      return null;
    }
  }

  private normalizeDiscordMessageContent(content: string): string {
    return content
      .replace(/^(?:\[(?:discord-user|discord-assistant|voice-user|voice-assistant)\]\s*)+/i, '')
      .replace(/^\*\*You:\*\*\s*/i, '')
      .replace(new RegExp(`^\\*\\*${config.botName}:\\*\\*\\s*`, 'i'), '');
  }

  private extractMessageLabel(msg: ChatMessage, textContent: string): string | null {
    if (typeof msg.label === 'string' && msg.label.trim()) {
      return msg.label.trim().toLowerCase();
    }
    const match = textContent.match(/^\[([a-z][\w-]*)\]\s*/i);
    return match ? match[1].toLowerCase() : null;
  }

  private mapLabelToRole(label: string | null): 'user' | 'assistant' | null {
    if (!label) return null;
    if (label === 'voice-user' || label === 'discord-user') return 'user';
    if (label === 'voice-assistant' || label === 'discord-assistant') return 'assistant';
    return null;
  }
}
