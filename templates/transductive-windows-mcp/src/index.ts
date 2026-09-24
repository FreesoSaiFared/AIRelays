import { handleMcp, TOTAL_TOOL_COUNT } from './mcp.ts';
export { DeviceHub } from './device-hub.ts';
export { PairingHub } from './pairing-hub.ts';

type Env = {
  DEVICE_HUB?: any;
  PAIRING_HUB?: any;
  OWNER_SETUP_TOKEN?: string;
  OWNER_PRINCIPAL_ID?: string;
  MCP_BEARER_TOKEN?: string;
  MCP_FIXTURE_SCOPES?: string;
  FIXTURE_DISPATCH?: { dispatch(name: string, args: Record<string, unknown>): Promise<unknown> };
};

function json(data: unknown, status = 200, headers: Record<string,string> = {}) {
  return Response.json(data, { status, headers });
}

function protectedResource(url: URL) {
  const resource = `${url.origin}/mcp`;
  return {
    resource,
    authorization_servers: [url.origin],
    scopes_supported: ['windows.read', 'windows.write', 'windows.admin'],
    bearer_methods_supported: ['header'],
  };
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.MCP_BEARER_TOKEN) return true;
  return request.headers.get('Authorization') === `Bearer ${env.MCP_BEARER_TOKEN}`;
}

function dispatchTimeoutMs(name: string): number {
  if (name === 'farm_deploy') return 300_000;
  if (name.startsWith('farm_')) return 60_000;
  return 25_000;
}

export async function dispatchToDevice(env: Env, name: string, args: Record<string, unknown>, request: Request): Promise<unknown> {
  if (env.FIXTURE_DISPATCH) return env.FIXTURE_DISPATCH.dispatch(name, args);
  const deviceId = request.headers.get('X-Transductive-Device') || 'default';
  if (!env.DEVICE_HUB) throw new Error('DEVICE_HUB_NOT_BOUND');
  const id = env.DEVICE_HUB.idFromName(deviceId);
  const stub = env.DEVICE_HUB.get(id);
  const r = await stub.fetch('https://device-hub.internal/dispatch', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, name, arguments: args, timeoutMs: dispatchTimeoutMs(name) }),
  });
  const data: any = await r.json();
  if (!r.ok || !data.ok) throw new Error(data.error || `DEVICE_DISPATCH_HTTP_${r.status}`);
  return data.result;
}

function home(url: URL): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Transductive Windows MCP</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#111;background:#f5f5f0}body{margin:0}.wrap{max-width:920px;margin:auto;padding:56px 22px}.eyebrow{letter-spacing:.16em;text-transform:uppercase;font-size:12px;font-weight:700}.hero{font-size:clamp(42px,7vw,78px);line-height:.94;letter-spacing:-.055em;margin:16px 0 24px;max-width:780px}.sub{font-size:20px;line-height:1.5;max-width:720px;color:#4a4a43}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin-top:42px}.card{background:#fff;border:1px solid #d9d9d0;border-radius:18px;padding:20px;box-shadow:0 8px 30px #00000008}.n{font-size:12px;font-weight:800;margin-bottom:30px}.ok{display:inline-flex;gap:8px;align-items:center;font-weight:700}.dot{width:9px;height:9px;border-radius:50%;background:#1d9b55}.dim{color:#6a6a62;font-size:14px;line-height:1.45}.footer{margin-top:38px;padding-top:18px;border-top:1px solid #d4d4cc;font-size:13px;color:#686860}</style></head><body><main class="wrap"><div class="eyebrow">Transductive / user-owned infrastructure</div><h1 class="hero">Your Windows MCP.<br>In your Cloudflare account.</h1><p class="sub">A ChatGPT-ready control plane that stays yours. The Worker handles MCP and authorization; a resident Windows relay performs native machine actions and fixed-function Session Farm control over an outbound connection.</p><section class="grid"><div class="card"><div class="n">01 / WORKER</div><div class="ok"><span class="dot"></span> MCP endpoint ready</div><p class="dim">${url.origin}/mcp<br>Modern + legacy protocol compatibility.</p></div><div class="card"><div class="n">02 / WINDOWS</div><strong>Pair a device</strong><p class="dim">Primary route: outbound WSS. Tailscale and one port-mapped listener remain optional recovery planes.</p></div><div class="card"><div class="n">03 / SESSION FARM</div><strong>Six workers + orchestrator</strong><p class="dim">Deploy, inspect, heal and continue the external ChatGPT session farm through the same paired Windows MCP.</p></div></section><div class="footer">TRANSDUCTIVE_WINDOWS_MCP/2 · ${TOTAL_TOOL_COUNT} tools: 144 upstream Windows tools + 11 Session Farm controls</div></main></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/') return home(url);
  if (url.pathname === '/healthz') return json({ status: 'ok', service: 'transductive-windows-worker' });
  if (url.pathname === '/readyz') return json({ status: 'ready', tools: TOTAL_TOOL_COUNT, upstreamTools: 144, sessionFarmTools: 11, deviceHubBound: !!env.DEVICE_HUB || !!env.FIXTURE_DISPATCH });
  if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(protectedResource(url));
  if (url.pathname === '/mcp') {
    if (!isAuthorized(request, env)) {
      return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"` });
    }
    const fixtureScopes = (env.MCP_FIXTURE_SCOPES || 'windows.read windows.write windows.admin').split(/[\s,]+/).filter(Boolean);
    return handleMcp(request, (name,args,req) => dispatchToDevice(env,name,args,req), { scopes: fixtureScopes });
  }
  if (url.pathname === '/agent/pair/start' && request.method === 'POST') {
    if (!env.PAIRING_HUB || !env.DEVICE_HUB) return json({ error: 'PAIRING_NOT_BOUND' }, 503);
    const token = env.OWNER_SETUP_TOKEN;
    if (token && request.headers.get('Authorization') !== `Bearer ${token}`) return json({ error: 'unauthorized' }, 401);
    const body = await request.json() as any;
    const ownerPrincipal = env.OWNER_PRINCIPAL_ID || String(body?.ownerPrincipal || '');
    if (!ownerPrincipal) return json({ error: 'OWNER_PRINCIPAL_NOT_CONFIGURED' }, 400);
    const id = env.PAIRING_HUB.idFromName(ownerPrincipal);
    return env.PAIRING_HUB.get(id).fetch(new Request('https://pairing-hub.internal/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerPrincipal, workerUrl: url.origin, label: body?.label || 'Windows PC' }),
    }));
  }
  if (url.pathname === '/agent/pair/claim' && request.method === 'POST') {
    if (!env.PAIRING_HUB || !env.DEVICE_HUB) return json({ error: 'PAIRING_NOT_BOUND' }, 503);
    const body = await request.json() as any;
    const ownerPrincipal = env.OWNER_PRINCIPAL_ID || String(body?.ownerPrincipal || '');
    if (!ownerPrincipal) return json({ error: 'OWNER_PRINCIPAL_NOT_CONFIGURED' }, 400);
    const id = env.PAIRING_HUB.idFromName(ownerPrincipal);
    return env.PAIRING_HUB.get(id).fetch(new Request('https://pairing-hub.internal/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: body?.code }),
    }));
  }
  if (url.pathname === '/agent/connect') {
    if (!env.DEVICE_HUB) return json({ error: 'DEVICE_HUB_NOT_BOUND' }, 503);
    const deviceId = url.searchParams.get('device') || 'default';
    const id = env.DEVICE_HUB.idFromName(deviceId);
    return env.DEVICE_HUB.get(id).fetch(request);
  }
  if (url.pathname === '/agent/status') {
    if (!env.DEVICE_HUB) return json({ online: false, reason: 'DEVICE_HUB_NOT_BOUND' });
    const deviceId = url.searchParams.get('device') || 'default';
    const id = env.DEVICE_HUB.idFromName(deviceId);
    return env.DEVICE_HUB.get(id).fetch(new Request(`https://device-hub.internal/status`));
  }
  return new Response('Not Found', { status: 404 });
}

export default { fetch: handleRequest };
