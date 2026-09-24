# Upgrade an existing Transductive Windows MCP

The Session Farm consolidation changes both halves of an existing deployment:

1. the Cloudflare Worker must advertise the combined 155-tool MCP surface;
2. the already-paired resident Windows relay must contain the fixed-function Session Farm bridge.

Re-pairing the machine is not required. The device credentials remain in the existing DPAPI-protected config and the Cloudflare OAuth secrets remain remote.

From an up-to-date AIRelays checkout on the paired Windows machine, run an elevated PowerShell in `templates\transductive-windows-mcp`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\upgrade-existing.ps1
```

The upgrade performs fail-fast local contract/security checks, force-reinstalls the resident agent package into the existing isolated runtime, verifies the Session Farm bridge import, restarts the existing `Transductive-Windows-MCP-Relay` scheduled task, installs transient Worker dependencies without creating a package lock, runs the template contract tests, and deploys the Worker with Wrangler.

Wrangler uses the account already authenticated on that workstation. Existing Worker secrets are not supplied by this script and are not written into the repository.

To upgrade only one half:

```powershell
# Resident relay only
.\upgrade-existing.ps1 -SkipCloudflare

# Cloudflare Worker only
.\upgrade-existing.ps1 -SkipAgent
```

For troubleshooting only, `-SkipTests` bypasses pre-deploy validation. Do not use it for normal promotion.

After a successful upgrade, reconnect or refresh the ChatGPT MCP/plugin connection if the current conversation cached the old tool list. `tools/list` should then expose 155 tools: 144 upstream Windows tools plus 11 `farm_*` controls.

The next live acceptance sequence is:

1. call `farm_status`;
2. if no farm is installed, call `farm_deploy` once with the verified AIRelays `repoRoot`;
3. call `farm_ensure_tabs` twice and require the second call to create zero tabs;
4. verify `w1` through `w6` plus `orch`;
5. close one managed tab and require exactly one replacement;
6. allow one marked worker output to receive exactly one generic `continue`;
7. verify one orchestrator heartbeat and one targeted control action.
