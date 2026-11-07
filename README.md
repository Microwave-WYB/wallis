# wallis

Declarative micro harnesses for agent workflows. A workflow is a small,
committed directory that any mainstream harness (Claude Code, Codex, Cursor,
Gemini CLI, pi) can call over MCP. Each agent in it loads only the prompt,
model, tools and sandbox it declares.

The name comes from the Wallis product,

    π/2 = (2/1)(2/3)(4/3)(4/5)(6/5)(6/7)…

an infinite product that folds term by term toward π. A wallis run works the
same way: it folds agent outputs into the run state one step at a time.

Status: first prototype. See [docs/design.md](docs/design.md).

## Layout

| Path | Contents |
| --- | --- |
| `core/` | Pure Gleam core compiled to JavaScript: run state, events, effects, views, reducers, pin, budget, journal |
| `host/` | The `wallis` npm package (not published): the SDK (`src/sdk/`), the thin host (`src/host/`: QuickJS sandbox, JSONL log, sessions, resume, fork, fake executor, MCP server) and the CLI (`src/cli/main.ts`) |
| `host/examples/two-node/` | A two-node workflow and a runner that can kill itself mid-call |
| `host/examples/ask/` | Two nodes, the first of which asks the human a question |
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
wallis run <workflow> --input '{...}' --executor <module>   # until it needs attention
wallis wait <run>        # in the background: returns when a node asks, the run pauses or ends
wallis wait              # in the background: returns when any of your own runs needs attention
wallis pending           # your idle nodes and runs here; prints nothing when there are none
wallis claim <run>       # take over a run (a logged event); others' runs are read-only
wallis send <run> <node> <text>
wallis resume <run> [--model alias=provider/model:thinking] [--budget usd=60]
wallis fork <run> --at <events|node> [--model ...]
wallis cancel <run> | wallis status <run> [--json]
wallis export <run> <artifact> <dir>   # copy an artifact out of a run
wallis serve --executor <module>   # stdio MCP server: run, send, get_run, cancel, wait
```

There is no real executor yet: `--executor` takes a module whose default
export returns `{ executor, scripts? }`, such as the scripted fake in
`host/test/fixtures/fake-executor.ts`.
