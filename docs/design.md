# wallis design

This document defines wallis (v2): a full rewrite of the authoring and calling
surface. The rewrite reuses the parts of v1 that real use validated: the
journal, sessions, workspace layers, the artifact store and the pi
executor. It drops the machinery that grew around interaction, around
implicit caching, and around defending against attackers who are not in the
threat model.

Status: **implemented.** v2 replaced v1 (phase 7, §10); v1 stays in git
history. The layout: `core/` (the Gleam core), `src/` (the package),
`test/`, `examples/`, `skills/wallis/` (the agent skill). §12 records the
implementation's decisions, §13 the acceptance results.

## 1. Purpose and threat model

wallis runs agent workflows whose **process is reproducible**. A fixed
workflow, run by different people in different environments, behaves
stably. It is also resumable, and safe to leave unattended.

A workflow is ordinary TypeScript code calling typed nodes:

- **commands:** sandboxed programs;
- **agents:** pi agent loops;
- **tool sources:** custom tool modules or MCP servers;
- **nested workflows.**

### What "reproducible" means here

It means process reproducibility, not functional determinism. Model
output is random, and the workflow body is plain code. Reproducibility comes
from four things:

1. **Declaration.** Everything a call depends on is declared: its input, its
   input artifacts, its sandbox volumes, its programs, its model alias.
2. **Records.** Every call's actual input, output and model is journaled.
3. **The environment belongs to the workflow.** The workflow defines its
   expected environment with whatever its author prefers (`mise.toml`, a
   setup command, a check command, a Dockerfile later). wallis provides the
   sandbox to run it in, not an environment manager.
4. **Explicit reuse.** Expensive results are kept as artifacts and passed
   to later runs as inputs. There is no implicit cache that could silently
   return a stale result.

### Threat model

wallis is the interpreter of its author's own code, and its permissions are
a subset of the agent that calls it, usually Claude Code. It does **not**
defend against a malicious workflow author or a malicious sub-agent. Its
sandbox has exactly two jobs:

1. **Prevent accidents.** A sub-agent or a command can't damage host files by
   mistake (a wrong `rm`, a wrong path, an overwrite).
2. **Make dependencies explicit.** A call sees only what it was given, so
   undeclared dependencies show up as errors, not as hidden variation
   between machines.

A determined bypass is acceptable. Reviews and tests use this model, and
nothing else.

When a sub-agent reaches outside its view, that is a workflow design error,
not a security event. It gets a clear, actionable error ("`/x` is not in your
workspace; this workflow did not provide it"), plus a diagnostic that tells
the author which volume or input is missing.

## 2. Shape

- An npm package, `wallis`, plus a skill that teaches agents to use it.
- **No CLI, no MCP server, no daemon.** Callers use the JS API from a script
  or from `node --input-type=module -e '…'`. Node 26 strips TypeScript types
  natively.
- **The workflow body is plain Node.** In the foreground it runs in the
  caller's process; a detached run is an ordinary detached Node process.
- **The run directory is the single source of truth**, so anyone can read
  it.
- **Platform:** Linux, because the sandbox uses bwrap. systemd is not
  required.
- **The MCP client stays:** workflows can use existing MCP servers as tools.

## 3. Naming

Three kinds of names, each with one style:

| Kind | Style | Names |
|---|---|---|
| Nodes and resources | lowercase noun | `workflow`, `command`, `agent`, `sandbox`, `toolset`, `mcp` |
| Schema builders | Capitalized (like TypeBox `Type.Object`) | `Artifact`, `Tree`, `Address` |
| Operations | verb | `run`, `attach`, `resume`, `stop`, `send`, `next`, `exportOutput`, `list`, `prune`; `ctx.call`, `ctx.start`, `ctx.spawn`, `ctx.loop`, `ctx.send` |

## 4. Authoring API

One file, `workflow.ts`, holds everything a workflow declares. Custom tool
modules are the only separate files, because they run in their own process.
Split a workflow into more modules only when it grows or is shared; that is
a convention, not a rule.

The film workflow below has two stages. The expensive stage runs once and
returns its working directory as a Tree; the cheap stage runs many times on
that Tree. This explicit staging replaces v1's implicit cache.

```ts
import { workflow, command, agent, sandbox, toolset, Artifact, Tree, Type } from "wallis";

const dt = sandbox({
  requires: ["darktable-cli", "nona", "python3"],
  volumes: ["./scripts:/scripts:ro", "dt-cache:/root/.cache/darktable"],
  environment: { OMP_NUM_THREADS: "4" },
});

const stitch = command({
  sandbox: dt,
  input:  Type.Object({ frame: Frame }),
  output: Type.Object({ neg: Artifact("image/tiff") }),
  run:    ({ frame }) => ["python3", "/scripts/stitch.py", frame.pto.path, frame.halves[0].path, frame.halves[1].path],
  parse:  (r) => ({ neg: r.file("neg.tif") }),
});

const render = command({ sandbox: dt, input: RenderIn, output: Type.Object({ jpg: Artifact("image/jpeg") }), run: …, parse: … });

const ente = toolset<typeof import("./tools/ente.ts")>("./tools/ente.ts", { network: "host", secrets: ["ENTE_TOKEN"] });

const uploader = agent({
  model: "default",
  prompt: "Upload every file to the album; handle errors yourself; confirm with list.",
  input:   Type.Object({ album: Type.String(), files: Type.Array(Artifact("image/jpeg")) }),
  output:  Type.Object({ uploaded: Type.Integer(), notes: Type.String() }),
  mailbox: Type.String(),                                    // messages to it enter its next turn
  tools:   [ente.upload, ente.list],
});

// Stage 1, run once: stitched linear negatives.
export const negatives = workflow({
  input:  Type.Object({ frames: Type.Array(Frame) }),
  output: Type.Object({ negs: Type.Record(Type.String(), Artifact("image/tiff")) }),
  run: async (ctx, { frames }) => {
    const negs: Record<string, ArtifactRef> = {};
    for (const f of frames) negs[f.id] = (await ctx.call(stitch, { frame: f })).neg;   // one at a time
    return { negs };
  },
});

// Stage 2, run many times on stage 1's output.
export const develop = workflow({
  input:  Type.Object({ negs: negatives.output.properties.negs, look: Look, only: Type.Optional(Type.Array(Type.String())), size: Size }),
  output: Type.Object({ images: Type.Record(Type.String(), Artifact("image/jpeg")) }),
  run: async (ctx, { negs, look, only, size }) => {
    const ids = only ?? Object.keys(negs);
    const images: Record<string, ArtifactRef> = {};
    for (const id of ids) images[id] = (await ctx.call(render, { neg: negs[id], look, size })).jpg;
    return { images };
  },
});

// Delivery: nests develop, then lets an agent upload.
export default workflow({
  input:  Type.Object({ negs: negatives.output.properties.negs, look: Look, album: Type.String() }),
  output: Type.Object({ images: develop.output.properties.images, report: uploader.output }),
  run: async (ctx, { negs, look, album }) => {
    const { images } = await ctx.call(develop, { negs, look, size: "full" });
    const job = ctx.start(uploader, { album, files: Object.values(images) });
    ctx.register("guidance", job.address);                    // the caller can steer it by name
    const report = await job.result;
    return { images, report };
  },
});
```

The main agent iterates with the human:

```ts
const { negs } = (await run(negatives, roll)).output;                       // once, about 10 minutes
await run(develop, { negs, look: L1, only: ["2835"], size: 1200 });          // seconds
await run(develop, { negs, look: L2, size: 1500 });                          // a whole-roll preview
await run(deliver, { negs, look: L2, album: "20261107_autocord_portra160" }); // after the human agrees
```

### 4.1 Nodes

| Node | Definition | Called by |
|---|---|---|
| `command` | sandbox, `run(input) → argv`, `parse(result, input) → output` | `ctx.call` / `ctx.start` |
| `agent` | model alias, prompt, input, output, optional `mailbox`, `tools`, `workspace` | through a session: `ctx.call(session, input)` → `[output, nextSession]` |
| `workflow` | input, output, `run(ctx, input)` | `ctx.call`, or a caller's `run()` |
| custom tool | a module exporting pi `AgentTool`s plus `annotations` and `replay` | an agent's `tools`, or `ctx.call(lib.tool, input)` |
| MCP tool | `mcp(json, overlay)`, then `server` or `server.tool` | same as a custom tool |

- **Nodes are plain values.** Import them and call them; a workflow does not
  list the nodes it uses.
- **Model aliases** come from project configuration, so there is no `env`
  argument. Each call journals the model that actually served it.

### 4.2 Agents

- **One-shot calls.** `ctx.call(agent, input)` (or `ctx.start`) runs the
  agent in a fresh session and returns its output only. Most calls are this.
- **Sessions.** `ctx.session(agent, { from?: Tree })` creates an immutable
  session value, for continuing a dialogue or seeding a workspace. Calling it
  returns `[output, next]`. Calling the same value twice is a branch.
- **Workspace.** `workspace: { access: "read" | "write" | "exec", sandbox? }`.
  - Without the field, access is inferred from the signature: Artifact or
    Tree inputs give `read`, Artifact or Tree outputs give `write`. `exec` is
    never inferred.
  - The file tools (pi-compatible `read`, `write`, `edit`, `ls`, `bash`) come
    from the access level, never from `tools`.
  - `ctx.files(s)` returns the session's `/w` as a Tree.
- **Tools.** `tools` holds custom tools and MCP tools only. A tool's
  annotations decide only whether it may run again when a stop cut it off
  (§12.3); wallis shows no warning for tools that write outside.
  - Given a whole MCP server (`server`), an agent sees only that server's
    tools annotated `readOnlyHint: true`. A tool that writes must be named
    (`server.tool`), so giving an agent a server never hands it a write by
    accident.
- **Turn budget.** `turns: N` (default 30) caps the model turns of one call.
  This is the only budget in the framework. Reaching it fails the call with
  `turn_limit_reached`; the body may catch it and continue from the returned
  session with `{ turns }` raised. Mailbox deliveries count as turns. Cost and
  time are the caller's concern.
- **Messages.** An agent has a mailbox only if it declares `mailbox: T`; it
  can send only to addresses it is given as `Address(T)` inputs (§6).
- **Missing information.** An agent that lacks information either sends a
  question to an address it was given and waits for the reply in its
  mailbox, or ends its call with an output such as
  `{ type: "need_info", question }`, which the workflow returns to its caller.

### 4.3 The body

The body is plain TypeScript. Its wallis operations are `ctx.call`,
`ctx.start`, `ctx.session`, `ctx.files`, `ctx.spawn`, `ctx.loop`, `ctx.send`,
`ctx.register` and `ctx.outbox`.

- **`ctx.start(node, input)`** starts a call without waiting and returns
  `{ address, result }`; the address reaches the running agent's mailbox.
  `ctx.call` is `start` plus `await result`.
- **`ctx.spawn(schema, async (ctx, mailbox) => …)`** starts an actor: a body task
  with its own branch and a mailbox. It returns `{ address, result }`.
  `ctx.map(items, f)` is sugar for one spawn per item. To limit concurrency,
  use plain code: a loop, or batches.
- **`ctx.loop(init, (ctx, state) => ({ next: s }) | ({ done: o }))`** is a
  typed fold: each step returns the literal `{ next }` or `{ done }`. State
  and output types are separate, and each iteration is a branch.
- **Errors.** A failed call throws one `NodeFailed` whose `reason` is a typed
  union.

### 4.4 Sandboxes

`sandbox({...})` is a subset of a compose service:

- **`requires`:** programs that must exist. Each is called by its real path,
  with its `argv[0]` name kept. Only the program and its prefix's `lib`,
  `lib64`, `libexec` and `share` become visible. wallis checks that the
  programs exist; their versions are the workflow's concern (§1).
- **`volumes`:**
  - `"<host>:<target>:ro"` is a read-only bind. The mode is required, and
    there is no `rw`. Host paths are relative or start with `~/`.
  - `"<name>:<target>"` is a named volume: a wallis-managed directory that
    persists across runs, writable by commands and tool sources, read-only
    for agents. This is where environments live (e.g. `"uv-env:/opt/venv"`,
    prepared by a setup command), because environments embed absolute paths
    and must not be moved.
- **`environment`**, **`devices`** and **`network: "none" | "host"`**
  (default `"none"`). Network is all or nothing: `"none"` is bwrap's
  `--unshare-all` (loopback only), `"host"` adds `--share-net`. Per-host allow
  lists are out of scope. A network is visible in the definition (`network:
  "host"`) and in an agent's `bash` tool description, nowhere implicit.
  - Named volumes belong to the project: they live in
    `<project>/.wallis/volumes/<name>`, so two projects never share one by
    name. Commands whose sandboxes mount the same named volume run one at
    a time (a lock per volume, held while the command runs), so concurrent
    setups of one environment never interleave.
  - `environment` may not set `HOME` (it is `/w`); a `PATH` there is put
    before the sandbox's own PATH, never replacing it.

## 5. Semantics

### 5.1 Runs

A run executes one workflow on one input.

- **Pure runs.** A run that registers no address and declares no outbox is a
  pure function of its input: it finishes or fails.
- **Interacting runs.** Other runs interact only through their registered
  addresses and outboxes (§6).
- **Interruption.** A run can be stopped at any time and resumed (§5.3).

### 5.2 The journal

- **One commit point.** The run log is append-only and is the single commit
  point. Every side file is either a content-addressed blob that an event
  names, written before that event, or a cache derivable from the log.
- **Attempts.** A call that runs again appends an attempt; nothing is
  deleted.

### 5.3 Resume, not caching

- **What resume skips.** `resume(id)` continues a stopped or crashed run in
  place. The body runs again from the top, and every call that completed
  before is answered from that run's journal. A completed call matches on
  its node, its input and the occurrence count of that same node and input.
  Only calls that were in flight, or that the body now makes differently,
  run again.
- **Scope.** This is the only reuse wallis does implicitly, and only within
  one run, with the same code and the same input. Nothing is shared across
  runs except artifacts that are passed explicitly.
- **A failure is not a completion.** A call whose newest attempt failed
  runs again on resume, as a new attempt; the journal keeps both. So
  resuming a run that failed (a frame's stitch was OOM-killed, say) redoes
  only the calls that failed or never finished. A run that completed stays
  completed.
- **Except a decided failure.** `turn_limit_reached` is the call's own
  outcome, not an accident, so it is journaled as the call's result: on
  resume the body gets the same `NodeFailed`, with the same session, and
  may continue it with more turns. Re-running the agent would only spend the
  turns again. (`output_invalid` after the agent's own retries is the same
  kind.) Crashes, OOM kills, non-zero exits and model or tool errors run
  again.
- **Calls are keyed by place.** The occurrence is counted per scope: a nested
  workflow call's own calls are keyed under that call, so the same command
  with the same input inside and outside it are two calls.
- **The body need not be deterministic.** A body that takes a different path
  on resume (it used `Math.random()`, say) only reuses less. Correctness
  never depends on it.

### 5.4 The artifact store

- **Shared within a project.** The content-addressed store under
  `.wallis/store/` is shared by every run of the project, so one run's output
  artifacts and Trees can be another run's input without copying.
- **A Tree is one digest:** a blob in the store that names its layers,
  bottom first. A snapshot of a directory has one layer; a Tree derived from
  another has the layers below it plus its own. `prune` follows a Tree to
  its layers.
- **Trees are directory snapshots.** Ingesting one hashes only changed files,
  using a (path, size, mtime) cache, and stores the data by reflink where the
  filesystem allows. As an input, a Tree is mounted read-only, in time
  independent of its size. A Tree derived from another (an agent's workspace,
  say) is stored as layers.
- **What belongs in Trees:** produced results, such as checkpoints, TIFFs,
  generated code and finals. Environments belong in named volumes (§4.4).
- **Cleanup.** `prune()` deletes store data that no remaining run
  references. It is explicit; nothing is evicted automatically.

### 5.5 Identity

Identity is a digest or a structural position, never a name. Names are
labels:

- a custom tool is (the digest of its module's source text, its sandbox and
  network, export key), or (MCP server, command, args, tool); the bundle
  wallis builds from the module is recorded in the run, so a resumed run
  serves the same bundle;
- a node is its definition digest;
- a workflow is its module digest.

**What a node's digest covers.** Its own definition: its schemas, its
sandbox, its prompt, and the source text of its own functions (`run`,
`parse`, a workflow's body). It does not cover the helpers those functions
close over (a `py(...)` argv builder, a shared constant, an imported
module) nor the files a sandbox binds. So after editing a helper, the
journal still matches the calls made before the edit. To redo them, either
retry the affected calls (`resume({ retry: [id] })` for a failed one) or
start a new run: resume reuses, by design, what the record says was done.

**A nested workflow's body is part of its digest.** Editing the body of a
workflow that is called with `ctx.call` changes that call's identity, and
every call inside it is keyed under that call (§5.3). So after the edit
everything inside the nested workflow runs again on resume, even the calls
whose nodes did not change. The top-level body is different: its calls are
keyed by the run, so editing it re-runs only what it now calls differently.
To keep finished work across an edit, put the edit in the top-level body or
a node, not in a nested workflow's body.

## 6. Actors and interaction

Interaction follows the BEAM (Erlang/Elixir) model, reduced to what
functional orchestration needs: processes with mailboxes, addressed by
value.

- **Actors.** `ctx.spawn(schema, async (ctx, mailbox) => …)` starts an actor and
  returns `{ address, result }`. The actor reads its mailbox with
  `for await (const m of mailbox)` and handles a typed union with `switch`.
- **Addresses** are values. They can be passed as inputs, put inside
  messages, or returned. `ctx.send(address, msg)` never blocks: mailboxes are
  unbounded, so there is no backpressure.
- **Every mailbox has a schema:** an agent's or workflow's `mailbox`, an
  actor's first `spawn` argument, an outbox's. **Every message is validated
  against the recipient's schema when it is sent**, before it is journaled,
  wherever it comes from. A rejected message is never delivered:
  - from an agent's `send` tool, the tool call fails with the validation
    errors, so the agent sees what was wrong and sends again (a turn, like
    any tool error);
  - from a body or actor, `ctx.send` throws `MessageRejected`: a workflow bug;
  - from the caller, `run.send` rejects with `MessageRejected`.

  Passing an address into an agent's `Address(T)` input requires the
  recipient's schema to equal `T` (equal digests), checked before the call
  starts.
- **A closed recipient rejects.** A message to a recipient that has ended
  (an agent call that returned, an actor or body that returned, a finished
  run) is rejected with reason `closed`, never journaled: the `send` tool
  fails, `ctx.send` throws `MessageRejected` (`reason: "closed"`),
  `run.send` rejects. A run that is only stopped still takes messages: they
  persist and are delivered on resume.
- **An agent's send is delivered once.** Its key is (call, turn, the model's
  tool-call id), and the journal delivers each key once. A reply with tool
  calls is checkpointed before its tools run, so a turn cut off by a crash
  resumes knowing its sends and gets their results back from the journal
  instead of sending again.
- **Many senders** may send to one mailbox; a coordinator collecting worker
  reports is the common case.
- **Resume.** The order in which messages are delivered to each mailbox is
  journaled. On resume the runtime delivers in the recorded order, then
  continues live. Each send is journaled once, by a key, so a body that runs
  again after a resume re-sends nothing: a body's key is its scope, a hash of
  (recipient, content, `replyTo`) and the count of that hash in the scope; a
  caller's is its own id. A body whose message content differs on resume
  (it includes a time, say) sends a new message.
- **Shutdown.** When a body returns, the mailboxes of the actors it spawned
  close: their `for await` loops end and the actors finish. A body that
  needs an actor's result awaits `result` before returning.
- **An actor's failure is never swallowed.**
  - If its spawner awaits `result` (or attaches a handler to it), the
    spawner gets the `NodeFailed` or the thrown error and handles it in code.
  - If nobody handles `result`, the failure propagates to the spawning body,
    like an unhandled rejection, and from there up the call chain. If nothing
    catches it, the run fails, and its first `FailedCall` names the actor (its
    const name and spawn site).
  - A failed actor's mailbox closes: later sends are rejected as `closed` on
    every path (an agent's `send` tool fails, `ctx.send` throws, `run.send`
    rejects). An agent waiting for its reply is not left hanging: the run
    fails, which cancels the waiting call.
- **No supervisors.** There is no supervisor, no restart policy and no `down`
  message in the framework. A restarting actor is plain code: a loop with a
  try/catch around each message, as the grade renderer does per job.
  Recovery of a whole run stays with the journal and `resume`; the
  orchestrating agent decides how to recover.
- **Not taken from BEAM:** selective receive (use `switch`), links and
  supervisors (above), hot code loading.

**Agents as actors:**

- **`mailbox: T`** in an agent's definition gives every running call of it a
  mailbox. Messages enter the agent's **next turn** automatically.
  - Several messages that arrived during one turn are delivered together.
  - A message sent with `{ interrupt: true }` aborts the current turn.
  - An agent with a mailbox and nothing to do waits for the next message.
    A message ends the wait (from the body, an actor or the caller; "finish
    now", say). A stop or a run failure cancels it. There is no operation
    that closes a running call from outside.
  - Each message is journaled with the turn it was delivered after.
- **`Address(T)`** as an input field gives the agent a `send` tool for that
  address. Sending never blocks, so the agent may send a question and keep
  working; the reply arrives in its mailbox.
- **Getting an agent's address:** `ctx.start(session, input)` returns it
  while the call runs.

**Across the run boundary:**

- **`ctx.register(name, address)`** exposes an address to the caller, which
  sends with `attach(id).send(name, value, { replyTo?, interrupt? })`.
  Messages sent while the run is stopped persist and are delivered on
  resume.
- **`ctx.outbox(name, T)`** returns an address whose messages go to the
  caller. They persist in the run directory and never block. The caller
  reads them with `attach(id).next({ timeout })`, which returns `message`
  (with `replyTo` for a reply to one of the caller's messages), `finished`,
  `failed`, `stopped` or `timeout`.
- **Envelopes.** A mailbox yields `{ id, from, replyTo?, body }`. `from` is
  the sender's own address, as in BEAM where a request carries `self()`, so
  a server replies with `ctx.send(m.from, result, { replyTo: m.id })` and
  needs no wiring back to its clients. An agent's `send` tool returns the
  new message's id, and its deliveries show `id`, `replyTo` and `body`, so it
  can match each result to the request it sent.
- **Message ids** are deterministic: `<mailbox owner>/<seq>`, with the
  sequence taken from the journaled delivery order, prefixed with the run id
  when they must be globally unique. Replies name the message they answer
  with `replyTo`.

**Example: an agent driving a compute actor.** Rendering is memory-heavy, so
one actor owns it and runs jobs one at a time. The grading agent submits
several jobs, keeps working or waits, looks at each image as it arrives, and
submits more. The loop ends when the agent returns its output.

```ts
const Job = Type.Object({ frame: Type.String(), look: Look, size: Size });

const grader = agent({
  prompt:  "Render the frames, inspect each image, adjust the look and re-render until it matches the reference. Return the final look.",
  input:   Type.Object({ frames: Type.Array(Type.String()), reference: Artifact("image/jpeg"), renderer: Address(Job) }),
  output:  Type.Object({ look: Look }),
  mailbox: Type.Object({ jpg: Artifact("image/jpeg") }),     // finished renders arrive here
});

export const grade = workflow({
  input:  Type.Object({ negs: negatives.output.properties.negs, frames: Type.Array(Type.String()), reference: Artifact("image/jpeg") }),
  output: Type.Object({ look: Look }),
  run: async (ctx, { negs, frames, reference }) => {
    const renderer = ctx.spawn(Job, async (ctx, mailbox) => {
      for await (const m of mailbox) {                        // one job at a time
        const { jpg } = await ctx.call(render, { neg: negs[m.body.frame], look: m.body.look, size: m.body.size });
        ctx.send(m.from, { jpg }, { replyTo: m.id });
      }
    });
    return ctx.call(grader, { frames, reference, renderer: renderer.address });
  },
});
```

On resume, finished renders are not redone: each `ctx.call(render, …)` is
matched in the journal, and the deliveries replay in their recorded order.

This one mechanism replaces v1's `ask`, steer, orchestrator nodes,
approvals, pending items and `submit`:

- **Asking:** the agent is given an `Address` (for example an outbox), and
  the answer comes back to its mailbox.
- **Steering:** the running agent's address, registered by name.
- **Approval:** body code sends a request to an outbox and waits for the
  answer in its own mailbox.

## 7. Caller API

```ts
import { run, attach, list, prune } from "wallis";

const r = await run(workflow, input, { detach?: true, onExit?: "<shell command>" });
r.id;                                   // run id: <workflow>-<time>-<rand>
await r.status();                       // completed, running and failed calls, elapsed time
await r.tree();                         // the call tree: each call's id, label, kind, attempts, inner calls
await r.transcript(callId);             // an agent call's dialogue (its last attempt)
await r.next({ timeout: "110m" });      // message | finished | failed | stopped | timeout
await r.send("guidance", "rename the album", { interrupt: true });
await r.stop();  await r.resume({ detach: true });
const f = await attach(workflow, id).done();   // Finished: f.output, f.exportOutput(dir)
await f.exportOutput("~/Pictures/150ND610-work/final-v2");
attach(id);  await list("./negative/workflow.ts");  await prune();
```

- **Output.** `output` and `exportOutput` are on `Finished`, which a
  foreground `run` returns and `done()` resolves to; a detached `Run` has
  neither until it is done. `exportOutput` copies every Artifact and Tree of
  the output into the dir (`~` is the home dir) and fails if a copy fails.
- **Who may attach.** `attach(wf, id)` checks that the run is a run of `wf`
  (its file and export), and throws otherwise.

- **Detaching.** `detach` starts the run as a detached Node process and
  returns at once. `onExit` runs when the run process exits normally.
- **Long waits.** Harnesses limit background commands (Claude Code: 2 hours),
  so `next({ timeout })` returns `timeout` with progress, and the caller
  waits again.
- **Where runs live.** A run belongs to the project of its workflow file (the
  nearest ancestor with `.wallis/` or `package.json`), not to the cwd.
- **Locking.** A run directory has a lock file naming its holder's pid and
  start time, so two processes never write the same run, and a reused pid is
  never taken for the holder. A dead holder's lock is taken over atomically;
  `stop` signals only the process the lock names.
- **Epochs.** Each start or resume is a new epoch (a fact in the log).
  Mailboxes that closed in an earlier epoch (a failed actor, a body that
  ended) are open again in the resumed one, so a resumed run is reachable
  as before.
- **Recovery is in place.** A failure names its calls: `next()` returns
  `failed` with each `FailedCall` (id, label as const name plus definition
  site, the enclosing calls, the attempt, the reason, a stderr or transcript
  tail) and whether `resume` alone re-runs it. The orchestrating agent fixes
  the cause (frees memory, edits a script, edits the workflow; a changed node
  definition re-runs that node), then calls `resume()`: finished calls come
  from the journal, failed ones run again. Decided failures (§5.3) re-run
  only when named: `resume({ retry: [id], turns })` continues that agent's
  session with more turns, or, for `output_invalid`, with the errors as its
  next message. Finished calls are never retried; redoing one is a new run.

## 8. Removed in v2

| Removed | Why |
|---|---|
| Orchestrator nodes, the agent `ask` tool, `submit`, pending items, approvals | replaced by actors and mailboxes (§6) |
| `send`/`interrupt`/`steer` as special verbs, `steerable`, node lookup by name | a registered address (§6) |
| The implicit cache: cross-run command cache, cache keys over argv, environment, sandbox, binds and binaries, write epochs, nondeterministic-output warnings, `fork --input`, `fork --forget` | explicit reuse through artifacts and Trees (§5.3, §5.4); implicit caches fail silently |
| QuickJS for the body, body bundling, the VM bridge | plain Node; correctness does not depend on body determinism (§5.3) |
| Ownership, `claim`, owner detection | runs are local files; a lock file is enough |
| The CLI (22 subcommands) and the MCP server | the JS API |
| Adversarial hardening: the TOCTOU openat walk, host re-parsing of declarations, device and environment guards, prototype-pollution checks, the escape-suite gate | outside the threat model (§1) |
| Resource limits and the systemd dependency | plain code controls concurrency; the OS OOM handler catches runaways |
| Environment checks and version constraints | the workflow defines its environment (§1) |
| Foldable, `ctx.parallel`, `observe`, cost and time budgets, seven error classes, bind snapshots | unused, replaced by `spawn` and `map`, or simplified (§4.3) |
| The `env` argument and declared node lists | nodes are plain values |
| Storing command scratch dirs beside their artifacts (2x storage) | artifacts only |

## 9. Carried over from v1

These modules are ported and adapted, not rewritten:

- the pi executor (`pi.ts`): retries, per-turn checkpoints, compaction,
  image token estimates (`images.ts`);
- the artifact store and Trees (`artifacts.ts`), and workspace layers
  (`layers.ts`, minus the userland overlay emulation);
- the toolset bundler and runner (`toolsets.ts`, `toolset-runner.ts`), and
  the MCP client (part of `tools.ts`);
- volume parsing (`volumes.ts`, `sdk/volumes.ts`) and the `requires`
  resolution (`hostbin.ts`, part of `confine.ts`);
- the log, the store and dialogues (`log.ts`, `store.ts`, `dialogues.ts`),
  including the atomic meta writes and the repair of a truncated last line;
- in the core: `ids`, `digest` and `value`, plus the journal, attempts and
  session hashing from `run.gleam`.

These tests are ported wherever their semantics survive:

- `sessions`, `workspace`, `loop`, `recovery`, `resume`, `artifacts`,
  `images`, `toolsets`, `volumes`, `identity`, `pi`, `siderius`;
- `run_test.gleam`;
- the escape-suite cases that test correctness and hermeticity rather than
  attacks (static symlinks resolved in the sandbox view, `requires` exposure,
  no network for agents).

The differential check (state rebuilt from the log equals the live state)
stays on for every test.

## 10. Plan

1. **Review this document** (done).
2. **Scaffold** `v2/core` (Gleam) and `v2/lib` (the npm package). Port the
   modules in §9, with their tests.
3. **Commands, workflows, nesting, the shared artifact store, Trees, run,
   attach and resume.** Acceptance: the film workflow's `negatives` once,
   then `develop` previews on its output.
4. **Agents, sessions, workspaces and tool sources.** Acceptance: the film
   workflow end to end, with the faux uploader and fake Ente.
5. **Actors, mailboxes, `register`, outbox and detach.** Acceptance:
   - an agent asking through an outbox and answered in its mailbox;
   - a coordinator collecting reports from several workers, identical on
     resume;
   - a steered agent;
   - a detached run awaited with `next`.
6. **Port SIDERIUS.**
7. **Replace v1.** Delete `core/` and `host/`, move `v2/` to the root, and
   rewrite README and the skill.
8. **Review,** under §1's threat model only.
9. **Ask the owner before pushing.**

Acceptance numbers:
- the film workflow's finals match the delivered SDR finals with the same
  MAD/PSNR as on v1;
- a single-frame `develop` preview on prebuilt negatives takes seconds.

## 11. Decisions on former open questions

1. **Budgets.** Only the agent turn budget (§4.2). No cost or time budgets.
2. **Commands with network.** Off by default; on when declared
   (`network: "host"`), visible in the definition (§4.4).
3. **The core stays in Gleam.** With caching, interventions and ownership
   gone, it holds the journal, attempts, sessions, turn budgets and mailbox
   delivery order: a pure state machine, tested without I/O, where
   exhaustive matching pays.

## 12. Implementation decisions (phases 3 to 5)

Choices the implementation made where this document and the target
examples left room. None changes the authoring API.

1. **Project configuration** is `<project>/.wallis/config.json`:
   `{ "models": { "<alias>": "provider/model[:thinking]" }, "executor": "./x.ts" }`.
   The optional executor module's default export returns
   `{ models, getApiKey? }`: a pi-ai model registry. Tests use the faux
   provider. Without one, pi-ai's built-in providers are used.
   `wallis/testing` re-exports pi-ai's registry and faux helpers for such
   modules.
2. **Identity on the wire.** A `CallId` is the call's journal key: a hash
   of (node digest, kind, canonical input, scope, session, occurrence).
   Request ids are the body's scope prefix plus a sequence number, so they
   repeat across resumes of a deterministic body.
   - Addresses are `actor:<scope>`, `agent:<call key>`, `wf:<scope>`,
     `outbox:<name>` and `caller`.
   - A message's id is `<address>/<seq>`.
   - A message the caller sends to a stopped run is persisted in the run's
     `inbox.jsonl`. `run.send` then returns its provisional id
     (`caller:<uuid>`); the journaled id exists once the run delivers it.
3. **Decided failures** also include a body tool call that was in flight
   when the run stopped and is not `replay: "safe"`. Its outcome is unknown,
   so it fails as `tool_failed` with `recovery: "retry"` until it is named
   in `resume({ retry })`; then it runs again (once: the retry's request is
   journaled when it is issued, so a further stop does not issue it twice). The same rule applies to `output_invalid`: an
   agent gets three submissions, then the call fails decided.
4. **Agents.**
   - There is one `send` tool. Its `to` names the `Address` input field, and
     its `message` takes the recipient's schema. pi checks (and coerces) the
     arguments against that schema, and wallis checks again against the
     recipient's mailbox before journaling.
   - The file tools (`read`, `ls`; `write`, `edit`; `bash`) each run in a
     fresh bwrap process over the call's view: `/w` as the overlay of its
     session's layers and its own upper dir, and `/in` holding the input
     artifacts and those of every message taken.
   - An Artifact or Tree in an agent's output is submitted as a path in
     `/w` and moved into the store.
   - A turn that ends without a result waits for the next message when the
     agent has a mailbox. Without one, the agent is reminded to submit;
     that costs a turn.
   - A tool call that a crash cut off returns an error to the model ("it may
     or may not have taken effect") when the call resumes from its
     checkpoint; a cut-off `send` returns its journaled result instead.
   - Closed actors and bodies are noted (`closed:<address>`, with the epoch
     they closed in), so a caller in another process rejects sends to them
     too, until a resume opens a new epoch. An agent call is closed when its
     journal entry settles with an answer or a decided failure; one whose
     failed attempt will run again on resume still takes messages.
   - The `bash` tool is killed after `workspace.bashTimeout` (default
     `"10m"`), and says so; its description states the network.
   - Files keep the modes they were written with, in `/w` and in the store
     (the manifest records them). A file an earlier call left writable is
     written in place (overlayfs copies it up into this call's layer); one
     it left read-only is read-only, as on any filesystem.
5. **Paths in values.** The journal keeps refs without `path`. A body or a
   caller sees the blob's path in the store, or a Tree's top layer dir.
   `ctx.files(s)` squashes a session's layers into one, so that path is the
   whole Tree. A sandbox sees its mount points.
   - **A body or caller must not write into a ref's `path`.** It is the
     store's own file or dir, hardlinked into every Tree that shares it, and
     store files keep their modes, so the host does not stop such a write:
     it would change every run's value at once. Inside sandboxes, inputs are
     read-only mounts, so a command or agent cannot. To change a file, copy
     it (a command's `/w`, or `exportOutput`) and change the copy.
6. **`requires`** skips version-manager shim dirs on `PATH` (`…/shims`:
   mise, asdf, pyenv), because a shim needs its manager's config. `node`
   falls back to the Node that runs wallis.
7. **Detached runs** are `node runner.ts <run dir>`, reading
   `start.json` (with its `onExit`, also on a detached resume). The caller
   writes the child's pid and start time into the lock at once,
   so the run is never seen as stopped while it starts. A handle from
   `resume({ detach: true })` treats the run as running until the new
   process logs.

## 13. Acceptance results (phases 3 to 7)

On the real roll (150ND610, 12 frames), with scripted executors only:

- **Finals against the delivered SDR finals** (v1's method: 8-bit RGB after JPEG decode; look
  `cool3` with the owner's per-frame overrides). v2 equals v1 on 11 frames (MAD 1.65 to 3.32,
  PSNR 33.5 to 40.4 dB, identical to v1 to two decimals). Frame 2835 is closer to the delivered
  final than v1 was: MAD 6.46 / PSNR 28.5 dB (v1: 19.03 / 21.8 dB).
- **SIDERIUS** (`examples/siderius`) runs end to end on scripted agents and commands, with v1's
  assertions on the carried history; its JudgeStop `request_input` is the approval pattern.
