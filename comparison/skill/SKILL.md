---
name: pi-orchestration
description: Build a small TypeScript program that orchestrates pi micro agents (pi-agent-core + pi-ai) directly, with no framework, for multi-step research or engineering loops (propose → implement → check, fan-out and judge, parallel scoring, cross-model review), with Python/PyTorch work run as sandboxed subprocesses. Use it when asked to automate a loop of LLM agents plus ML code, e.g. "build siderius-lite", "write an agent pipeline that tunes/trains/evaluates models", or "orchestrate several models in TS".
---

# Orchestrating pi micro agents in TypeScript

You write one small TS program. It calls pi agents as typed functions,
keeps all memory in local variables, runs Python (PyTorch) as sandboxed
subprocesses that exchange JSON files, and resumes by being run again. No
framework, no MCP by default.

## Start: copy the template

The template is code the project owns, not a dependency (shadcn/ui style).

```sh
cp -r <this skill>/template my-project && cd my-project
npm install            # exact pins: pi 1.5.0 packages, typebox 1.3.27
node run.ts            # provider keys from the usual env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)
```

```
my-project/
  run.ts          # the program: agents, loop, memory (edit this)
  prompts/*.md    # one system prompt per agent (edit these)
  lib/agent.ts    # the micro-agent unit (adapt as needed)
  lib/sandbox.ts  # bwrap: run a subprocess with fixed binds; Python steps; a try-run tool
  lib/steps.ts    # idempotent steps: skip when the output file exists
  harness/*.py    # ML code: reads input.json, writes output.json; never calls a model
  work/           # everything the run produces; delete it to start over
```

Then: rewrite `run.ts` for the task, write the prompts, put the model and
training/eval code in `harness/`, and change `lib/` freely. Read the three
`lib/` files once; they are short.

## 1. The micro-agent unit (`lib/agent.ts`)

```ts
const Plan = Type.Object({ lr: Type.Number({ exclusiveMinimum: 0, maximum: 1 }), epochs: Type.Integer({ minimum: 1 }) });
const plan = await runAgent(models, {
  model: "anthropic/claude-sonnet-5-5",   // provider/model
  system: prompt("propose"),
  output: Plan,                            // TypeBox: the result type and the submit_result schema
  tools: [],                               // only the TS tools it needs
  maxTurns: 6,
  checkpoint: "work/iter-0/propose.session.json",
}, { task, history, advice });            // its whole world: nothing else is visible
// plan: Static<typeof Plan>, validated
```

What `runAgent` does, and why:
- **No ambient context.** It uses pi-agent-core's `Agent` directly: no
  built-in tools, no AGENTS.md / CLAUDE.md, no extensions or skills. The
  model sees the system prompt, the input JSON and the tools you pass.
- **Typed result.** A `submit_result` tool whose `parameters` is the output
  schema. Invalid arguments come back as a tool error (pi checks them
  against `parameters` first; the tool checks again with `Value.Check`), and
  the model resubmits. `terminate: true` ends the turn once it is valid.
- **Turn quota.** Before every request it appends `[Turn k of N]` to the
  newest user or tool-result message, never the system prompt, so the
  cached prefix stays stable; at N without a result it aborts and throws.
- **Transient retries.** 429, 5xx, "overloaded", timeouts and network
  errors are retried after 5 s, 30 s, 2 min (`retries`); 401/403/412,
  billing and unknown models are not. A provider error is an assistant
  message with `stopReason: "error"`, not an exception: drop it and
  `continue()`.
- **Session persistence.** With `checkpoint`, the whole conversation is
  written after every completed turn (atomically). The next run with the
  same file continues from there instead of starting over.

Tools are plain pi `AgentTool`s with TypeBox `parameters`, registered in
process. Give agents only what they need; **by default no shell or fs on
the host**. For "let it run its code", give `tryRunTool(dir)` from
`lib/sandbox.ts`.

## 2. Orchestration: plain TS

Memory is local variables, pushed into each agent's input; agents never
pull it. Concurrency is `Promise.all` over independent calls.

- **propose → implement/evaluate → critique → refine:** `template/run.ts`
  (the loop; the history and the advice are locals fed back each round).
- **Fan-out, then a judge** that sees every answer: `snippets/patterns.ts` `fanOutThenJudge`.
- **Parallel scoring**, sorted in code: `scoreAll`.
- **Cross-model review** (author and reviewer are different models, one revision): `crossReview`.

Keep deterministic decisions (best score, stopping rules, dedupe, caps) in
TS, not in prompts.

## 3. Sandboxes (`lib/sandbox.ts`)

`sandboxed(argv, { ro, work, network?, gpu?, env?, timeoutMs? })`, about 30
lines of bwrap: the host's `/usr` and `/etc` read-only, your read-only
binds at fixed paths (`{ "/abs/harness": "/harness" }`), one writable dir at
`/work` (the cwd), private `/proc`, `/dev`, `/tmp`, **no network** unless
`network`, NVIDIA devices only with `gpu`, the environment cleared (only
`PATH`, `HOME` and what you pass). It dies with the parent.

- `python(harness, "train.py", "work/step", input)` writes `input.json`,
  runs `python3 /harness/train.py /work/input.json /work/output.json`, and
  returns `output.json`.
- `tryRunTool(scratch)`: an implementor's tool that runs its file in a
  fresh sandbox and returns capped output.
- Mount only what a step needs. An implementor must not see the evaluation
  code it is judged by; a judge must not see the candidate's tests.
- PyTorch from a venv: bind the venv read-only at a fixed path (e.g.
  `{ "/abs/.venv": "/venv" }`) and run `/venv/bin/python`. Build the venv
  once, outside the sandbox or in a step with `network: true`.

## 4. Recovery without a framework

Re-running the program is the resume:
- everything lands in `work/`, one directory per step (`work/iter-3/`);
- `step(file, fn)` (`lib/steps.ts`) runs `fn` once and stores its JSON
  result; on a re-run the file is read instead. Wrap every agent call and
  every expensive Python step;
- agents checkpoint their conversation (`checkpoint:`), so a crash mid-node
  loses at most the turn in flight;
- write outputs atomically (tmp file, then rename) so a crash never leaves
  a half file that a re-run would trust.

To redo a step, delete its file (or its directory). If you change a prompt
or a step's code, delete the affected `work/` entries yourself: the cache
is by file name, not by content.

## 5. Context control

- **Large inputs: codemode** (`snippets/codemode.ts`). Give the agent a
  `codemode` tool: it sends a short JavaScript body that runs in QuickJS
  (pi-codemode, no fs or network) with the full data as `input`, and only
  the returned value enters the context. Put a short description of the
  data in the agent's input, not the data.
- **Cap every tool result** (`capped(text, cap, file)`): over the cap, save
  the full text in `work/` and return the head plus the file name.
- **Turn quotas** are on by default (`maxTurns`, "Turn k of N").
- **Compaction:** pi-agent-core does not compact. For long dialogues, use
  `transformContext` to replace older messages with a summary
  (`generateSummary` from `@earendil-works/pi-coding-agent`), or keep agents
  short-lived and push only what they need.

## 6. TS / Python split

- TS: orchestration, agents, tools, decisions, file layout.
- Python: model code, training and evaluation (PyTorch), each step a script
  `harness/<step>.py input.json output.json`, deterministic given its input
  and seed, never calling a model API, run sandboxed.
- Exchange only JSON files (and artifacts such as checkpoints) inside the
  step's `work/` dir.

## 7. Pitfalls

- **Ambient context.** pi-coding-agent's session helpers load AGENTS.md,
  CLAUDE.md, user extensions and skills. For micro agents use
  `new Agent(...)` from pi-agent-core and pass `systemPrompt` and `tools`
  yourself.
- **Two validation layers.** pi validates tool arguments against
  `parameters` before `execute`, with its own message ("Validation failed
  for tool …"); keep your own `Value.Check` in `submit_result` anyway.
- **Errors are messages.** A provider failure ends the run with an
  assistant message `stopReason: "error"` (and `errorMessage`), not a
  throw. `agent.abort()` makes `prompt()` reject. Check both.
- **`continue()`** only works when the last message is a user or tool
  result; drop a failed assistant reply before retrying.
- **Turn counting.** `turn_end` also fires for errored and aborted
  replies; don't count those, and don't checkpoint them as progress.
- **Quota placement.** Never put per-turn text in the system prompt (it
  breaks provider caching); append to the newest message.
- **Compaction is yours** (see above); without it a long agent hits the
  window.
- **Model strings** are `provider/model`; `models.getModel(provider, id)`
  returns undefined for an unknown one: fail early.
- **Tests without paid calls:** pi-ai's faux provider
  (`fauxProvider`, `setResponses`, `fauxToolCall`), as in `test/faux.ts`.
  The system prompt reaches a faux reply as the first message (`role:
  "system"`).

### Optional: an existing MCP server

Only for servers you already have: `@earendil-works/pi-mcp`'s `McpClient`
with a `StdioTransport` (`inheritEnv: false`, secrets only in its `env`),
then wrap each allowlisted tool as an `AgentTool` whose `execute` calls
`client.callTool`. Run the server process in `sandboxed()` if you can.
