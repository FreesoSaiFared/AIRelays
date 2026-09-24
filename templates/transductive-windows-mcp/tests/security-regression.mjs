import assert from 'node:assert/strict';
import fs from 'node:fs';

const { SESSION_FARM_TOOLS } = await import('../src/session-farm-tools.mjs');
const mcp = fs.readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const relay = fs.readFileSync(new URL('../windows-agent/transductive_agent/relay_agent.py', import.meta.url), 'utf8');
const bridge = fs.readFileSync(new URL('../windows-agent/transductive_agent/session_farm_bridge.py', import.meta.url), 'utf8');
const upgrade = fs.readFileSync(new URL('../upgrade-existing.ps1', import.meta.url), 'utf8');
const seedScript = fs.readFileSync(new URL('../../../tools/session-farm/seed-session.mjs', import.meta.url), 'utf8');

const byName = new Map(SESSION_FARM_TOOLS.map((tool) => [tool.name, tool]));
for (const name of ['farm_deploy', 'farm_tick', 'farm_guard', 'farm_stop']) {
  assert.equal(byName.get(name)?.annotations?.destructiveHint, true, `${name} must require windows.admin`);
}
assert.equal(byName.get('farm_status')?.annotations?.readOnlyHint, true, 'farm_status must remain windows.read');
for (const name of ['farm_start', 'farm_ensure_tabs', 'farm_seed', 'farm_continue', 'farm_pause', 'farm_resume', 'farm_bind']) {
  const a = byName.get(name)?.annotations || {};
  assert.equal(a.readOnlyHint, undefined, `${name} must not be read-only`);
  assert.equal(a.destructiveHint, undefined, `${name} should remain ordinary windows.write`);
}

assert.match(mcp, /destructiveHint === true[\s\S]*windows\.admin/);
assert.match(mcp, /readOnlyHint === true[\s\S]*windows\.read/);
assert.match(index, /name === 'farm_deploy'\) return 300_000/);
assert.match(relay, /farm\.call\(name, args\) if farm\.handles\(name\) else upstream\.call_tool\(name, args\)/);

assert.match(bridge, /root \/ "tools" \/ "session-farm" \/ "deploy-windows\.ps1"/);
assert.match(bridge, /root \/ "tools" \/ "session-farm" \/ "seed-session\.mjs"/);
assert.match(bridge, /input=prompt/);
assert.match(bridge, /100_000/);
assert.match(bridge, /if host not in \{"127\.0\.0\.1", "localhost", "::1"\}/);
assert.match(bridge, /if not url\.startswith\("https:\/\/chatgpt\.com\/"\)/);
assert.doesNotMatch(bridge, /shell\s*=\s*True/);
assert.doesNotMatch(bridge, /os\.system\s*\(/);
assert.doesNotMatch(bridge, /subprocess\.(?:call|run|Popen)\([^\n]*shell\s*=\s*True/);

assert.match(seedScript, /if \(!args\.force && Number\(before\?\.userCount \|\| 0\) > 0\)/);
assert.match(seedScript, /reason: "existing-user-turn"/);
assert.match(seedScript, /refusing non-loopback farm control host/);
assert.match(seedScript, /refusing non-loopback CDP host/);
assert.match(seedScript, /bootstrap prompt exceeds/);
assert.match(seedScript, /for await \(const chunk of process\.stdin\)/);
assert.doesNotMatch(seedScript, /--prompt/);

assert.match(upgrade, /ProgramData[^\n]*Transductive\\WindowsMCP/);
assert.match(upgrade, /--force-reinstall/);
assert.match(upgrade, /session_farm_bridge import SessionFarmBridge/);
assert.match(upgrade, /Stop-ScheduledTask -TaskName \$RelayTaskName/);
assert.match(upgrade, /Start-ScheduledTask -TaskName \$RelayTaskName/);
assert.match(upgrade, /npm[^\n]*install[^\n]*--no-package-lock[^\n]*--ignore-scripts/i);
assert.match(upgrade, /wrangler','deploy/);
assert.doesNotMatch(upgrade, /OWNER_SETUP_TOKEN\s*=/);
assert.doesNotMatch(upgrade, /deviceSecret/);

console.log('TRANSDUCTIVE_SESSION_FARM_SECURITY_REGRESSION_OK scope_boundary=pass fixed_deployer=pass loopback_only=pass chatgpt_bind_only=pass one_shot_seed=pass seed_prompt_stdin=pass no_shell_true=pass upgrade_preserves_secrets=pass');
