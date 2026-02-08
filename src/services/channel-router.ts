import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Guild, ChannelType, TextChannel, type GuildBasedChannel } from 'discord.js';
import { WATSON_SYSTEM_PROMPT } from '../prompts/watson-system.js';
import { config } from '../config.js';
import type { Message } from './claude.js';

const SENDABLE_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

interface ChannelDef {
  displayName: string;
  channelId: string;
  topicPrompt: string | null;
}

const channels = JSON.parse(
  readFileSync(resolve(__dirname, '../channels.json'), 'utf-8'),
) as Record<string, ChannelDef>;

export class ChannelRouter {
  private guild: Guild;
  private activeChannelName = 'default';
  private historyMap = new Map<string, Message[]>();
  private resolvedChannels = new Map<string, TextChannel>();

  constructor(guild: Guild) {
    this.guild = guild;
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

  getSystemPrompt(): string {
    const active = this.getActiveChannel();
    if (!active.topicPrompt) {
      return WATSON_SYSTEM_PROMPT;
    }
    return `${WATSON_SYSTEM_PROMPT}\n\n---\n\nTopic context for this channel:\n${active.topicPrompt}`;
  }

  async getLogChannel(): Promise<TextChannel | null> {
    const active = this.getActiveChannel();
    const channelId = active.channelId || config.logChannelId;
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
    if (active.channelId && config.logChannelId) {
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

  getHistory(): Message[] {
    return this.historyMap.get(this.activeChannelName) || [];
  }

  setHistory(history: Message[]): void {
    this.historyMap.set(this.activeChannelName, history);
  }

  async switchTo(name: string): Promise<{ success: boolean; error?: string; historyCount: number; displayName?: string }> {
    // Check if it's a known channel name
    if (channels[name]) {
      this.activeChannelName = name;

      if (!this.historyMap.has(name)) {
        const seeded = await this.seedHistoryFromDiscord(name);
        this.historyMap.set(name, seeded);
      }

      const historyCount = this.historyMap.get(name)?.length || 0;
      console.log(`Switched to channel: ${name} (${historyCount} history messages)`);
      return { success: true, historyCount, displayName: channels[name].displayName };
    }

    // Try as a raw channel ID or <#id> mention
    const channelId = name.replace(/^<#(\d+)>$/, '$1');
    if (/^\d+$/.test(channelId)) {
      return this.switchToAdhoc(channelId);
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

    if (!this.historyMap.has(key)) {
      const seeded = await this.seedHistoryFromDiscord(key);
      this.historyMap.set(key, seeded);
    }

    const historyCount = this.historyMap.get(key)?.length || 0;
    console.log(`Switched to ad-hoc channel: #${displayName} / type=${resolved.type} (${historyCount} history messages)`);
    return { success: true, historyCount, displayName: `#${displayName}` };
  }

  switchToDefault(): Promise<{ success: boolean; error?: string; historyCount: number; displayName?: string }> {
    return this.switchTo('default');
  }

  clearActiveHistory(): void {
    this.historyMap.delete(this.activeChannelName);
    console.log(`Cleared history for channel: ${this.activeChannelName}`);
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
        const content = msg.content
          .replace(/^\*\*You:\*\*\s*/i, '')
          .replace(new RegExp(`^\\*\\*${config.botName}:\\*\\*\\s*`, 'i'), '');

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
}
