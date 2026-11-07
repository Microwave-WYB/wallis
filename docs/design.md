# wallis design

Status as of 2026-11-06. Sections are marked **decided** (agreed with the
owner), **proposed** (drafted, not yet confirmed) or **open**. Details the
first prototype had to fix are marked **prototype choice**: the simplest
option consistent with the section they sit in, not yet confirmed.

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

As built (`core/src/wallis_core/types.gleam`):

```gleam
// Event:  Started(workflow, pin, input) | Resumed(pin)
//       | Requested(id, branch, Call | Script | Read | Commit)
//       | AgentReturned(id, output, emits, usage) | AgentFailed(id, error, usage)
//       | ScriptReturned(id, output, minutes) | ScriptFailed(id, error, minutes)
//       | BodyFinished(output) | BodyFailed(error)
// Effect: Checkpoint | CallAgent(..) | RunScript(..) | Deliver(id, value)
//       | Fail(id, error) | Refuse(Option(id), reason) | Finish(outcome)
```

- Prototype choice: the body talks to the core only through `Requested`
  events: `Call` (agent), `Script`, `Read` (a view of the state) and
  `Commit` (body writes, `ctx.emit`). Each is answered by `Deliver`, `Fail`
  or `Refuse(Some(id))`, which reject the body's promise with `AgentFailed`
  or `Refused`. `Refuse(None)` stops the run.
- Prototype choice: `Checkpoint` means "append the event just stepped to the
  log". The core emits it for every event that changes the run, and not for
  replayed requests or `Resumed`.
- Prototype choice: the host holds `RunState` as an opaque handle;
  `step_json` and `snapshot_json` carry events, effects and state snapshots
  as JSON text.
- Prototype choice: request ids come from the body's branch path and a
  per-branch counter: `#0`, `#1`, `#2.a#0` (branch `a` of the parallel at
  `#2`), `#3>retry#0` (sub-workflow `retry` at `#3`). The order results
  arrive in does not change them. A merge call is `<id>/merge/<field>`.
- Prototype choice: decoders and encoders in `types.gleam` come from the
  Gleam language server code actions, driven headless by
  `tools/gleam-codegen.mjs`. The recursive JSON `Value` decoder is
  hand-written, because the action cannot generate it.

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

Prototype choices:

- Commutativity: `union`, `sum`, `countByKey` and `topK` without
  `keepLatest` are commutative. `replace`, `append`, `appendByKey`, `freeze`,
  `llmMerge` and `topK` with `keepLatest` are not. A non-commutative write
  from a parallel branch is refused (the request gets `Refuse`, nothing is
  written). Merging such writes at the join is not built.
- Reducer details: `union` stores items sorted by canonical value. `topK`
  breaks score ties by canonical value; unscored entries sort last. With
  `key`, a new entry replaces the old entry with that key. `keepLatest` keeps
  the latest write plus the top k of the others. `freeze`: the first write
  wins, later writes are ignored. `appendByKey` never prunes.
- `llmMerge`: the merge agent gets `{ current, incoming, max }` and returns
  `{ items, archived }`. Items past `max` are archived too. Each field has a
  per-run call cap. Past the cap, or when the merge call fails, the reducer
  keeps the newest `max` items deterministically. Archived items go through
  the reducer of the declared `archive` field. The call's other writes wait
  for its merges and are applied together.
- Agent writes: an agent declares `writes: { field: outputKey | { emit: true } }`.
  Output keys map to writes when the call ends; `emit` writes must target a
  declared field.
- Views: fields are ordered frozen, then append-only (`append`, `union`,
  `appendByKey`), then volatile, then by declaration order. Append-only
  lists show their newest items, and the window start moves in steps of
  `chunk` (default `maxItems / 4`). Volatile lists show their head. Objects
  show their first `maxItems` keys, and their list values are windowed too.
  Over `maxChars`, the view drops one item at a time from the field showing
  the most; then it truncates the text with a marker. Each field renders as
  `<field name="…" omitted="n">`, then one canonical JSON item per line.
  `omit` removes keys at any depth.
- Snapshot isolation: a call's view is rendered when it is requested. Its
  writes are buffered until it returns and checked atomically: one bad write
  refuses them all.
- Sub-workflows have no state of their own. They get a context without
  `read` or `emit`, and their request ids are prefixed.

## Durability (proposed)

- wallis keeps its own append-only event log; run state is a fold over it.
  Resume refolds the log; completed agent calls are answered from the journal
  by input digest.
- The workflow body runs in QuickJS with a virtual clock and seeded
  randomness, so replay is deterministic. A path divergence is an error.
- pi-durable is optional and internal to the pi executor (node checkpoints).

Prototype choices:

- The journal key is a digest of the request id, kind, name and canonical
  input. The digest is a pure, non-cryptographic 64-bit FNV-1a (two lanes),
  because the core has no FFI. Identical calls at different positions are
  not memoized.
- On resume the host refolds the log into a fresh core, then steps
  `Resumed(pin)`, then reruns the body from the start. The input comes from
  the logged `started` event. Replay rules for a request whose id is already
  recorded:
  - a different digest halts the run (path divergence);
  - a completed request is answered from the journal;
  - a request that was in flight is issued again with its original view.

  The resumed run's log therefore equals an uninterrupted run's.
- The sandbox is `quickjs-wasi` 3.6.2 (the version pi-codemode 1.5.0 uses),
  used directly rather than through pi-codemode. It loads the `encoding`
  extension (TypeBox needs `TextEncoder`) and nothing else. The virtual clock
  starts at 2025-01-01T00:00:00Z and advances 1 ms per read; the timezone is
  UTC; `Math.random` is mulberry32 seeded from the pin. The guest calls a
  synchronous `__wallis_send`; the host answers by calling
  `__wallis_deliver` and draining the job queue.
- The bundle comes from esbuild: `.md` files load as text, `.json` as JSON,
  and `wallis` maps to the SDK. The workflow digest is the sha256 of the
  bundle.
- The log is JSONL, fsynced per line. A partial last line, from a crash
  mid-write, is ignored.

## Pin and budget (proposed)

- Pin: workflow digest (bundled code, prompts, mcp.json), declared input
  files, resolved alias table, seed. A mismatch on resume is refused, naming
  the field.
- Budget: LLM spend (run USD and tokens, per-agent turns) checked before every
  agent call; compute budget (for example training minutes) passed to scripts
  and enforced by the sandbox.

Prototype choices:

- Pin fields:
  - `workflow_digest`;
  - `models`: the resolved alias table;
  - `seed`;
  - `inputs`: the sha256 of each file in the workflow's `pin.files`, which
    are relative to the project root.

  On resume they are compared in that order, and the first mismatch is
  refused as `pin mismatch: <field>`.
- Budget fields:
  - `usd`, `tokens`, `turns` (run totals) and `computeMinutes`.
  - A call is refused once spend reaches a limit. In-flight calls are not
    reserved, so parallel calls can overshoot by what is in flight.
  - Each call gets `maxTurns = min(agent.maxTurns, turns left)`.
  - `RunScript` carries the compute minutes left.
  - Merge calls are checked like any other call. A merge refused for budget
    uses the deterministic fallback.

## Tools and sandbox (proposed)

- Executors connect only to wallis. wallis proxies the declared stdio MCP
  servers, enforces per-agent tool allowlists, injects secrets into server
  processes only, logs calls and can rate-limit per node.
- Workflow-defined tools (`defineTool`) and `sandbox_exec` are served the same
  way.
- Loading is sandboxed too: the bundled workflow is evaluated in QuickJS
  without fs or network to obtain declarations, which are shown for approval
  on first run or when the digest changes.

## SDK (prototype choice)

The `wallis` package in `host/` exports `defineModels`, `defineMcp`,
`defineState`, `defineAgent(env, spec)`, `defineTool`, `subWorkflow`,
`workflow`, `view`, the reducers, TypeBox's `Type`, and the errors `Refused`
and `AgentFailed`. `env = { models, state?, mcp? }` exists for typing:
- an agent's `model` is `keyof` the alias table;
- `view.fields` and `writes` keys are state fields;
- `writes` values are output keys;
- `mcp` keys are servers in the imported `mcp.json`.

The body gets `ctx.call` (typed by the agent's TypeBox schemas and checked at
run time), `script`, `read`, `emit` (typed by the field's reducer),
`parallel`, `sub` and `seed`. This is a draft answer to open item 4.

## Executors (proposed)

`CallAgent` is an effect; the executor is a handler. v0 implements pi only.
Other executors need an LLM loop, an MCP client restricted to wallis, disabled
built-in tools, a system prompt without ambient context, structured output
and usage reports; unsupported declarations are refused. Notes for Claude
Code 2.1.301: `--bare` gives the cleanest isolation but needs an API key;
subscription auth needs a leak test.

## Prototype status

Built: the core (`core/`), the SDK and host (`host/`), a fake executor and
script runner, the two-node example with a kill-and-resume test, and the
SIDERIUS example (`.agents/workflows/siderius/`, see its `MAPPING.md`).

Not built yet:
- the pi executor and preflight;
- the MCP proxy, `defineTool` serving, `sandbox_exec`, secret injection and
  script sandboxing;
- the `state_read` pull tool and persistent sessions;
- pure script reducers and merging non-commutative writes at a join;
- the local profile file (resolution accepts a profile object);
- declaration approval on first run or digest change;
- the MCP server exposing workflows to harnesses.

## Open

1. GitHub owner for the repo and npm package.
2. Budget enforcement point in pi.
3. Codex and Gemini CLI executor capabilities.
4. Exact `defineAgent` / `defineState` / `workflow()` API.
