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
//       | AgentReturned(id, output, emits, usage, model)
//       | AgentIdle(id, message, usage, model) | AgentFailed(id, error, usage, model)
//       | ExecutorFailed(id, error) | RetryUnavailable
//       | ScriptReturned(id, output, minutes) | ScriptFailed(id, error, minutes)
//       | Sent(node, text, message_id) | AliasRebound(alias, from, to)
//       | BudgetRaised(kind, limit) | ExecutorChanged(name) | CancelRequested
//       | BodyFinished(output) | BodyFailed(FailReason)
// Effect: Checkpoint | CallAgent(.., transcript) | RunScript(..) | Deliver(id, value)
//       | Fail(id, FailReason) | Refuse(Option(id), Refusal) | Finish(Outcome)
```

- Prototype choice: the body talks to the core only through `Requested`
  events: `Call` (agent), `Script`, `Read` (a view of the state) and
  `Commit` (body writes, `ctx.emit`). Each is answered in one of three ways:
  - `Deliver`;
  - `Fail(id, FailReason)`, which the SDK throws as `AgentFailed` or
    `ScriptFailed`;
  - `Refuse(Some(id), Refusal)`, which it throws as `Refused` with the
    typed refusal.

  `Refuse(None, Refusal)` means the event itself was refused and not
  applied. The host decides what that means for the source of the event:
  - a refused `Resumed`, or a path divergence during replay, ends the
    session;
  - a refused send is reported to the sender.
- Prototype choice: strings appear only at the leaves of `Refusal`,
  `FailReason`, `IdleReason` and the statuses; nothing matches on message
  text.
- Prototype choice: `Checkpoint` means "append the event just stepped to the
  log". The core emits it for every event that changes the run, and not for
  replayed requests, `Resumed` or refused events.
- Prototype choice: the host holds `RunState` as an opaque handle;
  `step_json` and `snapshot_json` carry events, effects and state snapshots
  as JSON text.
- Prototype choice: request ids come from the body's branch path and a
  per-branch counter: `#0`, `#1`, `#2.a#0` (branch `a` of the parallel at
  `#2`), `#3>retry#0` (sub-workflow `retry` at `#3`). The order results
  arrive in does not change them.
- Prototype choice: decoders and encoders in `types.gleam` come from the
  Gleam language server code actions, driven headless by
  `tools/gleam-codegen.mjs`. The recursive JSON `Value` decoder is
  hand-written, because the action cannot generate it.

## Run and node status (decided)

- Run: `Running | Idle(Option(IdleReason)) | Finished(Outcome)`.
  - `Outcome = Done(value) | Failed(FailReason) | Cancelled`.
  - `IdleReason = BudgetExhausted(kind, spent, limit) | ExecutorUnavailable(alias, error)`.
  - `FailReason = BodyError(message) | AgentGaveUp(agent, error) | ScriptCrashed(script, error)`.
- Node (one agent call and its conversation): `Running | Idle(last_message) | Done(Submitted | GaveUp(error))`.
  An idle node is always waiting for a message.
- A refused resume or request does not change the persisted status.
- `stopped` is derived at query time: the run is not finished and no live
  process holds its lock. It is never logged.

Prototype choices:

- The status is derived from the requests, not stored:
  - `Running` while any call or script is in flight;
  - otherwise `Idle(Some(reason))` for the first request, by id, that is
    blocked on budget or an executor fault;
  - otherwise `Idle(None)` if a node waits for a message;
  - otherwise `Running` (the body is computing).
- Nodes are agent calls that started a conversation. Calls blocked on budget
  or an executor fault are not nodes yet; the run's idle reason names them.
- The lock is `<run>/lock` with the driver's pid. A lock whose pid is dead is
  stale.

## Asking the human (decided)

An agent that ends its turn without submitting a result makes its node
`Idle(last_message)`; the message is the question. `send(run, node, text)`
is allowed only to an idle node: it appends a user message to the same
conversation and the agent continues. The send is a logged event. There is
no `defineHuman`: a workflow-level question is an agent node that asks.

Prototype choices:

- `CallAgent` carries the transcript after the first prompt: the agent's
  messages and the replies. Executors can therefore be stateless, and a
  continued call after a crash is reissued with the whole transcript.
  Replaying an idle node does nothing; the idle turn is not run again.
- `Sent` carries a `message_id` chosen by the sender. The host uses it to
  apply each inbox entry once; the core ignores it.

## Notification and the MCP server (decided)

- `wallis wait <run>` blocks until something new needs attention, prints an
  agent-readable summary and exits; harnesses run it in the background.
- `wallis pending` lists idle nodes and idle runs under the current
  directory, and prints nothing when there are none (for a
  UserPromptSubmit-style hook).
- `wallis serve` is a stdio MCP server with the tools `run`, `send`,
  `get_run`, `cancel` and `wait`. `wait` is a long poll with a server-side
  cap. Every result appends what is pending. The `run` result and the
  server instructions tell the caller to run `npx wallis wait <run_id>` in
  the background.

Prototype choices:

- Runs live in `.wallis/runs/<run_id>/`: `log.jsonl`, `meta.json`, `lock`,
  `inbox.jsonl` and `inbox.jsonl.done`. A run id is
  `<workflow>-<UTC stamp>-<4 hex>`.
- A session drives a run until it is finished or idle, then releases the
  lock and exits. The next session resumes it.
- `send` and `cancel` append an inbox entry. A live driver polls the inbox
  every 100 ms. If no process holds the lock, the CLI starts a detached
  driver. The command returns once the entry is taken: its send is logged,
  or it is marked done.
- What `wait` returns:
  - it returns at once if the whole run is finished, idle or stopped;
  - otherwise it waits for a node to become idle that was not idle when the
    wait began.
- The `wait` cap is 30 s. A timeout returns "still running" (exit code 2 in
  the CLI).
- The executor is a module whose default export returns
  `{ executor, scripts? }`. It is passed with `--executor`, recorded in
  `meta.json`, and reused on resume. There is no default executor until pi
  is built.

## Recovery (decided)

- Result-defining changes are refused on resume: workflow digest, pinned
  files, seed, and the core's semantics version.
- Operational changes are allowed, and each is a logged event:
  - alias remaps (`AliasRebound`);
  - budget raises (`BudgetRaised`);
  - executor changes (`ExecutorChanged`).
- The journal key does not include the model. Every completed agent call
  records its resolved model. Completed calls are never re-executed; later
  calls, and idle nodes when they continue, use the new binding.
- Executor errors are not agent failures. A provider, auth or billing error
  leaves the call incomplete and the run `Idle(ExecutorUnavailable)`. After
  a fix or rebind, resume reissues the call. Agent failures (bad output,
  maxTurns) reach the body as typed errors.
- A spent budget pauses the run (`Idle(BudgetExhausted)`); a raise continues
  it.
- `wallis fork <run> --at <events|node> [--model ...]` copies a log prefix
  into a new run and leaves the original untouched.
- Out of scope: resuming with changed workflow code.

Prototype choices:

- The semantics version is a constant in the core (`wallis-core/2`).
- Resume order:
  1. refold the log;
  2. `Resumed` (only result-defining fields are compared);
  3. `ExecutorChanged` and `AliasRebound`;
  4. replay the body;
  5. `BudgetRaised`, `RetryUnavailable`, sends, inbox.

  Replaying a blocked or unavailable request does not reissue it. Only the
  logged `BudgetRaised` or `RetryUnavailable` does, so a refold reaches the
  same state. `RetryUnavailable` is logged only when it reissues something.
- Any executor exception other than `AgentFailure` is treated as an
  executor fault (the run pauses, nothing is recorded as a failure).
- Forking `--at <node>` keeps the events up to and including that node's
  request, so the fork issues it again; `--at <n>` keeps the first n events.

## Schemas at the boundary (decided)

Schema style: workflows write schemas as TypeBox, either as builders or as
`Type.Script` modules (TS syntax). Constrained types (`maxLength`,
`minimum`, integers) are builders passed in as the Script context:
`Type.Script({ ShortText: Type.String({ maxLength: 500 }) }, "type F = { statement: ShortText }")`.
`Options<...>` inside a Script string is not applied by typebox 1.3.27, so it
is not used. The SIDERIUS example uses Script modules for its named shapes
and keeps builders for small inline ones.

- Scripts declare TypeBox args and outputs (`defineScript`), and
  `ctx.script(script, args)` is typed by them.
- Every state field has a write schema, enforced for every write: `ctx.emit`,
  executor `emits` and declared `writes` mappings.
- The executor gets the agent's output JSON Schema (for provider-side
  structured output). Its `submit_result` validates against it and returns
  the errors to the model, which retries within its turn. Only giving up or
  exceeding maxTurns is an agent failure.

Prototype choices:

- Each value is checked twice, with the same TypeBox check (`schemaErrors`):
  in the sandbox before it is sent or delivered, and in the host before it
  is logged. What a mismatch becomes depends on where it comes from:

  | Source | Mismatch becomes |
  | --- | --- |
  | Body: agent input, script args, `emit` | `SchemaError`; nothing is logged |
  | Script output | `ScriptFailed` |
  | Agent output, emits, mapped writes | Agent failure; nothing is committed |
- The write schema follows the reducer:

  | Reducer | Write schema |
  | --- | --- |
  | `append`, `topK`, `appendByKey` | the item schema |
  | `freeze`, `replace` | the value schema |
  | `union` | an array of the item schema |
  | `sum` | number |
  | `countByKey` | string or array of strings |

  Item and value schemas are required arguments.
- The log keeps only a call's final valid output, with the usage of the whole
  call.

## State, views and reducers (proposed)

- One state per run. Agents never touch it directly: they read through a view
  and write through reducers.
- A view selects fields, caps size (`maxChars`, `maxItems`), records omitted
  counts and filters what an agent must not see. Views order output from
  stable to volatile and render canonically for prompt caching; windows grow
  in chunks so most calls only append.
- Reducers are built-in deterministic merges only (owner decision, round 3):
  `replace`, `append`, `union`, `sum`, `countByKey`, `topK`, `appendByKey`
  and `freeze`. Anything custom or LLM-based (consolidating findings,
  pruning a history) is ordinary workflow code: agent calls and plain
  functions, with the result written back through `replace`. The SDK has
  plain pruning helpers for that: `lastN`, `perKey`, `topKBy` and
  `dedupeBy`. Commutative-monoid reducers may run in parallel branches;
  others merge once, in declaration order, at the join.
- Each agent call is a transaction with snapshot isolation. Reads come from
  the initial view (push) or a capped `state_read` tool (pull). Writes
  (`submit_result`, `emit()`) are buffered and applied atomically at call end.
  Changes from other branches become visible at the next call boundary only.
- Optional persistent sessions get an appended delta message per call instead
  of a full re-render, with a periodic reset.
- Sub-workflows own their state and return only their output.

Prototype choices:

- Commutativity: `union`, `sum`, `countByKey` and `topK` without
  `keepLatest` are commutative. `replace`, `append`, `appendByKey`, `freeze`
  and `topK` with `keepLatest` are not. A non-commutative write
  from a parallel branch is refused (the request gets `Refuse`, nothing is
  written). Merging such writes at the join is not built.
- Reducer details: `union` stores items sorted by canonical value. `topK`
  breaks score ties by canonical value; unscored entries sort last. With
  `key`, a new entry replaces the old entry with that key. `keepLatest` keeps
  the latest write plus the top k of the others. `freeze`: the first write
  wins, later writes are ignored. `appendByKey` never prunes.
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
  - a different digest is refused as `PathDiverged`, and the session ends;
  - a completed request is answered from the journal;
  - a request that was in flight is issued again with its original view and
    transcript, and with the model its alias resolves to now;
  - an idle node, a call blocked on budget and a call the executor could not
    serve are left alone (see Recovery).

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
  - `models`: the resolved alias table. It is recorded but is operational,
    so it is not compared; see Recovery.
  - `seed`;
  - `inputs`: the sha256 of each file in the workflow's `pin.files`, which
    are relative to the project root;
  - `semantics`: the core's semantics version.

  On resume, `workflow_digest`, `seed`, `semantics` and `inputs` are
  compared in that order. The first mismatch is refused as
  `PinMismatch(field, recorded, current)`.
- Budget fields:
  - `usd`, `tokens`, `turns` (run totals) and `computeMinutes`.
  - Once spend reaches a limit, the next call or script is logged but
    paused, not refused. In-flight calls are not reserved, so parallel calls
    can overshoot by what is in flight.
  - Each call gets `maxTurns = min(agent.maxTurns, turns left)`.
  - `RunScript` carries the compute minutes left.

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
`workflow`, `view`, `defineScript`, the reducers, TypeBox's `Type`, and the
typed errors `Refused` (with `refusal`), `AgentFailed` (`agent`, `error`),
`ScriptFailed` (`script`, `error`) and `SchemaError` (`subject`, `errors`). `env = { models, state?, mcp? }` exists for typing:
- an agent's `model` is `keyof` the alias table;
- `view.fields` and `writes` keys are state fields;
- `writes` values are output keys;
- `mcp` keys are servers in the imported `mcp.json`.

The body gets these context methods:
- `ctx.call`, typed by the agent's TypeBox schemas and checked at run time;
- `script`, typed by the script's schemas;
- `read`;
- `emit`, typed and checked by the field's write schema;
- `parallel`, `sub` and `seed`.

An uncaught `AgentFailed` or `ScriptFailed` ends the run as
`AgentGaveUp`/`ScriptCrashed`; anything else ends it as `BodyError`. This is
a draft answer to open item 4. There are no workflow version declarations
(owner decision).

## Executors (proposed)

`CallAgent` is an effect; the executor is a handler. v0 implements pi only.
Other executors need an LLM loop, an MCP client restricted to wallis, disabled
built-in tools, a system prompt without ambient context, structured output
and usage reports; unsupported declarations are refused. Notes for Claude
Code 2.1.301: `--bare` gives the cleanest isolation but needs an API key;
subscription auth needs a leak test.

## Prototype status

Built:
- the core (`core/`) and the SDK and host (`host/`);
- sessions with a lock, the CLI (`run`, `resume`, `send`, `cancel`,
  `status`, `wait`, `pending`, `fork`, `serve`) and the stdio MCP server;
- the fake executor (multi-turn conversations, `submit_result` retries,
  executor errors) and the fake script runner;
- examples: `two-node` and `ask`;
- the SIDERIUS example (`.agents/workflows/siderius/`, see its `MAPPING.md`).

Not built yet:
- the pi executor and its preflight capabilities (preflight runs against
  whatever capabilities an executor declares);
- the MCP proxy, `defineTool` serving, `sandbox_exec`, secret injection and
  script sandboxing;
- the `state_read` pull tool and persistent sessions beyond the transcript;
- merging non-commutative writes at a join;
- the local profile file (resolution accepts a profile object);
- declaration approval on first run or digest change.

## Open

1. GitHub owner for the repo and npm package.
2. Budget enforcement point in pi.
3. Codex and Gemini CLI executor capabilities.
4. Exact `defineAgent` / `defineState` / `workflow()` API.
