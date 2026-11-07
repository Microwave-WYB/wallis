# wallis

Declarative micro harnesses for agent workflows. A workflow is a small,
committed directory that any mainstream harness (Claude Code, Codex, Cursor,
Gemini CLI, pi) can call over MCP. Each agent in it loads only the prompt,
model, tools and sandbox it declares.

The name comes from the Wallis product,

    π/2 = (2/1)(2/3)(4/3)(4/5)(6/5)(6/7)…

an infinite product that folds term by term toward π. A wallis run works the
same way: it folds agent outputs into the run state one step at a time.

Status: design stage. See [docs/design.md](docs/design.md).

## Layout

| Path | Contents |
| --- | --- |
| `core/` | Pure Gleam core compiled to JavaScript: run state, events, effects, views, reducers |
| `docs/design.md` | Current design: decided, proposed and open items |

Tools are pinned in `mise.toml`. Run the core tests with `mise run test`.
