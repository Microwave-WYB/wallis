# wallis design

Status as of 2026-11-08 (round 6). Sections are marked **decided** (agreed with the
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
   | `IdleNode` | idle node of a steerable agent (never a command), not waiting for an approval; takes an `OwnedRun` | send to an idle node |
   | `SteerableNode` | running node of a steerable agent (never a command); takes an `OwnedRun` | send to a running node (steer), interrupt |
   | `LiveNode` | a node that is not done, or a held failed one; takes an `OwnedRun` | restart, cancel one node |
   | `SubmittableNode` | an orchestrator node waiting for its result, or an agent waiting for an approval; takes an `OwnedRun` | submit_result |
   | `ResumableRun` | `checkPin` | replaying a resumed run |

   The host checks before it sends an event; the core checks again when it
   applies it, because time passes in between. Brands exist only where raw
   ids cross a boundary: `RunId` and `NodeId`, parsed from CLI and MCP input.
3. **Everything at a boundary is `unknown` until parsed** with its schema:
   model output, command output, MCP and CLI arguments, and artifact refs
   (verified against the run's store). No `as` casts at those boundaries.
   (The core's own JSON, produced by generated encoders, is trusted.)

## Positioning and the effect model (decided, round 6)

A wallis run has no outward side effects except through MCP tools in
`ask` mode, each approved by the orchestrator at the point of action and
journaled, so replay never repeats it. Agent sandboxes and commands have no
network, and MCP servers are the only channel to the outside. Every call's
result is journaled, so runs resume, fork and reproduce.

- **The orchestrator** is whoever owns the run: in practice an agent in a
  harness (Claude Code, Codex, ...), driving wallis over MCP or the CLI. It
  answers what the run asks (agent questions, orchestrator nodes, tool
  approvals) and decides on budgets, failures and models.
- **Internal and external nodes** (a distinction for the docs, not a type
  hierarchy). Agent sessions, commands and nested workflows are internal:
  fresh and re-executable from their input. MCP tools and orchestrator
  nodes are external: they reach a stateful outside, so the journal is the
  only truth about them. Consequences:
  - a question to the orchestrator must be self-contained: it sees only the
    item, not the run's context;
  - forks share the same orchestrator, so its answers can contaminate
    ablations (an answer given in one fork is a fact of the world for it);
  - restarting an external node, or a node that used one, asks the outside
    again (a tool is called again, an approval is asked again): that is not
    reproduction, and `restart` says so.
- **MCP tools, by mode.** An agent selects each tool as direct (it runs when
  called) or `ask` (it runs only after the orchestrator approves the call;
  a rejection's reason is the tool's result). A tool whose annotations say
  it writes outside (`destructiveHint`, or not read-only and open-world)
  must be in `ask` mode: preflight refuses it otherwise
  (`tool_writes_outside`). The body may call MCP tools as nodes
  (`mcpTool`), direct only. Every MCP result is journaled before anyone
  sees it.
- **Network.** Agents and commands never have network. An MCP server's
  overlay declares `network: "none" | "full"` (default `"full"`); sandbox
  `setup` keeps its network (logged). The round-3 domain allowlist and the
  overlay's `allowWrites` are gone.

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
  prompts/*.md     # prompts, imported as text; never mounted into a sandbox
  mcp.json         # standard MCP config, imported as JSON
  skills/          # standard SKILL.md directories
  <dirs>/          # code and files sandboxes need, mounted by name (e.g. trainer/, checks/)
```

- Prompts: `import p from "./prompts/p.md" with { type: "text" }`. The
  bundler inlines them, so the workflow digest covers prompt content.
- MCP: `import m from "./mcp.json" with { type: "json" }`, wrapped by
  `defineMcp(m, overlay)`, where the TS overlay gives each stdio server its
  sandbox (and its network, `"none" | "full"`). Agents select a subset of
  servers and tools, each direct or `ask`: `mcp: { arxiv: ["search",
  "fetch"], scholar: "*", ente: { ask: ["upload"] } }`. `${VAR}` in `env`
  is a secret reference.
- Nothing in the workflow dir is visible to a sandbox unless it is mounted
  by name (`defineMounts({ trainer: "./trainer" })`).
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

## Core shape (decided, rounds 4 and 5)

```gleam
pub fn step(run: RunState, event: Event) -> #(RunState, List(Effect))
```

The workflow is a pure program over journaled calls. The body is
deterministic, and its only interface to the world is `ctx.call(node,
input)` on a node (a command, a nested workflow, an MCP tool or an
orchestrator node), `ctx.session(agent).call(input)` for agents (round 6),
plus `ctx.parallel` and `ctx.map` for concurrency. Each call affects the body
only through its return value. **Run memory is the body's local
variables**, rebuilt by re-executing the body against the journal. Agents
never pull workflow memory: the body pushes everything an agent needs into
its typed input.

The core holds no workflow state. It keeps the journal (a cache, see "The
journal is a cache"), budget, pin, status, ownership, the interventions and
the held failure. A thin TS host executes effects and feeds results back as
events. Values cross the boundary as JSON only.

As built (`core/src/wallis_core/types.gleam`):

```gleam
// Event:  Started(workflow, pin, input) | Resumed(pin) | CodeChanged(from, to)
//       | Requested(id, Call(agent, input, session, index) | Command | Tool | Orchestrator, node_digest, occurrence)
//       | AgentReturned | AgentIdle(id, message, ..) | AgentAsked(id, message, ..)
//       | ApprovalRequested(id, server, tool, args, ..) | TurnInterrupted(id, ..) | TurnLimitReached(id, used, limit, ..)
//       | AgentFailed(id, AgentFailure, ..) | ExecutorFailed(id, error) | ToolRecorded(id, call, result)
//       | InputRejected(id, field?, chars, limit)
//       | CommandReturned(id, output, minutes) | CommandFailed(id, CommandFailure, minutes)
//       | ToolReturned(id, output) | ToolFailed(id, ToolFailure)
//       | Observed(at, label, value)
//       | Sent(.., turns) | Steered | InterruptRequested | Restarted(.., turns) | NodeCancelled
//       | ResultSubmitted(node, value)   (each with `by`)
//       | CancelRequested(by) | PauseRequested(by) | ResumeRequested(by) | Claimed(owner)
//       | AliasRebound | BudgetRaised | ExecutorChanged | RetryUnavailable
//       | BodyFinished(output) | BodyFailed(FailReason)
// Effect: Checkpoint | CallAgent(id, agent, model, input, turn, turn_limit, digest, transcript, note, previous, recorded)
//       | RunCommand(id, command, input, compute_minutes, digest) | CallTool(id, tool, input, digest)
//       | Deliver | Fail | Refuse | Finish
// AgentFailure   = GaveUp(error) | ContextExhausted | CancelledByOwner
// CommandFailure = ExitCode(code, stderr_head) | OutputMismatch(errors) | TimedOut(minutes)
//                | MissingFile(name) | Unrunnable(error) | CommandCancelled
// ToolFailure    = ToolError(message) | ToolOutputMismatch(errors) | ToolUnreachable(error) | ToolCancelled
// FailReason     = BodyError | AgentGaveUp(agent, AgentFailure) | CommandCrashed(command, CommandFailure)
//                | ToolCrashed(tool, ToolFailure) | WorkflowFailed(workflow, FailReason)
```

- Removed in round 4: workflow state, views, reducers, `emit`, `writes`,
  the `state_read` and `emit` tools, and the SDK pruning helpers. Removed
  in round 5: `ctx.script`, `ctx.sub`, `defineScript`, `defineTool`, the
  `scripts/` lookup, the max_turns agent failure, budget reservation and
  USD budgets, position-based journal matching, `PathDiverged`,
  `--code-changed` and `fork --at`. Removed in round 6: `ctx.call` on an
  agent (sessions), the `steer` verb (`send` covers it), the interrupt
  message, the overlay's `allowWrites`, the sandbox `network` option.
- **`ctx.observe(label, value)`** is monitoring only: logged for `status`,
  `tree` and `show`, never returned to the body, never matched.

Prototype choices:

- Every request is answered in one of three ways: `Deliver`; `Fail(id,
  FailReason)`, which the SDK throws as `AgentFailed`, `CommandFailed`,
  `ToolFailed` or `WorkflowFailed`; or `Refuse(Some(id), Refusal)`, thrown
  as `Refused`.
  `Refuse(None, Refusal)` means the event itself was refused and not
  applied: a refused `Resumed` ends the session; a refused intervention is
  reported to its sender (inbox entries: `inbox.jsonl.refused`).
- Strings appear only at the leaves of the refusal, failure and status
  unions; nothing matches on message text.
- `Checkpoint` means "append the event just stepped to the log". Hits,
  replayed observations, `Resumed` and refused events are not logged.
- Request ids are for display and interventions only: `#0`, `#2.a#0`
  (branch `a` of the parallel at `#2`), `#3.1#0` (item 1 of the map at
  `#3`), `#4>tune#0` (the nested workflow `tune` at `#4`), `#5:1` (call 1
  of the session created at `#5`). Observations take their own counter
  (`~0`).
- Intervention events carry `by`. The core applies them only through
  `check_owner` and the node checks; `Claimed` is not owner-checked, since
  who may claim depends on whether the owner process is alive.
- Codecs in `types.gleam` come from the Gleam language server code actions,
  driven by `tools/gleam-codegen.mjs`; the recursive `Value` decoder is
  hand-written. The recursive `FailReason` decoder is generated and lazy.

## Concurrency (decided, round 5)

- `ctx.call` takes its request id synchronously, when invoked, so
  `Promise.all([ctx.call(a, x), ctx.call(b, y)])` is deterministic whatever
  order results arrive in, and so is a replay after a kill.
- A branch with several sequential steps must run in `ctx.parallel` or
  `ctx.map(items, async (c, item, i) => ...)`, which give each branch its
  own counter. QuickJS has no async context tracking: ids taken after an
  `await` in plain concurrent code would depend on arrival order.
- The cache key's occurrence counter follows issue order, which is
  synchronous and deterministic, so identical parallel calls stay apart.

## Run and node status (decided)

- Run: `Running | Idle(Option(IdleReason)) | Finished(Outcome)`.
  - `Outcome = Done(value) | Failed(FailReason) | Cancelled`.
  - `IdleReason = BudgetReached(kind, spent, limit) | ExecutorUnavailable(alias, error) | PausedByUser | NodeFailure(node, reason)`.
- Node, by kind:
  - agent (one call of a session): `NodeRunning | NodeIdle(IdleCause) | NodeDone(Submitted | NodeFailed(AgentFailure))`,
    with `IdleCause = Question(message) | Asked(message) | TurnLimit(used, limit) | Interrupted | Approval(server, tool, args)`;
    every variant carries `id`, `agent`, `model`, `steerable` and `inbox`;
  - command: `CommandRunning | CommandDone(Succeeded | FailedWith(CommandFailure))`,
    with `id`, `command` and `inbox`; no dialogue, so no idle state;
  - MCP tool (body): `ToolRunning | ToolDone(ToolSucceeded | ToolFailedWith(ToolFailure))`;
  - orchestrator node: `OrchestratorPending(input) | OrchestratorDone`;
  - workflow: no status of its own; its subtree (ids under `>name`) is its status;
    a session has none either: its calls (`#n:k`) are its children in the tree.
- A refused resume or intervention does not change the persisted status.
- `stopped` is derived at query time: not finished and no live process
  holds the run's lock. It is never logged.

Prototype choices:

- The status is derived from the requests: `Running` while any call is in
  flight; otherwise `Idle(NodeFailure)` while a failure is held,
  `Idle(PausedByUser)` if paused, `Idle(reason)` for the first request held
  on the budget or an executor fault (its spend as it is now), `Idle(None)`
  if a node waits for its owner, else `Running` (the body is computing).
- Calls held back by a pause, the budget or an executor fault, and calls
  refused before they started, are not nodes.
- In TS the agent variants carry a literal `steerable`, so
  `node.type === "node_running" && node.steerable` narrows; command
  variants have no `steerable` field at all.

## An agent is a function, called through sessions (decided, rounds 4 to 6)

An agent call is `(input, inbox) → dialogue → Submitted(output) | AgentFailure`.

- **Sessions (round 6) are the only way to call an agent:**
  `ctx.session(agent).call(input)`. `ctx.call(agent, …)` is a type error,
  and a typed refusal (`session_required`) at run time. A one-off call is a
  session used once; a dialogue reuses the handle:

  ```ts
  const colorist = ctx.session(lookAgent);
  let look = await colorist.call({ sheet, measure });
  look = await colorist.call({ feedback: "too yellow" });   // same conversation
  ```

  - Each `.call` input is checked against the agent's input schema and
    appended to the same conversation as a new message; each output is
    validated. Budgets and `maxTurns` are per call.
  - A session's identity is where it was created in the call tree, taken
    synchronously like a request id, so replay matches. Its calls are its
    children: `#3:0`, `#3:1`.
  - A second `.call` while one is in flight is refused (`session_busy`).
  - A session is data, not a process: between calls nothing runs, and the
    next call rebuilds the agent from the dialogue its previous call left.
    There is no `close()`. Each call gets a fresh sandbox process
    (background processes die with it); the scratch dir belongs to the
    session and persists across its calls, cleaned with the run.
  - **Restarting a call rewinds its session** to before that call; the
    session's later calls are invalidated (the core decides what is on the
    live path).
- **`ask` (round 6).** Every agent has a built-in `ask(message)` tool: plain
  language, no schema. The question goes to the agent's caller, the body,
  which forwards it to the orchestrator (later, a parent agent may answer
  it; the semantics stay "answered by the caller"). The node goes
  `Idle(asked)`; the agent stays in the same loop and the reply becomes the
  tool's result, also after a host exit (the conversation is rebuilt up to
  the pending call and the reply is delivered as its result).
- Ending a turn without `submit_result` or `ask` is an implicit ask: its
  text is the question (`Idle(question)`), and the reply arrives as the next
  user message. There is no nudging.
- **Turns are an orchestration point, not a cut-off.** Every turn the model
  sees its quota, "Turn k of N", appended to the end of the newest message
  (the latest tool result or user message), never the system prompt, so
  the cached prefix stays stable. It is deterministic and logged. Reaching
  `maxTurns` without submitting makes the node `Idle(turn_limit { used,
  limit })` with its progress kept, and notifies as usual. The owner can
  `send` more turns (`--turns N`, MCP `turns`, optionally with a message),
  `restart` it (with a note), or `cancel` it (an agent failure to the body).
- Executor errors are not agent failures (see Recovery).
- The verbs (round 6):

  | Verb | Reaches | Effect | Capability |
  | --- | --- | --- | --- |
  | `send` (+ turns) | an idle agent node (asked, question, turn limit with turns, interrupted) | delivered: the dialogue continues | `IdleNode` |
  | `send` | a running agent node of a steerable agent | queued as a steer after the current turn | `SteerableNode` |
  | `interrupt` | a running agent node of a steerable agent | aborts the current turn, its tool calls included: `Idle(interrupted)`, progress kept | `SteerableNode` |
  | `submit_result` | an orchestrator node, or an agent node waiting for an approval | its result (checked against the answer schema), or the decision | `SubmittableNode` |
  | `restart` | a live node, or a held failed one | discards progress; reissues with the original input (+ note for steerable agents, + turns); a command reruns; a tool is called again | `LiveNode` |
  | cancel one node | a live node, or a held failed one | a typed failure for the body (accepting a held one propagates it) | `LiveNode` |

  `send`'s result says how it was delivered ("delivered as the reply to:
  <question>", "queued as steer after the current turn"), so the
  orchestrator can notice a race. "Interrupt and redirect" is `interrupt`,
  then `send`. `pause` and `resume` are unchanged.
- `steerable: boolean` on agents (default true). A non-steerable node
  accepts only cancel and a restart without a note. A command has no
  dialogue: messages, interrupts and notes are refused (`not_an_agent`);
  `SteerableNode` holds only agent nodes, so steering a command does not
  compile.

Prototype choices:

- `CallAgent` carries the transcript after the first prompt (questions,
  answers, steers, decisions), the node's turns so far and its allowance,
  the slot of the session's previous call (`previous`) and the MCP results
  already journaled for the call (`recorded`). An answer to a node at its
  turn limit without more turns is refused (`no_turns_left`); a restart
  resets the allowance to `maxTurns`, or to `--turns`.
- A session call's journal slot includes its previous call's slot, so a
  later call is keyed by the whole dialogue before it. The core keeps the
  chain (`<session>:<index>` → slot) for the current execution of the body.
- When a call ends, the host copies its checkpoint to
  `sessions/<slot>.json`; the session's next call starts from it (a fork
  copies `sessions/`). A restart discards the call's own checkpoint, so it
  starts from its previous call's dialogue again. The session's scratch dir
  (`work/<session>/scratch`) is not rewound.
- `session_busy` is checked in the workflow VM, where it is deterministic
  (a replayed hit arrives as late as the original result did).
- `ask` and `ask`-mode tools end the turn (pi's `finishTurn`) with a
  placeholder tool result marked in its details; the reply or decision
  replaces it when it arrives. They cannot run from codemode (a pausing
  call is refused there, typed as a tool error for the model), and a turn
  waits on at most one.
- `Sent` and `Steered` carry a sender-chosen `message_id`, so each inbox
  entry applies once. An interrupt is logged as `InterruptRequested`, then
  `TurnInterrupted` once the aborted turn has ended. A CLI `send` is an
  inbox entry the driver resolves when it applies it (idle: an answer;
  running: a steer); the CLI reads the outcome from the log.
- On restart the host closes the node's session (or kills its process) and
  deletes its dirs before the core reissues the call; a result of the old
  session is discarded with a note in the transcript.
- The step of an inbox message is the node's model turns as the core knows them.

## Orchestrator nodes (decided, round 6)

- `orchestrator({ name, input, output })` declares a node the orchestrator
  completes. The body calls it with `ctx.call`; the workflow lists it
  (`orchestrators: [pickLook, approveUpload]`), so `wallis describe` and
  MCP `describe` show which questions a workflow may ask and the answer
  schema of each.
- The orchestrator answers with `submit_result({ run, node, value })` (MCP)
  or `wallis submit <run> <node> '<json>'`. The value is checked against
  the node's output schema; a mismatch is refused with the errors
  (`invalid_answer`) and the node stays pending. Artifact refs in a value
  are verified against the run's store.
- Its input may carry artifact refs; the pending item lists each with its
  blob path and the `wallis export` command.
- Built in: the agent-ask forwarding (string → string, answered with
  `send`), and the MCP tool approval (`{ server, tool, args }` → `{ type:
  "approve" }` | `{ type: "reject", reason }`, the reason non-empty; the
  core re-checks the decision's shape).

Prototype choices:

- An orchestrator node is never held back by a pause or the budget, and is
  not live: there is nothing to restart or cancel while it waits.
- The answer schemas are written to run metadata (`meta.json` `answers`)
  so queries list them without bundling the workflow.
- A body MCP tool is direct only: a tool that writes outside is refused in
  preflight. Outward actions go through an agent's `ask`-mode tool.

## Structured pending (decided, round 6)

Attention is structured JSON for programmatic orchestrators: MCP `wait`,
`get_run` and `pending` return it, and the CLI prints it with `--json`
(`status`, `wait`, `pending`); the text `describe` stays for humans. Each
item has its kind, run, node, the question or input, and `actions`: the
allowed verbs with their arguments as JSON Schema and the CLI form.

| Kind | What waits | Actions |
| --- | --- | --- |
| `agent_ask` (`via`: `ask_tool` or `end_of_turn`) | an agent's question | `send`, `restart`, `cancel` |
| `turn_limit` | an agent at its turn limit | `send` with `turns`, `restart`, `cancel` |
| `interrupted` | an interrupted agent | `send`, `restart`, `cancel` |
| `approval_pending` | an `ask`-mode MCP call (`server`, `tool`, `args`) | `submit_result` with the decision, `restart`, `cancel` |
| `orchestrator_pending` | an orchestrator node (`input`, `artifacts`) | `submit_result` with its answer schema |
| `run_idle` | `budget_reached`, `executor_unavailable`, `paused_by_user` | `resume` (with `budget` or `models`) |
| `node_failed` | a held failure | `restart`, `cancel` |
| `stopped` | no process drives the run | `resume` |
| `finished` | the outcome | none |

## Notification and the MCP server (decided)

- `wallis wait <run>` blocks until something new needs attention, prints an
  agent-readable summary and exits; harnesses run it in the background.
- `wallis pending` lists idle nodes and idle runs under the current
  directory, and prints nothing when there are none (for a
  UserPromptSubmit-style hook).
- `wallis serve` is a stdio MCP server with the tools `run`, `describe`,
  `send`, `submit_result`, `interrupt`, `restart`, `get_run`, `pending`,
  `cancel`, `pause`, `resume` (with `budget` or `models`) and `wait`, plus
  the monitoring tools. `wait` is a long poll with a server-side cap. Every result appends what is pending. The `run` result and the
  server instructions tell the caller to run `npx wallis wait <run_id>` in
  the background.

Prototype choices:

- Runs live in `.wallis/runs/<run_id>/`: `log.jsonl`, `meta.json`, `lock`,
  `inbox.jsonl` and `inbox.jsonl.done`. A run id is
  `<workflow>-<UTC stamp>-<4 hex>`.
- A session drives a run until it is finished or idle, then releases the
  lock and exits. The next session resumes it.
- `send`, `submit`, `interrupt` and `cancel` append an inbox entry. A live driver polls the inbox
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
  `{ executor, commands? }`. It is passed with `--executor`, recorded in
  `meta.json`, and reused on resume. There is no default executor until pi
  is built.

## Ownership and notification (decided, round 3)

- A run records its owner. A run started over MCP is owned by the harness
  that runs `wallis serve`. A CLI caller's owner is its nearest harness
  ancestor, or the human when there is none.
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
  `/proc` (the start time makes a reused pid a different owner). `wallis
  serve` takes its nearest harness ancestor, like a CLI caller, and its
  parent only when there is none: harnesses start it through wrappers
  (`npx`, `sh -c`, `mise exec`), and the orchestrator's MCP runs must be
  its own for its shell's `npx wallis wait` (round 6; before, the wrapper
  owned them).
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
  `wallis show <run> [<node>]`, `wallis describe <workflow>`, `wallis doc`;
  interventions `send`, `submit`, `interrupt`, `restart`, `cancel --node`,
  `pause`, `resume`.
- **MCP tools for the owner:** `list_runs`, `run_tree`,
  `node_transcript(run, node, since?, limit?)` and `run_log(run, since?)`,
  all capped with cursors; `send`, `submit_result`, `interrupt`,
  `restart`, `pause`, `resume`, and `cancel` with an optional `node_id`.
- **`pause` and `resume`:** pause issues no new calls, and the run goes
  `Idle(PausedByUser)` once in-flight work ends; resume continues.
- Steering (a `send` to a running node) changes only the node's eventual
  output, which is journaled, so workflow replay stays deterministic.

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

- **Resource slots.** Commands declare `resources: { gpu?, memoryGb? }`. They
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
  profile's `slots`). A command needing more than the machine has is refused.
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
- Command memory scopes use `systemd-run --user --scope` only when the
  command declares `memoryGb` and systemd works. The scope wraps bwrap, which keeps
  its clean environment inside.

## Recovery (decided; round 5: the most important property)

- **Transient executor errors retry inside the executor.** Provider 429,
  529 and 5xx, timeouts and network errors are retried with backoff before
  anything is reported: 3 attempts after 5 s, 30 s and 2 min (the local
  profile's `retries`). Every retry is logged in the node's transcript.
  Only after the retries does the run see `executor_failed` (Idle
  `executor_unavailable`); a resume or rebind then reissues the call.
  Non-transient errors (auth, billing such as "412 account suspended", a
  missing model) are not retried.
- **In-node durability: every turn is checkpointed.** After every completed
  model step the node's whole conversation (messages, tool calls, results)
  is saved in its work dir. A reissued or resumed call continues from the
  last completed turn; earlier turns are never requested again. The node's
  scratch dir lives until the node is done, so the conversation and the
  files stay consistent. - A tool call in flight at a crash runs again if it
  only reads (`read_file`, `list_dir`, `read_spill`, codemode), only asks
  (`ask`, an `ask`-mode tool), or its MCP result is already journaled; any
  other call's result becomes an error the model sees ("may or may not
  have taken effect").
- **An uncaught node failure blocks only its dependents.** When the body
  fails because of a node failure it did not handle, the run is not
  finished: the failure is held (`Idle(NodeFailure)` once nothing else can
  proceed, an attention item meanwhile) and independent branches keep
  running. The owner `restart`s the node (optionally with a note,
  `--model` rebind or `--turns`): its journal entry is invalidated, it
  reruns, and the body runs again against the journal, so everything
  completed is a hit and it continues. Or the owner `cancel`s it: only then
  does the failure propagate, and the run finishes Failed if the body does
  not handle it. Commands work the same way (a restart reruns them, e.g.
  after fixing a `requires` or mount problem). A restart re-executes the
  node: MCP tools it calls and approvals it asks for reach the outside
  again, which is recovery, not reproduction.
- **Code changes are allowed.** Resume re-executes the body with the new
  bundle against the journal (see "The journal is a cache"); the change is
  logged (`CodeChanged`, old and new digests, both in the pin) and the host
  prints "code changed; N calls reused, first new call: <node> at <id>".
- Operational changes are logged events: alias remaps (`AliasRebound`),
  budget raises (`BudgetRaised`), executor changes (`ExecutorChanged`).
- Result-defining changes are refused on resume: pinned files, mount
  content, seed and the core's semantics version.
- `wallis fork <run>` copies the whole journal (and blobs) into a new run,
  which re-executes; unchanged calls hit. The journal is per run and its
  forks, never shared implicitly with other runs: runs are independent
  samples.

Prototype choices:

- **Own checkpoints, not pi-durable.** pi-durable 1.5.0 was evaluated: it
  is a complete harness of its own (storage, generation tasks, tools,
  codemode, compaction) behind an API marked experimental. Running nodes on
  it would duplicate the wallis tool layer (allowlist, caps, spills,
  sandboxes) and the executor's turn contract. pi-agent-core already
  restores a conversation (`initialState.messages`) and continues it
  (`continue()`), so the pi executor writes `work/<node>/session.json`
  itself (atomically, after every assistant message and every turn) and
  restores from it. A reply that failed or was aborted is never progress
  and is dropped on restore.
- The semantics version is `wallis-core/5` (round 6: sessions, MCP
  journaling, asks, approvals, orchestrator nodes).
- Resume order: refold; `Resumed` (pinned fields compared); `CodeChanged`
  if the bundle differs; `ExecutorChanged`, `AliasRebound`; re-execute the
  body; `BudgetRaised`, `RetryUnavailable`, answers, the inbox.
- A held failure is found by matching the body's failure (unwrapped from
  `WorkflowFailed`) against the journal's failed entries. A failure the
  owner already accepted (`cancelled_by_owner`, `command_cancelled`) and a
  `BodyError` end the run.
- After a held node's restart the host runs the body in a fresh workflow VM
  (built before the old one is disposed); calls still in flight from the
  old body are not reissued, and their results are journaled and hit.

## Schemas at the boundary (decided)

Schema style: workflows write schemas as TypeBox, either as builders or as
`Type.Script` modules (TS syntax). Constrained types (`maxLength`,
`minimum`, integers) are builders passed in as the Script context:
`Type.Script({ ShortText: Type.String({ maxLength: 500 }) }, "type F = { statement: ShortText }")`.
`Options<...>` inside a Script string is not applied by typebox 1.3.27, so it
is not used.

- Nodes declare TypeBox inputs and outputs, and `ctx.call(node, input)` is
  typed by them.
- The executor gets the agent's output JSON Schema (for provider-side
  structured output). Its `submit_result` validates against it and returns
  the errors to the model, which retries within its turn. Output caps come
  back to the model the same way, as validation errors. Only giving up or
  never submitting a valid result is an agent failure.

Prototype choices:

- Each value is checked twice, with the same TypeBox check (`schemaErrors`):
  in the sandbox before it is sent or delivered, and in the host before it
  is logged. What a mismatch becomes depends on where it comes from:

  | Source | Mismatch becomes |
  | --- | --- |
  | Body: a node's input | `SchemaError`; nothing is logged |
  | Command output (after `parse`) | `CommandFailed(output_mismatch)` |
  | Agent output | Agent failure (`gave_up`); nothing is logged as a result |
- Executor and command outputs arrive as `unknown`. The host parses them in
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

## Artifacts, sandboxes and commands (decided, round 5)

- **Artifacts.** Files handed downstream are typed artifacts in outputs:
  `Artifact(media)` = `{ digest: "sha256:…", name, media }`, stored in the
  run's content-addressed `blobs/`. The journal carries refs only, and every
  ref in an output is verified against the store. A fork shares blobs.
- **Sandboxes are declared by the workflow; the implementation is internal
  (bwrap only).**

  ```ts
  const py = defineSandbox({ mounts }, {
    name: "py",
    requires: ["uv"],                     // binaries the base must provide
    setup: [["uv", "sync", "--frozen"]],  // optional: once per digest, WITH network
    mounts: ["trainer", "data"],          // read-only only, by name from defineMounts
  });                                     // no network option: agents and commands never have one
  ```

  Nothing is implicit: the workflow dir is not mounted; whatever a sandbox
  needs comes through its mounts, so an implementor cannot read judge
  prompts or Health code. Each call gets a private writable scratch dir.
  There is no writable mount. The base is the host's system dirs,
  read-only; its identity (distro and version, kernel) goes in run
  metadata, and an optional `base` (a container image) is reserved for a
  later backend and ignored by bwrap.
- **`requires`**, per name: call-time `--bin name=path` (MCP `bins`) >
  local profile (per workflow > global) > the caller's PATH at run
  creation (not the host process's: systemd hosts have a minimal PATH).
  The resolved absolute paths are stored in run metadata and reused on
  resume. Only that one file is bound, read-only, at
  `/run/wallis/bin/<name>`, first on PATH. Preflight runs a check inside
  the sandbox (`<name> --version`, or `{ name, check }`). Typed refusals:
  `requires_missing(name)`, `requires_broken(name, exit, stderr_head)`,
  `unknown_bin(name)`. Versions go in metadata only, not the pin.
- **`setup`** runs once per digest (the declaration, its binaries and the
  content of its mounts) in bwrap with the network on, writing a cached env
  dir exposed as `$WALLIS_ENV`; `$WALLIS_ENV/bin` is on every run's PATH,
  and runs mount the env read-only without network. After setup every
  binary in `$WALLIS_ENV/bin` is smoke-tested the same way. It is logged
  (there is no first-run approval listing yet). Failure: `setup_failed`.
- **GPU** devices are bound only when the call declares `resources.gpu`.
- **Commands are typed adapters, called only by workflow code:**

  ```ts
  const train = command({ name: "train", sandbox: py, input, output,
    run: (i) => ["uv", "run", "--offline", "trainer/train.py", "--model", i.model.path],
    parse: (r) => ({ score: Number(r.stdout.trim()), checkpoint: r.file("ckpt.pt") }),
    resources: { gpu: 1, memoryGb: 12 } });
  ```

  `run` and `parse` are pure functions run in the workflow's QuickJS VM.
  Inside `run` an input artifact appears as its mounted form `{ ...ref,
  path }`. `r.file(name)` must name a file the command wrote in its scratch
  dir (else `missing_file`); it becomes an artifact. `parse`'s result is
  still checked against `output`. Without `parse`, the default protocol: the
  input JSON on stdin, the output JSON (with artifact drafts) on stdout, and
  `run` may be a plain argv. `argv[0]` is typed as one of the sandbox's
  required binaries. Agents cannot be handed commands.
- `wallis export <run> <artifact> <dir>` copies an artifact out; promoting
  artifacts across runs is the main agent's job.

Prototype choices:

- Layout inside a sandbox: `/w` is the call's scratch dir and working
  directory; each mount is at `/w/<name>`, read-only; input artifacts are
  at `/run/wallis/inputs/<hex>/<name>`; binaries at `/run/wallis/bin`; the
  setup env at `/run/wallis/env`. Plus `/usr`, `/etc`, the merged-`/usr`
  symlinks, private `/proc`, `/dev`, `/tmp`, no network, and the sandbox
  dies with the host. The environment is exactly `PATH`, `HOME=/w`,
  `LANG`, `WALLIS_SCRATCH`, `WALLIS_INPUTS`, `WALLIS_ENV`,
  `WALLIS_COMPUTE_MINUTES` (and, for MCP servers, their secrets); secrets
  never appear on a command line.
- No sandbox an agent or a command runs in has network (round 6: the
  domain allowlist is gone; filtering it per domain was premature). An MCP
  server's spawn shares the host network when its overlay says `"full"`
  (the default), and `setup` always does.
- A command whose sandbox cannot be built (no bwrap) fails as
  `unrunnable`; agents' `bash` reports it. `confine: "off"` (tests,
  development; an executor kit may set it) skips the sandbox preflight and
  the MCP annotation check and runs MCP servers unconfined; binaries are
  still resolved and recorded.
- Setup envs live in `$XDG_CACHE_HOME/wallis/envs/<digest>/`, ready once
  `.wallis-ready` is written. A setup step's argv is the same as a run's
  (`argv[0]` a required binary).
- A command's memory scope wraps bwrap in `systemd-run --user --scope -p
  MemoryMax=…`; the session-bus variables it needs are unset inside.
- Per-node dirs: `work/<node>/inputs/<hex>/<name>`, `work/<node>/scratch/`,
  `work/<node>/spill/` and the pi checkpoint `work/<node>/session.json`,
  deleted when the node is done.

## Mounts (decided, round 4)

- Declared like models: `defineMounts({ kb: "./knowledge", data: "" })`. A
  value is the default host dir; a relative path resolves against the
  workflow dir; an empty string means it must be supplied.
- The caller (`--mount name=dir`, MCP `mounts`) or the local profile remaps
  a name. Sandboxes reference names, typed as `keyof` the table.
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
- A sandbox sees each of its mounts at `/w/<name>`, read-only. Agents with a
  sandbox read their mounts with `bash`, `read_file` and `list_dir`.

## The journal is a cache (decided, round 5)

- **Key:** (node definition digest, canonical input digest, occurrence n).
  The nth call with the same node and input gets the nth recorded result.
  - Agent digest: prompt, model alias, input and output schemas, MCP
    selection, skills, needs, sandbox declaration, steerable, compaction,
    maxTurns.
  - Command digest: its `run` and `parse` code, schemas, resources, the
    sandbox declaration and its env digest (binaries and mount content).
  - Occurrences follow call issue order, which is synchronous and
    deterministic.
- **Resume re-executes the body against the cache.** Unchanged calls hit;
  anything changed misses and executes; downstream calls miss
  automatically when their inputs change. There is no path divergence.
- **Restart invalidates that node's entry** (logged), so it executes again;
  a session call's restart also invalidates the session's later calls and
  drops the call's journaled MCP results: the outside is asked again.
- **MCP calls are journaled** like every call: a body MCP node's result is
  its entry; an agent's MCP results join its call's record. Replay,
  resume, the restart of an unrelated node and fork reuse them.
- **Fork copies the cache** into a new run; the cache is never shared
  implicitly across runs.
- Request ids are only display and intervention identities.
- **Pin:** the workflow digest is recorded, not compared (code changes are
  allowed and logged); pinned files, mounts, the seed and the semantics
  version still refuse.

Prototype choices:

- The host computes the node digest (sha256 of the canonical declaration)
  and counts occurrences per (digest, canonical input), resetting them
  whenever the body starts; `Requested` carries both, so a refold rebuilds
  the same cache. The core's slot is a digest of the node digest, kind,
  name and canonical input, plus `#n`.
- The model alias is part of an agent's digest, not the model it resolves
  to: a rebind does not invalidate completed calls (as before, completed
  calls are never re-executed; later calls use the new binding).
- A hit is answered without being logged. A slot whose call is in flight
  or waiting is the same call: if it is requested under another id, its
  record moves to that id and the move is logged; a call in flight is
  reissued only if it was not issued in this session.
- A fork copies every event except those that ended the source
  (`body_finished`, `body_failed`, `cancel_requested`), then re-executes.
- The log is JSONL, fsynced per line; a partial last line is ignored.
- The workflow body runs in QuickJS (`quickjs-wasi` 3.6.2, the `encoding`
  extension only) with a virtual clock from 2025-01-01T00:00:00Z advancing
  1 ms per read, UTC, and `Math.random` seeded from the pin. The bundle comes
  from esbuild; the workflow digest is its sha256.

## Budget (decided, round 5)

- The budget is an attention point, not a hard cap. Its units are the
  run's agent model `turns` and command `computeMinutes`. USD and tokens are
  recorded in usage, logs and `status` for information only; they never
  trigger anything (subscriptions have no per-call cost, some providers
  report no prices).
- When spend reaches a limit, no new call is admitted; calls in flight
  finish normally, so a small overshoot (what was in flight) is expected.
  The run becomes `Idle(BudgetReached(kind, spent, limit))` and notifies
  through `wait`, `pending` and MCP. The owner raises it (`resume --budget
  turns=…`) and the run continues, or cancels.
- Per-agent `maxTurns` is the agent's own orchestration point (see "An
  agent is a function"), separate from the run budget.

Prototype choices:

- Each `RunCommand` carries the compute minutes left; the process is killed
  when they are spent (`timed_out`). There is no reservation: parallel
  calls may overshoot by what is in flight.

## SDK (prototype choice)

The `wallis` package in `host/` exports `defineModels`, `defineMcp(config,
overlay)`, `defineMounts`, `defineSandbox(env, spec)`, `defineAgent(env,
spec)`, `command(spec)`, `mcpTool(env, spec)`, `orchestrator(spec)`,
`subWorkflow`, `workflow`, `Foldable`, `Artifact`, `Decision`, TypeBox's
`Type`, and the typed errors `Refused`, `AgentFailed` (`agent`,
`failure`), `CommandFailed` (`command`, `failure`), `ToolFailed` (`tool`,
`failure`), `WorkflowFailed` (`workflow`, `reason`) and `SchemaError`.
Every node is `Node<I, O> = AgentDef | CommandDef | WorkflowNode |
OrchestratorDef | McpToolDef`, discriminated by `kind`; `ctx.call` takes
every kind but an agent (`CallableNode`).

The body gets `ctx.call(node, input)`, `ctx.session(agent)`,
`ctx.parallel`, `ctx.map`, `ctx.observe` and `ctx.seed`; nothing else.
Agents declare `model` (an alias), `prompt`, `input`, `output`, `mcp`
(their only tools besides codemode, `ask` and `submit_result`: per server
a list or `"*"` for direct tools, or `{ direct?, ask? }`), `sandbox?`,
`steerable`, `compaction`, `maxTurns` (default 16, at least 2) and
`needs`. The workflow lists its `agents`, `commands`, `orchestrators` and
`mcpTools`.

An uncaught failure ends the body as `AgentGaveUp`, `CommandCrashed`,
`ToolCrashed` or `WorkflowFailed` (a nested workflow's failure, with its
cause), which the core holds (see Recovery); anything else is
`BodyError`. There are no
workflow version declarations (owner decision).

## Executors (decided, round 3; revised rounds 4 and 5)

```
Executor    { id, capabilities, contextWindow?(model), start(NodeSpec) -> NodeSession }
NodeSession { turn(message?, turnLimit?) -> TurnResult, rebind?(model), steer?(text), interrupt?(), handle(), close() }
TurnResult  = submitted(output: unknown) | ended | turn_limit(used, limit) | agent_error(AgentFailure) | executor_error
```

A node is one agent call and its dialogue. The host starts a session on
the node's first turn and keeps it open while the node is idle; it closes
it when the node is done or the host exits. `NodeSpec` carries the
rendered input (with folded fields), the full `input`, the restart note,
the model's window, the node's turns and allowance, its checkpoint path,
the conversation so far, the output schema, its dirs and `exportArtifact`,
its sandbox handle, the selected MCP configs and how they spawn, and a
transcript sink.

**pi** is built: in process, through `@earendil-works/pi-agent-core`'s
`Agent` (1.5.0, exact pins), with no built-in tools and no ambient context.
Its tools come from the wallis tool layer. It retries transient errors,
checkpoints every turn, shows the quota and stops at the turn limit (see
Recovery and "An agent is a function").

The tool layer (`host/src/host/tools.ts`) builds every tool per node,
enforces the allowlist, logs every call, counts calls against a per-node
budget and caps every result. The tools:
- `codemode`, `ask` and `submit_result` (validated: schema and output cap), always;
- `read_spill`, which pages output spilled at the context cap;
- with a sandbox: `bash` (run in the agent's sandbox), `read_file`,
  `list_dir`, `write_file` and `export_artifact`, on the sandbox's paths
  (`/w` scratch, `/w/<mount>` read-only, `/run/wallis/inputs` read-only);
  without one, no filesystem at all;
- the allowlisted tools of upstream MCP servers, through `@earendil-works/pi-mcp`:
  direct ones run when called; `ask`-mode ones pause the turn for the
  orchestrator's approval and run (or carry the rejection's reason) when it
  arrives. Every MCP result is journaled (`ToolRecorded`) before the model
  sees it, and a reissued call answers a recorded tool call from the
  journal instead of calling the server again.

Agents' tools are MCP tools and built-ins only: a custom tool means an MCP
server, and a command cannot be handed to an agent. Codemode is always on
(owner decision, round 4): every tool is callable directly and from a
codemode script, which runs in pi-codemode's `CodemodeSandbox` (QuickJS, no
fs or network) with the full input as `input`. A codemode call costs a
turn, so `maxTurns` is at least 2.

**MCP servers run in a sandbox.** Each stdio server in mcp.json gets the
sandbox the TS overlay gives it, with the overlay's network (`"full"` by
default). `${VAR}`
secrets go into the server process's environment only, never into an
agent's sandbox. **Containment:** agent side effects stay inside its
sandbox, and the outside world changes only through `ask`-mode tools the
orchestrator approves, so preflight refuses a tool used directly (by an
agent, or by the body as a node) whose annotations say it writes outside
(`destructiveHint` true, or `readOnlyHint` false with `openWorldHint` true):
`tool_writes_outside`. It must be declared under `ask`. Annotations are the
server's own claim: this is a sanity check, not a proof.

Later rounds (not built): an **ACP executor** and a **Claude Agent SDK
executor**. Notes for Claude Code 2.1.301: `--bare` gives the cleanest
isolation but needs an API key; subscription auth needs a leak test.

Prototype choices:

- Model strings are `provider/model[:thinking]`; a trailing `:<level>` is a
  thinking level only if it names one.
- pi results: a turn that ends with text and no submission is `ended`;
  `stopReason: "error"` after the retries is `executor_error`; reaching the
  allowance aborts the agent and is `turn_limit`; usage counts completed
  turns only.
- Transient errors: 408, 409, 425, 429, 5xx, "overloaded", "rate limit",
  timeouts and network errors (ECONNRESET, ENOTFOUND, …), unless the
  message also names 401/402/403/404/412, billing, a suspension, an invalid
  key or a missing model. A retry drops the failed reply and continues.
- The quota note is `[Turn k of N]`, two newlines after the newest user or
  tool-result message, written into the message (and so into the
  checkpoint); a resumed request replaces a stale note instead of adding one.
- pi validates tool arguments before wallis's `submit_result` check; both
  errors go back to the model.
- A rebind inside a live session sets the pi agent's model; across sessions
  the checkpoint restores the conversation and the new model continues it.
- The per-node tool budget is 10 calls per allowed turn, at least 16.
- MCP tools are named `mcp__<server>__<tool>`. The containment preflight
  starts each server an agent uses, lists its tools and closes it.
- The CLI's default executor module is `host/src/executors/pi.ts`; the
  default command runner (CLI and MCP) is `ProcessCommands` with
  machine-wide resource slots.

## Prototype status

Built:
- the core (`core/`): the journal as a cache, budget, pin, status,
  ownership, interventions and their capabilities, held failures; the SDK
  and host (`host/`);
- sessions with a lock, the CLI and the stdio MCP server;
- the pi executor (retries, per-turn checkpoints, quota, turn limit,
  compaction, sessions, `ask`, approvals), the wallis tool layer, bwrap
  sandboxes with binaries and setup, commands, mounts, artifacts, machine
  slots, sandboxed MCP servers (direct and `ask` modes, journaled), body MCP
  tool nodes, orchestrator nodes, structured pending, and the annotation
  check;
- the fake executor and fake command runner;
- examples: `two-node` and `ask`;
- the SIDERIUS example (`.agents/workflows/siderius/`, see its `MAPPING.md`).

Not built yet:
- the ACP and Claude Agent SDK executors;
- a container backend (`base`), and per-domain network enforcement;
- declaration approval on first run or digest change (setup is only logged);
- file inputs and image inputs for agents;
- nested orchestration (a parent agent answering its child's `ask`);
- `ask` mode for body MCP nodes (outward body actions go through an agent).

## Open

1. GitHub owner for the repo and npm package.
2. Budget enforcement point in pi.
3. Codex and Gemini CLI executor capabilities.
4. Exact `defineAgent` / `workflow()` API.
