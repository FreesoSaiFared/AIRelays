import test from "node:test";
import assert from "node:assert/strict";
import { extractFarmControl, hashText, isEligibleContinuation, slotLaunchUrl, validateConfig } from "./session-farm.mjs";

function policy(overrides = {}) {
  return {
    requireMarker: true,
    cooldownMs: 5000,
    maxPerHourPerSession: 90,
    ...overrides,
  };
}

function slot(overrides = {}) {
  return {
    id: "w1",
    role: "worker",
    paused: false,
    targetId: "target-1",
    ready: true,
    busy: false,
    markerPresent: true,
    lastAssistantHash: hashText("finished turn"),
    lastContinuationAssistantHash: "",
    inFlightAssistantHash: "",
    lastContinuationAt: null,
    continuationTimes: [],
    ...overrides,
  };
}

test("requires exactly six workers", () => {
  const config = {
    protocol: "AIR_SESSION_FARM_CONFIG/1",
    listen: { host: "127.0.0.1", port: 39817 },
    cdp: { http: "http://127.0.0.1:9333" },
    workers: Array.from({ length: 6 }, (_, i) => ({ id: `w${i + 1}` })),
    orchestrator: { id: "orch" },
  };
  assert.equal(validateConfig(config), config);
  assert.throws(() => validateConfig({ ...config, workers: config.workers.slice(0, 5) }), /exactly six/);
});

test("slot launch URL prefers explicit launchUrl, then persisted conversation, then full urlIncludes", () => {
  assert.equal(
    slotLaunchUrl(
      { launchUrl: "https://chatgpt.com/c/explicit", urlIncludes: "https://chatgpt.com/c/config" },
      { boundUrl: "https://chatgpt.com/c/state" },
      { newTabUrl: "https://chatgpt.com/" },
    ),
    "https://chatgpt.com/c/explicit",
  );
  assert.equal(
    slotLaunchUrl(
      { urlIncludes: "https://chatgpt.com/c/config" },
      { boundUrl: "https://chatgpt.com/c/state" },
      { newTabUrl: "https://chatgpt.com/" },
    ),
    "https://chatgpt.com/c/state",
  );
  assert.equal(
    slotLaunchUrl(
      { urlIncludes: "https://chatgpt.com/c/config" },
      { boundUrl: "" },
      { newTabUrl: "https://chatgpt.com/" },
    ),
    "https://chatgpt.com/c/config",
  );
});

test("slot launch URL falls back to ChatGPT root", () => {
  assert.equal(slotLaunchUrl({}, {}, {}), "https://chatgpt.com/");
});

test("slot launch URL rejects a non-http explicit launch URL", () => {
  assert.throws(
    () => slotLaunchUrl({ launchUrl: "file:///tmp/nope" }, {}, { newTabUrl: "" }),
    /invalid launch URL/,
  );
});

test("worker continuation is one-shot per assistant output", () => {
  const s = slot();
  assert.deepEqual(isEligibleContinuation(s, policy(), Date.now()), { ok: true, reason: "eligible" });
  s.lastContinuationAssistantHash = s.lastAssistantHash;
  assert.equal(isEligibleContinuation(s, policy(), Date.now()).reason, "already-continued-this-output");
});

test("persisted in-flight claim blocks a duplicate after a send race", () => {
  const s = slot();
  s.inFlightAssistantHash = s.lastAssistantHash;
  assert.equal(isEligibleContinuation(s, policy(), Date.now()).reason, "in-flight");
});

test("a stale in-flight claim for an older output does not block a new output", () => {
  const s = slot({ inFlightAssistantHash: hashText("older turn") });
  assert.deepEqual(isEligibleContinuation(s, policy(), Date.now()), { ok: true, reason: "eligible" });
});

test("marker, busy and pause gates are explicit", () => {
  assert.equal(isEligibleContinuation(slot({ markerPresent: false }), policy(), Date.now()).reason, "marker-absent");
  assert.equal(isEligibleContinuation(slot({ busy: true, ready: false }), policy(), Date.now()).reason, "not-ready");
  assert.equal(isEligibleContinuation(slot({ paused: true }), policy(), Date.now()).reason, "paused");
});

test("hourly cap stops runaway continuation", () => {
  const now = Date.now();
  const s = slot({ continuationTimes: [new Date(now - 1000).toISOString(), new Date(now - 2000).toISOString()] });
  assert.equal(isEligibleContinuation(s, policy({ maxPerHourPerSession: 2 }), now).reason, "hourly-limit");
});

test("cooldown gate prevents rapid repeated continuation", () => {
  const now = Date.now();
  const s = slot({ lastContinuationAt: new Date(now - 1000).toISOString() });
  assert.equal(isEligibleContinuation(s, policy({ cooldownMs: 5000 }), now).reason, "cooldown");
});

test("extractFarmControl parses the last machine control envelope", () => {
  const text = `analysis text\n[[FARM_CONTROL/1]]\n{"actions":[{"worker":"w3","action":"nudge","prompt":"check the invariant"}]}`;
  assert.deepEqual(extractFarmControl(text), {
    actions: [{ worker: "w3", action: "nudge", prompt: "check the invariant" }],
  });
});

test("extractFarmControl tolerates braces inside JSON strings", () => {
  const text = `[[FARM_CONTROL/1]] {"actions":[{"worker":"w1","action":"nudge","prompt":"keep {x} intact"}]}`;
  const parsed = extractFarmControl(text);
  assert.equal(parsed.actions[0].prompt, "keep {x} intact");
});

test("extractFarmControl uses the last envelope in a reply", () => {
  const text = `[[FARM_CONTROL/1]] {"actions":[{"worker":"w1","action":"pause"}]}\nnotes\n[[FARM_CONTROL/1]] {"actions":[]}`;
  assert.deepEqual(extractFarmControl(text), { actions: [] });
});
