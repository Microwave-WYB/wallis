# wallis design

Status as of 2026-11-09 (foundation round). Sections are marked **decided** (agreed with the
owner), **proposed** (drafted, not yet confirmed) or **open**. Details the
first prototype had to fix are marked **prototype choice**: the simplest
option consistent with the section they sit in, not yet confirmed.

## Everything is a value (decided, foundation round)

**The only mutation is appending an event to the run log.** Every side
file is either a content-addressed blob that an event references, or a
cache derivable from the log. Crash windows between writes, semantics held
in host memory, arrival-order dependence, rewind bugs and name-as-identity
bugs are the classes this removes.

- **One commit point.** A value a later event depends on (a dialogue, a
  workspace layer) is written to `blobs/<sha256>` (temp file, then rename)
  before the event that names its digest. A crash in between leaves an
  unreferenced blob and no event: the run resumes from the event before.
- **The journal only grows.** Each slot keeps its attempts, newest first.
  A restart, a rewind or a forget adds an attempt (a rewound slot gets a
  `forgotten` mark); the newest attempt is the live one, and no known
  result is erased. Each settled attempt records the model that served it
  and the session's dialogue after it.
- **Config changes are events** (`alias_rebound`, `budget_raised`,
  `executor_changed`).
- **Checkpoints are events.** Every checkpoint of an agent call is a blob,
  then `agent_progressed(id, dialogue)`; a reissued attempt resumes from
  its newest (`call_agent.checkpoint`), and the session's next call starts
  from what its previous call left (`call_agent.history`).
- **The host decides nothing.** It executes effects and feeds events back:
  which tool calls in flight at a crash run again, which attempt an
  interrupt is for, and whether a restart retries an unknown outcome are
  core state and events (foundation round).
- **Run metadata is a cache.** The host notes facts about a run (workflow
  path, root, executor module, binaries, base, confinement, warnings,
  answer schemas, toolset digests, fork origin) as `noted(key, value)`
  events; `meta.json` is derived from them, cached with the log size it
  was derived at, written atomically and rebuilt when stale. Facts are not
  part of the run's snapshot. `start.json` is the launch request of
  `wallis run` (the first session's parameters), written once before any
  host runs; with the inbox, it is input, not state.

### Workspaces are layers (decided, foundation round)

- A session value's `/w` is an overlay of immutable layers, bottom first,
  with the call's own upper dir on top: in bwrap, the kernel's overlay
  (`--overlay-src <layer>… --overlay <upper> <work> /w`); the host's own
  file tools resolve paths the same way (upper first, then the layers
  top-down; whiteouts and opaque dirs honoured), and write to the upper.
- After a call returns, its upper dir (only the changes; deletions as
  whiteouts) becomes a layer: its manifest (each changed file's sha256) is
  written to `layers/<hex>.json`, `<hex>` being the manifest's sha256, and
  the dir is renamed to `layers/<hex>`, so nothing is copied. Then
  `agent_returned` names the session's layers after the call (the commit
  point). The session value after it is the parent's layers plus that
  one; beyond 16 layers they are squashed into one (hardlinks and merged
  manifests: an unchanged file is never copied or hashed again). A call in
  flight keeps its upper dir across a host exit; a restart starts a new
  attempt with an empty one, so the workspace matches the dialogue.
- `ctx.files(s)` is a Tree (`{ kind: "tree", layers }`) of that session's
  `/w`, without copying. `ctx.session(agent, { from: tree })` seeds a new
  session with it, copy-on-write; a Tree in a command's or an agent's
  input is mounted read-only at `/in/trees/<hex>` (its `path` given to
  `run`). The layers a new session starts from are part of its calls' key.
- No knobs: no snapshot option and no linear mode.

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
   | `IdleNode` | idle node of a steerable agent (never a command), not one whose tool call's outcome is unknown; takes an `OwnedRun` | send to an idle node |
   | `SteerableNode` | running node of a steerable agent (never a command); takes an `OwnedRun` | send to a running node (steer), interrupt |
   | `LiveNode` | a node that is not done, or a held failed one; takes an `OwnedRun` | restart, cancel one node |
   | `SubmittableNode` | an orchestrator node waiting for its result; takes an `OwnedRun` | submit_result |
   | `ResumableRun` | `checkPin` | replaying a resumed run |

   The host checks before it sends an event; the core checks again when it
   applies it, because time passes in between. Brands exist only where raw
   ids cross a boundary: `RunId` and `NodeId`, parsed from CLI and MCP input.
3. **Everything at a boundary is `unknown` until parsed** with its schema:
   model output, command output, MCP and CLI arguments, and artifact refs
   (verified against the run's store). No `as` casts at those boundaries.
   (The core's own JSON, produced by generated encoders, is trusted.)

## The core invariant (decided, round 7)

Agents interact with the workflow only through their input and output.
Their tools touch only the outside world (custom tools, MCP) or their own
sandbox. Exposure is permission: a tool given to an agent can be used
freely, and the agent knows only the tools it is given; no prompt text
mentions orchestrators, approvals or other capabilities. Outward writes
happen in the workflow body. Whether to ask first is code: call an
orchestrator node. The framework does not enforce it.

- **The orchestrator** is whoever owns the run: in practice an agent in a
  harness (Claude Code, Codex, ...), driving wallis over MCP or the CLI. It
  answers what the run asks (agents' `ask`, orchestrator nodes) and decides
  on budgets, failures, unknown outcomes and models.
- **Internal and external nodes** (a distinction for the docs, not a type
  hierarchy). Agent sessions, commands and nested workflows are internal:
  fresh and re-executable from their input. Tools (custom tools and MCP
  tools, called by agents or by the body) and orchestrator nodes are
  external: they reach a stateful outside, so the journal is the only truth
  about them. Consequences:
  - a question to the orchestrator must be self-contained: it sees only the
    item, not the run's context;
  - forks share the same orchestrator, so its answers can contaminate
    ablations (an answer given in one fork is a fact of the world for it);
  - restarting an external node, or a node that used one, asks the outside
    again (a tool is called again, a question is asked again): that is not
    reproduction, and `restart` says so;
  - a tool call in flight when the host died is made again only when it is
    safe (a custom tool with `replay: "safe"`, an MCP tool annotated
    `readOnlyHint: true`); otherwise its outcome is unknown and the node
    waits for the orchestrator (`outcome_unknown`; restart retries it).
- **The write rule is a warning, not a refusal.** A tool given to an agent
  whose annotations say it may write outside (`destructiveHint`, or not
  read-only and open-world; unannotated tools count as writes, per MCP's
  defaults) gives a preflight warning, recorded in run metadata and shown
  by `describe`. It is applied whenever an agent's tool list is built, with
  `confine: "off"` too. Body calls are not checked.
- **Network.** Agents and commands never have network. Tool processes
  (toolsets, MCP servers) are the channel outside: `network: "none" |
  "host"`, default `"host"` (it was `"full"`). Sandbox `setup` keeps its
  network (logged).

Round 7 removed what round 6 added for writes by agents: `ask`-mode MCP
tools, the built-in approval node and its pending kind, approvals answered
with `submit`, and the implicit ask. The round-6 positioning ("no outward
effects except approved `ask`-mode MCP tools") is replaced by the invariant
above.

## Agent tools and the workspace (decided, round 7)

```ts
const lib = toolset<typeof import("./tools/lib.ts")>("./tools/lib.ts", { sandbox: toolBox, secrets: ["API_KEY"] });
const mcp = defineMcp(mcpJson, { scholar: { sandbox: scholarBox } });
defineAgent(env, { ..., workspace: { sandbox: py, access: "exec" }, tools: [ask, lib.search, mcp.scholar] });
```

- **`workspace`** (plain data) is what an agent may do with files:
  `{ access: "read" | "write", sandbox? } | { access: "exec", sandbox }`.
  `read` gives `read` and `ls`; `write` adds `write`, `edit` and
  `export_artifact`; `exec` adds `bash` and needs a declared sandbox (the
  union makes `exec` without one a type error). Without a sandbox, `read`
  and `write` work on a minimal workspace: the input artifacts and a
  scratch dir, no volumes. Without `workspace` there is no filesystem. The
  file tools are wallis's own, with pi's names, parameters and descriptions
  (pi-coding-agent is not a dependency); `read` returns images as image
  content. The access is kept as one rank on the agent definition (none 0,
  read 1, write 2, exec 3), so a later inference from Artifact fields
  (round 8) can take a max.
- **`tools`** holds only capabilities beyond the workspace: `ask`, toolset
  tools and MCP tools or servers. Tool values are made only by wallis (a
  private symbol brand); anything else is a type error and is refused when
  the agent is defined. `codemode` and `submit_result` are always there,
  and `read_spill` (context protection).
- **Custom tools first.** A tool module exports plain pi `AgentTool`s
  (name, label, description, parameters, outputSchema, execute, `replay`)
  plus MCP `annotations` (`WallisTool`, declared with `satisfies` so the
  refs are typed). `toolset<typeof import("./tools/x.ts")>(path, { sandbox,
  secrets, network })` gives typed refs (`lib.search`); the import is
  type-only, and at run time only the path is used, so the implementation
  never enters the workflow VM. wallis bundles the module with esbuild
  together with a runner that registers each tool on the official MCP SDK
  server over stdio under its export name, so two exports never share a
  route (`parameters` as `inputSchema`; `outputSchema`,
  `structuredContent` and `annotations` passed through; the tool's `name`,
  which its agent sees, and `replay` in `_meta`), and runs it under node in the toolset's sandbox,
  with only its named secrets in its environment. A cancelled request
  aborts the tool's `signal`.
- **Existing MCP servers** are an adapter. `defineMcp(mcpJson, overlay)`
  returns server objects keyed by name (typed from the JSON keys); mcp.json
  stays standard, and the overlay gives `{ sandbox, network }`. A server
  object in `tools` gives only its tools annotated `readOnlyHint: true`
  (the others are named in a warning); `scholar.search` is one tool. Tool
  names are checked at preflight (`unknown_tool`): MCP is an unknown
  external object, with no codegen. Agent-visible names are
  `mcp__<server>__<tool>`. An agent sees each name once: a custom or MCP
  tool named like a built-in (`codemode`, `submit_result`, `read_spill`,
  `ask`, `read`, `write`, `edit`, `ls`, `bash`, `export_artifact`), or two
  of its tools by one name, are refused at preflight (`tool_name_taken`);
  if a source's listing changes after it, the agent call fails (held)
  rather than one tool replacing another. MCP servers run in their own sandboxes and never
  see an agent's input artifacts or scratch dir: MCP tools that expect
  local file paths cannot work on agent files (use the workspace or custom
  tools for files), and wallis offers no MCP `roots`.
- **Body calls.** `ctx.call(lib.upload, input)` is typed by the tool's
  parameters and returns its validated `structuredContent`, typed by its
  `outputSchema` (else `unknown`, unless a schema is passed as a third
  argument); `ctx.call(scholar.search, args, Schema?)` returns `unknown`
  unless parsed. Body calls are external nodes: journaled, replayed from
  the journal, and the same definition serves agents and the body.
- **Connection scope.** An agent gets one connection per source per agent
  call (each `ctx.call` of a session), so server state never crosses agents and
  nothing runs between calls; the body gets one per source per run (per
  host session). Every connection gets its own scratch dir
  (`work/<source>-<random>`), its working directory, confined or not. The client declares no capabilities, so
  sampling and elicitation are refused; resources and prompts are ignored.

Prototype choices:

- The sandbox layout is `/in` (input artifacts, and Trees at
  `/in/trees/<hex>`, read-only), `/w` (the workspace), each volume at its
  target and `/tmp` (plain, ephemeral) (foundation round; volumes this
  round).
- With `noUncheckedIndexedAccess`, `server.tool` reads as `McpTool |
  undefined` (tool names are not typed); `tools` and `ctx.call` take that.
- `describe` shows the warnings of the latest preflight of that workflow in
  the project, and each toolset's bundle digest from it; it does not start
  tool processes itself.
- A toolset tool's identity is (its bundle digest, export): the bundle is
  made once per run, at its start, and pinned (see "The journal is a
  cache"), so within a run a toolset never changes; a new run of changed
  code is new tools. An MCP server's tool stays (server, tool): a changed
  server is the outside world changing. The bundle digests are also in run
  metadata (`toolsets`).
- `describe` summarizes capabilities (this round): the tools given to
  agents that may write outside (unannotated counts as a write) and the
  agents that hold them (from the latest preflight, `writes`), the
  orchestrator questions, agents with `exec`, what reaches the network
  (toolsets, MCP servers, sandboxes with `network: "host"`), and every
  bind volume.

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
  prompts/*.md     # prompts, imported as text; never bound into a sandbox
  mcp.json         # standard MCP config, imported as JSON
  skills/          # standard SKILL.md directories
  <dirs>/          # code and files sandboxes need, bound as volumes (e.g. ./trainer:/trainer:ro)
```

- Prompts: `import p from "./prompts/p.md" with { type: "text" }`. The
  bundler inlines them, so the workflow digest covers prompt content.
- MCP: `import m from "./mcp.json" with { type: "json" }`, wrapped by
  `defineMcp(m, overlay)`, where the TS overlay gives each stdio server its
  sandbox (and its network, `"none" | "host"`); it returns server objects
  for agents' `tools` and body calls. `${VAR}` in `env` is a secret
  reference. Custom tools live in modules next to the workflow
  (`tools/*.ts`), loaded with `toolset` (see "Agent tools and the
  workspace").
- Nothing in the workflow dir is visible to a sandbox unless a volume binds
  it (`volumes: ["./trainer:/trainer:ro"]`).
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
orchestrator node), `ctx.call(ctx.session(agent), input)` for agents (round 6),
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
  Removed in round 7: the agent `mcp` selection, `ask`-mode tools and
  approvals, the implicit ask, `mcpTool` nodes, `session_busy`, the agent
  `sandbox` field (now part of `workspace`).
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

## Loops: `ctx.loop` (decided, foundation round)

`ctx.loop(init, async (ctx, state) => next(state2) | done(value))` is a
typed fold: `S` is inferred from `init`, `O` is the union of the `done(...)`
values. State and output are separate, so an ending (approved, abandoned)
lives only in the output and loop internals (sessions, counters) stay
inside.

```ts
const ending = await ctx.loop({ s: ctx.session(colorist), round: 0 }, async (c, st) => {
  const [look, s] = await c.call(st.s, { sheet, round: st.round });
  if (look.ok) return done({ type: "approved" as const, look });
  if (st.round >= 5) return done({ type: "abandoned" as const });
  return next({ s, round: st.round + 1 });
});
```

- Each iteration is its own branch (`<loop>.<i>`: its own ctx and request
  ids, like a `ctx.map` item), so replay, fork and resume are stable. State
  is plain data; sessions in it are values.
- The runtime shows the loop: each iteration's state is observed (label
  `loop <position>`, truncated to 2000 characters; monitoring only, never
  returned or matched), so `wallis tree` lists the loop, its iterations and
  the current one, and `status` the current iteration.
- No iteration cap: the budget governs long loops. A body exception fails
  the run like any body error; a node failure inside an iteration is held
  as usual (its restart recomputes from that iteration; earlier ones hit).
- Prefer `ctx.loop` to `let` plus `for` for loops that call nodes: the
  runtime can then show the iterations, and each one's request ids do not
  depend on how many calls the iterations before it made.

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

- **Sessions are values (foundation round), the only way to call an
  agent:** `ctx.call(ctx.session(agent), input)` returns `[output, next]`,
  where `next` is the session after the call. `ctx.call(agent, …)` is a
  type error, and a typed refusal (`session_required`) at run time.

  ```ts
  let s = ctx.session(lookAgent);
  let look;
  [look, s] = await ctx.call(s, { sheet, measure });
  [look, s] = await ctx.call(s, { feedback: "too yellow" });   // same conversation
  ```

  Without semicolons, a line that starts with `[` continues the line
  before it: end the line before with `;`.

  - Each call's input is checked against the agent's input schema and
    appended to the session's dialogue as a new message; each output is
    validated. Budgets and `maxTurns` are per call.
  - **A session value is plain data** (`{ kind: "session", agent, id }`):
    keep it, pass it to any branch, call it from anywhere. The value called
    is unchanged, so **calling the same value again is a branch** from the
    same dialogue, allowed implicitly (there is no `branch` API, no
    queueing and no `foreign_session`).
  - **Identity.** A call is keyed by (node digest, parent session id, input
    digest, occurrence); the occurrence counts calls of the same node,
    session and input within one branch of the body (`<branch path>/<n>`),
    in program order, like request ids, so it never depends on arrival
    order. The session after a call is a hash chain over the call's slot
    (which includes the parent session id) and the attempt that answered:
    `s<hash>`. A new session (`ctx.session(agent)`) has `id: null`; two are
    equal. A session id the run never answered with is refused
    (`unknown_session`).
  - **The dialogue is a content-addressed blob**: a delta from the parent
    session's dialogue (how many of its messages it keeps, and the rest),
    or whole after a compaction or when the chain of bases is deep.
    `agent_returned` names the dialogue the call left; a call of the
    session after it starts from there.
  - **A restart of a call is calling its parent value again**: a new
    attempt at the same slot. Its answer is a new session value (the
    attempt is in the hash), so every call after it misses. A cancelled or
    failed call answers with no session value: the body calls the value
    before it again.
  - A session is data, not a process: between calls nothing runs, and the
    next call rebuilds the agent from the dialogue blob. There is no
    `close()`. Each call gets a fresh sandbox process (background processes
    die with it). Until workspaces are layers, a lineage of sessions (calls
    descending from one new session's first call) shares one scratch dir.
  - `wallis tree` lists the calls, then the session values as a tree of
    branches (each the session after a call of its parent).
- **`ask` (round 6; opt-in since round 7: `tools: [ask]`).** `ask(message)`
  takes plain language, no schema. The question goes to the agent's caller, the body,
  which forwards it to the orchestrator (later, a parent agent may answer
  it; the semantics stay "answered by the caller"). The node goes
  `Idle(asked)`; the agent stays in the same loop and the reply becomes the
  tool's result, also after a host exit (the conversation is rebuilt up to
  the pending call and the reply is delivered as its result).
- Ending a turn with neither `submit_result` nor `ask` makes the node
  `Idle(ended_without_result)` with its final text (round 7: there is no
  implicit ask); a `send` continues it as the next user message. There is
  no nudging. Both idle states resume with `send`.
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
  | `send` (+ turns) | an idle agent node (question, ended without result, turn limit with turns, interrupted) | delivered: the dialogue continues | `IdleNode` |
  | `send` | a running agent node of a steerable agent (more turns are refused) | queued as a steer after the current turn | `SteerableNode` |
  | `interrupt` | a running agent node of a steerable agent | aborts the current turn, its tool calls included: `Idle(interrupted)`, progress kept | `SteerableNode` |
  | `submit_result` | an orchestrator node | its result, checked against the answer schema | `SubmittableNode` |
  | `restart` | a live node, or a held failed one | discards progress; reissues with the original input (+ note for steerable agents, + turns); a command reruns; a tool is called again; an orchestrator node is asked again | `LiveNode` |
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
  the session's dialogue before the call (`history`, a blob digest), this
  attempt's newest checkpoint (`checkpoint`) and the MCP results
  already journaled for the call (`recorded`). An answer to a node at its
  turn limit without more turns is refused (`no_turns_left`); a restart
  resets the allowance to `maxTurns`, or to `--turns`.
- The core keeps every session value an agent call answered with (the
  call and attempt it comes after); a call of it gets that attempt's
  dialogue as `history`. Every checkpoint of a call is a blob named by
  `agent_progressed`; a blob the journal names that the store does not
  have is refused (`dialogue_missing`), never a fresh start. A restart is
  a new attempt without a checkpoint, so it starts from its session's
  dialogue again.
- Calls of one session value made from plain concurrent code in one ctx
  (after an `await`, outside `parallel`/`map`) have the caveat every
  concurrent call has there (see Concurrency).
- `ask` ends the turn (pi's `finishTurn`) with a placeholder tool result
  marked in its details; the reply replaces it when it arrives, wherever
  it sits among the message's tool results. Later tool calls of that
  message are not run ("not run: this turn waits for the reply"). It
  cannot run from codemode.
- An interrupt wins over a question asked in the same turn (the
  placeholder stays, and the next message answers it). The core names the
  attempt an interrupt is for (`interrupt_turn(id, attempt)`; every
  `call_agent` carries its attempt); one that arrives before that attempt's
  turn has started is applied when it starts, and never to another attempt.
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
  (`orchestrators: [pickLook, confirmUpload]`), so `wallis describe` and
  MCP `describe` show which questions a workflow may ask and the answer
  schema of each.
- The orchestrator answers with `submit_result({ run, node, value })` (MCP)
  or `wallis submit <run> <node> '<json>'`. The value is checked against
  the node's output schema; a mismatch is refused with the errors
  (`invalid_answer`) and the node stays pending. Artifact refs in a value
  are verified against the run's store.
- Its input may carry artifact refs; the pending item lists each with its
  blob path and the `wallis export` command.
- A restart asks again (it stays pending); a cancel fails it with
  `OrchestratorCancelled` for the body (round 7).
- Built in: the agent-ask forwarding (string → string, answered with
  `send`). Asking before an outward write is an orchestrator node the body
  calls, then the write in the body: there is no approval machinery.

Prototype choices:

- An orchestrator node is never held back by a pause or the budget. A done
  one cannot be restarted (its answer has been used).
- The answer schemas are written to run metadata (`meta.json` `answers`)
  so queries list them without bundling the workflow.
- The core never sees tool schemas: the host checks a body tool's input
  against its listed `inputSchema` (unknown tools are refused,
  `unknown_tool`) and adds whether it is safe to replay to the request.

## Structured pending (decided, round 6)

Attention is structured JSON for programmatic orchestrators: MCP `wait`,
`get_run` and `pending` return it, and the CLI prints it with `--json`
(`status`, `wait`, `pending`); the text `describe` stays for humans. Each
item has its kind, run, node, the question or input, and `actions`: the
allowed verbs with their arguments as JSON Schema and the CLI form.

| Kind | What waits | Actions |
| --- | --- | --- |
| `agent_ask` | an agent's question (its `ask` tool) | `send`, `restart`, `cancel` |
| `ended_without_result` | an agent's turn ended with neither a result nor a question (its final text) | `send`, `restart`, `cancel` |
| `turn_limit` | an agent at its turn limit | `send` with `turns`, `restart`, `cancel` |
| `interrupted` | an interrupted agent | `send`, `restart`, `cancel` |
| `outcome_unknown` | a tool call in flight at a crash, not safe to repeat (`tool`, `args`; agent or body) | `restart` (retries it), `cancel` |
| `orchestrator_pending` | an orchestrator node (`input`, `artifacts`) | `submit_result` with its answer schema, `restart`, `cancel` |
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

- Runs live in `.wallis/runs/<run_id>/`: `log.jsonl`, `blobs/`,
  `meta.json` (a cache), `start.json` (the launch request), `lock`,
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
  `{ executor, commands? }`. It is passed with `--executor`, noted in the
  log (`meta.json`), and reused on resume. There is no default executor until pi
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
  is a blob named by `agent_progressed`. A reissued or resumed call
  continues from the last completed turn; earlier turns are never requested
  again. The call's upper dir lives until the call is done, so the
  conversation and the files stay consistent. **The core decides** each
  tool call in flight at a crash (the executor reports them as
  `tool_calls_in_flight`; the core answers `in_flight_decided`, logged): a
  call runs again if it
  only reads (`read`, `ls`, `read_spill`), only asks (`ask`), is an
  external tool that is safe to repeat (`replay: "safe"`, `readOnlyHint`)
  or whose result is already journaled (same tool and arguments), or is
  codemode while every external tool of the agent is safe. A call that
  worked only on the sandbox (`write`, `edit`, `bash`) becomes an error the
  model sees ("may or may not have taken effect"). Any other call's
  outcome is unknown: nothing runs, and the node waits for its owner
  (`Idle(outcome_unknown)`: restart retries it, cancel fails it). The
  retry is core state (the running attempt says so), so a crash between
  the restart and the reissue keeps it; it is spent on the next decision. A body
  tool call in flight at a crash is reissued only if safe; otherwise its
  node waits the same way.
- **An uncaught node failure blocks only its dependents.** When the body
  fails because of a node failure it did not handle, the run is not
  finished: the failure is held (`Idle(NodeFailure)` once nothing else can
  proceed, an attention item meanwhile) and independent branches keep
  running. The owner `restart`s the node (optionally with a note,
  `--model` rebind or `--turns`): a new attempt opens at its slot (the
  failed one stays in the journal), it reruns, and the body runs again against the journal, so everything
  completed is a hit and it continues. Or the owner `cancel`s it: only then
  does the failure propagate, and the run finishes Failed if the body does
  not handle it. Commands work the same way (a restart reruns them, e.g.
  after fixing a `requires` or volume problem). A restart re-executes the
  node: the tools it calls and the questions it asks reach the outside
  again, which is recovery, not reproduction.
- **Code changes are allowed.** Resume re-executes the body with the new
  bundle against the journal (see "The journal is a cache"); the change is
  logged (`CodeChanged`, old and new digests, both in the pin) and the host
  prints "code changed; N calls reused, first new call: <node> at <id>".
- Operational changes are logged events: alias remaps (`AliasRebound`),
  budget raises (`BudgetRaised`), executor changes (`ExecutorChanged`).
- Result-defining changes are refused on resume: pinned files, seed and
  the core's semantics version. A changed bind volume is not refused: it
  misses the cache of the calls that bind it.
- `wallis fork <run>` copies the whole journal (and blobs) into a new run,
  which re-executes; unchanged calls hit. The journal is per run and its
  forks, never shared implicitly with other runs: runs are independent
  samples.
- `wallis fork <run> --forget <node>…` (MCP `fork` with `forget`; this
  round) also forgets those calls in the fork: each gets a `call_forgotten`
  mark (an intervention with `by`, checked by the core: a call already
  forgotten, refused, or unknown is `not_live`, and a refused forget leaves
  no fork behind). A forgotten call executes again when the body reaches
  it; calls downstream miss only if their inputs change; a later call of
  a forgotten agent call's session misses (its session value is new). The
  source run and the fork's earlier attempts are untouched.

Prototype choices:

- **Own checkpoints, not pi-durable.** pi-durable 1.5.0 was evaluated: it
  is a complete harness of its own (storage, generation tasks, tools,
  codemode, compaction) behind an API marked experimental. Running nodes on
  it would duplicate the wallis tool layer (allowlist, caps, spills,
  sandboxes) and the executor's turn contract. pi-agent-core already
  restores a conversation (`initialState.messages`) and continues it
  (`continue()`), so the pi executor checkpoints its conversation through
  the host (`NodeSpec.checkpoint`: a blob, then `agent_progressed`, after
  every assistant message and every turn) and restores from the newest
  (`NodeSpec.resume`). A reply that failed or was aborted is never progress
  and is dropped on restore.
- The semantics version is `wallis-core/8` (this round: journal keys
  without names, structural node and tool identity, volumes in sandbox
  digests; `wallis-core/7` was the foundation round: an append-only journal
  of attempts, checkpoints and host facts as events, and the session,
  workspace and identity changes below; round 7 was opt-in ask, ended
  without result, unknown outcomes, body tool replay, orchestrator restart
  and cancel). Runs of earlier versions are refused on resume
  (`pin_mismatch` on `semantics`): their journal keys mean something else.
- The core keeps each call by its slot, as a per-kind state union
  (`AgentCall` with `AgentHeld | AgentRunning | AgentWaiting |
  AgentUnavailable | AgentSettled`, and likewise for commands, tools and
  orchestrator nodes), so a state is only ever paired with its kind. A
  running state says whether it was issued in this host session
  (`Resumed` resets it), so a call in flight is issued again once after a
  crash and not again when the body re-executes in the same session. Ids
  are opaque inside the core (`RequestId`, `SessionId`, `Slot`, `Digest`);
  a slot is made only by hashing a call. On the wire they are strings, and
  effects name the journal key `slot`.
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
  const py = defineSandbox({}, {          // a subset of a compose service
    name: "py",
    requires: ["uv"],                     // binaries the base must provide
    setup: [["uv", "sync", "--frozen"]],  // optional: once per digest, WITH network
    volumes: ["./trainer:/trainer:ro",    // a bind: the mode is written, only :ro exists
              "uv-cache:/var/cache/uv"],  // a named volume: a writable cache
    devices: ["/dev/dri"],                // dev-bound as declared
    environment: { UV_OFFLINE: "1" },
    network: "none",                      // default; "host" is for tool sources only
  });
  ```

  Nothing is implicit: the workflow dir is not mounted; whatever a sandbox
  needs comes through its volumes, so an implementor cannot read judge
  prompts or Health code. Each call gets a private writable `/w`. There is
  no writable bind. The base is the host's system dirs, read-only; its
  identity (distro and version, kernel) goes in run metadata, and `image`
  (a container image) is reserved for a later backend and ignored by bwrap.
  `defineMounts`, the workflow's `mounts` table and sandbox `mounts` are
  gone (this round; see "Volumes").
- **`requires`**, per name: call-time `--bin name=path` (MCP `bins`) >
  local profile (per workflow > global) > the caller's PATH at run
  creation (not the host process's: systemd hosts have a minimal PATH).
  The resolved absolute paths are stored in run metadata and reused on
  resume. A required program is called by its real path; its install
  prefix (the dir above its `bin/`) is visible read-only at the same path,
  so files it finds relative to itself are there, and its dir is on PATH
  (this round). Preflight runs a check inside
  the sandbox (`<name> --version`, or `{ name, check }`). Typed refusals:
  `requires_missing(name)`, `requires_broken(name, exit, stderr_head)`,
  `unknown_bin(name)`. Versions go in metadata only, not the pin.
- **`setup`** runs once per digest (the declaration, its binaries and the
  content of its bind volumes) in bwrap with the network on, writing a cached env
  dir exposed as `$WALLIS_ENV`; `$WALLIS_ENV/bin` is on every run's PATH,
  and runs mount the env read-only without network. After setup every
  binary in `$WALLIS_ENV/bin` is smoke-tested the same way. It is logged
  (there is no first-run approval listing yet). Failure: `setup_failed`.
- **Devices** a sandbox declares are dev-bound as declared; one this host
  lacks is refused at preflight (`device_missing(sandbox, device)`). GPU
  devices are also bound when a call declares `resources.gpu`.
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

- Layout inside a sandbox: `/w` is the working directory (a command's
  private dir; an agent's overlay of its session's layers); each volume is
  at its target (a bind read-only, a named volume writable); input
  artifacts are at `/in/<hex>/<name>` and Trees at `/in/trees/<hex>`;
  required programs at their real paths; the setup env at
  `/run/wallis/env`. Plus `/usr`, `/etc`, the merged-`/usr`
  symlinks, private `/proc`, `/dev`, `/tmp`, no network, and the sandbox
  dies with the host. The environment is exactly `PATH`, `HOME=/w`,
  `LANG`, `WALLIS_SCRATCH`, `WALLIS_INPUTS`, `WALLIS_ENV`,
  `WALLIS_COMPUTE_MINUTES`, the sandbox's declared `environment` (and, for
  MCP servers, their secrets); secrets
  never appear on a command line.
- No sandbox an agent or a command runs in has network (round 6: the
  domain allowlist is gone; filtering it per domain was premature): an
  agent or command whose sandbox declares `network: "host"` is a
  declaration error. A tool source's spawn shares the host network when its
  overlay or its sandbox says `"host"` (the overlay's default; it was
  `"full"` before this round), and `setup` always does.
- A command whose sandbox cannot be built (no bwrap) fails as
  `unrunnable`; agents' `bash` reports it. A local tool source (a toolset,
  an MCP server with a command) is refused at preflight
  (`sandbox_unavailable`, round 7 fixes): it fails closed. `confine:
  "off"` (tests, development; an executor kit may set it), and only it,
  skips the sandbox preflight and runs toolsets and MCP servers
  unconfined; binaries are still resolved and recorded.
- Setup envs live in `$XDG_CACHE_HOME/wallis/envs/<digest>/`, ready once
  `.wallis-ready` is written. A setup step's argv is the same as a run's
  (`argv[0]` a required binary).
- A command's memory scope wraps bwrap in `systemd-run --user --scope -p
  MemoryMax=…`; the session-bus variables it needs are unset inside.
- Per-node dirs: `work/<node>/inputs/<hex>/<name>`, `work/<node>/scratch/`,
  and `work/<node>/spill/`, deleted when the node is done.

## Volumes (decided, this round; replaces the round-4 mounts)

A sandbox declares its volumes in Docker/compose vocabulary, so a sandbox
reads as a subset of a compose service.

- **Bind volumes**, `"<host path>:<target>:ro"`: a host dir, read-only at
  the target. The mode must be written and only `:ro` exists; a missing
  mode, `:rw` or any other mode is a compile error (template literal types,
  with a readable message) and, for a string that slips past the types, a
  typed refusal at preflight (`invalid_volume(sandbox, volume, reason)`).
  The host path is relative (to the workflow dir) or starts with `~/`.
  Writes leave a node only as returned artifacts, and a run only through
  `wallis export`.
- The caller gives another host dir for a bind by its container target:
  `--volume /data=<dir>`, MCP `volumes: { "/data": dir }`, or the local
  profile's `volumes` (per workflow > global; paths resolve against the
  project root). Call-time dirs of a new run are noted (`noted volumes`)
  and reused by every later host of the run (a resume, the detached host
  of `submit`). A host dir that does not exist is
  `volume_missing(sandbox, target, path)`; a caller-given target no
  sandbox binds is `unknown_volume(target)`.
- **A bind's content digest is part of the cache key** of every command
  and agent call whose sandbox binds it (through the sandbox digest in the
  node digest). It is no longer pinned.
- **A run snapshots its binds when it starts** (foundation 9): each host
  dir is copied into the run, `<run>/binds/<hex>` (`cp -a
  --reflink=auto`: a reflink on filesystems that have them, else a plain
  copy), named by its digest and noted (`binds`: host dir -> digest).
  Calls bind the snapshot, so an edit while the run goes on never reaches
  it; every later host of the run reuses the snapshot (a noted one that is
  gone is `volume_missing`, never retaken). A fork takes a new snapshot:
  edit a bound script, then fork (or `fork --forget`), and the calls that
  bind it, and only those, run again.
- **Named volumes**, `"<name>:<target>"`: a wallis-managed writable dir,
  `$XDG_CACHE_HOME/wallis/volumes/<name>`, shared across runs and
  sandboxes that name it, and left out of every cache key. The contract:
  results must not depend on its contents (a cache: downloaded models, a
  compiler cache, darktable's cache). wallis cannot check it.
- **Targets** are absolute, plain (no `.`, `..` or trailing `/`), and
  overlap neither each other nor a dir the bwrap backend owns: `/usr`,
  `/etc`, `/bin`, `/sbin`, `/lib*`, `/proc`, `/dev`, `/in`, `/w`, `/tmp`,
  `/run/wallis` (nor `/` or `/run`, which contain them). This is a bwrap
  backend restriction (it reuses the host base at the same paths); the
  types refuse the reserved dirs too, and preflight refuses the rest as
  `invalid_volume`.
- Agents can use sandboxes with read-only binds and named volumes, which is
  all a volume can be; their file tools see each volume at its target (a
  bind read-only, a named volume writable with `write`).
- `describe` lists each sandbox's volumes, devices and network.

Prototype choices:

- The digest is `bind:sha256:` over the sorted relative paths, file
  sha256s and symlink targets. File hashes are cached by path, mtime and size in
  `$XDG_CACHE_HOME/wallis/file-hashes.json`; a content change that keeps
  all three is not detected.

## The journal is a cache (decided, round 5)

- **Key:** (node definition digest, kind, canonical input digest, the
  session it continues, occurrence n). The nth call with the same node and
  input gets the nth recorded result.
- **Identity is by digest or structure; names are labels only** (this
  round). No key, digest or id contains a node's, a sandbox's or a nested
  workflow's name, so renaming one with the same definition keeps every
  journal entry, and two names for one definition are one node.
  - Agent digest: prompt, model alias, input and output schemas, its
    tools (each by identity), access, skills, needs, the sandbox digest
    (declaration, binaries, bind volume content), steerable, compaction,
    maxTurns.
  - Command digest: its `run` and `parse` code, schemas, resources, the
    sandbox digest. Its description is a label.
  - Orchestrator digest: its description (the question), input and answer
    schemas.
  - A custom tool is (its toolset's bundle digest, export); an MCP tool is
    (server, tool). A run's toolsets are bundled once, when it starts: each
    bundle is a blob in the run's store, pinned as `toolset:<path>`, and
    every later host (and a fork) runs the pinned bundle whatever the
    source is now. A new run bundles the source as it is.
  - The workflow is its bundle digest (`workflow_digest`, recorded; the
    bundle itself is a blob in the run's store under that digest; a
    code change is logged as `code_changed`, followed by
    `workflow_declared` with the new code's agents, commands and
    orchestrators, which the core looks nodes up in from then on).
  - A session value is continued only by the agent whose dialogue it is
    (`session_of_another_agent`), so a relabelled value cannot hand one
    agent's dialogue to another.
  - A nested workflow's calls are under its call's id (`#3>#0`), not its
    name; a parallel key is escaped in ids (`#`, `.`, `>`, `~`, `%`), so no
    key reads as another id's path; node dirs map ids one to one
    (`#0.a#1` → `_0.a_1`; `-` escapes the rest).
  - A toolset declared twice with different options is a declaration
    error; the same tool given to an agent twice is one tool.
  - Occurrences follow call issue order, which is synchronous and
    deterministic.
- **Resume re-executes the body against the cache.** Unchanged calls hit;
  anything changed misses and executes; downstream calls miss
  automatically when their inputs change. There is no path divergence.
- **Restart opens a new attempt** at that node's slot (logged), so it
  executes again; a session call's restart also forgets the session's
  later calls (a `forgotten` attempt each) and starts without the call's
  journaled MCP results: the outside is asked again. Earlier attempts and
  their results stay in the journal.
- **MCP calls are journaled** like every call: a body MCP node's result is
  its entry; an agent's MCP results join its call's record. Replay,
  resume, the restart of an unrelated node and fork reuse them.
- **Fork copies the cache** into a new run; the cache is never shared
  implicitly across runs.
- Request ids are only display and intervention identities.
- **Pin:** the workflow digest is recorded, not compared (code changes are
  allowed and logged); pinned files, the seed and the semantics version
  still refuse. Bind volumes are not pinned: their content is in the
  cache key of the calls that bind them.

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
overlay)`, `toolset(path, options)`, `ask`,
`defineSandbox(env, spec)`, `defineAgent(env, spec)`, `command(spec)`,
`orchestrator(spec)`, `subWorkflow`, `workflow`, `Foldable`, `Artifact`,
the `WallisTool` and `ToolAnnotations` types, TypeBox's `Type`, and the
typed errors `Refused`, `AgentFailed` (`agent`, `failure`), `CommandFailed`
(`command`, `failure`), `ToolFailed` (`tool`, `failure`),
`OrchestratorCancelled` (`orchestrator`), `WorkflowFailed` (`workflow`,
`reason`) and `SchemaError`. Every node is `Node<I, O> = AgentDef |
CommandDef | WorkflowNode | OrchestratorDef`, discriminated by `kind`;
`ctx.call` takes every kind but an agent (`CallableNode`), and tool values
(toolset tools, MCP tools).

**`ctx` is typed by what the workflow declares** (this round): the body's
`ctx` is `Ctx<{ agents, commands, orchestrators, toolsets, servers }>`,
inferred from `workflow({ agents, commands, orchestrators, toolsets, mcp })`.
`ctx.call` on an undeclared command or orchestrator, `ctx.session` of an
undeclared agent, and a tool of an undeclared toolset or MCP server are
compile errors. Definitions carry their name as a literal type
(`CommandDef<I, O, "train">`), a toolset tool its module's type
(invariant), an MCP tool its server. Branches, iterations and map items get
the same typed ctx. A nested workflow's `ctx` is the permissive `Ctx`. At
run time the same rule holds whatever the types say: a node must be the
declared value itself (another value under a declared name is not it),
else `Refused` (`unknown_command`, `unknown_orchestrator`, `unknown_agent`,
`unknown_tool`).

The body gets `ctx.call(node | tool, input, schema?)`, `ctx.session(agent)`,
`ctx.parallel`, `ctx.map`, `ctx.observe` and `ctx.seed`; nothing else.
Agents declare `model` (an alias), `prompt`, `input`, `output`, `tools`
(beyond codemode and `submit_result`: `ask`, toolset tools, MCP tools or
servers), `workspace?`, `steerable`, `compaction`, `maxTurns` (default 16,
at least 2) and `needs`. The workflow lists its `agents`, `commands`,
`orchestrators`, `toolsets` and `mcp`.

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

The tool layer (`host/src/host/tools.ts`) builds every tool per agent
call, gives the agent exactly its declared tools, logs every call, counts
calls against a per-node budget, caps every result and journals every
external result. The tools:
- `codemode` and `submit_result` (validated: schema and output cap), and
  `read_spill`, which pages output spilled at the context cap, always;
- the workspace's file tools by access (`read`, `ls`; `write`, `edit`,
  `export_artifact`; `bash`), on the sandbox's paths (`/w` the workspace,
  read through its layers and written to the call's upper dir; `/in`,
  `/in/trees/<hex>` and bind volumes read-only, named volumes writable);
  an agent with a
  workspace gets one short note on these dirs in its system prompt;
- `ask`, if declared;
- custom tools and MCP tools from their sources (`toolsets.ts`), over one
  connection per source for the call. Every result is journaled
  (`ToolRecorded`, `{ tool, args, outcome }` under `<turn>/<tool call id>`,
  nested codemode calls under `<key>/<n>`) before the model sees it; a
  reissued call answers a journaled call from the journal when tool and
  arguments match (a mismatch, e.g. a provider reusing `call_0`, is a
  logged miss; a record that does not parse is a miss too).

A command cannot be handed to an agent. Codemode is always on (owner
decision, round 4): every tool except `ask` is callable directly and from a
codemode script, which runs in pi-codemode's `CodemodeSandbox` (QuickJS, no
fs or network) with the full input as `input`. A codemode call costs a
turn, so `maxTurns` is at least 2.

**Tool processes run in sandboxes.** A toolset runs under node in the
sandbox its `toolset` call names; each stdio MCP server in mcp.json runs in
the sandbox its overlay gives it; both with their declared network
(`"host"` by default). `${VAR}` secrets of mcp.json and a toolset's
`secrets` go into the tool process's environment only, never into an
agent's sandbox. Annotations are the tool's own claim: the write rule is a
warning, not a proof.

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
- MCP tools are named `mcp__<server>__<tool>`; custom tools keep their
  `name`. Preflight starts every declared source, lists its tools and
  closes it; the body then opens one connection per source for the run.
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
  compaction, sessions, `ask`, unknown outcomes), the wallis tool layer
  (workspace file tools, custom toolsets, MCP servers, journaling), bwrap
  sandboxes with binaries and setup, commands, volumes, artifacts, machine
  slots, body tool calls, orchestrator nodes, structured pending, and the
  write-rule warnings;
- the fake executor and fake command runner;
- examples: `two-node` and `ask`;
- the SIDERIUS example (`.agents/workflows/siderius/`, see its `MAPPING.md`).

Not built yet:
- the ACP and Claude Agent SDK executors;
- a container backend (`base`), and per-domain network enforcement;
- declaration approval on first run or digest change (setup is only logged);
- file inputs and image inputs for agents;
- nested orchestration (a parent agent answering its child's `ask`);
- a workspace inferred from Artifact fields (round 8), and the `/in`,
  `/w` layout, with volumes at their targets.

## Open

1. GitHub owner for the repo and npm package.
2. Budget enforcement point in pi.
3. Codex and Gemini CLI executor capabilities.
4. Exact `defineAgent` / `workflow()` API.
