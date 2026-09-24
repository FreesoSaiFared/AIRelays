#!/usr/bin/env node
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(HERE, "session-farm.config.json");
const DAEMON = path.join(HERE, "session-farm.mjs");
const DASHBOARD = path.join(HERE, "session-farm-dashboard.html");
const VERSION = "0.1.1";

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function loadConfig(configPath) {
  return JSON.parse(await fsp.readFile(configPath, "utf8"));
}

async function daemonOrigin(configPath) {
  const config = await loadConfig(configPath);
  return `http://${config.listen?.host || "127.0.0.1"}:${Number(config.listen?.port || 39817)}`;
}

async function daemonApi(configPath, pathname, { method = "GET", body = null, timeoutMs = 10000 } = {}) {
  const origin = await daemonOrigin(configPath);
  const options = { method, signal: AbortSignal.timeout(timeoutMs), headers: {} };
  if (body != null) {
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${origin}${pathname}`, options);
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { ok: false, raw: text }; }
  if (!response.ok) throw new Error(`daemon API ${pathname} failed: HTTP ${response.status}: ${text}`);
  return payload;
}

async function healthy(configPath) {
  try { return Boolean((await daemonApi(configPath, "/healthz", { timeoutMs: 1200 }))?.ok); }
  catch { return false; }
}

async function ensureDaemon(configPath) {
  if (await healthy(configPath)) return { ok: true, alreadyRunning: true };
  const child = spawn(process.execPath, [DAEMON, "--config", configPath], {
    cwd: HERE,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, AIRELAYS_SESSION_FARM_CONFIG: configPath },
  });
  child.unref();
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await healthy(configPath)) return { ok: true, alreadyRunning: false, pid: child.pid };
    await sleep(250);
  }
  throw new Error(`session-farm daemon did not become healthy; launcher pid=${child.pid}`);
}

const TOOLS = [
  ["farm_start", "Start the persistent six-worker plus orchestrator session farm.", {}],
  ["farm_status", "Read verified worker/orchestrator readiness, bindings, continuation and guard state.", {}],
  ["farm_tick", "Force one complete supervision cycle.", {}],
  ["farm_continue", "Continue one ready worker; prompt defaults to the generic continuation prompt.", {
    worker: { type: "string", enum: ["w1", "w2", "w3", "w4", "w5", "w6"] },
    prompt: { type: "string" },
  }, ["worker"]],
  ["farm_pause", "Pause automatic continuation for one worker.", {
    worker: { type: "string", enum: ["w1", "w2", "w3", "w4", "w5", "w6"] },
  }, ["worker"]],
  ["farm_resume", "Resume automatic continuation for one worker.", {
    worker: { type: "string", enum: ["w1", "w2", "w3", "w4", "w5", "w6"] },
  }, ["worker"]],
  ["farm_bind", "Bind a worker or orchestrator slot to an exact ChatGPT conversation URL.", {
    slot: { type: "string" }, url: { type: "string" },
  }, ["slot", "url"]],
  ["farm_guard", "Run the Windows interference-process guard immediately.", {}],
  ["farm_stop", "Stop the farm daemon cleanly without closing browser tabs.", {}],
].map(([name, description, properties, required = []]) => ({
  name,
  description,
  inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
}));

async function callTool(configPath, name, args = {}) {
  if (name === "farm_start") return ensureDaemon(configPath);
  await ensureDaemon(configPath);
  switch (name) {
    case "farm_status": return daemonApi(configPath, "/status");
    case "farm_tick": return daemonApi(configPath, "/tick", { method: "POST", body: {} });
    case "farm_continue": return daemonApi(configPath, "/continue", { method: "POST", body: { worker: args.worker, ...(args.prompt == null ? {} : { prompt: args.prompt }) } });
    case "farm_pause": return daemonApi(configPath, "/pause", { method: "POST", body: { worker: args.worker } });
    case "farm_resume": return daemonApi(configPath, "/resume", { method: "POST", body: { worker: args.worker } });
    case "farm_bind": return daemonApi(configPath, "/bind", { method: "POST", body: { slot: args.slot, url: args.url } });
    case "farm_guard": return daemonApi(configPath, "/guard", { method: "POST", body: {} });
    case "farm_stop": return daemonApi(configPath, "/shutdown", { method: "POST", body: {} });
    default: throw new Error(`unknown tool: ${name}`);
  }
}

function jsonRpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function jsonRpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: Boolean(value && value.ok === false && !value.skipped),
  };
}

async function handleRpc(configPath, message) {
  if (!message || message.jsonrpc !== "2.0") return jsonRpcError(message?.id ?? null, -32600, "invalid request");
  const { id, method, params = {} } = message;
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return null;
  if (method === "initialize") return jsonRpcResult(id, {
    protocolVersion: params.protocolVersion || "2025-06-18",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "airelays-session-farm-http", version: VERSION },
    instructions: "Control a persistent six-worker ChatGPT continuation farm. Workers normally define their own next turn and the farm submits only the configured generic continuation prompt. The orchestrator intervenes only when needed. No browser extension is required.",
  });
  if (method === "ping") return jsonRpcResult(id, {});
  if (method === "tools/list") return jsonRpcResult(id, { tools: TOOLS });
  if (method === "tools/call") {
    try { return jsonRpcResult(id, toolResult(await callTool(configPath, params.name, params.arguments || {}))); }
    catch (error) { return jsonRpcResult(id, toolResult({ ok: false, error: String(error?.stack || error?.message || error) })); }
  }
  return id == null ? null : jsonRpcError(id, -32601, `method not found: ${method}`);
}

async function readBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

async function sendDashboard(res) {
  const body = await fsp.readFile(DASHBOARD);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(body.length),
  });
  res.end(body);
}

function parseArgs(argv) {
  const args = {
    config: process.env.AIRELAYS_SESSION_FARM_CONFIG || DEFAULT_CONFIG,
    host: process.env.AIRELAYS_SESSION_FARM_MCP_HOST || "127.0.0.1",
    port: Number(process.env.AIRELAYS_SESSION_FARM_MCP_PORT || 39818),
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--config") args.config = argv[++i];
    else if (argv[i] === "--host") args.host = argv[++i];
    else if (argv[i] === "--port") args.port = Number(argv[++i]);
  }
  return args;
}

async function dashboardApi(configPath, url, req) {
  await ensureDaemon(configPath);
  if (req.method === "GET" && url.pathname === "/api/status") return daemonApi(configPath, "/status");
  if (req.method !== "POST") throw new Error("method-not-allowed");
  const body = JSON.parse((await readBody(req)) || "{}");
  if (url.pathname === "/api/continue") return daemonApi(configPath, "/continue", { method: "POST", body: { worker: body.worker } });
  if (url.pathname === "/api/pause") return daemonApi(configPath, "/pause", { method: "POST", body: { worker: body.worker } });
  if (url.pathname === "/api/resume") return daemonApi(configPath, "/resume", { method: "POST", body: { worker: body.worker } });
  if (url.pathname === "/api/tick") return daemonApi(configPath, "/tick", { method: "POST", body: {} });
  if (url.pathname === "/api/guard") return daemonApi(configPath, "/guard", { method: "POST", body: {} });
  throw new Error("not-found");
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = path.resolve(args.config);
  await fsp.access(configPath);
  await fsp.access(DASHBOARD);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://session-farm-mcp.local");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) return sendDashboard(res);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true, service: "airelays-session-farm-http-mcp", version: VERSION, daemonHealthy: await healthy(configPath) });
      }
      if (url.pathname.startsWith("/api/")) {
        try { return sendJson(res, 200, await dashboardApi(configPath, url, req)); }
        catch (error) {
          const message = String(error?.message || error);
          const status = message === "not-found" ? 404 : message === "method-not-allowed" ? 405 : 500;
          return sendJson(res, status, { ok: false, error: message });
        }
      }
      if (url.pathname !== "/mcp") return sendJson(res, 404, { ok: false, error: "not-found" });
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "POST" });
      const contentType = String(req.headers["content-type"] || "");
      if (!contentType.includes("application/json")) return sendJson(res, 415, { ok: false, error: "application/json required" });
      const parsed = JSON.parse(await readBody(req));
      if (Array.isArray(parsed)) {
        const replies = (await Promise.all(parsed.map((message) => handleRpc(configPath, message)))).filter(Boolean);
        if (!replies.length) { res.writeHead(202); return res.end(); }
        return sendJson(res, 200, replies);
      }
      const reply = await handleRpc(configPath, parsed);
      if (!reply) { res.writeHead(202); return res.end(); }
      return sendJson(res, 200, reply);
    } catch (error) {
      return sendJson(res, 500, jsonRpcError(null, -32603, String(error?.message || error)));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(args.port, args.host, resolve); });
  console.log(JSON.stringify({ event: "started", service: "airelays-session-farm-http-mcp", version: VERSION, pid: process.pid, host: args.host, port: args.port, endpoint: `http://${args.host}:${args.port}/mcp`, dashboard: `http://${args.host}:${args.port}/`, configPath }));
}

main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
