import { describe, it, expect, vi } from 'vitest';
import { GatewaySync } from '../src/services/gateway-sync.js';

describe('GatewaySync', () => {
  it('normalizes nested openai-user completion IDs to canonical channel keys', () => {
    const canonical = GatewaySync.sessionKeyForChannel('12345');
    const agentId = canonical.split(':')[1]!;
    const nested = `agent:${agentId}:openai-user:agent:${agentId}:openai-user:${canonical}`;

    expect(GatewaySync.countOpenAiUserPrefixes(nested)).toBe(2);
    expect(GatewaySync.stripOpenAiUserPrefixes(nested)).toBe(canonical);
    expect(GatewaySync.normalizeCompletionUserId(nested)).toBe(canonical);
  });

  it('flushes queued injects on first successful connect without reconnect callbacks', async () => {
    const gateway = new GatewaySync();
    const reconnectCb = vi.fn();
    gateway.onReconnect(reconnectCb);

    const flushSpy = vi.spyOn(gateway as any, 'flushInjectQueue').mockResolvedValue(undefined);

    await (gateway as any).onConnectEstablished(false);

    expect(reconnectCb).not.toHaveBeenCalled();
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it('runs reconnect callbacks and flushes queued injects after reconnect', async () => {
    const gateway = new GatewaySync();
    const reconnectCb = vi.fn().mockResolvedValue(undefined);
    gateway.onReconnect(reconnectCb);

    const flushSpy = vi.spyOn(gateway as any, 'flushInjectQueue').mockResolvedValue(undefined);

    await (gateway as any).onConnectEstablished(true);

    expect(reconnectCb).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  it('clears stale alias mapping when canonical session key is available', async () => {
    const gateway = new GatewaySync();
    const canonical = GatewaySync.sessionKeyForChannel('987654321');
    const agentId = canonical.split(':')[1]!;
    const alias = `agent:${agentId}:openai-user:${canonical}`;

    (gateway as any).sessionKeyCache.set(canonical, alias);

    const listSpy = vi.spyOn(gateway, 'listSessions').mockResolvedValue([
      { key: canonical },
      { key: alias },
    ]);

    await gateway.refreshSessionKeyCache([{ name: 'test', sessionKey: canonical }]);

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect((gateway as any).sessionKeyCache.has(canonical)).toBe(false);
  });

  it('mirrors injects to sibling alias sessions', async () => {
    const gateway = new GatewaySync();
    const canonical = GatewaySync.sessionKeyForChannel('55555');
    const agentId = canonical.split(':')[1]!;
    const alias1 = `agent:${agentId}:openai-user:${canonical}`;
    const alias2 = `agent:${agentId}:openai-user:${alias1}`;

    (gateway as any).connected = true;
    vi.spyOn(gateway, 'listSessions').mockResolvedValue([
      { key: canonical },
      { key: alias1 },
      { key: alias2 },
    ]);

    const rpcSpy = vi.spyOn(gateway as any, 'rpc').mockResolvedValue({ messageId: 'm1' });

    const mirrored = await gateway.mirrorInjectToSessionFamily(canonical, 'hello', 'discord-user', {
      excludeSessionKeys: [canonical],
    });

    expect(mirrored).toBe(2);
    expect(rpcSpy).toHaveBeenCalledTimes(2);
    expect(rpcSpy).toHaveBeenNthCalledWith(
      1,
      'chat.inject',
      expect.objectContaining({ sessionKey: alias1, message: 'hello', label: 'discord-user' }),
    );
    expect(rpcSpy).toHaveBeenNthCalledWith(
      2,
      'chat.inject',
      expect.objectContaining({ sessionKey: alias2, message: 'hello', label: 'discord-user' }),
    );
  });
});
