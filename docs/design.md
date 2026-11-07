# wallis design

Status as of 2026-11-06 (round 4). Sections are marked **decided** (agreed with the
owner), **proposed** (drafted, not yet confirmed) or **open**. Details the
first prototype had to fix are marked **prototype choice**: the simplest
option consistent with the section they sit in, not yet confirmed.

## Governing principle (decided, round 4)

Types make illegal states unrepresentable. Where types cannot reach (time,
external input), the core re-checks when it applies an event and returns a
typed refusal. Nothing is ever silently dropped.

Three rules, kept minimal (no generics or wrappers that add no proof):

1. **Every lifecycle is a discriminated union.** Each variant carries only
   the data meaningful in that state (run status, node, agent failure,
   inbox entry, effect).
2. **A capability is obtainable only through its check.** Gleam: opaque
   types in `core/src/wallis_core/capability.gleam` whose only constructor
   is the check. TS: classes with private constructors in
   `host/src/host/capability.ts`, narrowed with `instanceof`; the node data
   inside them is narrowed by the compiler (`node.type === "node_running" &&
   node.steerable`), not by hand-written predicates.

   | Capability | Check | Needed for |
   | --- | --- | --- |
   | `OwnedRun` | `checkOwner` (the human, or the run's owner) | every intervention |
   | `IdleNode` | idle node of a steerable agent; takes an `OwnedRun` | answer |
   | `SteerableNode` | running node of a steerable agent; takes an `OwnedRun` | steer, interrupt |
   | `LiveNode` | a node that is not done; takes an `OwnedRun` | restart, cancel one node |
   | `ResumableRun` | `checkPin` | replaying a resumed run |

   The host checks before it sends an event; the core checks again when it
   applies it, because time passes in between. Brands exist only where raw
   ids cross a boundary: `RunId` and `NodeId`, parsed from CLI and MCP input.
3. **Everything at a boundary is `unknown` until parsed** with its schema:
   model output, script output, MCP and CLI arguments, and artifact refs
   (verified against the run's store). No `as` casts at those boundaries.
   (The core's own JSON, produced by generated encoders, is trusted.)

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

## Core shape (decided, round 4)

```gleam
pub fn step(run: RunState, event: Event) -> #(RunState, List(Effect))
```

The workflow is a pure program over journaled calls. The body is
deterministic, and its only interface to the world is typed calls:
`ctx.call` (agents), `ctx.script`, `ctx.parallel` and `ctx.sub`. Each call
affects the body only through its return value. A run is a fold of the
body over its journal; resume, replay and fork all work this way. **Run
memory is the body's local variables**, rebuilt on replay. Agents never
pull workflow memory: the body pushes everything an agent needs into its
typed input.

The core therefore holds no workflow state. It keeps the journal, replay
matching, budget, pin, status, ownership and the interventions. A thin TS
host executes effects and feeds results back as events. Values cross the
boundary as JSON only.

As built (`core/src/wallis_core/types.gleam`):

```gleam
// Event:  Started(workflow, pin, input) | Resumed(pin) | Requested(id, Call | Script)
//       | AgentReturned(id, output, usage, model) | AgentIdle(id, message, usage, model)
//       | AgentFailed(id, AgentFailure, usage, model) | ExecutorFailed(id, error)
//       | InputRejected(id, field?, chars, limit)
//       | ScriptReturned(id, output, minutes) | ScriptFailed(id, error, minutes)
//       | Observed(at, label, value)
//       | Sent | Steered | Interrupted | Restarted | NodeCancelled   (each with `by`)
//       | CancelRequested(by) | PauseRequested(by) | ResumeRequested(by) | Claimed(owner)
//       | AliasRebound | BudgetRaised | ExecutorChanged | RetryUnavailable
//       | BodyFinished(output) | BodyFailed(FailReason)
// Effect: Checkpoint | CallAgent(id, agent, model, input, max_turns, digest, transcript, note)
//       | RunScript(..) | Deliver(id, value) | Fail(id, FailReason)
//       | Refuse(Option(id), Refusal) | Finish(Outcome)
// AgentFailure = GaveUp(error) | ContextExhausted | CancelledByOwner
```

- Removed in round 4 (owner decision): `defineState`, state fields and
  reducers, the commutativity rules and parallel-branch write checks; views
  and agent `view`s, and rendering state into prompts; `emit`, `writes`
  mappings and the `state_read` and `emit` tools; the round-3 SDK helpers
  (`lastN`, `perKey`, `topKBy`, `dedupeBy`). Workflow code uses plain JS.
- **`ctx.observe(label, value)`** is monitoring only: logged for `wallis
  show`, `tree` and `status`, never returned to the body, never matched on
  replay.

Prototype choices:

- Every request is answered in one of three ways: `Deliver`; `Fail(id,
  FailReason)`, which the SDK throws as `AgentFailed` (with the typed
  `failure`) or `ScriptFailed`; or `Refuse(Some(id), Refusal)`, thrown as
  `Refused`. `Refuse(None, Refusal)` means the event itself was refused and
  not applied. The host decides what that means for the source:
  - a refused `Resumed`, or a path divergence during replay, ends the
    session;
  - a refused intervention is reported to its sender (and, for inbox
    entries, written to `inbox.jsonl.refused`).
- Strings appear only at the leaves of `Refusal`, `FailReason`,
  `AgentFailure`, `IdleReason` and the statuses; nothing matches on message
  text.
- `Checkpoint` means "append the event just stepped to the log". The core
  emits it for every event that changes the run, and not for replayed
  requests, replayed observations, `Resumed` or refused events.
- The host holds `RunState` as an opaque handle; `step_json` and
  `snapshot_json` carry events, effects and snapshots as JSON text.
- Request ids come from the body's branch path and a per-branch counter:
  `#0`, `#1`, `#2.a#0` (branch `a` of the parallel at `#2`), `#3>retry#0`
  (sub-workflow `retry` at `#3`). Observations take their own per-branch
  counter (`~0`, `#2.a~0`), so adding or removing one never shifts a
  request id. A replayed observation with the same position is not logged
  again, whatever its value.
- Intervention events carry `by`, the sender's identity. The core applies
  them only through `check_owner` (the human, or the owner) and the node
  checks; ownership changes (`Claimed`) are not owner-checked, since who may
  claim depends on whether the owner process is alive, which the core
  cannot see.
- Decoders and encoders in `types.gleam` come from the Gleam language
  server code actions, driven headless by `tools/gleam-codegen.mjs`. The
  recursive JSON `Value` decoder is hand-written.

## Run and node status (decided)

- Run: `Running | Idle(Option(IdleReason)) | Finished(Outcome)`.
  - `Outcome = Done(value) | Failed(FailReason) | Cancelled`.
  - `IdleReason = BudgetExhausted(kind, spent, limit) | ExecutorUnavailable(alias, error) | PausedByUser`.
  - `FailReason = BodyError(message) | AgentGaveUp(agent, AgentFailure) | ScriptCrashed(script, error)`.
- Node (one agent call and its dialogue), one variant per state:
  `NodeRunning | NodeIdle(question) | NodeDone(Submitted | NodeFailed(AgentFailure))`.
  Every variant carries `id`, `agent`, `model`, `steerable` and `inbox`. An
  idle node is always waiting for an answer.
- A refused resume or intervention does not change the persisted status.
- `stopped` is derived at query time: the run is not finished and no live
  process holds its lock. It is never logged.

Prototype choices:

- The status is derived from the requests, not stored:
  - `Running` while any call or script is in flight;
  - otherwise `Idle(PausedByUser)` if paused;
  - otherwise `Idle(Some(reason))` for the first request, by id, that is
    blocked on budget or an executor fault;
  - otherwise `Idle(None)` if a node waits for an answer;
  - otherwise `Running` (the body is computing).
- Nodes are agent calls that started a dialogue. Calls held back by a
  pause, the budget or an executor fault, and calls refused before they
  started (`input_too_large`), are not nodes.
- In TS the node is a union whose `steerable` is a literal in each member,
  so `node.type === "node_running" && node.steerable` narrows to the
  steerable running variant.
- The lock is `<run>/lock` with the driver's pid. A lock whose pid is dead is
  stale.

## An agent is a function (decided, round 4)

An agent call is `(input, inbox) → dialogue → Submitted(output) | AgentFailure`.

- Ending a turn without `submit_result` makes the node `Idle`; its last
  message is the question.
- Executor errors are not agent failures; they pause the run (see Recovery).
- The inbox:

  | Message | Reaches | Effect | Capability |
  | --- | --- | --- | --- |
  | `answer` | an idle node | continues the dialogue | `IdleNode` |
  | `steer` | a running node | delivered at the next step boundary, progress kept | `SteerableNode` |
  | `interrupt` | a running node | aborts the current step, then delivers the message, progress kept | `SteerableNode` |
  | `restart` (a separate operation) | a node that is not done | discards progress and reissues the call with the original input plus an operator note; logged | `LiveNode` |
  | cancel one node | a node that is not done | an agent failure (`cancelled_by_owner`) for the body | `LiveNode` |

- **`steerable: boolean`** on agents, default true. A non-steerable node
  accepts only cancel and restart: no answers, steering or interrupts. The
  MCP `steer` and `interrupt` tool schemas enumerate only steerable agent
  names, generated from the declarations. The SIDERIUS evidence judge is
  `steerable: false`.
- Every message is logged per node: the node's journal entry records which
  messages arrived and at which step (its model turns so far).

Prototype choices:

- `CallAgent` carries the transcript after the first prompt: the agent's
  messages and the answers and steers. Executors can therefore be
  stateless, and a continued call after a crash is reissued with the whole
  transcript. Replaying an idle node does nothing.
- `Sent` and `Steered` carry a `message_id` chosen by the sender; the host
  uses it to apply each inbox entry once.
- An interrupt is logged as `Interrupted`; its message follows as an
  ordinary answer (`Sent`) once the aborted turn has ended.
- A restart's note is refused for a non-steerable node (`not_steerable`); a
  restart without a note is allowed. A call still held back by a pause or
  the budget has no dialogue yet and is refused (`node_not_running`); the
  restart of an unavailable call reissues it at once.
- On restart the host closes the node's session and deletes its dirs
  before the core reissues the call. A turn of the old session that ends
  later is discarded, with a note in the node's transcript; its usage is
  not counted (prototype limit: pi aborts quickly, the fake at once).
- The step of an inbox message is the node's model turns as the core knows
  them (sums of `usage.turns` of its finished turns); the exact step at
  which an executor applied a steer is in the node's transcript.

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

## Ownership and notification (decided, round 3)

- A run records its owner. A run started over MCP is owned by the harness
  process: the parent of `wallis serve`. A CLI caller's owner is its nearest
  harness ancestor, or the human when there is none.
- `wallis wait` with no run waits on the caller's own runs. `wait <run>`,
  `send`, `cancel`, `resume` and `fork` work only on own runs, with a clear
  error otherwise.
- The human at a terminal with no harness ancestor owns everything.
  Read-only queries work on any run.
- `wallis claim <run>` reassigns ownership, as a logged event (`Claimed`).
- `wallis pending` lists only own runs, and mentions unowned runs that can
  be claimed.
- Notifications carry content: run, node, the question or a result summary
  (truncated), and how to answer. They go through a `Notifier` interface.
  The backends now are the background `wait`, the pending hook, and pending
  items appended to MCP tool results; a Paseo backend comes later.

Prototype choices:

- Identities are `human` or `harness:<name>:<pid>:<start time>`, read from
  `/proc` (the start time makes a reused pid a different owner).
  `WALLIS_OWNER` overrides the caller's identity, for tests and scripted
  callers.
- Harness names: claude, codex, cursor-agent, cursor, gemini, pi, opencode,
  aider, goose, amp, paseo. They are matched on the process name or the
  first arguments, and `WALLIS_HARNESSES` overrides the list.
- A run is claimable when it is unfinished and its owner is gone: a harness
  pid that no longer exists with that start time, or no owner at all. An
  owner without a pid (from `WALLIS_OWNER`) counts as alive.
- `Claimed` is accepted on finished runs too. Without a live driver, the
  CLI applies it under the run's lock; otherwise it goes through the inbox.
- A fork is claimed by whoever forked it.
- Truncation: questions at 1200 characters, result summaries at 600.

## Monitoring and steering (decided, round 3; revised round 4)

- **Per-node transcripts** live in `.wallis/runs/<id>/nodes/<node>.jsonl`:
  messages, tool calls (direct and nested), results, spills and
  compactions. They are observational only and never affect replay.
- **Observations** (`ctx.observe`) are logged events; `wallis status`
  prints the latest value per label, `wallis tree` shows each one at its
  position, `wallis show <run>` lists them.
- **CLI:** `wallis ls`, `wallis tree <run>`, `wallis log <run> [--follow]`,
  `wallis show <run> [<node>]`; interventions `send` (answer), `steer`,
  `interrupt`, `restart`, `cancel --node`, `pause`, `resume`.
- **MCP tools for the owner:** `list_runs`, `run_tree`,
  `node_transcript(run, node, since?, limit?)` and `run_log(run, since?)`,
  all capped with cursors; `send`, `steer`, `interrupt`, `restart`,
  `pause`, `resume`, and `cancel` with an optional `node_id`.
- **`pause` and `resume`:** pause issues no new calls, and the run goes
  `Idle(PausedByUser)` once in-flight work ends; resume continues.
- Steering changes only the node's eventual output, which is journaled, so
  workflow replay stays deterministic.

Prototype choices:

- `Steered` appends a user message to the node's dialogue in the core. A
  node reissued after a crash therefore carries the steer.
- Pause is an admission state in the core (`Admitting | Holding`). A held
  request is `Blocked(PausedByUser)`, and `ResumeRequested` issues it like a
  budget raise. A pause or resume that changes nothing is not logged.
  `wallis resume` (and MCP `resume`) also lifts a pause.
- Interventions from another process go through the run's inbox
  (`inbox.jsonl`), each carrying `by`. The driver checks the capability
  against the live run and applies it; a refused entry is written to
  `inbox.jsonl.refused` with its typed refusal. Without a driver, pause and
  cancel-node are applied under the lock, and the CLI starts a driver for
  the others; steer and interrupt need a running node and are refused
  otherwise.
- Pages: at most 200 entries (default 50), each truncated to 2000
  characters; the cursor is the next entry index.

## Many runs on one machine (decided, round 3)

- **Resource slots.** Scripts declare `resources: { gpu?, memoryGb? }`. They
  take machine-wide flock slots, like `~/.local/bin/build-guard`, and run in
  `systemd-run --user --scope -p MemoryMax=...`.
- **Concurrency limits.** The local profile sets per-provider limits on LLM
  calls (`providers`), also through flock.
- **Run hosts** start detached via
  `systemd-run --user --unit wallis-run-<id> -p Restart=on-failure` when
  available, with a plain detached fallback. Hosts exit when the run is
  idle or finished.

Prototype choices:

- Slots are lock files in `$XDG_RUNTIME_DIR/wallis/slots/<kind>/slot<i>`,
  held by `flock -n` in a child process for as long as the work runs.
- Kinds: `gpu` (one file per GPU) and `memory` (one file per GB, from the
  profile's `slots`). A script needing more than the machine has is refused.
  Waiting slots poll every 500 ms.
- Provider limits wrap the executor: each `turn()` holds one
  `provider-<name>` slot. The provider is the model string up to the first
  `/`, and follows rebinds.
- `WALLIS_HOST=systemd|plain` overrides host detection. Tests use `plain`,
  so a SIGKILL test is not restarted by systemd.
- A systemd host gets the caller's `WALLIS_*`, `PATH`, `HOME`, `LANG`,
  `XDG_*`, `*_API_KEY`, `*_TOKEN` and `*_BASE_URL` variables.
- A host that finds its run already driven exits 0 (nothing to do), so
  systemd does not restart it. `send`/`cancel` start at most one host per
  handoff.
- Script memory scopes use `systemd-run --user --scope` only when the script
  declares `memoryGb` and systemd works. The scope wraps bwrap, which keeps
  its clean environment inside.

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
is not used.

- Scripts declare TypeBox args and outputs (`defineScript`), and
  `ctx.script(script, args)` is typed by them.
- The executor gets the agent's output JSON Schema (for provider-side
  structured output). Its `submit_result` validates against it and returns
  the errors to the model, which retries within its turn. Output caps come
  back to the model the same way, as validation errors. Only giving up or
  exceeding maxTurns is an agent failure.

Prototype choices:

- Each value is checked twice, with the same TypeBox check (`schemaErrors`):
  in the sandbox before it is sent or delivered, and in the host before it
  is logged. What a mismatch becomes depends on where it comes from:

  | Source | Mismatch becomes |
  | --- | --- |
  | Body: agent input, script args | `SchemaError`; nothing is logged |
  | Script output | `ScriptFailed` |
  | Agent output | Agent failure (`gave_up`); nothing is logged as a result |
- Executor and script outputs arrive as `unknown`. The host parses them in
  order: plain JSON (`toJson`), artifact drafts stored, every artifact ref
  verified against the run's store, then the schema.
- The log keeps only a call's final valid output, with the usage of the whole
  call.
- A submitted result over 100 000 characters of JSON is a validation error
  for the model (`OUTPUT_CAP`).

## Large inputs (decided, round 4)

- Fields render in full by default. `Foldable(T, { maxChars })` marks a field
  that may be folded: if its canonical JSON is at most `maxChars` it renders
  in full; otherwise it renders as a deterministic, size-bounded skeleton
  (item counts, field names, a truncated head of long strings), and the
  prompt lists the folded paths.
- The full input is always the JS `input` variable inside codemode. There
  are no separate input query tools.
- **Window check:** before a call's first request, the host checks the
  rendered prompt and input against the resolved model's context window at
  a conservative 3 characters per token. If it does not fit, the call is
  refused with a typed `InputTooLarge(agent, field?, chars, limit)`, logged
  as `InputRejected` and answered from the journal on replay. There is no
  global input budget.

Prototype choices:

- `Foldable` sets the JSON Schema keyword `x-wallis-fold: { maxChars }`;
  TypeBox ignores it when checking. The renderer follows `properties` and
  `items`; a mark inside a union is not seen.
- Skeletons: strings over 200 characters become `{ folded: "string", chars,
  head }`; arrays `{ folded: "array", items, first }`; objects `{ folded:
  "object", keys, fields }` with at most 20 keys; two levels deep.
- The window check names the largest top-level input field, or none when the
  input is not an object. It runs only when the executor reports the
  model's window (`Executor.contextWindow(model)`: pi's model catalog; the
  fake takes it as an option).
- The rebound model of a later resume does not lift a refusal already
  journaled; a fork before the call does.

## Context protection (decided, round 4)

Every entry into an agent's context is capped, and overflow is never
silent:

- A direct tool result or a codemode output over the cap is cut; the full
  text is spilled to the node's spill dir, with an explicit marker naming
  it and the `read_spill` call that pages it from the next script.
- Before each model request, the executor checks the context against the
  resolved model's window. By default it compacts with pi's summarizer
  (logged); with `compaction: false` the call fails as
  `AgentFailure(context_exhausted)`.

Prototype choices:

- The cap is 16 000 characters per result (`RESULT_CAP`, about 5 000 tokens).
  Spills are `work/<node>/spill/<n>.txt`, host-owned and deleted with the
  node's dirs; `read_spill` returns pages of at most 8 000 characters with
  the next offset.
- pi compaction keeps the first prompt and the most recent messages (at most
  20 000 tokens or a quarter of the budget) and replaces the rest with a
  summary from pi-coding-agent's `generateSummary`, through the same
  provider. The budget is 80% of the window; message size is the larger of
  pi's `estimateTokens` and 3 characters per token. A dialogue still over
  the budget after compaction fails as `context_exhausted`.

## Artifacts and per-node workspaces (decided)

- **Artifacts.** Files handed downstream are typed artifacts in outputs:
  `Artifact(media)` = `{ digest: "sha256:…", name, media }`. The host copies
  each into the run's content-addressed store, `.wallis/runs/<id>/blobs/`.
  The journal and replay carry refs only. A fork shares blobs (hardlink, or
  copy across filesystems).
- **Sandbox levels:**
  - `none`: no filesystem tools at all;
  - `read-only`: its input artifacts and its declared mounts, read-only;
  - `workspace`: the same plus a private writable scratch dir.
  A node's dirs live while it runs or is idle and are deleted when it is
  done; files not exported as artifacts are discarded. No directory is
  shared between nodes.
- **Scripts follow the same model.** `train` mounts the model artifact and
  the data and returns the checkpoint as an artifact.
- **Datasets** are mounts (see Mounts): read in place, never copied, their
  content digest pinned, so a changed dataset is a result-defining change.
- **Enforcement** uses bubblewrap on Linux for scripts. Without it, the host
  warns and runs unconfined (`confine: "auto"`) or refuses
  (`confine: "require"`); tests skip the confinement assertions with a
  message.
- `wallis export <run> <artifact> <dir>` copies an artifact out. Promoting
  artifacts across runs is the main agent's job; wallis has no other
  cross-run mechanism.

Prototype choices:

- Layout: `blobs/<sha256 hex>` (read-only files), and per node
  `work/<node>/inputs/<hex>/<name>` (hardlinked input artifacts) and
  `work/<node>/scratch/` and `work/<node>/spill/` (host-owned).
- Producers name files with drafts: a script's output may contain
  `{ "artifact": "<path in scratch>", "media": "…" }`, which the host stores
  and replaces with a ref before the output is checked and logged. A draft
  outside the scratch dir is an error. Agents call `export_artifact`
  (`AgentCall.exportArtifact` for executors) and submit the ref.
- Scripts get `WALLIS_INPUTS`, `WALLIS_SCRATCH`, `WALLIS_MOUNT_<NAME>` and
  `WALLIS_COMPUTE_MINUTES`. They read JSON args on stdin and write JSON to
  stdout. The interpreter follows the extension: `.py` python3, `.sh` sh,
  `.mjs`/`.js`/`.ts` node.
- bwrap mounts: `/usr` and `/etc` read-only, the merged-`/usr` symlinks, the
  interpreter's prefix and the scripts dir read-only, inputs and mounts
  read-only, scratch read-write. It also gives private `/proc`, `/dev` and
  `/tmp`, no network, a clean environment, and kills the sandbox when the
  host dies.
- The local profile is `~/.config/wallis/profile.json` merged with
  `<project>/.wallis/profile.json` (the project wins). It holds `models`
  (global and per-workflow remaps), `mounts` (the same shape, name → dir),
  `providers`
  (concurrent LLM calls) and `slots` (machine resources).

## Mounts (decided, round 4)

- Declared like models: `defineMounts({ kb: "./knowledge", data: "" })`. A
  value is the default host dir; a relative path resolves against the
  workflow dir; an empty string means it must be supplied.
- The caller (`--mount name=dir`, MCP `mounts`) or the local profile remaps
  a name. Agents and scripts reference names, typed as `keyof` the table.
- Read-only only: the `Mount` type has no writable variant. Writes leave a
  node only as returned artifacts, and a run only through `wallis export`.
- A missing value is a preflight error (`mount_unset`). Each mount's content
  digest goes into the pin (`inputs.mount.<name>`).
- This replaces the round-3 data dirs. There is no git-specific kind.

Prototype choices:

- Resolution per name: call-time > local profile (`mounts.workflows.<wf>`
  beats `mounts.global`) > the declared default. Call-time and profile
  paths resolve against the project root.
- The digest is `mount:sha256:` over the sorted relative paths and file
  sha256s. File hashes are cached by path, mtime and size in
  `$XDG_CACHE_HOME/wallis/file-hashes.json`; a content change that keeps
  all three is not detected.
- Scripts see a mount at its host path, read-only under bwrap, with its path
  in `WALLIS_MOUNT_<NAME>`. Agents at `read-only` or `workspace` level read
  their mounts with `read_file` and `list_dir`.

## Durability (proposed)

- wallis keeps its own append-only event log; a run is a fold of the body
  over it.
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
  - a request that was in flight is issued again with its original input and
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

- Executors connect only to wallis. wallis reaches the declared MCP servers
  (stdio and Streamable HTTP, through pi-mcp), enforces per-agent tool
  allowlists, injects secrets into server processes only, logs calls and
  can rate-limit per node. See Executors for the tool layer.
- Workflow-defined tools (`defineTool`) and `sandbox_exec` are served the same
  way.
- Loading is sandboxed too: the bundled workflow is evaluated in QuickJS
  without fs or network to obtain declarations, which are shown for approval
  on first run or when the digest changes.

## SDK (prototype choice)

The `wallis` package in `host/` exports `defineModels`, `defineMcp`,
`defineMounts`, `defineAgent(env, spec)`, `defineTool`, `defineScript(spec)`
or `defineScript(env, spec)`, `subWorkflow`, `workflow`, `Foldable`,
`Artifact`, TypeBox's `Type`, and the typed errors `Refused` (with
`refusal`), `AgentFailed` (`agent`, `failure: AgentFailure`),
`ScriptFailed` (`script`, `error`) and `SchemaError` (`subject`,
`errors`). `env = { models, mcp?, mounts? }` exists for typing:
- an agent's `model` is `keyof` the alias table;
- `mounts` entries are names in the mount table;
- `mcp` keys are servers in the imported `mcp.json`.

The body gets `ctx.call`, `ctx.script`, `ctx.parallel`, `ctx.sub`,
`ctx.observe` and `ctx.seed`; nothing else. There is no state-reading or
state-writing API. Agents declare `steerable` (default true), `compaction`
(default true), `sandbox`, `mounts`, `tools`, `mcp`, `maxTurns` (default
16) and `needs`.

An uncaught `AgentFailed` or `ScriptFailed` ends the run as
`AgentGaveUp`/`ScriptCrashed`; anything else ends it as `BodyError`. This is
a draft answer to open item 4. There are no workflow version declarations
(owner decision).

## Executors (decided, round 3; revised round 4)

```
Executor    { id, capabilities, contextWindow?(model), start(NodeSpec) -> NodeSession }
NodeSession { turn(message?) -> TurnResult, rebind?(model), steer?(text), interrupt?(), handle(), close() }
TurnResult  = submitted(output: unknown) | ended | agent_error(AgentFailure) | executor_error
```

A node is one agent call and its conversation. The host starts a session
on the node's first turn and keeps it open while the node is idle. It
closes the session when the node is done, or when its host process exits.
`NodeSpec` carries the following:
- the rendered input (`prompt`, with folded fields), the full `input`, the
  restart note, and the model's window when known;
- the conversation so far, so a session can be rebuilt after a restart;
- the output JSON Schema;
- the node's dirs and its `exportArtifact`;
- the selected MCP server configs;
- a transcript sink.

**pi** is built: in process, through `@earendil-works/pi-agent-core`'s
`Agent` (1.5.0, exact pins). It has no built-in tools and no ambient
context: no AGENTS.md or CLAUDE.md, no user extensions or skills. Its tools
come from the wallis tool layer as `AgentTool`s.

The tool layer (`host/src/host/tools.ts`) builds every tool per node. It
enforces the agent's allowlist, logs every call to the node's transcript,
counts calls against a per-node budget, and injects secrets into MCP
server processes only. The tools:
- `submit_result`, validated (schema and output cap); errors go back to the
  model;
- `read_spill`, which pages output spilled at the context cap;
- fs and exec tools confined to the node's dirs: `read_file` and
  `list_dir` from `read-only`; `write_file`, `export_artifact` and `exec`
  (bwrap) at `workspace`;
- declared `defineTool`s, served by their scripts;
- the allowlisted tools of upstream MCP servers, through
  `@earendil-works/pi-mcp`.

**codemode** is always on, for every agent (owner decision, round 4). Every
agent gets `codemode` and `submit_result`, plus its declared tools, which
are callable both directly and from a codemode script. A script runs in
pi-codemode's `CodemodeSandbox` (QuickJS, no fs or network), so codemode
adds no capability to a `sandbox: "none"` agent. Inside it, the agent's full
input is the `input` variable. Every nested call goes through the same
allowlist, logging and budget.

A codemode call costs a turn, so `defineAgent` refuses `maxTurns` below 2
(prototype choice); the SIDERIUS agents that had `maxTurns: 1` (the
evidence judge and the findings consolidator) now have 2.

Later rounds (not built):
- an **ACP executor**: generic; it enforces the allowlist by denying
  `session/request_permission` for non-wallis tools;
- a **Claude Agent SDK executor**.

Notes for Claude Code 2.1.301: `--bare` gives the cleanest isolation but
needs an API key; subscription auth needs a leak test.

Prototype choices:

- Model strings are `provider/model[:thinking]`. A trailing `:<level>` is a
  thinking level only if it names one, so OpenRouter-style ids with colons
  survive.
- `ended`, `agent_error` and `executor_error` for pi:
  - a turn whose last assistant message stops with text and no submission is
    `ended`, and the text is the question;
  - `stopReason: "error"` is an `executor_error` (provider, auth, billing);
  - reaching `maxTurns` without a submission aborts the agent and is an
    `agent_error`.
- pi validates tool arguments against `parameters` before the wallis
  `submit_result` check runs; both return errors to the model. Only accepted
  calls reach the tool layer's log.
- A rebuilt session gets the conversation so far folded into its first
  prompt ("Conversation so far: …"), not as synthetic assistant messages.
- A rebind inside a live session sets the pi agent's model. Across sessions
  (resume), the node restarts with its transcript.
- The per-node tool budget is 10 calls per allowed turn, at least 16. Nested
  calls count.
- MCP tools are named `mcp__<server>__<tool>`. `${VAR}` in a server's `env`
  or `headers` is resolved from the host environment for that process only.
- The CLI's default executor module is `host/src/executors/pi.ts` (pi with
  pi-ai's built-in providers). The default script runner is
  `ProcessScripts`.

## Prototype status

Built:
- the core (`core/`): journal, replay, budget, pin, status, ownership,
  interventions and their capabilities; the SDK and host (`host/`);
- sessions with a lock, the CLI and the stdio MCP server;
- the pi executor (pi-agent-core, compaction), the wallis tool layer
  (codemode for every agent, caps and spills, MCP through pi-mcp,
  `defineTool`s served by scripts, secret injection), bwrap scripts,
  mounts, artifacts and machine slots;
- the fake executor and the fake script runner;
- examples: `two-node` and `ask`;
- the SIDERIUS example (`.agents/workflows/siderius/`, see its `MAPPING.md`).

Not built yet:
- the ACP and Claude Agent SDK executors;
- `sandbox_exec`;
- declaration approval on first run or digest change.

## Open

1. GitHub owner for the repo and npm package.
2. Budget enforcement point in pi.
3. Codex and Gemini CLI executor capabilities.
4. Exact `defineAgent` / `workflow()` API.
