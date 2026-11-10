# wallis

## Everything is a value

The only mutation is appending an event to the run log. Every side file is
either a content-addressed blob (or layer) that an event names, written
before that event, or a cache derivable from the log (`meta.json`). The
journal only grows: a restart, a rewind or a forget adds an attempt. The
host executes effects and feeds events back; it decides nothing (crash
policy, attempts, retries are core state).

- **Sessions are values.** `ctx.call(s, input)` returns `[output, next]`;
  `s` is unchanged, so calling it again is a branch. Values are plain data
  and may go to any branch. A call is keyed by (node digest, parent
  session, input, occurrence per branch); the next session is a hash chain
  over the call's slot and attempt. Dialogues are blobs (deltas from the
  parent session's).
- **Workspaces are layers.** A session's `/w` is an overlay of immutable
  layers; a call's changes become a new layer (rename, no copy) before
  `agent_returned` names it; squashed beyond 16. `ctx.files(s)` is a Tree;
  `ctx.session(agent, { from })` seeds one copy-on-write.
- **Identity is structural.** Journal keys come from digests (node
  definition, canonical input, parent session, occurrence), never from
  display names or request ids; inside the core they are opaque types
  (`Slot`, `RequestId`, `SessionId`, `Digest`).

## Governing principle

Types make illegal states unrepresentable. Where types cannot reach (time,
external input), the core re-checks when it applies an event and returns a
typed refusal. Nothing is ever silently dropped.

1. Every lifecycle is a discriminated union; each variant carries only the
   data meaningful in that state.
2. A capability is obtainable only through its check (`OwnedRun`,
   `IdleNode`, `SteerableNode` (agents only), `LiveNode`, `SubmittableNode`, `ResumableRun`): opaque types in
   Gleam, classes with private constructors in TS. Prefer compiler narrowing
   over hand-written `x is T` predicates. Brand only raw ids that cross a
   boundary (`RunId`, `NodeId`).
3. Everything at a boundary is `unknown` until parsed with its schema (model
   and script output, MCP and CLI args, artifact refs against the store). No
   `as` casts there.

**Every new state or operation must name its union variant, the capability
it requires, and how its boundary input is parsed.** Keep it minimal: no
generics or wrappers that add no proof.

## Sources of truth

- `docs/design.md` holds the current design. Change it when a design decision
  changes, in the same change as the code.
- Items marked "proposed" there are not settled; ask before building on them.

## Toolchain

- Tools are declared in `mise.toml` (Gleam, Node). Do not install them globally.
- npm dependencies live in `host/package.json` with exact versions;
  `mise run install` installs them from the lockfile.
- `mise run build` builds the core. `mise run test` runs the core and host
  tests. `mise run typecheck` type-checks `host/` and `.agents/workflows/`.
- After changing a type in `core/src/wallis_core/types.gleam`, delete its
  old `_decoder`/`_to_json` functions and regenerate them: from `core/`,
  `node ../tools/gleam-codegen.mjs <file> <Type>...`.

## Core rules

- `core/` is pure Gleam: no FFI, no I/O, no clocks, no randomness. Everything
  the core needs arrives as an event; everything it wants done leaves as an
  effect.
- Model run state as explicit custom types and exhaustive `case`; no
  boolean flags for states.
- In the core, a match over a union we define has no `_` arm: list every
  arm, or say why the rest cannot occur.
- Generate decoders and JSON encoders with the Gleam language server code
  actions rather than writing them by hand.
- Every core behavior gets a test that replays a sequence of events; no test
  may need a model, network or device.

## Host and SDK rules

- `host/src/sdk/` runs inside the QuickJS sandbox: no Node imports.
- Host tests use the fake executor and fake commands (`confine: "off"`);
  tests that run real commands need bwrap and skip without it; never real model calls
  or API keys. CLI and MCP tests load `host/test/fixtures/fake-executor.ts`
  as the executor module and work in throwaway projects (`test/util.ts`).
- pi executor tests use pi-ai's faux provider (`fauxProvider().setResponses`);
  never real paid model calls.
- Host tests run with `WALLIS_DIFFERENTIAL=1` (`mise.toml`, `test/util.ts`):
  after every event a session checks that the state rebuilt from the log
  (as the CLI and MCP see it) equals its live state, and ends on a
  mismatch. Every state change must be logged.
- CLI tests run detached hosts with `WALLIS_HOST=plain` (set in
  `test/util.ts`) so SIGKILL tests are not restarted by systemd; tests that
  need bwrap or systemd skip with a message when unavailable.
- The workflow body is a pure program over journaled calls; run memory is
  its local variables. There is no workflow state in the core, no views,
  reducers or `emit` (owner decision, round 4). Agents get everything they
  need in their typed input.
- Codemode is on for every agent; a codemode call costs a turn, so agents
  need `maxTurns >= 2`. `maxTurns` is an orchestration point
  (`Idle(turn_limit)`), not a failure.
- One node union (agent | command | workflow | MCP tool | orchestrator);
  agents are called through session values only (`[out, next] = await
  ctx.call(ctx.session(agent), input)`), every
  other node (and tool values) with `ctx.call`. Agents' `tools` are `ask`,
  toolset tools and MCP tools only; file tools come from `workspace`
  access; commands are called by workflow code only. Multi-step concurrent
  branches use `ctx.parallel`/`ctx.map`.
- Agents interact with the workflow only through input and output; outward
  writes happen in the body (ask first with an orchestrator node). Agents
  and commands never get network; tool processes do. Every tool result is
  journaled; write-capable tools given to agents are warnings.
- The sandbox layout is fixed: `/in` (inputs, read-only), `/w` (the
  workspace; an agent's is an overlay of its session's layers), each volume
  at its target, `/tmp`. Layers and blobs are written before the event
  that names them.
- Sandboxes are declared (`defineSandbox`), bwrap only, nothing implicit,
  in compose vocabulary: `volumes` (`"./x:/x:ro"` binds, read-only only;
  `"name:/target"` named caches), `devices`, `network`, `environment`.
  Never mount the workflow dir implicitly, never add a writable bind. A
  bind is snapshotted into the run when it starts (a fork takes a new
  snapshot) and its digest is part of the cache key of every call that
  binds it; named volumes are outside every key (results must not depend on
  them). Volume rules are both a type (`CheckVolume`) and a preflight
  parse (`parseVolume`, `resolveVolumes`).
- Identity is by digest or structure; names are labels only. Never put a
  node's, sandbox's or nested workflow's name in a journal key, a node
  digest or a request id: a node is its definition digest, a custom tool
  is (bundle digest, export), an MCP tool is (server, tool). A change to
  what a digest covers bumps the core's semantics version.
- The workflow VM runs untrusted workflow code: the host parses its
  declarations (`host/src/host/declarations.ts`) and re-checks every
  sandbox rule itself; VM-side checks are early errors only. Host programs
  (bwrap, systemd-run) run by absolute path with an environment holding
  secrets only; everything else reaches the sandbox via `--setenv`.
- Recovery is the most important property: keep transient-error retries
  in the executor, per-turn checkpoints, held node failures, and the
  journal as a cache (node digest, input, occurrence) working, with tests.
- The budget (turns, compute minutes) is an attention point; USD and
  tokens are information only.
- Interventions carry `by` and go through the capability checks on both
  sides (host, then core). Verbs: send (idle: reply; running: steer),
  submit (orchestrator nodes), interrupt (no message), restart, cancel,
  pause, resume, and fork `--forget` (a `call_forgotten` mark per call in
  the fork).
- Every value crossing the sandbox or executor boundary is schema-checked on
  both sides (`src/sdk/validate.ts`); keep new boundaries that way.
- The body sees typed errors only (`Refused`, `AgentFailed`,
  `CommandFailed`, `ToolFailed`, `OrchestratorCancelled`, `WorkflowFailed`,
  `SchemaError`, each with
  a typed failure); never make it match on message text.
- `ctx` is typed by the workflow's declarations (`Ctx<D>`); keep every new
  ctx method's callbacks on `Ctx<D>`, and every new node kind declared
  (name literal type) and refused at run time when undeclared.
- Compile-time guarantees get `@ts-expect-error` tests in
  `host/test/sdk-types.ts`.
