# Transductive Windows MCP

A user-owned Cloudflare Worker that gives ChatGPT a standards-compliant OAuth MCP endpoint for controlling a Windows machine through a resident outbound relay.

The normal path does **not** require an inbound port, Tailscale, RDP exposure, or a Transductive server in the machine-data path:

```text
ChatGPT
  -> OAuth / MCP HTTPS
  -> your Cloudflare Worker
  -> DeviceHub Durable Object
  -> outbound WSS from your Windows PC
  -> resident relay
      -> winrdp-mcp 0.1.5 agent
      -> fixed-function AIRelays Session Farm bridge
  -> Windows
```

The public MCP surface is one control plane rather than two disconnected plugins: **144 generated upstream Windows tools plus 12 Session Farm tools = 156 tools**. Session Farm calls travel through the same signed outbound device connection as normal Windows tools.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/FreesoSaiFared/AIRelays/tree/main/templates/transductive-windows-mcp)

Cloudflare provisions the declared KV namespace and Durable Objects from `wrangler.jsonc`.

During setup provide:

- `OWNER_PRINCIPAL_ID`: your Transductive cryptographic principal (`tid:...`).
- `OWNER_SETUP_TOKEN`: a long random secret used only to authenticate explicit owner consent in the current V1 owner adapter.

OAuth access is separate from device pairing. OAuth grants use explicit `windows.read`, `windows.write`, and `windows.admin` capabilities and are bound to the exact deployed `${origin}/mcp` resource by `@cloudflare/workers-oauth-provider` 1.0.0.

## Pair Windows

After deployment, obtain a one-time pairing code from the Worker owner flow, then on Windows run an elevated PowerShell:

```powershell
.\windows-agent\install-windows.ps1 -WorkerUrl https://YOUR-WORKER.workers.dev -PairCode XXXX-XXXX-XXXX
```

The installer creates a SYSTEM startup task for the outbound relay and stores device credentials using Windows DPAPI. The native execution layer remains upstream `winrdp-mcp[agent-ui]==0.1.5`; this template does not reimplement Windows transport semantics in JavaScript.

## Session Farm through the same MCP

The resident relay intercepts only these fixed tool names locally; every other tool remains delegated unchanged to upstream `winrdp-mcp`:

- `farm_deploy`
- `farm_start`
- `farm_status`
- `farm_tick`
- `farm_ensure_tabs`
- `farm_seed`
- `farm_continue`
- `farm_pause`
- `farm_resume`
- `farm_bind`
- `farm_guard`
- `farm_stop`

This removes the need for ChatGPT to discover a second Session Farm connector. The Cloudflare MCP advertises the farm controls directly, and the paired Windows relay routes them to canonical helpers under `tools/session-farm/`.

The first `farm_deploy` call should provide `repoRoot` when the resident relay does not already know the AIRelays checkout. The bridge persists that repository root and the resolved Session Farm config path in:

```text
%ProgramData%\Transductive\WindowsMCP\session-farm-bridge.json
```

After that, normal farm calls need no workstation paths. `farm_deploy` invokes only canonical `tools\session-farm\deploy-windows.ps1`; `farm_seed` invokes only canonical `tools\session-farm\seed-session.mjs`. The bridge does not expose a general-purpose shell.

Example first deployment arguments:

```json
{
  "repoRoot": "E:\\AIRelays",
  "updateFromMain": true,
  "enableSelfHealing": true,
  "startNow": true
}
```

Use the actual checkout path on the paired machine; the example path is not a default.

## Bootstrap a newly created session exactly once

Self-healing can reopen an established conversation URL, but a genuinely new ChatGPT tab still needs its first mission. `farm_seed` provides that missing first-turn primitive without putting browser automation back in an extension.

Example:

```json
{
  "slot": "w1",
  "prompt": "You are worker 1. Own the mechanical verification task. Continue autonomously and end unfinished turns with the TF_CONTINUE marker."
}
```

The prompt is sent from the resident relay to the canonical Node seeder over **stdin**, not a process command line. The seeder verifies the farm and CDP listeners are loopback-only, resolves the exact slot target ID, requires the target to be ready, and by default refuses to seed any conversation that already contains a user turn. That makes repeated setup idempotent: the first successful bootstrap creates the user turn; later calls skip with `existing-user-turn`.

`force=true` exists for deliberate reseeding of an existing conversation, but normal fleet creation should leave it false.

A useful startup pattern is:

1. `farm_deploy`;
2. `farm_ensure_tabs` twice, requiring the second call to create zero tabs;
3. `farm_seed` `orch` with the orchestrator contract and task context;
4. `farm_seed` each newly blank worker with its one-time mission;
5. thereafter let each worker define its own continuation frontier and let the daemon submit only generic `continue` turns.

Scope mapping follows the existing MCP authorization model:

- `farm_status` -> `windows.read`
- seeding and ordinary tab/session state changes -> `windows.write`
- `farm_deploy`, `farm_tick`, `farm_guard`, and `farm_stop` -> `windows.admin`

`farm_tick` is admin-scoped because a configured tick may run the process interference guard. `farm_deploy` receives an extended device-dispatch timeout so validation and scheduled-task installation can finish without the normal short tool timeout.

## Connect ChatGPT

Add:

```text
https://YOUR-WORKER.workers.dev/mcp
```

as a custom MCP/plugin endpoint in ChatGPT. The Worker advertises OAuth protected-resource metadata, CIMD support, PKCE S256, and explicit capability consent.

A single `tools/list` should expose all 156 tools, including `farm_status`, `farm_deploy`, and `farm_seed`.

## Local contract check

```bash
npm test
```

This verifies the template is internally complete, preserves the exact 144-tool generated upstream surface, adds exactly 12 non-colliding Session Farm tools, pins OAuth provider 1.0.0, and binds grants to the exact MCP resource.

The Python resident-agent package should also byte-compile cleanly:

```bash
python -m compileall windows-agent/transductive_agent
```

## Recovery planes

The outbound Worker relay is the primary route. Tailscale/MagicDNS and a narrow port-mapped/OpenSSH break-glass path are intentionally separate recovery transports; they are not required for normal operation.

## Status

The generated 144-tool Windows contract remains immutable. The 12 Session Farm controls are a separate fixed-function overlay and do not alter upstream winrdp tool semantics. Real Cloudflare deployment, physical Windows pairing, Brave CDP availability, seven live ChatGPT tabs, initial seed round-trips, and actual continuation round-trips remain provider/device acceptance steps until exercised on the paired workstation.
