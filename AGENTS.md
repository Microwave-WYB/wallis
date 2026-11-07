# wallis

## Sources of truth

- `docs/design.md` holds the current design. Change it when a design decision
  changes, in the same change as the code.
- Items marked "proposed" there are not settled; ask before building on them.

## Toolchain

- Tools are declared in `mise.toml` (Gleam, Node). Do not install them globally.
- npm dependencies live in `host/package.json` with exact versions;
  `mise run install` installs them from the lockfile.
- `mise run build` builds the core. `mise run test` runs the core and host
  tests. `mise run typecheck` type-checks `host/` and `.agents/workflows/`.
- After changing a type in `core/src/wallis_core/types.gleam`, delete its
  old `_decoder`/`_to_json` functions and regenerate them: from `core/`,
  `node ../tools/gleam-codegen.mjs <file> <Type>...`.

## Core rules

- `core/` is pure Gleam: no FFI, no I/O, no clocks, no randomness. Everything
  the core needs arrives as an event; everything it wants done leaves as an
  effect.
- Model run state as explicit custom types and exhaustive `case`; no
  boolean flags for states.
- Generate decoders and JSON encoders with the Gleam language server code
  actions rather than writing them by hand.
- Every core behavior gets a test that replays a sequence of events; no test
  may need a model, network or device.

## Host and SDK rules

- `host/src/sdk/` runs inside the QuickJS sandbox: no Node imports.
- Host tests use the fake executor and fake scripts; never real model calls
  or API keys. CLI and MCP tests load `host/test/fixtures/fake-executor.ts`
  as the executor module and work in throwaway projects (`test/util.ts`).
- pi executor tests use pi-ai's faux provider (`fauxProvider().setResponses`);
  never real paid model calls.
- CLI tests run detached hosts with `WALLIS_HOST=plain` (set in
  `test/util.ts`) so SIGKILL tests are not restarted by systemd; tests that
  need bwrap or systemd skip with a message when unavailable.
- Reducers are built-in deterministic merges only; custom or LLM-based
  merging is workflow code (owner decision).
- Every value crossing the sandbox or executor boundary is schema-checked on
  both sides (`src/sdk/validate.ts`); keep new boundaries that way.
- The body sees typed errors only (`Refused`, `AgentFailed`, `ScriptFailed`,
  `SchemaError`); never make it match on message text.
