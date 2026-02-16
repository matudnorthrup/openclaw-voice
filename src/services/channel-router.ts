import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Guild, ChannelType, TextChannel, ForumChannel, type GuildBasedChannel } from 'discord.js';
import { WATSON_SYSTEM_PROMPT } from '../prompts/watson-system.js';
import { config } from '../config.js';
import type { Message } from './claude.js';
import { GatewaySync, type ChatMessage } from './gateway-sync.js';

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
}

const channels = JSON.parse(
  readFileSync(resolve(__dirname, '../channels.json'), 'utf-8'),
) as Record<string, ChannelDef>;

export class ChannelRouter {
  private guild: Guild;
  private activeChannelName = 'default';
  private historyMap = new Map<string, Message[]>();
  private resolvedChannels = new Map<string, TextChannel>();
  private gatewaySync: GatewaySync | null = null;
  private lastAccessed = new Map<string, number>();

  constructor(guild: Guild, gatewaySync?: GatewaySync) {
    this.guild = guild;
    this.gatewaySync = gatewaySync ?? null;
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
    if (seeded.length > 0) {
      this.historyMap.set(name, seeded);
    }
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
    let hasDefaultMain = false;
    for (const [name, def] of Object.entries(channels)) {
      if (!def.channelId && !def.sessionKey) continue;
      const sessionKey = def.sessionKey
        || (def.channelId ? GatewaySync.sessionKeyForChannel(def.channelId) : GatewaySync.defaultSessionKey);
      if (sessionKey === GatewaySync.defaultSessionKey) {
        hasDefaultMain = true;
      }
      result.push({ name, displayName: def.displayName, sessionKey });
    }
    if (!hasDefaultMain) {
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
        if (def.channelId) {
          const latestDiscord = await this.getLastMessageFromDiscord(name);
          if (latestDiscord && !this.containsEquivalentMessage(messages, latestDiscord)) {
            console.warn(
              `OpenClaw session appears stale for #${name}; falling back to Discord history for seed`,
            );
            return this.seedHistoryFromDiscord(name);
          }
        }
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

      const content = this.normalizeDiscordMessageContent(this.extractTextContent(msg.content));
      if (!content) continue;

      // Messages injected from voice with label 'voice-user' are user messages
      if (msg.label === 'voice-user') {
        messages.push({ role: 'user', content });
        continue;
      }

      // Keep user and assistant messages as-is
      if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({ role: msg.role, content });
      }
    }
    return messages;
  }

  private containsEquivalentMessage(messages: Message[], target: Message): boolean {
    const needle = this.normalizeMessageForCompare(target);
    if (!needle) return false;
    const tail = messages.slice(-20);
    return tail.some((msg) => this.normalizeMessageForCompare(msg) === needle);
  }

  private normalizeMessageForCompare(message: Message): string {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = this.normalizeDiscordMessageContent(String(message.content ?? ''))
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    return content ? `${role}:${content}` : '';
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
          messages.push({ role: 'assistant', content });
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
      for (const msg of fetched.values()) {
        const content = this.normalizeDiscordMessageContent(msg.content);
        if (!content.trim()) continue;
        return {
          role: msg.author.bot ? 'assistant' : 'user',
          content,
        };
      }
      return null;
    } catch (err: any) {
      console.error(`Failed to fetch last Discord message from #${name}:`, err.message);
      return null;
    }
  }

  private normalizeDiscordMessageContent(content: string): string {
    return content
      .replace(/^\[(?:discord-user|discord-assistant)\]\s*/i, '')
      .replace(/^\*\*You:\*\*\s*/i, '')
      .replace(new RegExp(`^\\*\\*${config.botName}:\\*\\*\\s*`, 'i'), '');
  }
}
