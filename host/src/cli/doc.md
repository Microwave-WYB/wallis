# wallis: writing and orchestrating workflows

Agents interact with the workflow only through their input and output.
Their tools touch only the outside world (custom tools, MCP) or their own
sandbox; a tool given to an agent can be used freely. Outward writes
happen in the workflow body; to ask first, call an orchestrator node. Every
call's result is journaled, so runs resume, fork and reproduce.

## A workflow: .agents/workflows/<name>/workflow.ts

```ts
import { ask, defineAgent, defineMcp, defineModels, defineSandbox, orchestrator, toolset, Type, workflow } from "wallis";
import mcpConfig from "./mcp.json" with { type: "json" };
import prompt from "./prompts/colorist.md" with { type: "text" };

const models = defineModels({ default: "anthropic/claude-sonnet-5-5" });
const toolBox = defineSandbox({}, { name: "tools", requires: ["node"] });
const py = defineSandbox({}, { name: "py", requires: ["bash", "python3"] });
// Custom tools first: tools/lib.ts exports pi AgentTools with MCP annotations.
const lib = toolset<typeof import("./tools/lib.ts")>("./tools/lib.ts", { sandbox: toolBox, secrets: ["ENTE_TOKEN"] });
// Existing MCP servers: objects by name; the overlay gives sandbox and network.
const mcp = defineMcp(mcpConfig, { scholar: { sandbox: toolBox } });

const colorist = defineAgent({ models }, {
  name: "colorist", model: "default", prompt,
  input: Type.Object({ sheet: Type.String() }), output: Type.Object({ look: Type.String() }),
  workspace: { access: "exec", sandbox: py },          // read: read, ls; write: + write, edit; exec: + bash
  tools: [ask, lib.search, mcp.scholar],                // a whole server: its read-only tools only
});
const confirm = orchestrator({ name: "confirm", description: "Publish this look?",
  input: Type.Object({ look: Type.String() }), output: Type.Object({ ok: Type.Boolean() }) });

export default workflow({
  name: "roll", models, mcp, toolsets: [lib], agents: [colorist], orchestrators: [confirm],
  input: Type.Object({ sheet: Type.String() }), output: Type.Any(),
  run: async (ctx, input) => {
    const s = ctx.session(colorist);                    // agents only through sessions
    let look = await ctx.call(s, { sheet: input.sheet });
    look = await ctx.call(s, { sheet: "too yellow" });       // same conversation
    const { ok } = await ctx.call(confirm, look);       // asking first is code
    if (ok) await ctx.call(lib.upload, { look: look.look });   // the outward write, in the body
    return look;
  },
});
```

- A tool module: `export const search = { name, label, description,
  parameters, outputSchema, execute, replay: "safe", annotations: {
  readOnlyHint: true } } satisfies WallisTool<typeof Params>;`.
- Tools that may write outside (unannotated ones too) given to an agent
  are a preflight warning (run metadata, `describe`): writes belong in the
  body. A tool call in flight at a crash is made again only if
  `replay: "safe"` or read-only; otherwise the node waits (outcome
  unknown).
- `ctx.call` takes commands, nested workflows, orchestrator nodes and tool
  values (`lib.x` typed by its schemas; `mcp.server.tool` returns unknown
  unless a schema is passed as third argument). A session's calls run in
  the order made; calling it from a `parallel`/`map` branch is refused.
- MCP servers never see the agent's files: use the workspace or custom
  tools for files.

## Orchestrating a run

- `wallis describe <workflow>`: its input, agents (workspace, tools), the
  questions it may ask you (orchestrator nodes, answer schemas) and the
  latest tool warnings.
- `wallis run <workflow> --input '<json>'`, then `npx wallis wait <run>` in
  the background: it returns when something needs you.
- `wallis pending --json` / `status <run> --json` / `wait --json`: every
  pending item with its kind and `actions` (verbs and argument schemas).
  Kinds: agent_ask, ended_without_result, turn_limit, interrupted,
  outcome_unknown, orchestrator_pending, run_idle, node_failed, stopped,
  finished.
- `wallis send <run> <node> "<text>" [--turns n]`: an idle agent gets it;
  a running one gets it after its current turn (a steer). The output says
  which.
- `wallis submit <run> <node> '<json>'`: an orchestrator node's result,
  checked against its schema.
- `wallis interrupt <run> <node>`: stops the node's turn; then `send`.
- `wallis restart <run> <node> [note]` (retries an unknown outcome, asks an
  orchestrator node again), `cancel <run> [--node n]`, `pause <run>`,
  `resume <run> [--budget turns=n] [--model alias=m]`, `fork <run>`.
- Questions reach you without the run's context: answer from the item.
  Forks share you as their orchestrator. A restart re-calls the outside
  (tools, questions): that is not reproduction.

The same verbs are MCP tools of `wallis serve`: run, describe, send,
submit_result, interrupt, restart, cancel, pause, resume, get_run,
pending, wait.
