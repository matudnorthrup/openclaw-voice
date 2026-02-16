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

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

const RPC_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;

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
  }

  isConnected(): boolean {
    return this.connected;
  }

  getConnectionState(): 'connected' | 'reconnecting' | 'disconnected' {
    if (this.connected) return 'connected';
    if (this.reconnectTimer !== null) return 'reconnecting';
    return 'disconnected';
  }

  async inject(sessionKey: string, message: string, label?: string): Promise<{ messageId: string } | null> {
    try {
      const params: any = { sessionKey, message };
      if (label) params.label = label;
      const result = await this.rpc('chat.inject', params);
      return result;
    } catch (err: any) {
      console.warn(`GatewaySync inject failed: ${err.message}`);
      return null;
    }
  }

  async getHistory(sessionKey: string, limit?: number): Promise<{ messages: ChatMessage[] } | null> {
    try {
      const params: any = { sessionKey };
      if (limit !== undefined) params.limit = limit;
      const result = await this.rpc('chat.history', params);
      return result;
    } catch (err: any) {
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
                this.connected = true;
                this.reconnectAttempt = 0;
                this.startPing();
                console.log('Connected to OpenClaw gateway');
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
    if (this.reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
      console.error(`GatewaySync: giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
      return;
    }

    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt - 1), RECONNECT_CAP_MS);
    console.log(`GatewaySync: reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect().catch((err) => {
        console.warn(`GatewaySync reconnect failed: ${err.message}`);
      });
    }, delay);
  }
}
