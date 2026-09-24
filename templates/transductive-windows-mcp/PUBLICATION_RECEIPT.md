# Publication receipt

- Source donor: `emog33k/winrdp-mcp` 0.1.5, commit `d5e2051b1c37d3c7221a8eff98819e4ba41097bc`.
- OAuth runtime: `@cloudflare/workers-oauth-provider` 1.0.0.
- MCP tool contract: 144 generated tools, compact gzip payload split into six immutable modules.
- Primary machine route: outbound authenticated WebSocket from Windows to the user's own Cloudflare Worker.
- Recovery routes: Tailscale/MagicDNS and narrow port-map/OpenSSH are independent optional planes.
- Local disposable-VM acceptance: MCP facade, signed relay, one-time pairing, scope hierarchy, OAuth source contract, Windows agent package, landing page and browser receipt passed before publication.
- Publication isolation: this template is added only below `templates/transductive-windows-mcp/` in AIRelays; no pre-existing AIRelays files are modified.
- Remaining acceptance boundary: real Cloudflare deployment, physical Windows pairing, and live ChatGPT OAuth/MCP connection are not claimed by this repository receipt until separately exercised.
