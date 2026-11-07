# wallis

## Sources of truth

- `docs/design.md` holds the current design. Change it when a design decision
  changes, in the same change as the code.
- Items marked "proposed" there are not settled; ask before building on them.

## Toolchain

- Tools are declared in `mise.toml` (Gleam, Node). Do not install them globally.
- `mise run build` and `mise run test` build and test the core.

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
