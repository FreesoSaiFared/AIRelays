type PairRecord = {
  code: string;
  deviceId: string;
  deviceSecret: string;
  label: string;
  ownerPrincipal: string;
  workerUrl: string;
  createdAt: number;
  expiresAt: number;
};

type Env = { DEVICE_HUB: any };

const PAIRING_PROTOCOL = 'TRANSDUCTIVE_DEVICE_PAIRING/1';
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIR_CODE_CHARS = 12; // 60 bits from a 32-symbol alphabet.
const PAIR_CODE_TTL_MS = 10 * 60_000;

function randomCode(): string {
  const bytes = new Uint8Array(PAIR_CODE_CHARS);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += PAIR_CODE_ALPHABET[byte & 31];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export class PairingHub {
  state: any;
  env: Env;

  constructor(state: any, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/start') && request.method === 'POST') return this.start(request);
    if (url.pathname.endsWith('/claim') && request.method === 'POST') return this.claim(request);
    return new Response('not found', { status: 404 });
  }

  async start(request: Request): Promise<Response> {
    const body = await request.json() as any;
    const ownerPrincipal = String(body?.ownerPrincipal || '');
    const workerUrl = String(body?.workerUrl || '');
    const label = String(body?.label || 'Windows PC').slice(0, 120);
    if (!ownerPrincipal || !workerUrl.startsWith('https://')) {
      return Response.json({ error: 'INVALID_PAIR_REQUEST' }, { status: 400 });
    }

    const deviceId = `dev-${crypto.randomUUID()}`;
    let code = randomCode();
    for (let i = 0; i < 6 && await this.state.storage.get(`pair:${code}`); i++) code = randomCode();
    if (await this.state.storage.get(`pair:${code}`)) {
      return Response.json({ error: 'PAIR_CODE_ALLOCATION_FAILED' }, { status: 503 });
    }

    const now = Date.now();
    const rec: PairRecord = {
      code,
      deviceId,
      deviceSecret: randomSecret(),
      label,
      ownerPrincipal,
      workerUrl,
      createdAt: now,
      expiresAt: now + PAIR_CODE_TTL_MS,
    };
    await this.state.storage.put(`pair:${code}`, rec, { expirationTtl: 15 * 60 });
    return Response.json({
      protocol: PAIRING_PROTOCOL,
      code,
      deviceId,
      label,
      expiresAt: rec.expiresAt,
    });
  }

  async claim(request: Request): Promise<Response> {
    const body = await request.json() as any;
    const code = String(body?.code || '').trim().toUpperCase();
    if (!code) return Response.json({ error: 'PAIR_CODE_REQUIRED' }, { status: 400 });

    const key = `pair:${code}`;
    const rec = await this.state.storage.get(key) as PairRecord | undefined;
    if (!rec || rec.expiresAt < Date.now()) {
      if (rec) await this.state.storage.delete(key);
      return Response.json({ error: 'PAIR_CODE_INVALID_OR_EXPIRED' }, { status: 404 });
    }

    // Consume before configuration so the human-visible code is one-shot even if
    // downstream device configuration fails. A new pairing session is then required.
    await this.state.storage.delete(key);
    const id = this.env.DEVICE_HUB.idFromName(rec.deviceId);
    const stub = this.env.DEVICE_HUB.get(id);
    const configured = await stub.fetch('https://device-hub.internal/configure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: rec.deviceId, deviceSecret: rec.deviceSecret }),
    });
    if (!configured.ok) {
      return Response.json({ error: 'DEVICE_CONFIGURATION_FAILED' }, { status: 502 });
    }

    return Response.json({
      protocol: PAIRING_PROTOCOL,
      workerUrl: rec.workerUrl,
      deviceId: rec.deviceId,
      deviceSecret: rec.deviceSecret,
      ownerPrincipal: rec.ownerPrincipal,
      label: rec.label,
    });
  }
}
