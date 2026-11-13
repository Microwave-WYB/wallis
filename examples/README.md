# Examples

Written before the implementation, as its target: they declared the public `wallis` surface
(first as `api.d.ts`, now the package's own types). They typecheck with the package
(`mise run typecheck`) and each runs end to end in a test on scripted agents, so no model is
called: `test/film.test.ts`, `test/chat.test.ts`, `test/siderius.test.ts`.

| File | Shows |
|---|---|
| `film/workflow.ts` | on tiny synthetic scans (stdlib python3 scripts in `film/scripts`; the owner's real workflow has the same shape over darktable and Hugin): `negatives` (stage 1, once), `develop` (stage 2, many times), `deliver` (nesting, an agent, a steering address), `grade` (an agent driving a compute actor) |
| `film/iterate.ts` | the orchestrating agent's side: `run`, detach and `next`, `attach` to reuse an earlier run's output, `exportOutput` |
| `chat/workflow.ts`, `chat/terminal.ts` | a chat harness: an agent with a mailbox registered as `user`, replies through an outbox, changes back as a Tree |
| `siderius/workflow.ts` | the SIDERIUS research loop (see `siderius/README.md` and `siderius/MAPPING.md`): a carried history as the body's local variables, nested workflows, many agents, a toolset, and the stop check as an outbox question answered in the body's mailbox |
| `film/type-checks.ts` | mistakes the types must reject (each line is `@ts-expect-error`) |

## Decisions the examples made that docs/v2.md did not have

1. **Host files enter through the caller.** `Tree.from(hostDir)` and `Artifact.from(hostFile)`
   are caller-only markers; `run` snapshots them into the store when the run starts. The input is
   then a digest, so the run is reproducible from its record. Bodies never read host paths.
2. **Refs carry `path`.** An Artifact or Tree in a command's input is mounted read-only; its
   `path` is the mount point in that sandbox. This replaces v1's per-roll `--volume` overrides.
3. **Default `parse`:** stdout as JSON, checked against `output`. `r.file(name)` and
   `r.dir(name)` turn scratch-dir results into an Artifact or a Tree; the media comes from the
   output schema.
4. **Workflows may declare `mailbox`.** The body gets it as a third argument and its address as
   `ctx.self` (the approval pattern in §6). Actors declare theirs as the first argument:
   `ctx.spawn(Job, async (ctx, mailbox) => …)`. Every mailbox has a schema.
5. **Envelopes:** `{ id, from, replyTo?, body }`. **Every message is validated against the
   recipient's schema when sent**, before it is journaled; a rejected message is never delivered.
   An agent's `send` tool call fails with the errors (the agent corrects it and sends again); a
   body's `ctx.send` throws `MessageRejected`; the caller's `run.send` rejects with it. `from` is
   `Address<unknown>` at compile time, so a reply is checked at runtime only. Passing an address
   into an agent's `Address(T)` input requires the recipient's schema to equal `T`.
6. **An agent's mailbox may be a union** (`{ jpg } | { error }`): an actor reports failures as
   messages and the agent decides.
7. **Artifacts that arrive by mail are readable** by the receiving agent (the grader looks at
   each render), as its Artifact inputs are.
8. **Typed tool results:** a toolset tool's `outputSchema` types what `ctx.call(tool, …)` returns.
9. **Caller API shapes:**
   - `run(wf, input)` waits and returns `Finished` with `output`;
   - `run(wf, input, { detach: true })` returns a `Run` at once;
   - `attach(wf, id)` is typed by the workflow, and `done()` waits;
   - `next()` returns `message | finished | failed | stopped | timeout`.
10. **`NodeFailed.reason`** lists the failure kinds. `turn_limit_reached` carries the session, so
    a body can continue it with more turns.
11. **One-shot agent calls.** `ctx.call(agent, input)` returns the output only, in a fresh
    session; `ctx.session` is for continuing a dialogue or seeding a workspace (the chat).
12. **Inputs: data as data, files as Trees.** Small metadata (the roll's pairs, crops, EXIF) is
    parsed by the caller and passed as plain input; Trees carry only bulk files (NEFs, Hugin
    projects, the base scan). Collections are arrays of records (`[{ frame, tiff, … }]`), not
    maps keyed by name, so bodies do not index with `!`.
13. **Concurrency is a 10-line `pool` in the workflow file**, not a framework feature.
14. **Prompts are plain strings.** A long prompt is read with `readFileSync` next to the
    workflow. It is part of the agent's definition digest.

## Not covered yet

- MCP servers;
- `ctx.loop`;
- named-volume environments prepared by a setup command;
- the pi extension.
