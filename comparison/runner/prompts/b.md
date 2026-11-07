## Target technology: a wallis workflow

/work/project is a copy of the wallis framework, with its dependencies installed and its Gleam core already built (core/build). Read README.md, AGENTS.md and docs/design.md first, then the SDK under host/src/sdk and the examples under host/examples. Node 26 is on PATH (`node`, `npx`), and gleam is on PATH in case you must rebuild the core.

Build the replica as a wallis workflow in /work/project/.agents/workflows/siderius/. Run wallis's own tests with:

```
cd /work/project/host && node --test
```

Run the type check with:

```
npx tsc --noEmit -p . && npx tsc --noEmit -p ../.agents/workflows
```

(adapt the second path to how tsconfig is set up). Do not change wallis itself unless something is genuinely missing or broken. If you must, make the smallest change and list every framework change in REPLICA.md.

wallis's bwrap sandboxing cannot nest inside your sandbox. For end-to-end tests, use wallis's fake executor and its development switch that turns confinement off; see docs/design.md.
