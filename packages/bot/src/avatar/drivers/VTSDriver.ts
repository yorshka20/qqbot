import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DriverAdapter } from './DriverAdapter';
import { DEFAULT_VTS_CONFIG, type VTSConfig, type VTSParameterValue, type VTSRequest, type VTSResponse } from './types';

type PendingEntry = {
  resolve: (r: VTSResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class VTSDriver extends DriverAdapter {
  readonly name = 'VTubeStudio';

  private readonly config: VTSConfig;
  private ws: WebSocket | null = null;
  private connected = false;
  private authenticated = false;
  private authToken: string | null = null;
  private readonly pendingRequests = new Map<string, PendingEntry>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFrameTs = 0;
  private destroyed = false;

  private connectResolve: ((...args: unknown[]) => void) | null = null;

  constructor(config: Partial<VTSConfig> = {}) {
    super();
    this.config = { ...DEFAULT_VTS_CONFIG, ...config };
  }

  async connect(): Promise<void> {
    this.destroyed = false;

    // Try loading cached token
    const tokenPath = this.config.tokenFilePath;
    const file = Bun.file(tokenPath);
    if (await file.exists()) {
      this.authToken = (await file.text()).trim();
    }

    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve as unknown as (...args: unknown[]) => void;

      const host = this.config.host;
      const port = this.config.port;
      this.ws = new WebSocket(`ws://${host}:${port}`);

      this.ws.addEventListener('open', () => {
        this.connected = true;
        this.authenticate().catch((err) => {
          this.emit('error', err);
          reject(err);
        });
      });

      this.ws.addEventListener('message', (ev) => this.handleMessage(ev.data as string));

      this.ws.addEventListener('close', () => this.handleClose());

      this.ws.addEventListener('error', () => {
        this.emit('error', new Error('VTS WebSocket error'));
        reject(new Error('VTS WebSocket error'));
      });
    });
  }

  private async authenticate(): Promise<void> {
    const { pluginName, pluginDeveloper } = this.config;

    if (!this.authToken) {
      // Step 1: request a new token
      const resp = await this.sendRequest('AuthenticationTokenRequest', {
        pluginName,
        pluginDeveloper,
      });
      const token = resp.data.authenticationToken as string | undefined;
      if (!token) throw new Error('VTS token request returned no token');
      this.authToken = token;

      // Persist token to disk
      const dir = dirname(this.config.tokenFilePath);
      await mkdir(dir, { recursive: true });
      await Bun.write(this.config.tokenFilePath, token);
    }

    // Step 2: authenticate with the token
    const resp = await this.sendRequest('AuthenticationRequest', {
      pluginName,
      pluginDeveloper,
      authenticationToken: this.authToken,
    });
    if (resp.data.authenticated !== true) {
      throw new Error(`VTS authentication failed: ${resp.data.reason ?? 'unknown'}`);
    }

    this.authenticated = true;
    this.reconnectAttempts = 0;
    this.emit('connected');
    if (this.connectResolve) {
      this.connectResolve(undefined);
      this.connectResolve = null;
    }
  }

  private sendRequest(messageType: string, data: Record<string, unknown>): Promise<VTSResponse> {
    if (!this.ws || !this.connected) {
      throw new Error('VTS WebSocket not connected');
    }
    const requestID = crypto.randomUUID();
    const req: VTSRequest = {
      apiName: 'VTubeStudioPublicAPI',
      apiVersion: '1.0',
      requestID,
      messageType,
      data,
    };
    this.ws.send(JSON.stringify(req));

    return new Promise<VTSResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestID);
        reject(new Error(`VTS request timeout: ${messageType}`));
      }, 10_000);
      this.pendingRequests.set(requestID, { resolve, reject, timer });
    });
  }

  private handleMessage(raw: string): void {
    let resp: VTSResponse;
    try {
      resp = JSON.parse(raw);
    } catch {
      return;
    }

    const entry = this.pendingRequests.get(resp.requestID);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pendingRequests.delete(resp.requestID);

    if (resp.messageType === 'APIError') {
      entry.reject(new Error(`VTS API error: ${resp.data.message ?? 'unknown'}`));
    } else {
      entry.resolve(resp);
    }
  }

  override async sendFrame(params: Record<string, number>): Promise<void> {
    if (!this.authenticated || !this.ws) return;

    const fps = this.config.throttleFps ?? 30;
    const minInterval = 1000 / fps;
    const now = Date.now();
    if (now - this.lastFrameTs < minInterval) return;
    this.lastFrameTs = now;

    const parameterValues: VTSParameterValue[] = Object.entries(params).map(([id, value]) => ({
      id,
      value,
      weight: 1.0,
    }));

    const req: VTSRequest = {
      apiName: 'VTubeStudioPublicAPI',
      apiVersion: '1.0',
      requestID: crypto.randomUUID(),
      messageType: 'InjectParameterDataRequest',
      data: { faceFound: true, mode: 'set', parameterValues },
    };

    try {
      this.ws.send(JSON.stringify(req));
    } catch (err) {
      this.emit('error', err as Error);
    }
  }

  private handleClose(): void {
    this.connected = false;
    this.authenticated = false;
    this.ws = null;
    this.emit('disconnected');

    for (const [id, entry] of this.pendingRequests) {
      clearTimeout(entry.timer);
      entry.reject(new Error('VTS disconnected'));
      this.pendingRequests.delete(id);
    }

    if (!this.destroyed) {
      const delay = Math.min(30_000, 3000 * 2 ** this.reconnectAttempts);
      this.reconnectAttempts += 1;
      this.reconnectTimer = setTimeout(() => {
        this.connect().catch((err) => this.emit('error', err));
      }, delay);
    }
  }

  override async disconnect(): Promise<void> {
    this.destroyed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const [id, entry] of this.pendingRequests) {
      clearTimeout(entry.timer);
      entry.reject(new Error('VTS driver destroyed'));
      this.pendingRequests.delete(id);
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
    this.authenticated = false;
  }

  override isConnected(): boolean {
    return this.connected && this.authenticated;
  }
}
