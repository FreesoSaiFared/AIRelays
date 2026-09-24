#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const args = { config: process.env.AIRELAYS_SESSION_FARM_CONFIG || "", slot: "", force: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--config") args.config = argv[++i];
    else if (argv[i] === "--slot") args.slot = argv[++i];
    else if (argv[i] === "--force") args.force = true;
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
  }
  return args;
}

function isLoopback(host) {
  return new Set(["127.0.0.1", "localhost", "::1"]).has(String(host || "").toLowerCase());
}

async function readStdin(maxBytes = 100_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`bootstrap prompt exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 8000) });
  if (!response.ok) throw new Error(`${options.label || "request"} failed: HTTP ${response.status}`);
  return response.json();
}

async function evaluate(target, expression, timeoutMs = 12_000) {
  if (!globalThis.WebSocket) throw new Error("Node.js 22+ is required: global WebSocket is unavailable");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const id = Math.floor(Math.random() * 1_000_000_000);
    let finished = false;
    const done = (fn, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      fn(value);
    };
    const timer = setTimeout(() => done(reject, new Error(`CDP Runtime.evaluate timed out after ${timeoutMs} ms`)), timeoutMs);
    ws.addEventListener("open", () => ws.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    })));
    ws.addEventListener("message", (event) => {
      let message; try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== id) return;
      if (message.error) return done(reject, new Error(`CDP error: ${JSON.stringify(message.error)}`));
      if (message.result?.exceptionDetails) return done(reject, new Error(`CDP JS exception: ${message.result.exceptionDetails.text || "unknown"}`));
      done(resolve, message.result?.result?.value);
    });
    ws.addEventListener("error", () => done(reject, new Error("CDP websocket error")));
  });
}

async function inspect(target) {
  return evaluate(target, `(() => {
    const labels = (el) => [el?.getAttribute?.('aria-label'), el?.getAttribute?.('data-testid'), el?.innerText].filter(Boolean).join(' ');
    const buttons = [...document.querySelectorAll('button')];
    const busy = buttons.some((b) => /stop|stop generating|stop streaming/i.test(labels(b)));
    const composer = document.querySelector('textarea') || document.querySelector('[contenteditable="true"][data-lexical-editor="true"]') || document.querySelector('div[contenteditable="true"]');
    const users = [...document.querySelectorAll('[data-message-author-role="user"]')];
    const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    return {
      href: location.href,
      title: document.title,
      busy,
      ready: !!composer && !busy,
      userCount: users.length,
      assistantCount: assistants.length,
      lastUser: users.length ? (users[users.length - 1].innerText || '').slice(-4000) : ''
    };
  })()`);
}

async function submit(target, prompt) {
  const encoded = JSON.stringify(String(prompt));
  return evaluate(target, `(async () => {
    const prompt = ${encoded};
    const labels = (el) => [el?.getAttribute?.('aria-label'), el?.getAttribute?.('data-testid'), el?.innerText].filter(Boolean).join(' ');
    const getComposer = () => document.querySelector('textarea') || document.querySelector('[contenteditable="true"][data-lexical-editor="true"]') || document.querySelector('div[contenteditable="true"]');
    const composerText = (el) => el ? ('value' in el ? String(el.value || '') : String(el.innerText || el.textContent || '')) : '';
    const observe = () => {
      const buttons = [...document.querySelectorAll('button')];
      const busy = buttons.some((b) => /stop|stop generating|stop streaming/i.test(labels(b)));
      const users = [...document.querySelectorAll('[data-message-author-role="user"]')];
      const lastUser = users.length ? (users[users.length - 1].innerText || '') : '';
      const c = getComposer();
      return { busy, userCount: users.length, lastUser, composer: composerText(c) };
    };
    const verify = async (method, beforeUsers) => {
      for (let i = 0; i < 16; i += 1) {
        await new Promise((r) => setTimeout(r, 125));
        const after = observe();
        if (after.userCount > beforeUsers || after.busy || after.lastUser.trim().endsWith(prompt.trim())) {
          return { ok: true, method, verified: true, after: { ...after, lastUser: after.lastUser.slice(-4000) } };
        }
      }
      const after = observe();
      return { ok: false, error: 'submission-not-observed', method, after: { ...after, lastUser: after.lastUser.slice(-4000) } };
    };
    const before = observe();
    const composer = getComposer();
    if (!composer) return { ok: false, error: 'composer-not-found', before };
    if (before.busy) return { ok: false, error: 'session-busy', before };
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(composer, prompt); else composer.value = prompt;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      composer.textContent = '';
      composer.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: prompt }));
      composer.textContent = prompt;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
    }
    await new Promise((r) => setTimeout(r, 120));
    const buttons = [...document.querySelectorAll('button')];
    const send = buttons.find((b) => /send|submit/i.test(labels(b)) && !b.disabled);
    if (send) { send.click(); return verify('button', before.userCount); }
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    return verify('enter', before.userCount);
  })()`, 15_000);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log("Usage: node seed-session.mjs --config <path> --slot <w1..w6|orch> [--force] < prompt.txt");
    return;
  }
  if (!args.config) throw new Error("--config is required");
  const configPath = path.resolve(args.config);
  const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
  const slotIds = new Set([...(config.workers || []).map((w) => String(w.id)), String(config.orchestrator?.id || "")]);
  if (!slotIds.has(String(args.slot || ""))) throw new Error(`unknown slot: ${args.slot || ""}`);
  const prompt = await readStdin();
  if (!prompt) throw new Error("bootstrap prompt is empty");

  const listenHost = String(config.listen?.host || "127.0.0.1");
  if (!isLoopback(listenHost)) throw new Error(`refusing non-loopback farm control host: ${listenHost}`);
  const daemonOrigin = `http://${listenHost}:${Number(config.listen?.port || 39817)}`;
  const status = await fetchJson(`${daemonOrigin}/status`, { label: "farm status" });
  const slot = status?.slots?.[args.slot];
  if (!slot?.targetId) throw new Error(`slot is not bound to a live target: ${args.slot}`);
  if (slot.busy || !slot.ready) throw new Error(`slot is not ready for bootstrap: ${args.slot}`);

  const cdpBase = String(config.cdp?.http || "").replace(/\/$/, "");
  if (!cdpBase) throw new Error("cdp.http is required");
  const cdpUrl = new URL(cdpBase);
  if (!isLoopback(cdpUrl.hostname)) throw new Error(`refusing non-loopback CDP host: ${cdpUrl.hostname}`);
  const targets = await fetchJson(`${cdpBase}/json/list`, { label: "CDP target list" });
  const target = targets.find((row) => row.type === "page" && row.id === slot.targetId && row.webSocketDebuggerUrl);
  if (!target) throw new Error(`CDP target disappeared: ${slot.targetId}`);

  const before = await inspect(target);
  if (!args.force && Number(before?.userCount || 0) > 0) {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: "existing-user-turn",
      slot: args.slot,
      targetId: slot.targetId,
      userCount: before.userCount,
      assistantCount: before.assistantCount,
      href: before.href,
    }));
    return;
  }
  if (before?.busy || !before?.ready) throw new Error(`target became unavailable for bootstrap: ${args.slot}`);
  const result = await submit(target, prompt);
  if (!result?.ok) throw new Error(`bootstrap submission failed: ${JSON.stringify(result)}`);
  console.log(JSON.stringify({
    ok: true,
    skipped: false,
    slot: args.slot,
    targetId: slot.targetId,
    href: before.href,
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    method: result.method,
    verified: Boolean(result.verified),
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.stack || error?.message || error) }));
  process.exit(1);
});
