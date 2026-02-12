import { randomUUID } from 'node:crypto';
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

const RPC_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;

export class GatewaySync {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private connected = false;
  private destroyed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsUrl: string;

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
  }

  async connect(): Promise<void> {
    if (this.destroyed) return;
    return this.doConnect();
  }

  destroy(): void {
    this.destroyed = true;
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
            this.send({
              type: 'req',
              id: connectId,
              method: 'connect',
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                scopes: ['operator.admin'],
                client: { id: 'gateway-client', mode: 'backend', version: '1.0.0', platform: 'node' },
                auth: { token: config.gatewayToken },
              },
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
