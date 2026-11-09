# wallis: writing and orchestrating workflows

A run has no outward side effects except through MCP tools in `ask` mode,
each approved by you, the orchestrator, at the point of action and
journaled, so replay never repeats it. Agent sandboxes and commands have no
network; MCP servers are the only channel outside. Every call's result is
journaled, so runs resume, fork and reproduce.

## A workflow: .agents/workflows/<name>/workflow.ts

```ts
import { defineAgent, defineMcp, defineModels, mcpTool, orchestrator, Type, workflow } from "wallis";
import mcpConfig from "./mcp.json" with { type: "json" };
import prompt from "./prompts/colorist.md" with { type: "text" };

const models = defineModels({ default: "anthropic/claude-sonnet-5-5" });
// Each server: its sandbox, and its network ("full" by default).
const mcp = defineMcp(mcpConfig, { ente: { sandbox: enteBox } });   // enteBox: a defineSandbox(...)

const colorist = defineAgent({ models, mcp }, {
  name: "colorist", model: "default", prompt,
  input: Type.Object({ sheet: Type.String() }), output: Type.Object({ look: Type.String() }),
  // Direct tools run when called; `ask` tools wait for your approval.
  mcp: { scholar: ["search"], ente: { ask: ["upload"] } },
});
const search = mcpTool({ mcp }, { server: "scholar", tool: "search", input: Type.Object({ q: Type.String() }), output: Type.Any() });
const pickLook = orchestrator({ name: "pick_look", description: "Choose the roll's look.",
  input: Type.Object({ options: Type.Array(Type.String()) }), output: Type.Object({ choice: Type.String() }) });

export default workflow({
  name: "roll", models, mcp, agents: [colorist], mcpTools: [search], orchestrators: [pickLook],
  input: Type.Object({ sheet: Type.String() }), output: Type.Any(),
  run: async (ctx, input) => {
    const refs = await ctx.call(search, { q: "film looks" });       // journaled MCP call
    const s = ctx.session(colorist);                               // agents only through sessions
    let look = await s.call({ sheet: input.sheet });
    look = await s.call({ sheet: "too yellow" });                  // same conversation
    const { choice } = await ctx.call(pickLook, { options: [look.look, "cool3"] });  // asks you
    return { refs, choice };
  },
});
```

- `ctx.call` takes commands, nested workflows, MCP tools and orchestrator
  nodes; agents go through `ctx.session(agent).call(input)`. A second call
  of a session while one is in flight is refused (`session_busy`).
- Every agent has `ask(message)`: its question goes to you; your reply is
  the tool's result. An agent that ends its turn without a result asks too.
- A tool whose annotations say it writes outside must be under `ask`
  (preflight refuses it otherwise). Body MCP tools are direct only.
- Sandboxes (`defineSandbox`) are bwrap, read-only mounts, no network.
- Branches with several steps run in `ctx.parallel` / `ctx.map`.

## Orchestrating a run

- `wallis describe <workflow>`: its input, agents and the questions it may
  ask you (orchestrator nodes, with answer schemas).
- `wallis run <workflow> --input '<json>'`, then `npx wallis wait <run>` in
  the background: it returns when something needs you.
- `wallis pending --json` / `status <run> --json` / `wait --json`: every
  pending item with its kind and `actions` (verbs and argument schemas).
- `wallis send <run> <node> "<text>" [--turns n]`: an idle agent gets it as
  the reply; a running one gets it after its current turn (a steer). The
  output says which.
- `wallis submit <run> <node> '<json>'`: an orchestrator node's result
  (checked against its schema), or an approval: `{"type":"approve"}` or
  `{"type":"reject","reason":"..."}`.
- `wallis interrupt <run> <node>`: stops the node's turn; then `send`.
- `wallis restart <run> <node> [note]`, `cancel <run> [--node n]`,
  `pause <run>`, `resume <run> [--budget turns=n] [--model alias=m]`,
  `fork <run>`.
- Questions reach you without the run's context: answer from the item.
  Forks share you as their orchestrator. A restart re-calls the outside
  (tools, approvals): that is not reproduction.

The same verbs are MCP tools of `wallis serve`: run, describe, send,
submit_result, interrupt, restart, cancel, pause, resume, get_run,
pending, wait.
