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
  -> Windows
```

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

## Connect ChatGPT

Add:

```text
https://YOUR-WORKER.workers.dev/mcp
```

as a custom MCP/plugin endpoint in ChatGPT. The Worker advertises OAuth protected-resource metadata, CIMD support, PKCE S256, and explicit capability consent.

## Local contract check

```bash
npm test
```

This verifies the template is internally complete, has the exact 144-tool generated surface (stored as a compressed immutable contract), pins OAuth provider 1.0.0, and binds grants to the exact MCP resource.

## Recovery planes

The outbound Worker relay is the primary route. Tailscale/MagicDNS and a narrow port-mapped/OpenSSH break-glass path are intentionally separate recovery transports; they are not required for normal operation.

## Status

The deterministic disposable-VM acceptance matrix is green for the generated 144-tool contract, signed relay protocol, pairing, scope hierarchy, OAuth source contract, Windows installer contract, and browser-rendered deployment UX. Real Cloudflare, physical Windows, and live ChatGPT acceptance remain provider/device acceptance steps.
