import { makeEnvelope, signEnvelope, verifyEnvelope, type DeviceEnvelope } from './device-protocol.ts';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class DeviceHub {
  state: any;
  env: any;
  pending = new Map<string, Pending>();
  seen = new Set<string>();

  constructor(state: any, env: any) {
    this.state = state;
    this.env = env;
  }

  async secret(): Promise<string> {
    const secret = await this.state.storage.get('deviceSecret');
    if (!secret || typeof secret !== 'string') throw new Error('DEVICE_NOT_PAIRED');
    return secret;
  }

  sockets(): any[] {
    return this.state.getWebSockets ? this.state.getWebSockets() : [];
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/configure') && request.method === 'POST') {
      const body = await request.json() as any;
      if (!body?.deviceId || !body?.deviceSecret) return Response.json({ error: 'INVALID_CONFIGURATION' }, { status: 400 });
      await this.state.storage.put('deviceId', String(body.deviceId));
      await this.state.storage.put('deviceSecret', String(body.deviceSecret));
      await this.state.storage.put('pairedAt', Date.now());
      return Response.json({ ok: true, deviceId: String(body.deviceId) });
    }
    if (url.pathname.endsWith('/connect')) return this.connect(request, url);
    if (url.pathname.endsWith('/status')) {
      const paired = !!(await this.state.storage.get('deviceSecret'));
      return Response.json({ paired, online: this.sockets().length > 0, sockets: this.sockets().length });
    }
    if (url.pathname.endsWith('/dispatch') && request.method === 'POST') {
      const { deviceId, name, arguments: args, timeoutMs = 25_000 } = await request.json() as any;
      try {
        const result = await this.dispatch(deviceId, name, args || {}, timeoutMs);
        return Response.json({ ok: true, result });
      } catch (e: any) {
        return Response.json({ ok: false, error: String(e?.message || e) }, { status: 503 });
      }
    }
    return new Response('not found', { status: 404 });
  }

  async connect(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('upgrade required', { status: 426 });
    const secret = await this.secret();
    const auth = request.headers.get('Authorization') || '';
    if (auth !== `Bearer ${secret}`) return new Response('unauthorized', { status: 401 });
    const configuredId = await this.state.storage.get('deviceId');
    const deviceId = url.searchParams.get('device') || String(configuredId || 'default');
    if (configuredId && deviceId !== configuredId) return new Response('wrong device', { status: 403 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.serializeAttachment?.({ deviceId, connectedAt: Date.now() });
    this.state.acceptWebSocket(server);
    const hello = await signEnvelope(makeEnvelope('hello', deviceId, crypto.randomUUID(), { accepted: true }), secret);
    server.send(JSON.stringify(hello));
    return new Response(null, { status: 101, webSocket: client } as any);
  }

  async dispatch(deviceId: string, name: string, args: unknown, timeoutMs: number): Promise<unknown> {
    const secret = await this.secret();
    const ws = this.sockets().find((s: any) => (s.deserializeAttachment?.()?.deviceId || 'default') === deviceId);
    if (!ws) throw new Error('DEVICE_OFFLINE');
    const opId = crypto.randomUUID();
    const env = await signEnvelope(makeEnvelope('command', deviceId, opId, { name, arguments: args }), secret);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(opId); reject(new Error('DEVICE_TIMEOUT')); }, timeoutMs);
      this.pending.set(opId, { resolve, reject, timer });
      ws.send(JSON.stringify(env));
    });
  }

  async webSocketMessage(ws: any, message: string | ArrayBuffer): Promise<void> {
    let env: DeviceEnvelope;
    try { env = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); }
    catch { return; }
    let secret: string;
    try { secret = await this.secret(); } catch { return; }
    if (!(await verifyEnvelope(env, secret))) return;
    const attachment = ws.deserializeAttachment?.();
    if (attachment?.deviceId && env.deviceId !== attachment.deviceId) return;
    const replayKey = `${env.deviceId}:${env.nonce}`;
    if (this.seen.has(replayKey)) return;
    this.seen.add(replayKey);
    if (this.seen.size > 4096) this.seen = new Set([...this.seen].slice(-2048));
    if (env.kind !== 'result' && env.kind !== 'error') return;
    const p = this.pending.get(env.opId);
    if (!p) return;
    clearTimeout(p.timer); this.pending.delete(env.opId);
    if (env.kind === 'error') p.reject(new Error(String((env.body as any)?.error || 'DEVICE_ERROR')));
    else p.resolve((env.body as any)?.result ?? env.body);
  }

  webSocketClose(_ws: any, _code: number, _reason: string, _clean: boolean): void {}
  webSocketError(_ws: any, _error: unknown): void {}
}
