const objectSchema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const worker = { type: 'string', enum: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'] };
const slot = { type: 'string', enum: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'orch'] };
const configPath = { type: 'string', description: 'Optional absolute path to session-farm.config.json on the paired Windows device.' };
const repoRoot = { type: 'string', description: 'Optional absolute AIRelays repository root. Falls back to paired-device config or AIRELAYS_REPO_ROOT.' };

export const SESSION_FARM_TOOLS = [
  {
    name: 'farm_deploy',
    description: 'Validate, install or repair the canonical AIRelays six-worker plus orchestrator session farm on the paired Windows device.',
    inputSchema: objectSchema({
      repoRoot,
      configPath,
      updateFromMain: { type: 'boolean', default: true },
      enableSelfHealing: { type: 'boolean', default: true },
      startNow: { type: 'boolean', default: true },
      validationOnly: { type: 'boolean', default: false },
    }),
    annotations: { destructiveHint: true },
  },
  {
    name: 'farm_start',
    description: 'Start the persistent session-farm daemon if it is not already healthy.',
    inputSchema: objectSchema({ repoRoot, configPath }),
    annotations: {},
  },
  {
    name: 'farm_status',
    description: 'Read verified state for six worker slots, the orchestrator, continuation state, tab-healing state and recent receipts.',
    inputSchema: objectSchema({ configPath }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'farm_tick',
    description: 'Run one complete session-farm supervision cycle, including configured guard, tab reconciliation, continuation and orchestrator heartbeat.',
    inputSchema: objectSchema({ configPath }),
    annotations: { destructiveHint: true },
  },
  {
    name: 'farm_ensure_tabs',
    description: 'Reconcile the seven logical session slots and create only missing Brave/ChatGPT page targets.',
    inputSchema: objectSchema({ configPath }),
    annotations: {},
  },
  {
    name: 'farm_continue',
    description: 'Submit one verified continuation to a ready worker. Prompt defaults to the farm generic continuation prompt.',
    inputSchema: objectSchema({ configPath, worker, prompt: { type: 'string' } }, ['worker']),
    annotations: {},
  },
  {
    name: 'farm_pause',
    description: 'Pause automatic continuation for one worker without closing its tab.',
    inputSchema: objectSchema({ configPath, worker }, ['worker']),
    annotations: {},
  },
  {
    name: 'farm_resume',
    description: 'Resume automatic continuation for one paused worker.',
    inputSchema: objectSchema({ configPath, worker }, ['worker']),
    annotations: {},
  },
  {
    name: 'farm_bind',
    description: 'Bind a worker or orchestrator slot to an exact ChatGPT conversation URL.',
    inputSchema: objectSchema({ configPath, slot, url: { type: 'string', minLength: 1 } }, ['slot', 'url']),
    annotations: {},
  },
  {
    name: 'farm_guard',
    description: 'Run the configured Windows interference-process guard immediately and return exact considered/terminated processes.',
    inputSchema: objectSchema({ configPath }),
    annotations: { destructiveHint: true },
  },
  {
    name: 'farm_stop',
    description: 'Stop the persistent session-farm daemon cleanly while leaving browser tabs open.',
    inputSchema: objectSchema({ configPath }),
    annotations: { destructiveHint: true },
  },
];

export const SESSION_FARM_TOOL_NAMES = new Set(SESSION_FARM_TOOLS.map((tool) => tool.name));
