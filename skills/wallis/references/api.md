# wallis API reference

Everything is imported from `wallis` (and test helpers from `wallis/testing`).
Schemas are TypeBox (`Type` is re-exported).

## Values and schema builders

| Builder | Value | Notes |
|---|---|---|
| `Artifact(media?)` | `ArtifactRef<M>`: `{ kind: "artifact", digest, name, media, path }` | a content-addressed file in the project store; `path` is its mount point in a sandbox, its store path in a body or caller |
| `Artifact.from(hostFile, { media?, name? })` | caller only | ingested into the store when the run starts |
| `Tree()` | `TreeRef`: `{ kind: "tree", digest, path }` | a directory snapshot, mounted read-only |
| `Tree.from(hostDir)` | caller only | snapshotted incrementally (a hash cache) and reflinked |
| `Address(T)` | `Address<Static<T>>`: `{ kind: "address", id }` | where messages of type `T` can be sent; as an agent input it gives the agent a `send` tool |

`Static`, `TSchema` and `Type` come from TypeBox.

## Resources

```ts
sandbox({
	requires?: string[],            // programs on PATH, called by their real path (shims skipped)
	volumes?: string[],             // "./host:/target:ro" (relative to the workflow file, or ~/) | "name:/target" (writable, exclusive) | "name:/target:ro" (shared)
	environment?: Record<string, string>,  // no HOME (it is /w); a PATH goes before the sandbox's own
	devices?: string[],             // e.g. "/dev/dri"
	network?: "none" | "host",      // default "none" (loopback only)
}): Sandbox
```

A named volume is a wallis-managed dir that persists across runs, writable by
commands and tool sources, read-only for agents. It belongs to the project
(`<project>/.wallis/volumes/<name>`). Like a Docker volume it has one writer at a time: `"name:/target"` mounts it writable and holds it
alone (no other writer and no reader meanwhile); `"name:/target:ro"` mounts
it read-only and shares it with the other readers, which run at the same
time. Agents always mount named volumes read-only, as readers. Toolsets and
MCP servers hold their volumes as long as their connection is open. A call
that waits for a volume shows in `status().waiting`; a stop ends the wait.
The locks are `flock(2)` (util-linux's `flock` must be installed), so a
holder that died never keeps one. One volume may be mounted once per
sandbox. A required script's `#!` interpreter must be in
the host base or in `requires`; otherwise the sandbox is refused, naming it.

```ts
toolset<typeof import("./tools/x.ts")>(path, { sandbox?, network?, secrets? }): Toolset<M>
```

A module of pi `AgentTool`s (`WallisTool`: `name`, `description`,
`parameters`, `outputSchema?`, `annotations?`, `replay?: "safe"`,
`execute`). It runs bundled under `node` in its sandbox (wallis adds `node`
to it); `secrets` names environment variables passed to it. A tool's
identity is (the module's source text, its sandbox and network, export).
`toolset.x` is a `Tool<I, O>` typed by `parameters` and `outputSchema`. A
source that dies at startup fails the call with its stderr.

```ts
mcp({ mcpServers: { name: { command, args?, env? } } }, { name: { sandbox?, network? } }): McpServers
```

`servers.name.tool` is a `Tool`; `servers.name` (the whole server) gives an
agent only its tools annotated `readOnlyHint: true`; name a writing tool to
give it. `${VAR}` in `env` is filled from the caller's
environment.

## Nodes

```ts
command({
	sandbox, input, output,
	run: (input) => string[],                 // argv; refs carry their mount `path`
	parse?: (r: CommandResult, input) => output,  // default: JSON.parse(stdout)
}): Command<I, O>
```

`CommandResult`: `code`, `stdout`, `stderr`, `file(name)` (an Artifact; the
media comes from the output schema), `dir(name)` (a Tree). Failures:
`command_exited` (exit code or signal, with the stderr tail),
`output_invalid` (parse threw, a missing file, a schema mismatch, a
`file`/`dir` path that leads out of `/w`). A sandbox that cannot start the
command (bwrap's own error) is `command_exited` with code 127 and the
message "the sandbox could not start the command: bwrap: …".

```ts
agent({
	model: string,                  // alias from .wallis/config.json (an unknown alias is an error naming the known ones)
	prompt: string,
	input, output,
	mailbox?: TSchema,              // messages enter the next turn
	tools?: Tool[],                 // toolset and MCP tools
	workspace?: { access: "read" | "write" | "exec", sandbox?, bashTimeout?: Duration },  // inferred read/write; exec never; bash killed after bashTimeout (default "10m")
	turns?: number,                 // default 30; deliveries count
}): Agent<I, O, M>
```

The agent's tools: `submit_result` (its output; three invalid results fail
the call, decided, as `output_invalid`), one `send` tool when it has
`Address` inputs (its `to` names the field, its `message` takes that
recipient's schema), file tools by access (`read`, `ls`; `write`, `edit`;
`bash`), each in a fresh bwrap process over `/w` (its session's layers) and
`/in` (its input files and those of every message it took, restored after
a resume). `/tmp` is empty again in every tool call. Files keep the modes
they were written with.
An Artifact or Tree in its output is the path of a file or dir in `/w`.

```ts
workflow({
	input, output,
	mailbox?: TSchema,              // the body's own; its address is ctx.self
	run: async (ctx, input, mailbox) => output,
}): Workflow<IS, OS, M>
```

## The body (`ctx`)

| Operation | Returns |
|---|---|
| `ctx.call(node, input, { turns? })` | the output; a session call `[output, nextSession]` |
| `ctx.start(node, input, { turns? })` | `Running`: `{ address, result }` (the address reaches a running agent's or workflow's mailbox) |
| `ctx.session(agent, { from?: TreeRef })` | an immutable session; calling it twice branches |
| `ctx.files(session)` | its `/w` as a `TreeRef` |
| `ctx.spawn(schema, async (ctx, mailbox) => R)` | `Running<R, M>`: an actor with its own branch |
| `ctx.map(items, (ctx, item, i) => …)` | results in order (one branch per item) |
| `ctx.loop(init, (ctx, state) => ({ next }) \| ({ done }))` | the `done` value; each iteration a branch |
| `ctx.send(address, body, { replyTo?, interrupt? })` | the message id; throws `MessageRejected` |
| `ctx.self` | this body's or actor's address |
| `ctx.register(name, address)` | exposes it to the caller |
| `ctx.outbox(name, schema)` | an address whose messages go to the caller |

A `Mailbox<M>` is an async iterable of `Envelope<M>`
(`{ id, from, replyTo?, body }`) with `receive()`.

Errors: `NodeFailed` (`call: CallRef`, `reason`), `MessageRejected` (`to`,
`reason: "invalid" | "closed"`, `errors: { path, message }[]`). An actor's failure
reaches whoever awaits its `result` (the `NodeFailed` or the thrown error);
if nobody handles it, it fails the spawning body and, uncaught, the run.
`reason: "closed"`: the recipient has ended in this epoch (each
start or resume is one; a resume reopens what an earlier epoch closed).

## The caller

```ts
run(wf, input): Promise<Finished<O>>                                   // foreground, waits; throws NodeFailed
run(wf, input, { detach: true, onExit?: "<shell>" }): Promise<Run<O>>  // its own process
attach(id) / attach(wf, id): Run<O>                                    // attach(wf, id) throws for a run of another workflow
list(workflowFile): Promise<{ id, state, started }[]>
prune(): Promise<{ freed }>
```

`Run<O>`:

| Method | |
|---|---|
| `id` | `<workflow>-<utc time>-<rand>` |
| `status()` | `{ state: running \| stopped \| finished \| failed, elapsed, completed, running: CallRef[], waiting: { call: CallRef, volume }[], failed: FailedCall[] }` |
| `tree()` | the calls under the calls they were made in, with attempts (`unknown`: for reading) |
| `transcript(callId)` | the dialogue of an agent call's last attempt |
| `next({ timeout? })` | `message` (an outbox's, or a reply to the caller with `replyTo`) \| `finished` \| `failed` (`FailedCall[]`, the fatal one first) \| `stopped` \| `timeout` (progress) |
| `send(name, body, { replyTo?, interrupt? })` | the message id; rejects with `MessageRejected` |
| `stop()` | SIGTERM to the run's process (only the one its lock names: pid and start time) |
| `resume({ detach?, retry?: CallId[], turns? })` | continues in place (a detached resume keeps the run's `onExit`) |
| `done()` | waits; `Finished<O>` or throws `NodeFailed` |

`Finished<O>` adds `output` and `exportOutput(dir)` (copies the output's files; `~` is the home dir; fails if a copy fails).

`CallRef`: `{ id, label, path, attempt }`; `label` is the node's const name
and definition site (`stitch (film/workflow.ts:93)`), `path` the enclosing
calls' labels. `FailedCall` adds `reason`, `recovery: "resume" | "retry"`
and `tail`.

## Project files

```
<project>/.wallis/config.json   { "models": { alias: "provider/model[:thinking]" }, "executor"?: "./x.ts", "retryDelaysMs"?: number[] }
<project>/.wallis/runs/<id>/    log.jsonl (the journal), meta.json, lock, inbox.jsonl, work/
<project>/.wallis/store/        blobs/, layers/: content-addressed, shared by every run; never write into them
<project>/.wallis/volumes/      named volumes, one dir each
```

`retryDelaysMs` (default `[5000, 30000, 120000]`): the waits before an agent
retries a transient provider error (rate limits, overload, network) within a
turn; after the last, the call fails with `model_failed`.

An executor module's default export returns `{ models, getApiKey? }` (a
pi-ai model registry; `wallis/testing` exports `createModels` and the faux
provider).
