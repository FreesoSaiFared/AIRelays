#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(HERE, "session-farm.config.json");
const DAEMON = path.join(HERE, "session-farm.mjs");
const SERVER_NAME = "airelays-session-farm";
const SERVER_VERSION = "0.1.0";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readConfig(configPath) {
  return JSON.parse(await fsp.readFile(configPath, "utf8"));
}

async function daemonOrigin(configPath) {
  const config = await readConfig(configPath);
  const host = config.listen?.host || "127.0.0.1";
  const port = Number(config.listen?.port || 39817);
  return `http://${host}:${port}`;
}

async function api(configPath, pathname, { method = "GET", body = null, timeoutMs = 10000 } = {}) {
  const origin = await daemonOrigin(configPath);
  const options = {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {},
  };
  if (body != null) {
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${origin}${pathname}`, options);
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { ok: false, raw: text }; }
  if (!response.ok) throw new Error(`session-farm API ${pathname} failed: HTTP ${response.status}: ${text}`);
  return payload;
}

async function isHealthy(configPath) {
  try {
    const result = await api(configPath, "/healthz", { timeoutMs: 1200 });
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

async function startDaemon(configPath) {
  if (await isHealthy(configPath)) return { ok: true, alreadyRunning: true, configPath };
  await fsp.access(configPath);
  const child = spawn(process.execPath, [DAEMON, "--config", configPath], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    cwd: HERE,
    env: { ...process.env, AIRELAYS_SESSION_FARM_CONFIG: configPath },
  });
  child.unref();
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await isHealthy(configPath)) return { ok: true, alreadyRunning: false, pid: child.pid, configPath };
    await sleep(250);
  }
  throw new Error(`session-farm daemon did not become healthy; launcher pid=${child.pid}`);
}

const TOOLS = [
  {
    name: "farm_start",
    description: "Start the persistent Windows session-farm daemon for six ChatGPT worker tabs plus one orchestrator tab. The daemon continues independently of the MCP client.",
    inputSchema: {
      type: "object",
      properties: { configPath: { type: "string", description: "Absolute path to session-farm.config.json" } },
      additionalProperties: false,
    },
  },
  {
    name: "farm_status",
    description: "Return verified binding, readiness, marker, continuation, guard, and orchestrator state for all six workers and the orchestrator.",
    inputSchema: { type: "object", properties: { configPath: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "farm_tick",
    description: "Force one complete supervision cycle: process guard, tab discovery, probes, orchestrator controls, worker continuation, and orchestrator heartbeat.",
    inputSchema: { type: "object", properties: { configPath: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "farm_continue",
    description: "Submit one continuation to a ready worker. Prompt defaults to the farm continuation prompt, normally just 'continue'.",
    inputSchema: {
      type: "object",
      required: ["worker"],
      properties: {
        configPath: { type: "string" },
        worker: { type: "string", enum: ["w1", "w2", "w3", "w4", "w5", "w6"] },
        prompt: { type: "string", description: "Optional override; omit for generic continuation." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "farm_pause",
    description: "Pause automatic continuation for one worker without closing its tab.",
    inputSchema: {
      type: "object",
      required: ["worker"],
      properties: { configPath: { type: "string" }, worker: { type: "string", enum: ["w1", "w2", "w3", "w4", "w5", "w6"] } },
      additionalProperties: false,
    },
  },
  {
    name: "farm_resume",
    description: "Resume automatic continuation for one paused worker.",
    inputSchema: {
      type: "object",
      required: ["worker"],
      properties: { configPath: { type: "string" }, worker: { type: "string", enum: ["w1", "w2", "w3", "w4", "w5", "w6"] } },
      additionalProperties: false,
    },
  },
  {
    name: "farm_bind",
    description: "Bind a worker or orchestrator slot to a specific ChatGPT tab URL. This persists in the daemon state and survives target-id changes.",
    inputSchema: {
      type: "object",
      required: ["slot", "url"],
      properties: { configPath: { type: "string" }, slot: { type: "string" }, url: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "farm_guard",
    description: "Run the Windows interference-process guard immediately and return exact processes considered and terminated.",
    inputSchema: { type: "object", properties: { configPath: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "farm_stop",
    description: "Stop the persistent session-farm daemon cleanly. Worker browser tabs are left open.",
    inputSchema: { type: "object", properties: { configPath: { type: "string" } }, additionalProperties: false },
  },
];

function configPathFrom(args = {}) {
  return path.resolve(args.configPath || process.env.AIRELAYS_SESSION_FARM_CONFIG || DEFAULT_CONFIG);
}

async function callTool(name, args = {}) {
  const configPath = configPathFrom(args);
  switch (name) {
    case "farm_start":
      return startDaemon(configPath);
    case "farm_status":
      return api(configPath, "/status");
    case "farm_tick":
      return api(configPath, "/tick", { method: "POST", body: {} });
    case "farm_continue":
      return api(configPath, "/continue", { method: "POST", body: { worker: args.worker, ...(args.prompt == null ? {} : { prompt: args.prompt }) } });
    case "farm_pause":
      return api(configPath, "/pause", { method: "POST", body: { worker: args.worker } });
    case "farm_resume":
      return api(configPath, "/resume", { method: "POST", body: { worker: args.worker } });
    case "farm_bind":
      return api(configPath, "/bind", { method: "POST", body: { slot: args.slot, url: args.url } });
    case "farm_guard":
      return api(configPath, "/guard", { method: "POST", body: {} });
    case "farm_stop":
      return api(configPath, "/shutdown", { method: "POST", body: {} });
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function resultEnvelope(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: Boolean(value && value.ok === false && !value.skipped),
  };
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  const { id, method, params = {} } = message;
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;
  if (method === "initialize") {
    return emit({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: "Control a persistent six-worker ChatGPT session farm. Ordinary continuation is generic and external: workers define their own next turn and end with the configured continuation marker; the daemon injects only the continuation prompt. The orchestrator receives compact status packets and intervenes only when needed. Browser extensions are not used.",
      },
    });
  }
  if (method === "ping") return emit({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return emit({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    try {
      const value = await callTool(params.name, params.arguments || {});
      return emit({ jsonrpc: "2.0", id, result: resultEnvelope(value) });
    } catch (error) {
      const value = { ok: false, error: String(error?.stack || error?.message || error) };
      return emit({ jsonrpc: "2.0", id, result: resultEnvelope(value) });
    }
  }
  if (id != null) emit({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line);
    void handle(message);
  } catch (error) {
    emit({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(error?.message || error) } });
  }
});
