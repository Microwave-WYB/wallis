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

Agents interact with the workflow only through their input and output.
Their tools touch only the outside world (custom tool modules, MCP servers)
or their own sandbox (a workspace with `read`, `write` or `exec` access).
Outward writes happen in the workflow body; asking the orchestrator first
is an orchestrator node. Agents are called through sessions, and every
call's result, tool calls included, is journaled.

Status: an experimental prototype, not published to npm. Round 7 (agent
tools and workspaces, custom toolsets served over MCP from their own
sandbox, opt-in `ask`, unknown outcomes after a crash, the round-6 review
fixes) is built and its tests pass, including a state-coverage acceptance
test driven through the CLI and MCP with pi's faux provider; no workflow
has been run against a real model at length. See
[docs/design.md](docs/design.md) for the design and every prototype choice,
and `wallis doc` for a short guide.

## Layout

| Path | Contents |
| --- | --- |
| `core/` | Pure Gleam core compiled to JavaScript: the journal (a content-addressed cache), budget, pin, status, ownership, interventions and their capabilities, held failures |
| `host/` | The `wallis` npm package (not published): the SDK (`src/sdk/`), the thin host (`src/host/`: QuickJS sandbox, JSONL log, sessions, resume, fork, fake executor, MCP server) and the CLI (`src/cli/main.ts`) |
| `host/examples/two-node/` | A two-node workflow and a runner that can kill itself mid-call |
| `host/examples/ask/` | Two nodes, the first of which asks the human a question |
| `host/src/host/pi.ts`, `tools.ts`, `toolsets.ts` | The pi executor (pi-agent-core: retries, per-turn checkpoints, turn quota, compaction) and the wallis tool layer (codemode, workspace file tools, custom toolsets and MCP servers in their own sandboxes, journaled results, caps with spills, the write-rule warnings) |
| `host/src/host/capability.ts`, `render.ts`, `volumes.ts` | Capabilities (`OwnedRun`, `IdleNode`, `SteerableNode`, `LiveNode`, `ResumableRun`), Foldable input rendering and the window check, sandbox volumes (preflight, bind digests) |
| `host/src/host/confine.ts`, `commands.ts`, `slots.ts` | Declared bwrap sandboxes (binaries, setup, volumes, devices); command calls; machine-wide resource and provider slots |
| `.agents/workflows/siderius/` | SIDERIUS expressed as a wallis workflow; `MAPPING.md` lists what maps and what does not |
| `comparison/` | The framework-free alternative and the comparison experiment; see its README |
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
wallis doc | describe <workflow>       # how to write and drive workflows | what a workflow asks (JSON)
wallis run <workflow> --input '{...}' [--volume /target=dir] [--bin name=path] --executor <module>   # until it needs attention
wallis wait <run>        # in the background: returns when a node asks, the run pauses or ends
wallis wait              # in the background: returns when any of your own runs needs attention
wallis pending [--json]  # what waits for you here, with the actions that resolve it
wallis claim <run>       # take over a run (a logged event); others' runs are read-only
wallis send <run> <node> [text] [--turns N]   # idle: the reply (or more turns); running: a steer after its turn
wallis submit <run> <node> '<json>'    # an orchestrator node's result, checked against its schema
wallis restart <run> <node> [note] [--turns N] [--model a=m]   # rerun a node (also a held failed one)
wallis resume <run> [--model alias=provider/model:thinking] [--budget turns=500]   # code changes are fine
wallis fork <run> [--model ...]        # copies the journal (a cache); unchanged calls hit
wallis cancel <run> | wallis status <run> [--json]
wallis export <run> <artifact> <dir>   # copy an artifact out of a run
wallis ls | tree <run> | log <run> [--follow] | show <run> [<node>]   # monitoring, observations
wallis interrupt <run> <node> | pause <run> | cancel <run> --node <node>   # steering
wallis serve --executor <module>   # stdio MCP server: run, describe, send, submit_result, interrupt, restart, get_run, pending, wait, ...
```

The default executor is pi (`host/src/executors/pi.ts`, pi-ai's built-in
providers, auth from their usual environment variables). `--executor` takes
any module whose default export returns `{ executor, commands? }`, such as the
scripted fake in `host/test/fixtures/fake-executor.ts`. Machine settings
(bind volume dirs by target, binaries, retry delays, provider limits, slots, model remaps) live in the local profile:
`~/.config/wallis/profile.json` and `.wallis/profile.json`.

## Acknowledgements

The reference workload is [SIDERIUS](https://github.com/yuema137/SIDERIUS)
(MIT License). The SIDERIUS example and the comparison replicate its design
and concepts; see `MAPPING.md` for how they correspond.

wallis builds on [pi](https://github.com/earendil-works/pi) (pi-agent-core,
pi-ai, pi-codemode, pi-mcp) for its agent executor.

## License

MIT. See [LICENSE](LICENSE).
