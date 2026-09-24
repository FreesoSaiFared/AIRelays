export const DEVICE_PROTOCOL = 'TRANSDUCTIVE_DEVICE_RELAY/1';

const te = new TextEncoder();

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + stable(obj[k])).join(',') + '}';
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export type DeviceEnvelope = {
  protocol: typeof DEVICE_PROTOCOL;
  kind: 'command' | 'result' | 'hello' | 'error';
  deviceId: string;
  opId: string;
  nonce: string;
  ts: number;
  body: unknown;
  sig?: string;
};

export function canonicalUnsigned(env: DeviceEnvelope): string {
  return stable({
    protocol: env.protocol,
    kind: env.kind,
    deviceId: env.deviceId,
    opId: env.opId,
    nonce: env.nonce,
    ts: env.ts,
    body: env.body,
  });
}

export async function signEnvelope(env: DeviceEnvelope, secret: string): Promise<DeviceEnvelope> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, te.encode(canonicalUnsigned(env)));
  return { ...env, sig: hex(sig) };
}

export async function verifyEnvelope(env: DeviceEnvelope, secret: string, now = Date.now(), maxSkewMs = 120_000): Promise<boolean> {
  if (!env || env.protocol !== DEVICE_PROTOCOL || !env.sig) return false;
  if (!Number.isFinite(env.ts) || Math.abs(now - env.ts) > maxSkewMs) return false;
  if (!/^[0-9a-f]{64}$/i.test(env.sig)) return false;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(env.sig.match(/../g)!.map(x => parseInt(x, 16)));
  return crypto.subtle.verify('HMAC', key, sig, te.encode(canonicalUnsigned(env)));
}

export function makeEnvelope(kind: DeviceEnvelope['kind'], deviceId: string, opId: string, body: unknown): DeviceEnvelope {
  return {
    protocol: DEVICE_PROTOCOL,
    kind,
    deviceId,
    opId,
    nonce: crypto.randomUUID(),
    ts: Date.now(),
    body,
  };
}
