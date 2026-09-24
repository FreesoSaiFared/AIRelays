# Publication receipt

- Source donor: `emog33k/winrdp-mcp` 0.1.5, commit `d5e2051b1c37d3c7221a8eff98819e4ba41097bc`.
- OAuth runtime: `@cloudflare/workers-oauth-provider` 1.0.0.
- Upstream MCP tool contract: exactly 144 generated tools, compact gzip payload split into six immutable modules.
- AIRelays overlay: 12 fixed-function Session Farm controls (`farm_deploy`, `farm_start`, `farm_status`, `farm_tick`, `farm_ensure_tabs`, `farm_seed`, `farm_continue`, `farm_pause`, `farm_resume`, `farm_bind`, `farm_guard`, `farm_stop`).
- Combined advertised MCP surface: 156 tools. The overlay does not modify or shadow any of the 144 upstream names.
- Primary machine route: outbound authenticated WebSocket from Windows to the user's own Cloudflare Worker.
- Session Farm route: the same signed device channel terminates in the resident relay, which handles only the 12 fixed names locally and delegates every other name unchanged to upstream `winrdp-mcp`.
- Session Farm bridge is fixed-function: deployment can only invoke canonical `tools/session-farm/deploy-windows.ps1`; first-turn seeding can only invoke canonical `tools/session-farm/seed-session.mjs`; neither adds a general shell primitive.
- One-shot seed boundary: bootstrap prompts are passed to the Node seeder over stdin rather than process argv; daemon control and CDP hosts must both be loopback; normal seeding skips any target that already contains a user turn; deliberate reseeding requires explicit `force=true`.
- OAuth scope boundary: read-only status uses `windows.read`; seeding and normal farm mutations use `windows.write`; deployment/tick/guard/stop use `windows.admin`.
- Recovery routes: Tailscale/MagicDNS and narrow port-map/OpenSSH are independent optional planes.
- Repository acceptance: template smoke verifies 144 upstream + 12 overlay names and scope annotations; focused security regression checks fixed seeding/deployer paths, loopback boundaries, one-shot behavior, prompt-on-stdin, and no shell=True execution; resident-agent Python unit tests cover bridge seeding and config boundaries.
- Remaining acceptance boundary: real Cloudflare deployment, physical Windows relay upgrade/pairing, actual AIRelays checkout path, Brave CDP, seven live ChatGPT sessions, first-turn seed round-trips, and live continuation/orchestrator round-trips are not claimed until separately exercised on the paired workstation.
