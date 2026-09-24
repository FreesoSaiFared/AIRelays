import assert from 'node:assert/strict';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const wrangler = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const oauth = fs.readFileSync(new URL('../src/oauth-entry.ts', import.meta.url), 'utf8');
const { getToolSurface } = await import('../src/tools.compact.mjs');
const tools = await getToolSurface();

assert.equal(pkg.dependencies['@cloudflare/workers-oauth-provider'], '1.0.0');
assert.equal(wrangler.main, 'src/oauth-entry.ts');
assert.ok(wrangler.compatibility_flags.includes('global_fetch_strictly_public'));
assert.ok(wrangler.kv_namespaces.some((x) => x.binding === 'OAUTH_KV'));
assert.equal(tools.count, 144);
assert.equal(tools.tools.length, 144);
assert.match(oauth, /const resource = `\$\{origin\}\/mcp`/);
assert.match(oauth, /resourceMetadata:\s*\{[\s\S]*?resource,[\s\S]*?authorization_servers:\s*\[origin\]/);
assert.match(oauth, /clientIdMetadataDocumentEnabled:\s*true/);
assert.match(oauth, /allowPlainPKCE:\s*false/);
assert.match(oauth, /allowImplicitFlow:\s*false/);
assert.match(oauth, /constantTimeEqual\(supplied, env\.OWNER_SETUP_TOKEN\)/);
console.log('TRANSDUCTIVE_TEMPLATE_SMOKE_OK provider=1.0.0 resource_bound=pass tools=144');
