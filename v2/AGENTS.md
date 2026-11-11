# wallis v2

`docs/v2.md` is the source of truth for v2. Read it before changing
anything under `v2/`. When a design decision changes, change docs/v2.md in
the same commit as the code.

The value and type rules of the root `AGENTS.md` apply here too:

- types make illegal states unrepresentable;
- the Gleam core is pure (no FFI, I/O, clocks or randomness);
- unions are matched exhaustively, with no `_` arm over our own types;
- boundary input is `unknown` until it is parsed.

Its v1-only parts do not apply, wherever docs/v2.md §8 removes them:
ownership capabilities, the CLI, the MCP server, orchestrators, caching,
QuickJS, resource limits and the adversarial hardening.

## Layout

- `core/`: the pure Gleam core. It holds the journal, attempts, resume
  matching, session values and mailbox delivery order.
- `lib/`: the npm package `wallis`. It is the host (store, log, sandbox,
  executors) and the authoring API.
- `examples/`: target workflows owned by the coordinator. Do not edit them.

## Toolchain

- `mise run v2:build` builds the core.
- `mise run v2:test` runs the core and lib tests.
- `mise run v2:typecheck` type-checks `lib/`.
- After you change a type in `core/src/wallis_core/types.gleam`, delete its
  generated functions and regenerate them. From `v2/core/`, run
  `node ../../tools/gleam-codegen.mjs src/wallis_core/types.gleam <Type>...`.
- Run lib tests with explicit globs (`node --test 'test/*.test.ts'`), never
  bare.
- Every lib test runs with `WALLIS_DIFFERENTIAL=1`: after every event, the
  state rebuilt from the log must equal the live state.
- Every core test replays events through `support.replay`, which runs the
  same check.
- Tests never make real model calls. Use pi-ai's faux provider or scripted
  executors.
