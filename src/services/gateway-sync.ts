import { randomUUID, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { config } from '../config.js';

interface RpcResponse {
  type: 'res';
  id: string;
  ok?: boolean;
  payload?: any;
  result?: any;
  error?: { code: number; message: string };
}

interface RpcEvent {
  type: 'event';
  event: string;
  payload?: any;
}

type WsMessage = RpcResponse | RpcEvent;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  label?: string;
}

interface QueuedInject {
  sessionKey: string;
  message: string;
  label?: string;
  enqueuedAt: number;
}

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

const RPC_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
const INJECT_QUEUE_MAX = 200;
const INJECT_QUEUE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const OPENCLAW_STATE_DIR = join(homedir(), '.openclaw');
const DEVICE_IDENTITY_PATH = join(OPENCLAW_STATE_DIR, 'identity', 'device.json');

const ROLE = 'operator';
const SCOPES = ['operator.read', 'operator.write', 'operator.admin'];
const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function publicKeyRawBase64Url(publicKeyPem: string): string {
  // Extract raw 32-byte Ed25519 public key from PEM (last 32 bytes of DER)
  const der = Buffer.from(
    publicKeyPem.replace(/-----BEGIN PUBLIC KEY-----/g, '').replace(/-----END PUBLIC KEY-----/g, '').replace(/\s/g, ''),
    'base64',
  );
  // Ed25519 SPKI is 44 bytes: 12-byte header + 32-byte key
  const raw = der.subarray(der.length - 32);
  return base64UrlEncode(raw);
}

function loadDeviceIdentity(): DeviceIdentity | null {
  try {
    if (!existsSync(DEVICE_IDENTITY_PATH)) return null;
    const parsed = JSON.parse(readFileSync(DEVICE_IDENTITY_PATH, 'utf8'));
    if (parsed?.version === 1 && parsed.deviceId && parsed.publicKeyPem && parsed.privateKeyPem) {
      return { deviceId: parsed.deviceId, publicKeyPem: parsed.publicKeyPem, privateKeyPem: parsed.privateKeyPem };
    }
    return null;
  } catch {
    return null;
  }
}

function buildSignedDevice(identity: DeviceIdentity, token: string, nonce: string | undefined) {
  const signedAtMs = Date.now();
  const version = nonce ? 'v2' : 'v1';
  const scopeStr = SCOPES.join(',');
  const parts = [version, identity.deviceId, CLIENT_ID, CLIENT_MODE, ROLE, scopeStr, String(signedAtMs), token];
  if (version === 'v2') parts.push(nonce ?? '');
  const payload = parts.join('|');

  const key = createPrivateKey(identity.privateKeyPem);
  const signature = base64UrlEncode(sign(null, Buffer.from(payload, 'utf8'), key));

  return {
    device: {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64Url(identity.publicKeyPem),
      signature,
      signedAt: signedAtMs,
      nonce,
    },
  };
}

const PING_INTERVAL_MS = 25_000;

export class GatewaySync {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private connected = false;
  private destroyed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private wsUrl: string;
  private deviceIdentity: DeviceIdentity | null;
  private injectQueue: QueuedInject[] = [];
  private reconnectCallbacks: Array<() => void | Promise<void>> = [];

  static get defaultSessionKey(): string {
    return `agent:${config.gatewayAgentId}:main`;
  }

  static sessionKeyForChannel(channelId: string): string {
    return `agent:${config.gatewayAgentId}:discord:channel:${channelId}`;
  }

  constructor() {
    // Derive WebSocket URL from gatewayUrl (http → ws)
    const base = config.gatewayUrl.replace(/^http/, 'ws');
    this.wsUrl = base;
    this.deviceIdentity = loadDeviceIdentity();
    if (this.deviceIdentity) {
      console.log(`Loaded OpenClaw device identity: ${this.deviceIdentity.deviceId.slice(0, 8)}...`);
    } else {
      console.warn('No OpenClaw device identity found; scopes may be limited');
    }
  }

  async connect(): Promise<void> {
    if (this.destroyed) return;
    return this.doConnect();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopPing();
    this.stopCacheRefresh();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Reject all pending requests
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('GatewaySync destroyed'));
      this.pending.delete(id);
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.injectQueue = [];
    this.reconnectCallbacks = [];
  }

  isConnected(): boolean {
    return this.connected;
  }

  getConnectionState(): 'connected' | 'reconnecting' | 'disconnected' {
    if (this.connected) return 'connected';
    if (this.reconnectTimer !== null) return 'reconnecting';
    return 'disconnected';
  }

  // Cache resolved session keys: channelId → actual gateway session key
  private sessionKeyCache = new Map<string, string>();
  // Track which session keys we've already attempted discovery for (avoid repeating)
  private sessionDiscoveryAttempted = new Set<string>();
  // Periodic cache refresh interval
  private cacheRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private static CACHE_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Return the resolved session key for a given key (from discovery cache).
   * Used by callers that bypass GatewaySync for HTTP calls (e.g. getResponse).
   */
  getResolvedSessionKey(sessionKey: string): string {
    return this.sessionKeyCache.get(sessionKey) ?? sessionKey;
  }

  /**
   * Proactively discover session keys for all known channel IDs.
   * Call once after connect, then runs periodically to handle session restarts.
   */
  async refreshSessionKeyCache(channelSessionKeys: { name: string; sessionKey: string }[]): Promise<void> {
    try {
      const sessions = await this.listSessions();
      if (!sessions || sessions.length === 0) return;

      let updated = 0;
      for (const { name, sessionKey } of channelSessionKeys) {
        const channelId = this.extractChannelId(sessionKey);
        if (!channelId) continue;

        // Find shortest matching session key (most canonical)
        const candidates: string[] = [];
        for (const session of sessions) {
          if (session.key.includes(channelId)) candidates.push(session.key);
        }
        if (candidates.length === 0) continue;

        candidates.sort((a, b) => a.length - b.length);
        const best = candidates[0];
        const current = this.sessionKeyCache.get(sessionKey);

        if (best !== sessionKey && best !== current) {
          console.log(`Session cache refresh: ${name} → ${best}`);
          this.sessionKeyCache.set(sessionKey, best);
          this.sessionDiscoveryAttempted.add(sessionKey);
          updated++;
        } else if (best !== sessionKey && !current) {
          this.sessionKeyCache.set(sessionKey, best);
          this.sessionDiscoveryAttempted.add(sessionKey);
          updated++;
        }
      }

      if (updated > 0) {
        console.log(`Session cache refresh: updated ${updated} key(s)`);
      }
    } catch (err: any) {
      console.warn(`Session cache refresh failed: ${err.message}`);
    }
  }

  /**
   * Start periodic cache refresh for known channels.
   */
  startCacheRefresh(channelSessionKeys: { name: string; sessionKey: string }[]): void {
    // Initial warm-up (delayed to allow WS connect)
    setTimeout(() => this.refreshSessionKeyCache(channelSessionKeys), 5000);

    // Periodic refresh
    this.cacheRefreshTimer = setInterval(
      () => this.refreshSessionKeyCache(channelSessionKeys),
      GatewaySync.CACHE_REFRESH_INTERVAL_MS,
    );
  }

  stopCacheRefresh(): void {
    if (this.cacheRefreshTimer) {
      clearInterval(this.cacheRefreshTimer);
      this.cacheRefreshTimer = null;
    }
  }

  getQueueDepth(): number {
    return this.injectQueue.length;
  }

  onReconnect(cb: () => void | Promise<void>): void {
    this.reconnectCallbacks.push(cb);
  }

  clearReconnectCallbacks(): void {
    this.reconnectCallbacks = [];
  }

  private enqueueInject(sessionKey: string, message: string, label?: string): void {
    if (this.injectQueue.length >= INJECT_QUEUE_MAX) {
      this.injectQueue.shift(); // FIFO evict oldest
    }
    this.injectQueue.push({ sessionKey, message, label, enqueuedAt: Date.now() });
    console.log(`Gateway inject queued (depth=${this.injectQueue.length})`);
  }

  private async flushInjectQueue(): Promise<void> {
    const now = Date.now();
    this.injectQueue = this.injectQueue.filter(item => now - item.enqueuedAt < INJECT_QUEUE_TTL_MS);

    const toFlush = [...this.injectQueue];
    this.injectQueue = [];

    if (toFlush.length === 0) return;
    console.log(`Flushing ${toFlush.length} queued inject(s)`);

    for (const item of toFlush) {
      // inject() will re-queue if connection drops mid-flush
      await this.inject(item.sessionKey, item.message, item.label);
    }
  }

  private async onConnectEstablished(): Promise<void> {
    for (const cb of this.reconnectCallbacks) {
      try {
        await cb();
      } catch (err: any) {
        console.warn(`Reconnect callback failed: ${err.message}`);
      }
    }
    await this.flushInjectQueue();
  }

  async inject(sessionKey: string, message: string, label?: string): Promise<{ messageId: string } | null> {
    // If not connected, queue for later delivery
    if (!this.connected) {
      this.enqueueInject(sessionKey, message, label);
      return null;
    }

    // Check if we have a cached alternate session key for this channel
    const resolvedKey = this.sessionKeyCache.get(sessionKey) ?? sessionKey;

    try {
      const params: any = { sessionKey: resolvedKey, message };
      if (label) params.label = label;
      const result = await this.rpc('chat.inject', params);
      return result;
    } catch (err: any) {
      // If session not found, invalidate cache and re-discover
      if (err.message?.includes('session not found')) {
        // Always clear stale cache entry and re-discover
        this.sessionKeyCache.delete(sessionKey);
        this.sessionDiscoveryAttempted.delete(sessionKey);
        const channelId = this.extractChannelId(sessionKey);
        if (channelId) {
          const discovered = await this.discoverSessionForChannel(channelId);
          if (discovered && discovered !== sessionKey && discovered !== resolvedKey) {
            console.log(`Gateway session fallback: ${sessionKey} → ${discovered}`);
            this.sessionKeyCache.set(sessionKey, discovered);
            // Retry with discovered key
            try {
              const params: any = { sessionKey: discovered, message };
              if (label) params.label = label;
              const result = await this.rpc('chat.inject', params);
              return result;
            } catch (retryErr: any) {
              console.warn(`GatewaySync inject failed (retry with ${discovered}): ${retryErr.message}`);
              return null;
            }
          }
        }
      }
      console.warn(`GatewaySync inject failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Given a channel ID, search all gateway sessions for one that references
   * this channel — handles cases where the gateway created a session with
   * a different key format than our standard one.
   */
  async discoverSessionForChannel(channelId: string): Promise<string | null> {
    try {
      const sessions = await this.listSessions();
      if (!sessions) return null;

      // Collect all sessions that reference this channel ID, prefer shortest key
      // (prevents progressive nesting like agent:main:openai-user:agent:main:openai-user:...)
      const candidates: string[] = [];
      for (const session of sessions) {
        if (session.key.includes(channelId)) candidates.push(session.key);
        else if (session.channel && session.channel.includes(channelId)) candidates.push(session.key);
      }

      if (candidates.length === 0) return null;
      // Return the shortest key — the most canonical form
      candidates.sort((a, b) => a.length - b.length);
      return candidates[0];
    } catch (err: any) {
      console.warn(`GatewaySync discoverSessionForChannel failed: ${err.message}`);
      return null;
    }
  }

  private extractChannelId(sessionKey: string): string | null {
    // Extract channel ID from "agent:main:discord:channel:1234567890"
    const match = sessionKey.match(/channel:(\d+)$/);
    return match ? match[1] : null;
  }

  async listSessions(): Promise<{ key: string; displayName?: string; channel?: string; status?: string }[] | null> {
    try {
      const result = await this.rpc('sessions.list', {});
      if (result?.sessions) return result.sessions;
      if (Array.isArray(result)) return result;
      return null;
    } catch (err: any) {
      console.warn(`GatewaySync listSessions failed: ${err.message}`);
      return null;
    }
  }

  async getHistory(sessionKey: string, limit?: number): Promise<{ messages: ChatMessage[] } | null> {
    let resolvedKey = this.sessionKeyCache.get(sessionKey) ?? sessionKey;

    // Proactive session discovery on first access — handles cases where the gateway
    // has split a channel into a new session with a different key.  Without this,
    // getHistory would silently return stale data from the old session.
    if (resolvedKey === sessionKey && !this.sessionDiscoveryAttempted.has(sessionKey)) {
      this.sessionDiscoveryAttempted.add(sessionKey);
      const channelId = this.extractChannelId(sessionKey);
      if (channelId) {
        const discovered = await this.discoverSessionForChannel(channelId);
        if (discovered && discovered !== sessionKey) {
          console.log(`Gateway history discovery: ${sessionKey} → ${discovered}`);
          this.sessionKeyCache.set(sessionKey, discovered);
          resolvedKey = discovered;
        }
      }
    }

    try {
      const params: any = { sessionKey: resolvedKey };
      if (limit !== undefined) params.limit = limit;
      const result = await this.rpc('chat.history', params);
      return result;
    } catch (err: any) {
      // If session not found, invalidate cache and re-discover
      if (err.message?.includes('session not found')) {
        this.sessionKeyCache.delete(sessionKey);
        this.sessionDiscoveryAttempted.delete(sessionKey);
        const channelId = this.extractChannelId(sessionKey);
        if (channelId) {
          const discovered = await this.discoverSessionForChannel(channelId);
          if (discovered && discovered !== sessionKey && discovered !== resolvedKey) {
            console.log(`Gateway history fallback: ${sessionKey} → ${discovered}`);
            this.sessionKeyCache.set(sessionKey, discovered);
            try {
              const params: any = { sessionKey: discovered };
              if (limit !== undefined) params.limit = limit;
              return await this.rpc('chat.history', params);
            } catch (retryErr: any) {
              console.warn(`GatewaySync getHistory failed (retry with ${discovered}): ${retryErr.message}`);
              return null;
            }
          }
        }
      }
      console.warn(`GatewaySync getHistory failed: ${err.message}`);
      return null;
    }
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let connectId: string | null = null;
      let settled = false;

      try {
        const ws = new WebSocket(this.wsUrl);
        this.ws = ws;

        ws.addEventListener('message', (event) => {
          let msg: WsMessage;
          try {
            msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
          } catch {
            return;
          }

          // Handle connect challenge — send connect request
          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            connectId = randomUUID();
            const nonce = (msg as any).payload?.nonce as string | undefined;

            const connectParams: any = {
              minProtocol: 3,
              maxProtocol: 3,
              role: ROLE,
              scopes: SCOPES,
              client: { id: CLIENT_ID, mode: CLIENT_MODE, version: '1.0.0', platform: 'node' },
              auth: { token: config.gatewayToken },
            };

            // Add device identity signing for full scope access
            if (this.deviceIdentity) {
              const { device } = buildSignedDevice(this.deviceIdentity, config.gatewayToken, nonce);
              connectParams.device = device;
            }

            this.send({
              type: 'req',
              id: connectId,
              method: 'connect',
              params: connectParams,
            });
            return;
          }

          // Handle RPC responses
          if (msg.type === 'res') {
            // Check if this is the connect response (hello-ok)
            if (connectId && msg.id === connectId) {
              connectId = null;
              if (msg.ok && msg.payload?.type === 'hello-ok') {
                const isReconnect = this.reconnectAttempt > 0;
                this.connected = true;
                this.reconnectAttempt = 0;
                this.startPing();
                console.log('Connected to OpenClaw gateway');
                if (isReconnect) {
                  this.onConnectEstablished().catch(err => {
                    console.warn(`onConnectEstablished failed: ${err.message}`);
                  });
                }
                if (!settled) { settled = true; resolve(); }
              } else {
                const errMsg = msg.error?.message || 'connect rejected';
                console.error(`OpenClaw gateway connect failed: ${errMsg}`);
                if (!settled) { settled = true; reject(new Error(errMsg)); }
              }
              return;
            }

            // Regular RPC response
            const pending = this.pending.get(msg.id);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(msg.id);
              if (msg.error) {
                pending.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
              } else {
                pending.resolve(msg.ok ? msg.payload : msg.result);
              }
            }
            return;
          }
        });

        ws.addEventListener('close', () => {
          const wasConnected = this.connected;
          this.connected = false;
          this.ws = null;
          this.stopPing();

          // Reject pending requests
          for (const [id, req] of this.pending) {
            clearTimeout(req.timer);
            req.reject(new Error('WebSocket closed'));
            this.pending.delete(id);
          }

          if (!settled) {
            settled = true;
            reject(new Error('WebSocket closed during handshake'));
          }

          if (!this.destroyed) {
            if (wasConnected) {
              console.warn('OpenClaw gateway connection lost, will reconnect...');
            }
            this.scheduleReconnect();
          }
        });

        ws.addEventListener('error', () => {
          // The close event will fire after this — reconnect handled there
        });
      } catch (err) {
        if (!settled) { settled = true; reject(err); }
      }
    });
  }

  private send(data: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private rpc(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.ws) {
        reject(new Error('Not connected'));
        return;
      }

      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, RPC_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: 'req', id, method, params });
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;

    this.reconnectAttempt++;

    const baseDelay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt - 1), RECONNECT_CAP_MS);
    // Add jitter: ±25%
    const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
    const delay = Math.round(baseDelay + jitter);

    if (this.reconnectAttempt <= 10) {
      console.log(`GatewaySync: reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    } else if (this.reconnectAttempt % 10 === 0) {
      console.log(`GatewaySync: still reconnecting (attempt ${this.reconnectAttempt}, queue=${this.injectQueue.length})`);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect().catch((err) => {
        console.warn(`GatewaySync reconnect failed: ${err.message}`);
      });
    }, delay);
  }
}
