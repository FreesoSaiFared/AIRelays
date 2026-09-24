#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROTOCOL = "AIR_SESSION_FARM_STATE/1";
const VERSION = "0.1.1";
const DEFAULT_CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), "session-farm.config.json");

export function hashText(text = "") {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function asArray(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function tail(text, chars) { const s = String(text || ""); return s.length <= chars ? s : s.slice(-chars); }
function ensureDirSync(dir) { fs.mkdirSync(dir, { recursive: true }); }

async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return clone(fallback); throw error; }
}

export function validateConfig(config) {
  if (!config || config.protocol !== "AIR_SESSION_FARM_CONFIG/1") throw new Error("config.protocol must be AIR_SESSION_FARM_CONFIG/1");
  if (!Array.isArray(config.workers) || config.workers.length !== 6) throw new Error("session farm requires exactly six worker slots");
  const ids = config.workers.map((w) => String(w.id || "").trim());
  if (ids.some((id) => !id)) throw new Error("every worker needs a non-empty id");
  if (new Set(ids).size !== ids.length) throw new Error("worker ids must be unique");
  if (!config.orchestrator?.id) throw new Error("orchestrator.id is required");
  if (ids.includes(config.orchestrator.id)) throw new Error("orchestrator id must differ from worker ids");
  if (!config.cdp?.http) throw new Error("cdp.http is required");
  if (!config.listen?.host || !config.listen?.port) throw new Error("listen.host and listen.port are required");
  return config;
}

export async function loadConfig(configPath = DEFAULT_CONFIG) {
  return validateConfig(JSON.parse(await fsp.readFile(configPath, "utf8")));
}

function workerState(worker) {
  return {
    id: worker.id, role: "worker", paused: false,
    boundUrl: worker.urlIncludes || "", targetId: null, title: "", status: "unbound",
    ready: false, busy: false, markerPresent: false,
    lastAssistant: "", lastAssistantHash: "", lastProbeAt: null, lastError: null,
    lastContinuationAssistantHash: "", lastContinuationAt: null, continuationTimes: [],
    inFlightAssistantHash: "", inFlightStartedAt: null,
  };
}

function orchestratorState(orch) {
  return {
    id: orch.id, role: "orchestrator", paused: false,
    boundUrl: orch.urlIncludes || "", targetId: null, title: "", status: "unbound",
    ready: false, busy: false, markerPresent: false,
    lastAssistant: "", lastAssistantHash: "", lastProbeAt: null, lastError: null,
    lastControlAppliedHash: "",
    controlProgress: { hash: "", done: [] },
  };
}

function defaultState(config) {
  const slots = Object.fromEntries(config.workers.map((w) => [w.id, workerState(w)]));
  slots[config.orchestrator.id] = orchestratorState(config.orchestrator);
  return {
    protocol: PROTOCOL, version: VERSION, createdAt: nowIso(), updatedAt: nowIso(), running: true,
    slots, lastTickAt: null, lastGuardAt: null, lastGuardResult: null,
    lastOrchestratorHeartbeatAt: null, lastOrchestratorSnapshotHash: "", events: [],
  };
}

export function isEligibleContinuation(slot, policy, nowMs = Date.now()) {
  if (!slot || slot.role !== "worker") return { ok: false, reason: "not-worker" };
  if (slot.paused) return { ok: false, reason: "paused" };
  if (!slot.targetId) return { ok: false, reason: "unbound" };
  if (!slot.ready || slot.busy) return { ok: false, reason: "not-ready" };
  if (policy.requireMarker && !slot.markerPresent) return { ok: false, reason: "marker-absent" };
  if (!slot.lastAssistantHash) return { ok: false, reason: "no-assistant-output" };
  if (slot.inFlightAssistantHash === slot.lastAssistantHash) return { ok: false, reason: "in-flight" };
  if (slot.lastContinuationAssistantHash === slot.lastAssistantHash) return { ok: false, reason: "already-continued-this-output" };
  if (slot.lastContinuationAt) {
    const age = nowMs - Date.parse(slot.lastContinuationAt);
    if (Number.isFinite(age) && age < policy.cooldownMs) return { ok: false, reason: "cooldown" };
  }
  const cutoff = nowMs - 60 * 60 * 1000;
  const recent = asArray(slot.continuationTimes).filter((t) => Date.parse(t) >= cutoff);
  if (recent.length >= policy.maxPerHourPerSession) return { ok: false, reason: "hourly-limit" };
  return { ok: true, reason: "eligible" };
}

export function extractFarmControl(text, marker = "[[FARM_CONTROL/1]]") {
  const source = String(text || "");
  const markerIndex = source.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const rest = source.slice(markerIndex + marker.length).trim();
  const start = rest.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < rest.length; i += 1) {
    const ch = rest[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) {
      try { const obj = JSON.parse(rest.slice(start, i + 1)); return obj && typeof obj === "object" ? obj : null; }
      catch { return null; }
    }
  }
  return null;
}

class CdpClient {
  constructor(baseHttp) { this.baseHttp = String(baseHttp).replace(/\/$/, ""); }

  async targets() {
    const response = await fetch(`${this.baseHttp}/json/list`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status}`);
    return (await response.json()).filter((row) => row.type === "page" && row.webSocketDebuggerUrl);
  }

  async evaluate(target, expression, timeoutMs = 8000) {
    if (!globalThis.WebSocket) throw new Error("Node.js 22+ is required: global WebSocket is unavailable");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      const requestId = Math.floor(Math.random() * 1_000_000_000);
      let finished = false;
      const finish = (fn, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error(`CDP Runtime.evaluate timed out after ${timeoutMs} ms`)), timeoutMs);
      ws.addEventListener("open", () => ws.send(JSON.stringify({
        id: requestId, method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      })));
      ws.addEventListener("message", (event) => {
        let msg; try { msg = JSON.parse(String(event.data)); } catch { return; }
        if (msg.id !== requestId) return;
        if (msg.error) return finish(reject, new Error(`CDP error: ${JSON.stringify(msg.error)}`));
        if (msg.result?.exceptionDetails) return finish(reject, new Error(`CDP JS exception: ${msg.result.exceptionDetails.text || "unknown"}`));
        finish(resolve, msg.result?.result?.value);
      });
      ws.addEventListener("error", () => finish(reject, new Error("CDP websocket error")));
    });
  }

  async probe(target) {
    return this.evaluate(target, `(() => {
      const labels = (el) => [el?.getAttribute?.('aria-label'), el?.getAttribute?.('data-testid'), el?.innerText].filter(Boolean).join(' ');
      const buttons = [...document.querySelectorAll('button')];
      const busy = buttons.some((b) => /stop|stop generating|stop streaming/i.test(labels(b)));
      const composer = document.querySelector('textarea') || document.querySelector('[contenteditable="true"][data-lexical-editor="true"]') || document.querySelector('div[contenteditable="true"]');
      const assistant = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      const lastAssistant = assistant.length ? (assistant[assistant.length - 1].innerText || '') : '';
      return {href:location.href,title:document.title,busy,ready:!!composer&&!busy,composerPresent:!!composer,lastAssistant:lastAssistant.slice(-16000)};
    })()`);
  }

  async submit(target, prompt) {
    const encoded = JSON.stringify(String(prompt));
    return this.evaluate(target, `(async () => {
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
        return {busy,lastUser,composer:composerText(c)};
      };
      const verify = async (method) => {
        for (let i=0;i<8;i+=1) {
          await new Promise((r)=>setTimeout(r,125));
          const after = observe();
          if (after.busy || after.composer.trim()==='' || after.lastUser.trim().endsWith(prompt.trim())) return {ok:true,method,verified:true,after};
        }
        return {ok:false,error:'submission-not-observed',method,after:observe()};
      };
      const composer = getComposer();
      if (!composer) return {ok:false,error:'composer-not-found'};
      composer.focus();
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto,'value')?.set;
        if (setter) setter.call(composer,prompt); else composer.value=prompt;
        composer.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:prompt}));
        composer.dispatchEvent(new Event('change',{bubbles:true}));
      } else {
        composer.textContent='';
        composer.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,inputType:'insertText',data:prompt}));
        composer.textContent=prompt;
        composer.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:prompt}));
      }
      await new Promise((r)=>setTimeout(r,120));
      const buttons=[...document.querySelectorAll('button')];
      const send=buttons.find((b)=>/send|submit/i.test(labels(b))&&!b.disabled);
      if (send) { send.click(); return verify('button'); }
      composer.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));
      composer.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));
      return verify('enter');
    })()`, 12000);
  }
}

class SessionFarm {
  constructor(config, configPath) {
    this.config = config;
    this.configPath = path.resolve(configPath);
    this.statePath = path.resolve(config.stateFile || path.join(path.dirname(this.configPath), "session-farm.state.json"));
    this.state = null;
    this.cdp = new CdpClient(config.cdp.http);
    this.targetsById = new Map();
    this.slotLocks = new Map();
    this.tickInFlight = false;
    this.stopping = false;
    this.lastGuardMs = 0;
  }

  async init() {
    this.state = await readJson(this.statePath, defaultState(this.config));
    if (this.state.protocol !== PROTOCOL) this.state = defaultState(this.config);
    const defaults = defaultState(this.config);
    for (const [id, value] of Object.entries(defaults.slots)) this.state.slots[id] ||= value;
    for (const worker of this.config.workers) {
      const slot = this.state.slots[worker.id];
      slot.continuationTimes ||= [];
      slot.inFlightAssistantHash ||= "";
      slot.inFlightStartedAt ||= null;
      if (slot.inFlightAssistantHash) {
        slot.lastContinuationAssistantHash = slot.inFlightAssistantHash;
        this.event("recovered-inflight-as-consumed", { slot: slot.id, assistantHash: slot.inFlightAssistantHash });
        slot.inFlightAssistantHash = "";
        slot.inFlightStartedAt = null;
      }
    }
    const orch = this.state.slots[this.config.orchestrator.id];
    orch.controlProgress ||= { hash: "", done: [] };
    this.state.running = true;
    await this.persist();
  }

  event(type, detail = {}) {
    this.state.events ||= [];
    this.state.events.push({ at: nowIso(), type, ...detail });
    if (this.state.events.length > 300) this.state.events = this.state.events.slice(-300);
  }

  async persist() { this.state.updatedAt = nowIso(); await atomicJson(this.statePath, this.state); }

  async withSlotLock(id, fn) {
    const previous = this.slotLocks.get(id) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tailPromise = previous.then(() => gate);
    this.slotLocks.set(id, tailPromise);
    await previous;
    try { return await fn(); }
    finally { release(); if (this.slotLocks.get(id) === tailPromise) this.slotLocks.delete(id); }
  }

  clearObserved(slot, status = "missing") {
    slot.targetId = null; slot.status = status; slot.ready = false; slot.busy = false; slot.markerPresent = false;
    slot.lastAssistant = ""; slot.lastAssistantHash = ""; slot.lastProbeAt = nowIso(); slot.lastError = null;
  }

  _chatTargets(targets) {
    let regex; try { regex = new RegExp(this.config.browser?.chatUrlRegex || "^https://chatgpt\\.com/"); } catch { regex = /^https:\/\/chatgpt\.com\//; }
    return targets.filter((t) => regex.test(String(t.url || "")));
  }

  _matchTarget(targets, cfg, slot) {
    const explicit = String(cfg.urlIncludes || "").trim();
    if (explicit && !explicit.startsWith("REPLACE_WITH_")) return targets.find((t) => String(t.url || "").includes(explicit)) || null;
    const title = String(cfg.titleIncludes || "").trim();
    if (title) return targets.find((t) => String(t.title || "").includes(title)) || null;
    if (slot.boundUrl) return targets.find((t) => t.url === slot.boundUrl) || null;
    return null;
  }

  async resolveTargets(targets) {
    this.targetsById = new Map(targets.map((t) => [t.id, t]));
    const chatTargets = this._chatTargets(targets), claimed = new Set();
    const orchCfg = this.config.orchestrator, orch = this.state.slots[orchCfg.id];
    const orchTarget = this._matchTarget(chatTargets, orchCfg, orch);
    if (orchTarget) { orch.targetId = orchTarget.id; orch.boundUrl = orchTarget.url; orch.title = orchTarget.title || ""; claimed.add(orchTarget.id); }
    else this.clearObserved(orch);

    const unresolved = [];
    for (const cfg of this.config.workers) {
      const slot = this.state.slots[cfg.id];
      const target = this._matchTarget(chatTargets.filter((t) => !claimed.has(t.id)), cfg, slot);
      if (target) { slot.targetId = target.id; slot.boundUrl = target.url; slot.title = target.title || ""; claimed.add(target.id); }
      else { this.clearObserved(slot); unresolved.push({ cfg, slot }); }
    }
    if (this.config.browser?.autoAssignUnboundWorkers) {
      const available = chatTargets.filter((t) => !claimed.has(t.id)).sort((a,b)=>`${a.title}\n${a.url}`.localeCompare(`${b.title}\n${b.url}`));
      for (const { cfg, slot } of unresolved) {
        if (cfg.urlIncludes || slot.boundUrl) continue;
        const target = available.shift(); if (!target) break;
        slot.targetId = target.id; slot.boundUrl = target.url; slot.title = target.title || ""; claimed.add(target.id);
        this.event("auto-bound", { slot: slot.id, url: target.url, targetId: target.id });
      }
    }
  }

  async probeAll() {
    for (const slot of Object.values(this.state.slots)) {
      if (!slot.targetId) continue;
      const target = this.targetsById.get(slot.targetId);
      if (!target) { this.clearObserved(slot); continue; }
      try {
        const p = await this.cdp.probe(target);
        slot.title = p?.title || target.title || ""; slot.boundUrl = p?.href || target.url || slot.boundUrl;
        slot.busy = Boolean(p?.busy); slot.ready = Boolean(p?.ready); slot.status = slot.busy ? "busy" : slot.ready ? "ready" : "not-ready";
        slot.lastAssistant = String(p?.lastAssistant || ""); slot.lastAssistantHash = slot.lastAssistant ? hashText(slot.lastAssistant) : "";
        slot.markerPresent = slot.lastAssistant.includes(this.config.continuation.marker); slot.lastProbeAt = nowIso(); slot.lastError = null;
      } catch (error) {
        slot.status = "probe-error"; slot.ready = false; slot.busy = false; slot.lastError = String(error?.message || error); slot.lastProbeAt = nowIso();
        this.event("probe-error", { slot: slot.id, error: slot.lastError });
      }
    }
  }

  async activate(slot, target) {
    const command = asArray(this.config.activation?.command).filter(Boolean);
    if (!command.length) return { ok: true, skipped: true };
    const values = { "{id}": slot.id, "{targetId}": target.id, "{url}": target.url || "", "{title}": target.title || "" };
    const argv = command.map((part) => { let s = String(part); for (const [k,v] of Object.entries(values)) s = s.split(k).join(v); return s; });
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: ["ignore","pipe","pipe"] });
      let stdout="", stderr="", settled=false;
      const done=(result)=>{ if(settled)return; settled=true; clearTimeout(timer); resolve(result); };
      child.stdout?.on("data",(c)=>{stdout+=String(c);}); child.stderr?.on("data",(c)=>{stderr+=String(c);});
      const timer=setTimeout(()=>{child.kill();done({ok:false,timeout:true,stdout:tail(stdout,2000),stderr:tail(stderr,2000)});},Number(this.config.activation?.timeoutMs||8000));
      child.on("exit",(code)=>done({ok:code===0,code,stdout:tail(stdout,2000),stderr:tail(stderr,2000)}));
      child.on("error",(e)=>done({ok:false,error:String(e?.message||e)}));
    });
  }

  async submitToSlot(slot, prompt, reason) {
    if (!slot?.targetId) return { ok:false,error:"slot-unbound" };
    const target=this.targetsById.get(slot.targetId); if(!target) return {ok:false,error:"target-missing"};
    const activation=await this.activate(slot,target); if(!activation.ok){this.event("activation-failed",{slot:slot.id,reason,activation});return{ok:false,error:"activation-failed",activation};}
    const submission=await this.cdp.submit(target,prompt); if(!submission?.ok){this.event("submit-failed",{slot:slot.id,reason,submission});return{ok:false,error:submission?.error||"submit-failed",submission};}
    this.event("submitted",{slot:slot.id,reason,promptHash:hashText(prompt),method:submission.method,verified:Boolean(submission.verified)});
    return {ok:true,activation,submission};
  }

  _pruneTimes(slot) {
    const cutoff=Date.now()-60*60*1000; slot.continuationTimes=asArray(slot.continuationTimes).filter((t)=>Date.parse(t)>=cutoff);
  }

  async continueSlot(id,{force=false,prompt=null,reason="continuation"}={}) {
    return this.withSlotLock(id, async()=>{
      const slot=this.state.slots[id]; if(!slot)return{ok:false,error:"unknown-slot"}; if(slot.role!=="worker")return{ok:false,error:"not-worker"};
      const effectivePolicy=force?{...this.config.continuation,requireMarker:false}:this.config.continuation;
      const eligibility=isEligibleContinuation(slot,effectivePolicy); if(!eligibility.ok)return{ok:false,skipped:true,reason:eligibility.reason};
      const claimedHash=slot.lastAssistantHash;
      slot.inFlightAssistantHash=claimedHash; slot.inFlightStartedAt=nowIso();
      this.event("continuation-claimed",{slot:id,assistantHash:claimedHash,reason});
      await this.persist();
      const text=prompt==null?this.config.continuation.prompt:String(prompt);
      let result;
      try { result=await this.submitToSlot(slot,text,reason); }
      catch(error){ result={ok:false,error:String(error?.stack||error?.message||error)}; }
      if(result.ok){
        const when=nowIso(); slot.lastContinuationAt=when; slot.lastContinuationAssistantHash=claimedHash; this._pruneTimes(slot); slot.continuationTimes.push(when); slot.status="submitted";
      }
      slot.inFlightAssistantHash=""; slot.inFlightStartedAt=null;
      if(!result.ok)this.event("continuation-released-after-failure",{slot:id,assistantHash:claimedHash,error:result.error||"submit-failed"});
      await this.persist();
      return result;
    });
  }

  _workerSnapshot(){return this.config.workers.map((w)=>{const s=this.state.slots[w.id];return{id:s.id,status:s.status,paused:s.paused,ready:s.ready,busy:s.busy,marker:s.markerPresent,outputHash:s.lastAssistantHash,tail:tail(s.lastAssistant,Number(this.config.orchestration.tailCharsPerWorker||1400)),lastError:s.lastError};});}

  buildOrchestratorPacket(){return `[SESSION_FARM_STATUS/1]\n${JSON.stringify({generatedAt:nowIso(),workers:this._workerSnapshot(),instruction:"Keep the six worker sessions on track. Intervene only when needed. For machine actions, end with [[FARM_CONTROL/1]] followed by JSON: {\"actions\":[{\"worker\":\"w1\",\"action\":\"nudge|continue|pause|resume\",\"prompt\":\"optional\"}]}. An empty actions array means no intervention. Workers normally self-continue from their own TF_CONTINUE marker; do not micromanage ordinary progress."},null,2)}`;}

  async maybeApplyOrchestratorControl(){
    const orch=this.state.slots[this.config.orchestrator.id]; if(!orch?.lastAssistantHash||orch.lastAssistantHash===orch.lastControlAppliedHash)return[];
    const control=extractFarmControl(orch.lastAssistant,this.config.orchestration.controlMarker); if(!control)return[];
    const controlHash=orch.lastAssistantHash;
    if(orch.controlProgress?.hash!==controlHash)orch.controlProgress={hash:controlHash,done:[]};
    const done=new Set(asArray(orch.controlProgress.done).map(Number)), actions=asArray(control.actions), receipts=[];
    for(let index=0;index<actions.length;index+=1){
      if(done.has(index))continue;
      const action=actions[index], worker=this.state.slots[String(action.worker||"")]; let receipt;
      if(!worker||worker.role!=="worker")receipt={ok:false,error:"unknown-worker",action};
      else{
        const kind=String(action.action||"").toLowerCase();
        if(kind==="pause"){worker.paused=true;receipt={ok:true,worker:worker.id,action:kind};}
        else if(kind==="resume"){worker.paused=false;receipt={ok:true,worker:worker.id,action:kind};}
        else if(kind==="continue")receipt={worker:worker.id,action:kind,...await this.continueSlot(worker.id,{force:true,reason:"orchestrator-continue"})};
        else if(kind==="nudge"){
          const p=String(action.prompt||"").trim(); receipt=!p?{ok:false,worker:worker.id,error:"nudge-prompt-empty"}:{worker:worker.id,action:kind,...await this.continueSlot(worker.id,{force:true,prompt:p,reason:"orchestrator-nudge"})};
        }else receipt={ok:false,worker:worker.id,error:"unsupported-action",action:kind};
      }
      receipts.push({index,...receipt});
      if(receipt.ok){done.add(index);orch.controlProgress.done=[...done].sort((a,b)=>a-b);await this.persist();}
      await sleep(250);
    }
    if(actions.every((_,i)=>done.has(i))){orch.lastControlAppliedHash=controlHash;orch.controlProgress={hash:"",done:[]};await this.persist();}
    this.event("orchestrator-control",{controlHash,receipts,complete:actions.every((_,i)=>done.has(i))});
    return receipts;
  }

  async maybeHeartbeatOrchestrator(){
    const orch=this.state.slots[this.config.orchestrator.id]; if(!orch?.targetId||!orch.ready||orch.busy||orch.paused)return{ok:false,skipped:true,reason:"orchestrator-not-ready"};
    const snapshotHash=hashText(JSON.stringify(this._workerSnapshot().map((x)=>({...x,tail:x.tail.slice(-400)}))));
    const last=this.state.lastOrchestratorHeartbeatAt?Date.parse(this.state.lastOrchestratorHeartbeatAt):0, heartbeatMs=Number(this.config.orchestration.heartbeatMs||120000);
    if(snapshotHash===this.state.lastOrchestratorSnapshotHash&&Date.now()-last<heartbeatMs)return{ok:false,skipped:true,reason:"heartbeat-not-due"};
    const result=await this.submitToSlot(orch,this.buildOrchestratorPacket(),"orchestrator-heartbeat");
    if(result.ok){this.state.lastOrchestratorHeartbeatAt=nowIso();this.state.lastOrchestratorSnapshotHash=snapshotHash;await this.persist();}
    return result;
  }

  async guardApply(){
    const guard=this.config.guard||{}; if(!guard.enabled)return{ok:true,skipped:true,reason:"disabled"}; if(process.platform!=="win32")return{ok:true,skipped:true,reason:"windows-only"};
    const deny=asArray(guard.denyCommandlineRegex).filter(Boolean).map((x)=>new RegExp(x,"i")), protect=asArray(guard.protectCommandlineRegex).filter(Boolean).map((x)=>new RegExp(x,"i"));
    if(!deny.length)return{ok:true,skipped:true,reason:"no-deny-patterns"};
    const output=await new Promise((resolve,reject)=>execFile("powershell.exe",["-NoProfile","-Command","Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"],{windowsHide:true,maxBuffer:8*1024*1024},(e,stdout,stderr)=>e?reject(new Error(`process inventory failed: ${stderr||e.message}`)):resolve(stdout)));
    const parsed=JSON.parse(String(output||"[]")),rows=Array.isArray(parsed)?parsed:[parsed],considered=[],killed=[];
    for(const row of rows){const pid=Number(row.ProcessId),cmd=`${row.Name||""} ${row.CommandLine||""}`;if(!pid||pid===process.pid||protect.some((r)=>r.test(cmd))||!deny.some((r)=>r.test(cmd)))continue;considered.push({pid,name:row.Name||"",commandLine:tail(row.CommandLine||"",800)});killed.push(await new Promise((resolve)=>execFile("taskkill.exe",["/PID",String(pid),"/T","/F"],{windowsHide:true},(e,stdout,stderr)=>resolve({pid,ok:!e,stdout:tail(stdout,1000),stderr:tail(stderr,1000)}))));}
    const result={ok:killed.every((x)=>x.ok),considered,killed,at:nowIso()};this.state.lastGuardAt=result.at;this.state.lastGuardResult=result;if(killed.length)this.event("guard-kill",{killed});await this.persist();return result;
  }

  async tick(){
    if(this.tickInFlight)return{ok:false,skipped:true,reason:"tick-already-running"};this.tickInFlight=true;
    try{
      let guard=null;const guardInterval=Number(this.config.guard?.intervalMs||5000);if(Date.now()-this.lastGuardMs>=guardInterval){try{guard=await this.guardApply();}catch(error){guard={ok:false,error:String(error?.message||error)};this.event("guard-error",guard);}this.lastGuardMs=Date.now();}
      const targets=await this.cdp.targets();await this.resolveTargets(targets);await this.probeAll();
      const controls=await this.maybeApplyOrchestratorControl(),continuations=[];
      for(const worker of this.config.workers){const result=await this.continueSlot(worker.id);if(result.ok||!result.skipped)continuations.push({worker:worker.id,...result});if(result.ok)await sleep(300);}
      const heartbeat=await this.maybeHeartbeatOrchestrator();this.state.lastTickAt=nowIso();await this.persist();return{ok:true,at:this.state.lastTickAt,guard,controls,continuations,heartbeat};
    }catch(error){const message=String(error?.stack||error?.message||error);this.event("tick-error",{error:message});this.state.lastTickAt=nowIso();await this.persist();return{ok:false,at:this.state.lastTickAt,error:message};}
    finally{this.tickInFlight=false;}
  }

  publicStatus(){
    const slots={};for(const[id,s]of Object.entries(this.state.slots))slots[id]={id:s.id,role:s.role,paused:s.paused,boundUrl:s.boundUrl,targetId:s.targetId,title:s.title,status:s.status,ready:s.ready,busy:s.busy,markerPresent:s.markerPresent,lastAssistantHash:s.lastAssistantHash,lastAssistantTail:tail(s.lastAssistant,1200),lastContinuationAt:s.lastContinuationAt||null,inFlightAssistantHash:s.inFlightAssistantHash||"",lastProbeAt:s.lastProbeAt,lastError:s.lastError};
    return{protocol:PROTOCOL,version:VERSION,running:this.state.running,configPath:this.configPath,statePath:this.statePath,lastTickAt:this.state.lastTickAt,lastGuardAt:this.state.lastGuardAt,lastOrchestratorHeartbeatAt:this.state.lastOrchestratorHeartbeatAt,slots,recentEvents:asArray(this.state.events).slice(-30)};
  }

  async bind(id,url){const slot=this.state.slots[id];if(!slot)return{ok:false,error:"unknown-slot"};slot.boundUrl=String(url||"").trim();this.clearObserved(slot,slot.boundUrl?"bound-awaiting-target":"unbound");slot.boundUrl=String(url||"").trim();this.event("manual-bind",{slot:id,url:slot.boundUrl});await this.persist();return{ok:true,slot:id,boundUrl:slot.boundUrl};}
}

async function parseBody(req){const chunks=[];for await(const chunk of req)chunks.push(chunk);return chunks.length?JSON.parse(Buffer.concat(chunks).toString("utf8")):{};}
function sendJson(res,status,body){const data=Buffer.from(`${JSON.stringify(body)}\n`,`utf8`);res.writeHead(status,{"content-type":"application/json; charset=utf-8","content-length":String(data.length),"cache-control":"no-store"});res.end(data);}

async function createControlServer(farm){
  const server=http.createServer(async(req,res)=>{try{
    const url=new URL(req.url||"/","http://session-farm.local");
    if(req.method==="GET"&&url.pathname==="/healthz")return sendJson(res,200,{ok:true,service:"airelays-session-farm",version:VERSION,pid:process.pid});
    if(req.method==="GET"&&url.pathname==="/status")return sendJson(res,200,farm.publicStatus());
    if(req.method!=="POST")return sendJson(res,404,{ok:false,error:"not-found"});
    const body=await parseBody(req);
    if(url.pathname==="/tick")return sendJson(res,200,await farm.tick());
    if(url.pathname==="/continue")return sendJson(res,200,await farm.continueSlot(String(body.worker||""),{force:true,prompt:body.prompt??null,reason:"mcp-manual"}));
    if(url.pathname==="/pause"||url.pathname==="/resume"){const slot=farm.state.slots[String(body.worker||"")];if(!slot||slot.role!=="worker")return sendJson(res,404,{ok:false,error:"unknown-worker"});slot.paused=url.pathname==="/pause";await farm.persist();return sendJson(res,200,{ok:true,worker:slot.id,paused:slot.paused});}
    if(url.pathname==="/bind")return sendJson(res,200,await farm.bind(String(body.slot||""),String(body.url||"")));
    if(url.pathname==="/guard")return sendJson(res,200,await farm.guardApply());
    if(url.pathname==="/shutdown"){farm.stopping=true;farm.state.running=false;await farm.persist();sendJson(res,200,{ok:true,shuttingDown:true});setTimeout(()=>server.close(()=>process.exit(0)),50);return;}
    return sendJson(res,404,{ok:false,error:"not-found"});
  }catch(error){return sendJson(res,500,{ok:false,error:String(error?.stack||error?.message||error)});}});
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(Number(farm.config.listen.port),farm.config.listen.host,resolve);});return server;
}

function parseArgs(argv){const args={config:process.env.AIRELAYS_SESSION_FARM_CONFIG||DEFAULT_CONFIG,once:false};for(let i=2;i<argv.length;i+=1){if(argv[i]==="--config")args.config=argv[++i];else if(argv[i]==="--once")args.once=true;else if(argv[i]==="--help"||argv[i]==="-h")args.help=true;}return args;}

async function main(){
  const args=parseArgs(process.argv);if(args.help){console.log("Usage: node session-farm.mjs --config <session-farm.config.json> [--once]");return;}
  const configPath=path.resolve(args.config),config=await loadConfig(configPath);ensureDirSync(path.dirname(configPath));const farm=new SessionFarm(config,configPath);await farm.init();
  if(args.once){const result=await farm.tick();console.log(JSON.stringify(result,null,2));process.exit(result.ok?0:1);}
  const server=await createControlServer(farm);console.log(JSON.stringify({event:"started",service:"airelays-session-farm",version:VERSION,pid:process.pid,listen:config.listen,configPath,statePath:farm.statePath}));
  const loop=async()=>{if(farm.stopping)return;const result=await farm.tick();if(!result.ok)console.error(JSON.stringify({event:"tick-error",at:nowIso(),error:result.error}));setTimeout(loop,Number(config.continuation.tickMs||2000));};setTimeout(loop,50);
  const stop=async(signal)=>{if(farm.stopping)return;farm.stopping=true;farm.state.running=false;farm.event("signal",{signal});await farm.persist();server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),3000).unref();};
  process.on("SIGINT",()=>void stop("SIGINT"));process.on("SIGTERM",()=>void stop("SIGTERM"));
}

const invoked=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(invoked)main().catch((error)=>{console.error(error?.stack||error);process.exit(1);});
