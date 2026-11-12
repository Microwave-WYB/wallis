# wallis

Reproducible, resumable, sandboxed multi-step agent workflows, written as
plain TypeScript.

A workflow is one file of typed nodes:

- **commands** are sandboxed programs;
- **agents** are pi agent loops with typed input and output;
- **tools** are custom toolset modules or MCP servers;
- **nested workflows** are workflows called from a workflow.

The body that ties them together is ordinary code. Every call's input, output
and model is journaled, so a run can be stopped or crash at any time and
`resume()` continues it without redoing what finished. Expensive results are
content-addressed Artifacts and Trees in the project's store, and they are
reused explicitly by passing them to the next run. There is no hidden cache.

```ts
import { agent, Artifact, command, sandbox, Tree, Type, workflow, run } from "wallis";

const box = sandbox({ requires: ["python3"], volumes: ["./scripts:/scripts:ro"] });

const summarize = command({
	sandbox: box,
	input: Type.Object({ data: Tree() }),
	output: Type.Object({ report: Artifact("text/markdown") }),
	run: ({ data }) => ["python3", "/scripts/summarize.py", data.path, "report.md"],
	parse: (r) => ({ report: r.file("report.md") }),
});

const analyst = agent({
	model: "default",
	prompt: "Read the report and answer the question.",
	input: Type.Object({ report: Artifact("text/markdown"), question: Type.String() }),
	output: Type.Object({ answer: Type.String() }),
});

export const ask = workflow({
	input: Type.Object({ data: Tree(), question: Type.String() }),
	output: Type.Object({ answer: Type.String() }),
	run: async (ctx, { data, question }) => {
		const { report } = await ctx.call(summarize, { data });
		return ctx.call(analyst, { report, question });
	},
});

// From a caller script:
const r = await run(ask, { data: Tree.from("./data"), question: "What changed?" });
console.log(r.output.answer);
```

Agents and the workflow can also talk while a run is going:

- actors with mailboxes;
- an agent's `send` tool to an address it was given;
- a caller steering a running agent through a registered address;
- questions to the caller through an outbox.

Every message is checked against its recipient's schema.

## Requirements

- Linux with [bubblewrap](https://github.com/containers/bubblewrap). Every
  command, agent workspace and tool source runs in its own sandbox, and has no
  network unless it declares one.
- Node 26 or newer.

## Install

```sh
npm install github:Microwave-WYB/wallis#main   # the package
npx skills add Microwave-WYB/wallis             # the agent skill, for Claude Code, pi and others
```

Installing from git runs the package's `prepare` script, which builds
`dist/` with TypeScript (Node does not strip types inside `node_modules`).
So scripts must not be disabled: with `--ignore-scripts` (or
`ignore-scripts=true` in `.npmrc`) the package installs without `dist/` and
cannot be imported. The Gleam core is committed as JavaScript
(`core/dist/`), so the install needs no Gleam.

Model aliases come from `<project>/.wallis/config.json`
(`{ "models": { "default": "provider/model" } }`), served by pi-ai's
providers with their usual API keys.

## Documentation

- `skills/wallis/SKILL.md`: how to write, run, iterate on and recover
  workflows (for agents and people), with `references/api.md` and
  `references/patterns.md`.
- `docs/design.md`: the design, its threat model (accidents and
  reproducibility, not adversaries) and its decisions.
- `examples/`:
  - `chat`: a chat harness with an agent in a copy-on-write repo;
  - `siderius`: a research loop;
  - `film`: a two-stage film workflow with delivery and grading, on tiny
    synthetic scans.

## Development

```sh
mise run install     # npm dependencies, from the lockfile
mise run build       # the Gleam core (and core/dist), then dist/
mise run test        # core and package tests (scripted executors only)
mise run typecheck
```

MIT licensed.
