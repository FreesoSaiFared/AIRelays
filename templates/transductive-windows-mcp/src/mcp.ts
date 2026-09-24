import { getToolSurface } from './tools.compact.mjs';
import { SESSION_FARM_TOOLS } from './session-farm-tools.mjs';

export const MODERN_PROTOCOL = '2026-07-28';
export const LEGACY_PROTOCOL = '2025-11-25';
export const WINDOWS_SCOPES = ['windows.read', 'windows.write', 'windows.admin'] as const;
export const UPSTREAM_TOOL_COUNT = 144;
export const SESSION_FARM_TOOL_COUNT = SESSION_FARM_TOOLS.length;
export const TOTAL_TOOL_COUNT = UPSTREAM_TOOL_COUNT + SESSION_FARM_TOOL_COUNT;

export type DispatchTool = (name: string, args: Record<string, unknown>, request: Request) => Promise<unknown>;
export type McpAuthorization = {
  scopes: readonly string[];
  principalId?: string;
  clientId?: string;
};

function result(id: unknown, value: unknown): Response {
  return Response.json(
    { jsonrpc: '2.0', id, result: value },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

function error(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
  status = 400,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } },
    { status, headers },
  );
}

function validateModernHeaders(request: Request, body: any): Response | null {
  const version = request.headers.get('MCP-Protocol-Version');
  if (version !== MODERN_PROTOCOL) return null;
  const hm = request.headers.get('Mcp-Method');
  if (!hm || hm !== body.method) {
    return error(body.id ?? null, -32020, 'HeaderMismatch: Mcp-Method', undefined, 400);
  }
  const expectedName = body?.params?.name ?? body?.params?.uri ?? body?.params?.taskId;
  if (expectedName !== undefined) {
    const hn = request.headers.get('Mcp-Name');
    if (!hn || hn !== String(expectedName)) {
      return error(body.id ?? null, -32020, 'HeaderMismatch: Mcp-Name', undefined, 400);
    }
  }
  return null;
}

export function requiredScopeForTool(def: any): typeof WINDOWS_SCOPES[number] {
  if (def?.annotations?.destructiveHint === true) return 'windows.admin';
  if (def?.annotations?.readOnlyHint === true) return 'windows.read';
  return 'windows.write';
}

export function scopeAllows(scopes: readonly string[], required: string): boolean {
  const set = new Set(scopes);
  if (set.has('windows.admin')) return true;
  if (required === 'windows.read') return set.has('windows.read') || set.has('windows.write');
  if (required === 'windows.write') return set.has('windows.write');
  return false;
}

function scopeDenied(request: Request, id: unknown, required: string): Response {
  const origin = new URL(request.url).origin;
  const metadata = `${origin}/.well-known/oauth-protected-resource/mcp`;
  return error(
    id,
    -32003,
    `Insufficient scope: ${required}`,
    { requiredScope: required },
    403,
    {
      'Cache-Control': 'no-store',
      'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${required}", resource_metadata="${metadata}"`,
    },
  );
}

export async function handleMcp(
  request: Request,
  dispatch: DispatchTool,
  auth: McpAuthorization = { scopes: WINDOWS_SCOPES },
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return error(null, -32700, 'Parse error', undefined, 400);
  }

  const upstream = await getToolSurface();
  const tools = [...upstream.tools, ...SESSION_FARM_TOOLS];

  const mismatch = validateModernHeaders(request, body);
  if (mismatch) return mismatch;
  const id = body.id ?? null;
  const method = body.method;

  if (method === 'server/discover') {
    return result(id, {
      protocolVersion: MODERN_PROTOCOL,
      serverInfo: { name: 'transductive-windows-worker', version: '0.2.0' },
      capabilities: { tools: { listChanged: false } },
    });
  }

  if (method === 'initialize') {
    return result(id, {
      protocolVersion: body?.params?.protocolVersion || LEGACY_PROTOCOL,
      serverInfo: { name: 'transductive-windows-worker', version: '0.2.0' },
      capabilities: { tools: { listChanged: false } },
      instructions: 'User-owned Windows control plane. The paired resident relay exposes the generated Windows tool surface plus fixed-function AIRelays Session Farm controls.',
    });
  }

  if (method === 'notifications/initialized') return new Response(null, { status: 202 });

  if (method === 'tools/list') {
    return result(id, {
      tools: tools.map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
        _meta: { requiredScope: requiredScopeForTool(t) },
      })),
      ttlMs: 86_400_000,
      cacheScope: 'private',
    });
  }

  if (method === 'tools/call') {
    const name = body?.params?.name;
    const args = body?.params?.arguments || {};
    const def = (tools as readonly any[]).find(t => t.name === name);
    if (!def) return error(id, -32602, `Unknown tool: ${name}`, undefined, 404);

    const requiredScope = requiredScopeForTool(def);
    if (!scopeAllows(auth.scopes, requiredScope)) return scopeDenied(request, id, requiredScope);

    try {
      const value = await dispatch(name, args, request);
      const structuredContent = value && typeof value === 'object' ? value : { value };
      return result(id, {
        content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
        structuredContent,
        isError: false,
      });
    } catch (e: any) {
      const msg = String(e?.message || e);
      return result(id, {
        content: [{ type: 'text', text: msg }],
        structuredContent: { error: msg },
        isError: true,
      });
    }
  }

  return error(id, -32601, `Method not found: ${method}`, undefined, 404);
}
