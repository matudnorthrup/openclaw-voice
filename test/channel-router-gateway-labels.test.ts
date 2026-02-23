import { describe, it, expect } from 'vitest';
import { Collection } from 'discord.js';
import { ChannelRouter } from '../src/services/channel-router.js';
import type { ChatMessage } from '../src/services/gateway-sync.js';

function makeRouter(): ChannelRouter {
  const guild = {
    channels: { cache: new Collection<string, any>() },
  } as any;
  return new ChannelRouter(guild);
}

describe('ChannelRouter gateway label mapping', () => {
  it('maps [discord-user] assistant-role entries to user role', () => {
    const router = makeRouter();
    const input: ChatMessage[] = [
      { role: 'assistant', content: '[discord-user]\n\nhello from text chat' },
    ];

    const result = (router as any).convertOpenClawMessages(input);

    expect(result).toEqual([
      { role: 'user', content: 'hello from text chat' },
    ]);
  });

  it('strips repeated labels and preserves assistant role for [discord-assistant]', () => {
    const router = makeRouter();
    const input: ChatMessage[] = [
      { role: 'assistant', content: '[discord-assistant]\n\n[discord-assistant]\n\nassistant text' },
    ];

    const result = (router as any).convertOpenClawMessages(input);

    expect(result).toEqual([
      { role: 'assistant', content: 'assistant text' },
    ]);
  });

  it('maps explicit discord-user label to user role without text prefix', () => {
    const router = makeRouter();
    const input: ChatMessage[] = [
      { role: 'assistant', content: 'plain text', label: 'discord-user' },
    ];

    const result = (router as any).convertOpenClawMessages(input);

    expect(result).toEqual([
      { role: 'user', content: 'plain text' },
    ]);
  });
});
