# wallis

Declarative micro harnesses for agent workflows. A workflow is a small,
committed directory that any mainstream harness (Claude Code, Codex, Cursor,
Gemini CLI, pi) can call over MCP. Each agent in it loads only the prompt,
model, tools and sandbox it declares.

The name comes from the Wallis product,

    π/2 = (2/1)(2/3)(4/3)(4/5)(6/5)(6/7)…

an infinite product that folds term by term toward π. A wallis run works the
same way: it is a fold of the workflow body over its journal of agent and
script results, one call at a time.

Status: first prototype. See [docs/design.md](docs/design.md).

## Layout

| Path | Contents |
| --- | --- |
| `core/` | Pure Gleam core compiled to JavaScript: the journal (a content-addressed cache), budget, pin, status, ownership, interventions and their capabilities, held failures |
| `host/` | The `wallis` npm package (not published): the SDK (`src/sdk/`), the thin host (`src/host/`: QuickJS sandbox, JSONL log, sessions, resume, fork, fake executor, MCP server) and the CLI (`src/cli/main.ts`) |
| `host/examples/two-node/` | A two-node workflow and a runner that can kill itself mid-call |
| `host/examples/ask/` | Two nodes, the first of which asks the human a question |
| `host/src/host/pi.ts`, `tools.ts` | The pi executor (pi-agent-core: retries, per-turn checkpoints, turn quota, compaction) and the wallis tool layer (codemode, bash and file tools in the agent's sandbox, caps with spills, sandboxed MCP servers, the containment check) |
| `host/src/host/capability.ts`, `render.ts`, `mounts.ts` | Capabilities (`OwnedRun`, `IdleNode`, `SteerableNode`, `LiveNode`, `ResumableRun`), Foldable input rendering and the window check, read-only mounts |
| `host/src/host/confine.ts`, `commands.ts`, `slots.ts` | Declared bwrap sandboxes (binaries, setup, mounts); command calls; machine-wide resource and provider slots |
| `.agents/workflows/siderius/` | SIDERIUS expressed as a wallis workflow; `MAPPING.md` lists what maps and what does not |
| `tools/gleam-codegen.mjs` | Drives `gleam lsp` code actions to generate decoders and JSON encoders |
| `docs/design.md` | Current design: decided, proposed and open items, plus prototype choices |

Tools are pinned in `mise.toml`; npm dependencies are pinned in
`host/package.json`.

```sh
mise run install     # npm ci in host/
mise run test        # core (gleeunit) and host (node --test) tests
mise run typecheck   # tsc --noEmit for host/ and .agents/workflows/
```

Runs live under `.wallis/runs/` of the project. The CLI (run it with
`node host/src/cli/main.ts`; `npx wallis` once installed):

```sh
wallis run <workflow> --input '{...}' [--mount name=dir] [--bin name=path] --executor <module>   # until it needs attention
wallis wait <run>        # in the background: returns when a node asks, the run pauses or ends
wallis wait              # in the background: returns when any of your own runs needs attention
wallis pending           # your idle nodes and runs here; prints nothing when there are none
wallis claim <run>       # take over a run (a logged event); others' runs are read-only
wallis send <run> <node> [text] [--turns N]   # answer an idle node, or grant more turns
wallis steer <run> <node> <text>       # a running node of a steerable agent, at its next step
wallis restart <run> <node> [note] [--turns N] [--model a=m]   # rerun a node (also a held failed one)
wallis resume <run> [--model alias=provider/model:thinking] [--budget turns=500]   # code changes are fine
wallis fork <run> [--model ...]        # copies the journal (a cache); unchanged calls hit
wallis cancel <run> | wallis status <run> [--json]
wallis export <run> <artifact> <dir>   # copy an artifact out of a run
wallis ls | tree <run> | log <run> [--follow] | show <run> [<node>]   # monitoring, observations
wallis interrupt <run> <node> [text] | pause <run> | cancel <run> --node <node>   # steering
wallis serve --executor <module>   # stdio MCP server: run, send, steer, interrupt, restart, get_run, cancel, wait, ...
```

The default executor is pi (`host/src/executors/pi.ts`, pi-ai's built-in
providers, auth from their usual environment variables). `--executor` takes
any module whose default export returns `{ executor, commands? }`, such as the
scripted fake in `host/test/fixtures/fake-executor.ts`. Machine settings
(mount dirs, binaries, retry delays, provider limits, slots, model remaps) live in the local profile:
`~/.config/wallis/profile.json` and `.wallis/profile.json`.
