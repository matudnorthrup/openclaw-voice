import { describe, it, expect } from 'vitest';
import { Collection, ChannelType } from 'discord.js';
import { ChannelRouter } from '../src/services/channel-router.js';

function makeRouterWithForums(names: Array<{ id: string; name: string }>): ChannelRouter {
  const cache = new Collection<string, any>();
  for (const f of names) {
    cache.set(f.id, {
      id: f.id,
      name: f.name,
      type: ChannelType.GuildForum,
    });
  }
  const guild = {
    channels: { cache },
  } as any;
  return new ChannelRouter(guild);
}

describe('ChannelRouter forum matching', () => {
  it('matches spaced query against compact/hyphen forum names', () => {
    const router = makeRouterWithForums([
      { id: '1', name: 'openclaw-forum' },
      { id: '2', name: 'general-forum' },
    ]);

    const result = router.findForumChannel('open claw');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('1');
  });

  it('ignores filler words like forum/topic/thread in query', () => {
    const router = makeRouterWithForums([
      { id: '1', name: 'openclaw-forum' },
    ]);

    const result = router.findForumChannel('my open claw forum topic');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('1');
  });
});

