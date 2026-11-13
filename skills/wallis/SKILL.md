---
name: wallis
description: Write and run reproducible, resumable, sandboxed multi-step agent workflows as plain TypeScript with wallis. Use it when a task needs several agent calls, sandboxed commands (training, rendering, builds) or tools chained with typed inputs and outputs; when a long run must survive crashes and resume without redoing finished steps; when expensive results should be staged once and reused explicitly; or when the orchestrating agent iterates with a human, steers a running agent, or answers its questions through mailboxes. Covers commands, agents, sessions, tool sources (custom toolsets, MCP), nested workflows, actors and mailboxes, content-addressed artifacts and Trees, the caller API (run, attach, next, send, resume, exportOutput), and recovery.
license: MIT
compatibility: Linux with bubblewrap (bwrap) for the sandbox; Node 26 or newer.
metadata:
  version: "2.0.0"
---

# wallis

wallis runs agent workflows whose **process is reproducible**. A workflow is
one TypeScript file of typed nodes: sandboxed **commands**, pi **agents**,
**tools** (custom toolsets or MCP servers) and nested **workflows**. Its body
is plain code; every call's input, output and model is journaled, so a run
can stop at any time and **resume** without redoing what finished.

Use wallis when a task is several steps that must be repeatable, survive
crashes, keep large intermediate files, or involve agents talking to the
workflow (or to you) while they run. For a single prompt or a one-off
script, do not.

The package is `wallis` (Node 26+, types stripped natively). There is no CLI:
callers use the JS API from a script or `node --input-type=module -e '…'`.
Linux with bubblewrap is required; every command, agent workspace and tool
source runs in its own sandbox with no network unless declared.

## Writing a workflow

Start from `assets/workflow.ts`. One file holds everything a workflow
declares; nodes are plain values you import and call.

```ts
import { readFileSync } from "node:fs";
import { agent, Artifact, command, sandbox, Tree, Type, workflow } from "wallis";

const box = sandbox({ requires: ["python3"], volumes: ["./scripts:/scripts:ro"] });

const stitch = command({
	sandbox: box,
	input: Type.Object({ raw: Tree(), frame: Type.String() }),
	output: Type.Object({ neg: Artifact("image/tiff") }),
	run: ({ raw, frame }) => ["python3", "/scripts/stitch.py", `${raw.path}/${frame}.NEF`, "neg.tif"],
	parse: (r) => ({ neg: r.file("neg.tif") }),          // a file in the command's /w becomes an Artifact
});

const reviewer = agent({
	model: "default",                                      // an alias from .wallis/config.json
	prompt: readFileSync(new URL("./prompts/review.md", import.meta.url), "utf8"),
	input: Type.Object({ neg: Artifact("image/tiff") }),
	output: Type.Object({ ok: Type.Boolean(), notes: Type.String() }),
	turns: 20,
});

export const negatives = workflow({
	input: Type.Object({ raw: Tree(), frames: Type.Array(Type.String()) }),
	output: Type.Object({ negs: Type.Array(Artifact("image/tiff")) }),
	run: async (ctx, { raw, frames }) => {
		const negs = [];
		for (const frame of frames) negs.push((await ctx.call(stitch, { raw, frame })).neg); // one at a time
		const review = await ctx.call(reviewer, { neg: negs[0]! });                          // one-shot agent call
		if (!review.ok) throw new Error(review.notes);
		return { negs };
	},
});
```

Rules that matter:

- **Commands**: `run(input) → argv` (refs in the input carry their mount
  `path`), `parse(result, input) → output` (default: stdout as JSON). The
  input JSON is also on stdin. `r.file(name)` and `r.dir(name)` turn files
  the command wrote in `/w` into an Artifact or a Tree.
- **Sandboxes** (`sandbox({...})`): `requires` (programs, called by their
  real path), `volumes` (`"./x:/x:ro"` read-only binds relative to the
  workflow file, `"name:/target"` named volumes that persist), `environment`,
  `devices`, `network: "none" | "host"`. Nothing else is visible: not the
  workflow dir, not `$HOME`. A call sees `/in` (its inputs, read-only), `/w`
  (its scratch dir, also `$HOME`), its volumes and an empty `/tmp` (new for
  every process: in an agent, for every tool call). A script's `#!`
  interpreter must be in the host base (`/usr`, `/bin`, …) or in `requires`.
- **Agents** are called one-shot (`ctx.call(agent, input)` → output) or
  through sessions to continue a dialogue (`ctx.call(ctx.session(agent), input)`
  → `[output, next]`). File tools come from `workspace.access`
  (`read`/`write`/`exec`, inferred from Artifact or Tree inputs and outputs);
  `tools` holds toolset and MCP tools only. `turns` (default 30) is the only
  budget.
- **Errors**: a failed call throws `NodeFailed` with a typed `reason`
  (`command_exited`, `output_invalid`, `turn_limit_reached`, `model_failed`,
  `tool_failed`, `workflow_threw`) and its `call` (`CallRef`). Catch it in
  the body when the workflow can go on.
- Concurrency is plain code (`Promise.all`, a small pool, `ctx.map`). Run
  memory-heavy commands one at a time.

The full author API is in [references/api.md](references/api.md).

## Running it (the caller)

```ts
import { attach, run, Tree } from "wallis";
import { develop, negatives } from "./workflow.ts";

const r = await run(negatives, { raw: Tree.from("~/scans/roll1"), frames: ["0001", "0002"] }); // waits
r.output.negs;                                   // refs with host paths into the project store: read them, never write into them
await r.exportOutput("./out");                   // copy the output's files somewhere

const d = await run(negatives, input, { detach: true });   // its own process; returns at once
for (;;) {
	const n = await d.next({ timeout: "100m" });   // message | finished | failed | stopped | timeout
	if (n.type !== "timeout") break;
}
const again = attach(negatives, d.id);            // pick a run back up by id, typed
```

- `Tree.from(dir)` and `Artifact.from(file)` snapshot host files into the
  project store when the run starts (incremental, reflinked); bodies never
  read host paths.
- Runs live in the project of the workflow file (nearest `.wallis/` or
  `package.json`): `.wallis/runs/<id>/`, with `.wallis/store/` shared.
- Model aliases come from `.wallis/config.json`
  (`{ "models": { "default": "provider/model" } }`); an optional `executor`
  module supplies a pi-ai model registry (use `wallis/testing`'s faux
  provider for tests: never spend real model calls on tests).
- `list(workflowFile)`, `prune()` (delete store data no run references).

## Explicit staging and reuse

There is **no cross-run cache**. Expensive stages run once and return their
results as Artifacts or Trees; later runs take them as input:

```ts
const { negs } = (await run(negatives, roll)).output;          // once, minutes
await run(develop, { negs, look: L1, only: ["2835"] });        // seconds, many times
```

Keep a stage's run id; `(await attach(negatives, id).done()).output` gets
its output back in a later step. A second `run(negatives, …)` recomputes
everything, by design. Resume (below) is the only implicit reuse, and only
within one run.

## Iterating as the orchestrating agent

You (Claude Code, pi) are the caller. Each step is a short script or
`node -e` that imports the workflow and calls `run`/`attach`. Keep run ids in
the conversation: they are the history. Show the human the files (`path`
of an output artifact, or `exportOutput`) and change the input for the next
step. For anything that takes longer than your harness allows a background
command (Claude Code: 2 hours), run detached and loop on
`next({ timeout })`, which returns `timeout` with progress.

## Interaction: actors, mailboxes, steering

Every mailbox has a schema, and every message is validated against the
recipient's schema when it is sent; a rejected one is never delivered.

- `ctx.spawn(schema, async (ctx, mailbox) => …)` starts an actor; it reads
  `for await (const m of mailbox)` and replies with
  `ctx.send(m.from, body, { replyTo: m.id })`. Its mailbox closes when the
  body that spawned it returns.
- An agent with `mailbox: T` gets messages in its next turn (several at
  once; `{ interrupt: true }` aborts the current turn). An `Address(T)`
  input gives it a `send` tool to that address.
- `ctx.register(name, address)` exposes an address to the caller:
  `run.send(name, body, { interrupt? })`. `ctx.outbox(name, T)` sends to the
  caller: `run.next()` returns its messages.
- A message to a recipient that has ended is rejected (`closed`); to a
  stopped run it persists and is delivered on resume.
- An actor's failure is never swallowed: await its `result` to handle it;
  unhandled, it fails the spawning body (and the run, naming the actor). A
  failed actor's mailbox is closed. There are no supervisors: to keep an
  actor alive across bad jobs, put a try/catch around each message.

Steering a running agent, asking the human, approvals and a compute actor
are worked through in [references/patterns.md](references/patterns.md).

## Recovery

A run can stop at any time (crash, kill, OOM, `run.stop()`). `resume()`
runs the body again from the top: every call that finished is answered from
the journal, calls that were in flight or failed run again.

```ts
const r = attach(negatives, id);
const { failed } = await r.status();      // FailedCall: id, label, path, attempt, reason, recovery, tail
// fix the cause (free memory, fix a script), then:
await r.resume({ detach: true });
```

- `recovery: "resume"`: a crash, a non-zero exit, a model or tool error. A
  plain `resume()` re-runs it.
- `recovery: "retry"`: a **decided** failure, the call's own outcome:
  `turn_limit_reached`, `output_invalid` after the agent's retries, a tool
  whose outcome is unknown. It re-runs only when named:
  `resume({ retry: [failed[0].id], turns: 20 })` continues that agent's own
  session with more turns (or, for `output_invalid`, with the errors).
- `failed` lists the failure that ended the run first, then the others by
  time. `failed[].tail` holds the last lines of stderr or of the transcript;
  `r.transcript(callId)` the dialogue of the call's last attempt. Finished
  calls are never retried: to redo one, start a new run.
- Editing a nested workflow's body re-runs everything inside it on resume
  (its calls are keyed under it); editing the top-level body re-runs only
  what it now calls differently.

## Pitfalls

- **Never write into a ref's `path` on the host** (a body, a caller, a
  script run outside wallis). It is the project store's own file, shared by
  every Tree and run that holds the same content; the store keeps files'
  modes, so nothing stops the write. Copy first (`exportOutput`, or a
  command that copies its input into `/w`) and change the copy. Sandboxes
  mount inputs read-only, so commands and agents cannot make this mistake.
- **Node identity covers a node's own source, not its helpers.** A node's
  digest covers its schemas, sandbox, prompt and the source text of its own
  `run`/`parse`/body, but not helpers they close over (an argv builder, a
  constant, an imported module) nor the files a sandbox binds. After editing
  a helper or a bound script, resume still answers the earlier calls from the
  journal: retry the affected calls or start a new run.
- The body may take different paths on resume (it is plain code); it then
  reuses less, never wrongly. Keep call inputs deterministic where you can.
- Agents get everything through their input; they cannot read the run or the
  host. A sub-agent reaching outside its view is a workflow design error:
  give it the file (as an input Artifact or Tree) or the volume.
- No network unless the sandbox (or toolset) says `network: "host"`.
- Programs in `requires` must be real binaries on PATH; version-manager shims
  (`…/shims`) are skipped.
- `ctx.loop(init, step)`: pass its type arguments explicitly when `step`
  returns both `{ next }` and `{ done }` literals (TypeScript widens them).
- MCP tools are an index (`servers.probe.count!` under
  `noUncheckedIndexedAccess`).
- Memory-heavy steps one at a time, and for tests never real model calls: use
  `wallis/testing`'s faux provider or a scripted executor module.
- Keep caller code (`run(...)`) out of the workflow's module, or guard it with
  `if (import.meta.main)`: a detached run imports that module in its own
  process (wallis refuses a `run()` there).
