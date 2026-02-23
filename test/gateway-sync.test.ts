import { describe, it, expect, vi } from 'vitest';
import { GatewaySync } from '../src/services/gateway-sync.js';

describe('GatewaySync', () => {
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
});
