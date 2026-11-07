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
| `host/` | The `wallis` npm package (not published): the SDK (`src/sdk/`) and the thin host (`src/host/`: QuickJS sandbox, JSONL log, resume, fake executor) |
| `host/examples/two-node/` | A two-node workflow and a runner that can kill itself mid-call |
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
