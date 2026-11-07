# wallis design

Status as of 2026-11-06. Sections are marked **decided** (agreed with the
owner), **proposed** (drafted, not yet confirmed) or **open**.

## Goal (decided)

A workflow is a fixed, declarative composition of agents, committed to a repo
and runnable after a plain clone, like `mcp.json` or `SKILL.md`. Each agent
(a "micro" harness) loads only its declared prompt, model, tools, skills, MCP
servers and sandbox; it may have no filesystem access at all. Workflows are
exposed to every mainstream harness over MCP.

Reference workload: [SIDERIUS](https://github.com/yuema137/SIDERIUS), an
iterative ML research loop. Its task package stays domain code; its framework
layer (carried history, resume, run invariants, accounting) maps onto wallis.

## Files (decided)

```
.agents/workflows/<name>/
  workflow.ts      # entry: declarations + control flow
  *.md             # prompts, imported as text
  mcp.json         # standard MCP config, imported as JSON
  skills/          # standard SKILL.md directories
  scripts/         # domain scripts, run in a sandbox
```

- Prompts: `import p from "./p.md" with { type: "text" }`. The bundler inlines
  them, so the workflow digest covers prompt content.
- MCP: `import m from "./mcp.json" with { type: "json" }`. Agents select a
  subset of servers and tools: `mcp: { arxiv: ["search", "fetch"], scholar: "*" }`.
  `${VAR}` in `env` is a secret reference. Network allowlists live in TS, not
  in the JSON.
- The workflow directory name is the workflow name and its MCP tool name.

## Models (decided)

- The author declares an alias table: `defineModels({ default, reasoner, judge, ... })`.
  Values are concrete pi model strings (`provider/model:thinking`), or empty.
- Agents reference aliases only (type `keyof models`).
- Callers may remap alias values (CLI, local profile, MCP `models` parameter).
  They cannot add aliases or rebind agents. There are no locks.
- Resolution per alias: call-time > local profile (per-workflow beats global) >
  workflow value > `default`. Unresolvable `default` is an error.
- No runtime fallback on model failure.
- The resolved table goes into the event log and the pin. Preflight checks
  auth and each agent's `needs` (structured output, tool calls, context size).

## Runtime (decided)

- Core: pure Gleam compiled to JavaScript, chosen for immutability.
- Default executor: pi. It owns provider auth (including OAuth), the model
  catalog, the agent loop, compaction and usage accounting.

## Core shape (proposed)

```gleam
pub fn step(run: RunState, event: Event) -> #(RunState, List(Effect))
// Event:  AgentReturned | ScriptReturned | Resumed | ...
// Effect: CallAgent | RunScript | Checkpoint | Refuse(reason) | Finish
```

The core decides budget, pin, journal hits, views and reducers. A thin TS host
executes effects and feeds results back as events. Values cross the boundary
as JSON only.

## State, views and reducers (proposed)

- One state per run. Agents never touch it directly: they read through a view
  and write through reducers.
- A view selects fields, caps size (`maxChars`, `maxItems`), records omitted
  counts and filters what an agent must not see. Views order output from
  stable to volatile and render canonically for prompt caching; windows grow
  in chunks so most calls only append.
- Reducers: `replace`, `append`, `union`, `sum`, `countByKey`, `topK`,
  `appendByKey`, `freeze`, `llmMerge` (bounded calls), plus pure script
  reducers. Commutative-monoid reducers may run in parallel branches; others
  merge once, in declaration order, at the join.
- Each agent call is a transaction with snapshot isolation. Reads come from
  the initial view (push) or a capped `state_read` tool (pull). Writes
  (`submit_result`, `emit()`) are buffered and applied atomically at call end.
  Changes from other branches become visible at the next call boundary only.
- Optional persistent sessions get an appended delta message per call instead
  of a full re-render, with a periodic reset.
- Sub-workflows own their state and return only their output.

## Durability (proposed)

- wallis keeps its own append-only event log; run state is a fold over it.
  Resume refolds the log; completed agent calls are answered from the journal
  by input digest.
- The workflow body runs in QuickJS with a virtual clock and seeded
  randomness, so replay is deterministic. A path divergence is an error.
- pi-durable is optional and internal to the pi executor (node checkpoints).

## Pin and budget (proposed)

- Pin: workflow digest (bundled code, prompts, mcp.json), declared input
  files, resolved alias table, seed. A mismatch on resume is refused, naming
  the field.
- Budget: LLM spend (run USD and tokens, per-agent turns) checked before every
  agent call; compute budget (for example training minutes) passed to scripts
  and enforced by the sandbox.

## Tools and sandbox (proposed)

- Executors connect only to wallis. wallis proxies the declared stdio MCP
  servers, enforces per-agent tool allowlists, injects secrets into server
  processes only, logs calls and can rate-limit per node.
- Workflow-defined tools (`defineTool`) and `sandbox_exec` are served the same
  way.
- Loading is sandboxed too: the bundled workflow is evaluated in QuickJS
  without fs or network to obtain declarations, which are shown for approval
  on first run or when the digest changes.

## Executors (proposed)

`CallAgent` is an effect; the executor is a handler. v0 implements pi only.
Other executors need an LLM loop, an MCP client restricted to wallis, disabled
built-in tools, a system prompt without ambient context, structured output
and usage reports; unsupported declarations are refused. Notes for Claude
Code 2.1.301: `--bare` gives the cleanest isolation but needs an API key;
subscription auth needs a leak test.

## Open

1. GitHub owner for the repo and npm package.
2. Budget enforcement point in pi.
3. Codex and Gemini CLI executor capabilities.
4. Exact `defineAgent` / `defineState` / `workflow()` API.
