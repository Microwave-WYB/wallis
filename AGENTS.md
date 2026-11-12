# wallis

`docs/design.md` is the design and the source of truth. When a design decision
changes, change it in the same commit as the code. Items marked "proposed"
there are not settled; ask before building on them. The agent skill
(`skills/wallis/`) documents the public API for users; keep it in step with
the code.

## Everything is a value

The only mutation is appending an event to a run's log. Every side file is
either a content-addressed blob or layer in the project's store, written
before the event that names it, or a cache derivable from the log
(`meta.json`). The journal only grows: a resume, a retry or a new attempt
adds to it. The host executes effects and feeds events back; the core
decides what runs and what is answered from the record.

- **Sessions are values.** `ctx.call(session, input)` returns `[output,
  next]`; the session is unchanged, so calling it again is a branch. A
  session id is a hash chain over the call it comes after and that call's
  attempt.
- **Workspaces and Trees are layers.** A session's `/w` is an overlay of
  immutable layers; a call's changes become a new layer (renamed in, never
  copied) before the event that names it; squashed beyond 16. A Tree is one
  digest naming its layers.
- **Identity is structural.** Journal keys come from digests and positions
  (node definition, canonical input, scope, session, occurrence), never from
  display names; inside the core they are opaque types (`Slot`, `RequestId`,
  `SessionId`, `Digest`).

## Governing principle

Types make illegal states unrepresentable. Where types cannot reach (time,
other processes, external input), the core re-checks when it applies an
event and returns a typed refusal. Nothing is ever silently dropped.

1. Every lifecycle is a discriminated union; each variant carries only the
   data meaningful in that state.
2. Prefer compiler narrowing over hand-written `x is T` predicates. Brand
   only raw ids that cross a boundary (`CallId`, `MessageId`).
3. Everything at a boundary is `unknown` until parsed with its schema
   (command and model output, tool results, messages, files read back from
   the run directory). No `as` casts there.

**Every new state or operation must name its union variant and how its
boundary input is parsed.** Keep it minimal: no generics or wrappers that add
no proof.

## Layout

- `core/`: the pure Gleam core (journal, attempts, resume matching, sessions,
  mailbox order). `core/dist/` is its JavaScript, committed so installing
  the package never needs Gleam: rebuild it with `mise run build`.
- `src/`: the package `wallis`, the authoring and caller API and the runtime.
  `src/host/` holds the host's internals (log, store, layers, sandbox, tool
  sources).
- `test/`: node:test suites; `test/fixtures/` their workflows and scripted
  executors.
- `examples/`: chat, SIDERIUS and a film-style example on tiny synthetic
  inputs; each runs in a test.
- `skills/wallis/`: the agent skill (Agent Skills spec).
- `tools/`: `gleam-codegen.mjs`, `build-core.mjs`.

## Toolchain

- Tools are declared in `mise.toml` (Gleam, Node). Do not install them
  globally. npm dependencies are pinned in `package.json`;
  `mise run install` installs them from the lockfile.
- `mise run build` builds the core (and `core/dist`) and `dist/`.
  `mise run test` runs the core and package tests. `mise run typecheck`
  type-checks `src/`, `test/`, `examples/` and the skill's starter.
- After changing a type in `core/src/wallis_core/types.gleam`, delete its
  generated `_decoder`/`_to_json` functions and regenerate them, from
  `core/`: `node ../tools/gleam-codegen.mjs src/wallis_core/types.gleam <Type>...`.
- Run `node --test` with explicit globs (`'test/*.test.ts'`), never bare: a
  bare run picks up fixtures.

## Core rules

- `core/` is pure Gleam: no FFI, no I/O, no clocks, no randomness. Everything
  the core needs arrives as an event; everything it wants done leaves as an
  effect.
- Model run state as explicit custom types and exhaustive `case`; no boolean
  flags for states. A match over a union we define has no `_` arm: list every
  arm, or say why the rest cannot occur.
- Every core behavior gets a test that replays a sequence of events
  (`test/support.gleam`'s `replay` also checks that the state refolded from
  the logged events equals the live one); no test needs a model, network or
  device.

## Package rules

- Every test runs with `WALLIS_DIFFERENTIAL=1` (`test/util.ts`): after every
  event the state rebuilt from the log must equal the live state. Every
  state change is logged.
- Tests never make real model calls or need API keys: pi-ai's faux provider
  or a scripted executor module (`test/fixtures/*-executor.ts`). Tests that
  spawn sandboxes need bwrap, skip with a reason without it, and carry
  timeouts. Named volumes and caches go to a throwaway `XDG_CACHE_HOME`.
- The workflow body is plain code over journaled calls; run memory is its
  local variables. The core holds no workflow state.
- Every message is validated against its recipient's mailbox schema before
  it is journaled; a closed recipient rejects.
- A node's digest covers its own definition (schemas, sandbox, prompt, the
  source of its own functions), never its name or label, and not the helpers
  it closes over (docs/design.md §5.5). A change to what a digest or a slot
  covers bumps the core's semantics version.
- The sandbox's jobs are preventing accidents and making dependencies
  explicit (docs/design.md §1): nothing implicit is mounted, binds are
  read-only, no network unless declared.
- The body sees typed errors only (`NodeFailed` with a `reason` union,
  `MessageRejected` with `invalid` or `closed`); never match on message text.
- Recovery is the most important property: resume in place, attempts,
  per-turn checkpoints, decided failures retried only when named. Keep them
  tested.
- Heavy work in tests and acceptance (stitching, rendering) runs one at a
  time, under `build-guard` after `wait-for-no-game` on the owner's host.
