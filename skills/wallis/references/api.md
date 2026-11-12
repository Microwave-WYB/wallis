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
	volumes?: string[],             // "./host:/target:ro" (relative to the workflow file, or ~/) | "name:/target"
	environment?: Record<string, string>,
	devices?: string[],             // e.g. "/dev/dri"
	network?: "none" | "host",      // default "none" (loopback only)
}): Sandbox
```

A named volume is a wallis-managed dir that persists across runs, writable by
commands and tool sources, read-only for agents.

```ts
toolset<typeof import("./tools/x.ts")>(path, { sandbox?, network?, secrets? }): Toolset<M>
```

A module of pi `AgentTool`s (`WallisTool`: `name`, `description`,
`parameters`, `outputSchema?`, `annotations?`, `replay?: "safe"`,
`execute`). It runs bundled under `node` in its sandbox (which must allow
`node`); `secrets` names environment variables passed to it. A tool's
identity is (bundle digest, export). `toolset.x` is a `Tool<I, O>` typed
by `parameters` and `outputSchema`.

```ts
mcp({ mcpServers: { name: { command, args?, env? } } }, { name: { sandbox?, network? } }): McpServers
```

`servers.name.tool` is a `Tool`; `servers.name` (the whole server) gives an
agent its read-only tools. `${VAR}` in `env` is filled from the caller's
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
`output_invalid` (parse threw, a missing file, a schema mismatch).

```ts
agent({
	model: string,                  // alias from .wallis/config.json ("default" when unknown)
	prompt: string,
	input, output,
	mailbox?: TSchema,              // messages enter the next turn
	tools?: Tool[],                 // toolset and MCP tools
	workspace?: { access: "read" | "write" | "exec", sandbox? },  // inferred read/write; exec never
	turns?: number,                 // default 30; deliveries count
}): Agent<I, O, M>
```

The agent's tools: `submit_result` (its output; three invalid results fail
the call, decided, as `output_invalid`), `send` (one per `Address` input
field, named by `to`), file tools by access (`read`, `ls`; `write`, `edit`;
`bash`), each in a fresh bwrap process over `/w` (its session's layers) and
`/in` (its input files and those of every message it took). An Artifact or
Tree in its output is the path of a file or dir in `/w`.

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
`reason: "invalid" | "closed"`, `errors: { path, message }[]`).

## The caller

```ts
run(wf, input): Promise<Finished<O>>                                   // foreground, waits; throws NodeFailed
run(wf, input, { detach: true, onExit?: "<shell>" }): Promise<Run<O>>  // its own process
attach(id) / attach(wf, id): Run<O>
list(workflowFile): Promise<{ id, state, started }[]>
prune(): Promise<{ freed }>
```

`Run<O>`:

| Method | |
|---|---|
| `id` | `<workflow>-<utc time>-<rand>` |
| `status()` | `{ state: running \| stopped \| finished \| failed, elapsed, completed, running: CallRef[], failed: FailedCall[] }` |
| `tree()` | the calls under the calls they were made in, with attempts |
| `transcript(callId)` | an agent call's dialogue |
| `next({ timeout? })` | `message` (an outbox's) \| `finished` \| `failed` (`FailedCall[]`) \| `stopped` \| `timeout` (progress) |
| `send(name, body, { replyTo?, interrupt? })` | the message id; rejects with `MessageRejected` |
| `stop()` | SIGTERM to the run's process |
| `resume({ detach?, retry?: CallId[], turns? })` | continues in place |
| `done()` | waits; `Finished<O>` or throws `NodeFailed` |

`Finished<O>` adds `output` and `exportOutput(dir)`.

`CallRef`: `{ id, label, path, attempt }`; `label` is the node's const name
and definition site (`stitch (film/workflow.ts:93)`), `path` the enclosing
calls' labels. `FailedCall` adds `reason`, `recovery: "resume" | "retry"`
and `tail`.

## Project files

```
<project>/.wallis/config.json   { "models": { alias: "provider/model[:thinking]" }, "executor"?: "./x.ts" }
<project>/.wallis/runs/<id>/    log.jsonl (the journal), meta.json, lock, inbox.jsonl, work/
<project>/.wallis/store/        blobs/, layers/: content-addressed, shared by every run
```

An executor module's default export returns `{ models, getApiKey? }` (a
pi-ai model registry; `wallis/testing` exports `createModels` and the faux
provider).
