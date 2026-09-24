# AIRelays Session Farm

This subsystem moves ChatGPT continuation out of browser extensions and into a persistent Windows process.

It manages exactly **six worker ChatGPT tabs plus one orchestrator tab**. Workers normally decide their own next step and end a turn with the configured continuation marker. The external daemon does the one thing a completed chat turn cannot do by itself: it submits the next user turn, normally just `continue`.

The orchestrator is not in the hot path for every continuation. It receives periodic compact state packets and only intervenes when a worker drifts, stalls, needs a different prompt, or should be paused.

When tab self-healing is enabled, the daemon also performs the other browser-lifecycle action a completed session cannot do for itself: if one of the seven assigned tabs disappears, the daemon opens a replacement through Brave/Chromium DevTools Protocol and reattaches the logical slot. No browser extension or userscript owns this loop.

## Architecture

```text
six worker tabs                         orchestrator tab
     |                                        |
     +---------------- Brave CDP -------------+
                         |
                 session-farm.mjs
                         |
            persistent Windows process
               |                    |
       process interference     loopback control
            guard                127.0.0.1:39817
                                    /       \
                                   /         \
                         stdio MCP           streamable HTTP MCP
                  session-farm-mcp.mjs   session-farm-http-mcp.mjs
                                                   |
                                            127.0.0.1:39818/mcp
                                                   |
                                   Tailscale Serve / Cloudflare Tunnel
                                       only when remote access is wanted
```

There is no browser extension in the continuation path or the tab-recovery path.

The daemon reads, opens, and submits through Brave/Chromium DevTools Protocol. If foreground activation is needed on the host, a narrow optional adapter invokes **CUA driver only to activate the target surface**. CUA driver is not used to type the prompt, press Send, scrape the conversation, decide readiness, schedule continuation, or create tabs.

## Continuation state machine

A worker is eligible when all of these are true:

1. it is bound to a live ChatGPT tab;
2. the page is not generating;
3. the composer is available;
4. the slot is not paused;
5. the latest assistant output contains `[[TF_CONTINUE_NOW/1]]` when `requireMarker=true`;
6. that exact assistant output has not already been continued or claimed in-flight;
7. cooldown and hourly runaway limits are satisfied.

The daemon then submits the configured continuation prompt. The default is simply:

```text
continue
```

Before submission, the exact assistant-output hash is atomically persisted as an in-flight claim. Per-worker continuation is serialized. After a verified submission the claim becomes the consumed hash and is persisted before the control call returns.

If the process crashes with an in-flight claim, restart treats that output as consumed. This deliberately chooses **at-most-once continuation** over risking duplicate prompts. A transient submission failure observed before a successful send releases the claim and remains retryable.

The CDP submitter does not trust synthetic Enter or a button click by itself. It verifies that the page changed by observing generation, a cleared composer, or a matching new user message before recording success.

## Seven-tab self-healing

Set:

```json
{
  "browser": {
    "ensureTabs": true,
    "newTabUrl": "https://chatgpt.com/",
    "spawnGraceMs": 15000,
    "spawnSpacingMs": 250,
    "postSpawnSettleMs": 750
  }
}
```

With `ensureTabs=true`, every supervision tick verifies that each logical slot has a live page target. A missing worker or orchestrator receives a new Brave/Chromium CDP target. The daemon prefers, in order:

1. the slot's explicit `launchUrl`;
2. the full persisted conversation URL from its last successful binding;
3. a full `urlIncludes` value when that value itself is an HTTP(S) URL;
4. `browser.newTabUrl`;
5. `https://chatgpt.com/`.

For established conversations, use the exact conversation URL as `launchUrl` or let the daemon persist it after the first successful probe. That lets a browser restart reopen the same conversation rather than a blank ChatGPT page.

A freshly spawned target is tracked by target ID during a configurable grace interval. This prevents a loading or redirecting page from being mistaken for a still-missing slot and duplicated on the next 2-second tick.

The daemon does **not** close unrelated ChatGPT tabs. The invariant is "at least one live target per configured logical slot", not "kill every extra tab".

`farm_ensure_tabs` forces this reconciliation immediately even when automatic `ensureTabs` is disabled. This is useful during setup and acceptance testing.

## Orchestrator contract

The orchestrator receives packets beginning with:

```text
[SESSION_FARM_STATUS/1]
```

Each packet contains the six workers' current state and a short tail of their most recent assistant output. The orchestrator should only intervene when needed.

Machine actions are emitted at the end of its reply as:

```text
[[FARM_CONTROL/1]]
{"actions":[]}
```

Supported actions are:

```json
{"worker":"w2","action":"pause"}
{"worker":"w2","action":"resume"}
{"worker":"w3","action":"continue"}
{"worker":"w4","action":"nudge","prompt":"Return to the acceptance criterion and mechanically verify it."}
```

An empty action list means the workers remain on their autonomous continuation loop.

Orchestrator action progress is persisted per action. A transiently failed nudge/continue remains retryable, while successful earlier actions in the same envelope are not repeated.

## Requirements

- Windows for the process guard and scheduled-task installer.
- Node.js 22 or newer.
- Brave launched with a DevTools endpoint, for example a local same-host endpoint on port `9333`.
- Either existing worker/orchestrator conversations, or tab self-healing enabled so the daemon can open missing slots.
- Optional: a host-specific CUA-driver activation command.

Loopback addresses in this subsystem are same-host IPC only. Inter-host access is deliberately not implemented through `127.0.0.1`; use Tailscale MagicDNS/Tailscale Services, Tailscale Serve, or an explicit Cloudflare Tunnel for remote access.

## Configure

Copy the example:

```powershell
Copy-Item tools\session-farm\session-farm.config.example.json `
  $env:LOCALAPPDATA\AIRelays\session-farm\session-farm.config.json
```

For an existing orchestrator conversation, set `orchestrator.urlIncludes` to a unique fragment of the conversation URL and optionally set `orchestrator.launchUrl` to the full conversation URL so it can be reopened after a browser restart.

Worker slots can specify `urlIncludes`, `launchUrl`, both, or neither. With `autoAssignUnboundWorkers=true`, otherwise-unclaimed ChatGPT tabs are assigned to the six worker slots and their full URLs are persisted in state. With `ensureTabs=true`, missing slots are created automatically.

The interference guard only terminates processes whose command lines match a configured deny expression. Protected expressions are checked first. Do not add generic process names such as `node`, `python`, or `brave` to the deny list.

## Optional CUA activation

`activation.command` is intentionally an argv template rather than a hard-coded CUA API. The repository cannot safely guess the exact local CUA-driver build or schema.

To use the included adapter, set `activation.command` to:

```json
[
  "powershell.exe",
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  "tools\\session-farm\\activate-cua.ps1",
  "-SessionId",
  "{id}",
  "-TargetId",
  "{targetId}",
  "-Url",
  "{url}",
  "-Title",
  "{title}"
]
```

Then provide the actual local CUA-driver activation argv as JSON in `CUA_DRIVER_ACTIVATE_ARGV_JSON`. Placeholders `{id}`, `{targetId}`, `{url}`, and `{title}` are expanded.

The adapter fails closed if no host-specific CUA invocation has been supplied. If CDP submission works without foreground activation, leave `activation.command` empty and CUA is not required.

## Run once

```powershell
node tools\session-farm\session-farm.mjs `
  --config $env:LOCALAPPDATA\AIRelays\session-farm\session-farm.config.json `
  --once
```

A successful one-shot tick is the first acceptance check. It should report tab bindings, any tab-spawn receipts, and probe states without submitting duplicate continuations.

## Install as a persistent Windows process

```powershell
powershell -ExecutionPolicy Bypass -File tools\session-farm\install-windows.ps1 -StartNow
```

The installer creates the `AIRelays-SessionFarm` scheduled task with restart-on-failure behavior. The task runs the daemon at logon and leaves browser tabs open when the daemon stops.

## Local stdio MCP

```powershell
node tools\session-farm\session-farm-mcp.mjs
```

It exposes:

- `farm_start`
- `farm_status`
- `farm_tick`
- `farm_ensure_tabs`
- `farm_continue`
- `farm_pause`
- `farm_resume`
- `farm_bind`
- `farm_guard`
- `farm_stop`

`farm_start` launches the persistent daemon detached from the MCP process. Closing the MCP client therefore does not stop continuation.

## Streamable HTTP MCP

For ChatGPT/plugin registration or a remote MCP transport, start the HTTP surface separately:

```powershell
node tools\session-farm\session-farm-http-mcp.mjs `
  --config $env:LOCALAPPDATA\AIRelays\session-farm\session-farm.config.json
```

Local endpoint:

```text
http://127.0.0.1:39818/mcp
```

The HTTP MCP exposes the same farm tools and automatically starts the detached daemon if necessary. Keep it loopback-bound on the Windows host. For access from another user-owned machine, expose it privately through Tailscale Serve using a MagicDNS/Tailscale Service identity. For ChatGPT registration, put a narrowly scoped authenticated or capability URL in front of it through the existing Cloudflare tunnel/gateway rather than binding the service directly to a public interface.

The dashboard API also exposes `POST /api/ensure-tabs` for the same explicit reconciliation action.

## Worker and orchestrator bootstraps

`worker-contract.txt` contains the minimal convention that lets each worker describe its own next turn. The external daemon therefore does not need a detailed continuation prompt.

`orchestrator-contract.txt` defines the status/control envelope for the seventh supervising session.

Tab self-healing intentionally does not invent a worker mission. If a missing slot reopens an established conversation, the conversation already contains its mission. If it opens a blank ChatGPT page, seed that new session with the worker or orchestrator contract plus the task you want it to own.

## Mechanical acceptance

Run the pure state-machine tests:

```powershell
node --test tools\session-farm\session-farm.test.mjs
```

Syntax checks:

```powershell
node --check tools\session-farm\session-farm.mjs
node --check tools\session-farm\session-farm-mcp.mjs
node --check tools\session-farm\session-farm-http-mcp.mjs
```

For a live host, acceptance is:

1. `/healthz` returns `ok: true` from the daemon;
2. `farm_status` shows six worker slots and one orchestrator slot;
3. `farm_ensure_tabs` creates exactly the missing slot targets and reports their target IDs;
4. immediately repeating `farm_ensure_tabs` creates no duplicate targets during the spawn grace window;
5. closing one managed tab causes the configured self-healer to create one replacement, not seven new tabs;
6. an established slot with a persisted/full `launchUrl` reopens the intended conversation after a browser restart;
7. each live slot has a target id and current probe time;
8. a worker with a fresh continuation marker receives exactly one continuation;
9. the same assistant-output hash is not continued a second time, including across process restart;
10. a busy, paused, or already in-flight worker receives none;
11. the process guard reports exactly which matching processes it terminated;
12. the orchestrator can pause/resume/nudge one worker through a `FARM_CONTROL` envelope and failed actions remain retryable;
13. a prompt submission is counted only after observable page confirmation;
14. no browser extension is required for any of the above.
