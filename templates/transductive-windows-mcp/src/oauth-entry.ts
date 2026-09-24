import {
  AuthorizationError,
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { dispatchToDevice, handleRequest } from './index.ts';
import { handleMcp, WINDOWS_SCOPES } from './mcp.ts';

interface AuthProps {
  principalId: string;
  scopes: string[];
  authenticatedVia: 'setup-token' | 'transductive';
}

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  DEVICE_HUB: any;
  PAIRING_HUB: any;
  OWNER_SETUP_TOKEN: string;
  OWNER_PRINCIPAL_ID: string;
  OWNER_AUTH_MODE?: string;
}

const SUPPORTED_SCOPES = [...WINDOWS_SCOPES];

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch] || ch);
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const aa = new Uint8Array(ah);
  const bb = new Uint8Array(bh);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) diff |= (aa[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

function oauthErrorResponse(error: AuthorizationError): Response {
  if (!error.redirectUri) return new Response(error.description, { status: 400 });
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set('error', error.code);
  redirect.searchParams.set('error_description', error.description);
  if (error.state) redirect.searchParams.set('state', error.state);
  if (error.issuer) redirect.searchParams.set('iss', error.issuer);
  return Response.redirect(redirect, 302);
}

async function parseAuthorization(request: Request, env: Env): Promise<AuthRequest | Response> {
  try {
    return await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) return oauthErrorResponse(error);
    throw error;
  }
}

function consentPage(request: Request, auth: AuthRequest, clientName: string, principalId: string): Response {
  const requested = auth.scope.filter((scope) => SUPPORTED_SCOPES.includes(scope as any));
  const original = new URL(request.url);
  const scopeCards = SUPPORTED_SCOPES.map((scope) => {
    const requestedByClient = requested.includes(scope);
    const label = scope === 'windows.read' ? 'Read' : scope === 'windows.write' ? 'Operate' : 'Admin';
    const detail = scope === 'windows.read'
      ? 'Inspect files, processes, services, system state and screenshots.'
      : scope === 'windows.write'
        ? 'Run commands and make non-destructive changes.'
        : 'Allow tools upstream marks destructive, including deletion and administrative changes.';
    return `<label class="scope ${requestedByClient ? 'requested' : 'not-requested'}"><input type="checkbox" name="scope" value="${scope}" ${requestedByClient ? 'checked' : 'disabled'}><span><b>${label}</b><code>${scope}</code><small>${detail}</small></span></label>`;
  }).join('');

  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Windows MCP</title><style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#111;background:#f3f3ee}*{box-sizing:border-box}body{margin:0}.wrap{max-width:760px;margin:0 auto;padding:48px 20px 72px}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}.hero{font-size:clamp(38px,7vw,66px);letter-spacing:-.055em;line-height:.96;margin:14px 0 20px}.lead{font-size:18px;line-height:1.5;color:#55554d}.panel{background:#fff;border:1px solid #d8d8d0;border-radius:20px;padding:22px;margin-top:24px;box-shadow:0 12px 40px #00000008}.client{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.pill{font-size:12px;background:#ebf7ef;color:#12633b;border-radius:999px;padding:7px 10px;font-weight:800}.scopes{display:grid;gap:10px;margin-top:18px}.scope{display:flex;gap:12px;border:1px solid #deded7;border-radius:14px;padding:14px}.scope input{margin-top:3px}.scope span{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;align-items:baseline}.scope code{font-size:11px;color:#68685f}.scope small{grid-column:1/-1;color:#66665f;line-height:1.4}.not-requested{opacity:.45}.token{width:100%;padding:13px 14px;border:1px solid #c9c9c0;border-radius:12px;font:inherit;margin-top:8px}.actions{display:flex;gap:10px;margin-top:18px}.btn{border:0;border-radius:12px;padding:13px 16px;font:inherit;font-weight:800;cursor:pointer}.primary{background:#111;color:white}.secondary{background:#e7e7e0;color:#222}.fine{font-size:12px;color:#77776f;line-height:1.45;margin-top:14px}</style></head><body><main class="wrap"><div class="eyebrow">Transductive / explicit capability grant</div><h1 class="hero">Let this client control your Windows MCP?</h1><p class="lead">The Worker belongs to you. This screen grants this OAuth client only the Windows capabilities you approve.</p><section class="panel"><div class="client"><div><small>OAuth client</small><h2>${htmlEscape(clientName || auth.clientId)}</h2><code>${htmlEscape(auth.clientId)}</code></div><span class="pill">Owner ${htmlEscape(principalId)}</span></div><form method="post" action="/authorize/complete"><input type="hidden" name="authorization_url" value="${htmlEscape(original.toString())}"><div class="scopes">${scopeCards}</div><label><div style="margin-top:20px;font-weight:750">Owner setup secret</div><input class="token" type="password" name="setup_token" autocomplete="current-password" required></label><div class="actions"><button class="btn primary" type="submit">Authorize selected capabilities</button><button class="btn secondary" type="submit" name="deny" value="1">Deny</button></div><p class="fine">V1 owner authentication uses the deployment setup secret once during authorization. The Transductive cryptographic-principal adapter is a separate upgrade seam; this Worker never auto-approves an OAuth request.</p></form></section></main></body></html>`;
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function authorizeGet(request: Request, env: Env): Promise<Response> {
  if (!env.OWNER_PRINCIPAL_ID || env.OWNER_PRINCIPAL_ID.includes('replace-me')) {
    return new Response('OWNER_PRINCIPAL_ID is not configured', { status: 503 });
  }
  const parsed = await parseAuthorization(request, env);
  if (parsed instanceof Response) return parsed;
  const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
  if (!client) return new Response('Unknown OAuth client', { status: 400 });
  return consentPage(request, parsed, client.clientName || parsed.clientId, env.OWNER_PRINCIPAL_ID);
}

async function authorizeComplete(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const encodedUrl = String(form.get('authorization_url') || '');
  let authorizationUrl: URL;
  try { authorizationUrl = new URL(encodedUrl); } catch { return new Response('Invalid authorization request', { status: 400 }); }
  const here = new URL(request.url);
  if (authorizationUrl.origin !== here.origin || authorizationUrl.pathname !== '/authorize') {
    return new Response('Invalid authorization origin', { status: 400 });
  }

  const parsed = await parseAuthorization(new Request(authorizationUrl.toString()), env);
  if (parsed instanceof Response) return parsed;
  const client = await env.OAUTH_PROVIDER.lookupClient(parsed.clientId);
  if (!client) return new Response('Unknown OAuth client', { status: 400 });

  if (form.get('deny') === '1') {
    const redirect = new URL(parsed.redirectUri);
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('state', parsed.state);
    if (parsed.issuer) redirect.searchParams.set('iss', parsed.issuer);
    return Response.redirect(redirect, 302);
  }

  const supplied = String(form.get('setup_token') || '');
  if (!env.OWNER_SETUP_TOKEN || !await constantTimeEqual(supplied, env.OWNER_SETUP_TOKEN)) {
    return new Response('Owner authentication failed', { status: 401 });
  }

  const selected = form.getAll('scope').map(String);
  const requested = new Set(parsed.scope);
  const granted = selected.filter((scope) => SUPPORTED_SCOPES.includes(scope as any) && requested.has(scope));
  if (!granted.includes('windows.read') && parsed.scope.includes('windows.read')) {
    return new Response('windows.read is required for a useful Windows MCP grant', { status: 400 });
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: parsed,
    userId: env.OWNER_PRINCIPAL_ID,
    metadata: { clientName: client.clientName || parsed.clientId },
    scope: granted,
    props: {
      principalId: env.OWNER_PRINCIPAL_ID,
      scopes: granted,
      authenticatedVia: 'setup-token',
    } satisfies AuthProps,
  });
  return Response.redirect(redirectTo, 302);
}

class McpApiHandler extends WorkerEntrypoint<Env, AuthProps> {
  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    return handleMcp(
      request,
      (name, args, req) => dispatchToDevice(this.env as any, name, args, req),
      { scopes: props.scopes || [], principalId: props.principalId },
    );
  }
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/authorize' && request.method === 'GET') return authorizeGet(request, env);
    if (url.pathname === '/authorize/complete' && request.method === 'POST') return authorizeComplete(request, env);
    return handleRequest(request, env as any);
  },
};

function createOAuthProvider(origin: string): OAuthProvider<Env> {
  const resource = `${origin}/mcp`;
  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: McpApiHandler,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: SUPPORTED_SCOPES,
    resourceMetadata: {
      resource,
      authorization_servers: [origin],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'Transductive Windows MCP',
    },
    clientIdMetadataDocumentEnabled: true,
    allowImplicitFlow: false,
    allowPlainPKCE: false,
  });
}

const oauthHandler: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const origin = new URL(request.url).origin;
    return createOAuthProvider(origin).fetch(request, env, ctx);
  },
};

export default oauthHandler;
