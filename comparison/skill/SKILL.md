---
name: pi-orchestration
description: Build a small TypeScript program that orchestrates LLM micro agents directly, with no framework, for multi-step research or engineering loops (propose → implement → check, fan-out and judge, parallel scoring, cross-model review), with Python/PyTorch work run as sandboxed subprocesses. The patterns are SDK-neutral; pi (pi-agent-core + pi-ai) is the reference implementation. Use it when asked to automate a loop of LLM agents plus ML code, e.g. "build siderius-lite", "write an agent pipeline that tunes/trains/evaluates models", or "orchestrate several models in TS".
---

# Orchestrating micro agents in TypeScript

You write one small TS program. It calls agents as typed functions, keeps
all memory in local variables, runs Python (PyTorch) as sandboxed
subprocesses that exchange JSON files, and resumes by being run again. No
framework, no MCP by default. The agent SDK sits behind one function in one
file; pi is the reference implementation.

## Start: copy the template

The template is code the project owns, not a dependency (shadcn/ui style).

```sh
cp -r <this skill>/template my-project && cd my-project
npm install            # exact pins: pi 1.5.0 packages, typebox 1.3.27
node run.ts            # provider keys from the usual env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)
```

```
my-project/
  run.ts            # the program: agents, loop, memory (edit this)
  prompts/*.md      # one system prompt per agent (edit these)
  lib/tool.ts       # SDK-neutral types: Tool, AgentSpec, AgentResult
  lib/agent.ts      # the seam: re-exports runAgent from one variant
  lib/agent.pi.ts   # the pi variant: the ONLY file that imports an agent SDK
  lib/sandbox.ts    # bwrap: run a subprocess with fixed binds; Python steps; a try-run tool
  lib/steps.ts      # idempotent steps: skip when the output file exists
  harness/*.py      # ML code: reads input.json, writes output.json; never calls a model
  work/             # everything the run produces; delete it to start over
```

Then: rewrite `run.ts` for the task, write the prompts, put the model and
training/eval code in `harness/`, and change `lib/` freely. The `lib/`
files are short; read them once.

## 1. The micro-agent unit

One function, the whole contract:

```ts
const result = await runAgent({
  model: "anthropic/claude-sonnet-5-5",   // provider/model
  system: prompt("propose"),
  output: Plan,                            // TypeBox: the result type and its schema
  tools: [tryRunTool("work/scratch")],     // only the tools it needs (SDK-neutral Tool)
  maxTurns: 6,
  session: "work/iter-0/propose.session.json",
}, { task, history, advice });            // its whole world: nothing else is visible

// result: { type: "submitted", value } | { type: "question", message } | { type: "failed", kind, error }
const plan = submitted(result);            // the value, or throw
```

A tool is a TypeBox schema plus a plain function (`lib/tool.ts`):

```ts
const lookup = tool({
  name: "lookup", description: "Look up a column's stats.",
  parameters: Type.Object({ column: Type.String() }),
  execute: async ({ column }) => ({ text: JSON.stringify(stats[column] ?? null) }),
});
```

Any variant of `runAgent` must do the following (`lib/agent.pi.ts` does,
on pi):
- **No ambient context:** no built-in tools, no AGENTS.md / CLAUDE.md, no
  user extensions or skills. The model sees the system prompt, the input
  JSON and the tools passed.
- **Typed result:** a `submit_result` tool whose parameters are the output
  schema; an invalid submission goes back to the model as a tool error and
  it retries. Ending a turn with text instead is a `question`.
- **Turn quota:** before every request, append `[Turn k of N]` to the
  newest user or tool-result message (never the system prompt, so the
  cached prefix stays stable). At N without a result: `failed`, kind
  `turn_limit`.
- **Transient retries:** 429, 5xx, "overloaded", timeouts and network
  errors retry after 5 s, 30 s, 2 min; 401/403/412, billing and unknown
  models fail at once (kind `provider`).
- **Session persistence:** with `session`, save the whole conversation after
  every completed turn (atomically); a later call with the same file
  continues it, after a crash or with `answer` (a reply to its question).

Give agents only what they need; **by default no shell or fs on the host**.
For "let it run its code", give `tryRunTool(dir)` from `lib/sandbox.ts`.

### Another SDK

Write `lib/agent.<sdk>.ts` exporting the same `runAgent(spec, input)`,
convert `Tool` to the SDK's tool type inside it, and change the one line in
`lib/agent.ts`. Nothing else changes: `run.ts`, `lib/sandbox.ts` and
`lib/steps.ts` import no SDK. No adapter library, no plugin mechanism.

## 2. Orchestration: plain TS

Memory is local variables, pushed into each agent's input; agents never
pull it. Concurrency is `Promise.all` over independent calls.

- **propose → evaluate → critique → refine:** `template/run.ts` (the
  history and the advice are locals fed back each round).
- **Fan-out, then a judge** that sees every answer: `snippets/patterns.ts` `fanOutThenJudge`.
- **Parallel scoring**, sorted in code: `scoreAll`.
- **Cross-model review** (author and reviewer are different models, one revision): `crossReview`.
- **A question** (`type: "question"`) is a result like any other: answer
  it in code, ask a human, or call again with `answer`.

Keep deterministic decisions (best score, stopping rules, dedupe, caps) in
TS, not in prompts.

## 3. Sandboxes (`lib/sandbox.ts`)

`sandboxed(argv, { ro, work, network?, gpu?, env?, timeoutMs? })`, about 30
lines of bwrap: the host's `/usr` and `/etc` read-only, your read-only
binds at fixed paths (`{ "/abs/harness": "/harness" }`), one writable dir
at `/work` (the cwd), private `/proc`, `/dev`, `/tmp`, **no network**
unless `network`, NVIDIA devices only with `gpu`, the environment cleared
(only `PATH`, `HOME` and what you pass). It dies with the parent.

- `python(harness, "train.py", "work/step", input)` writes `input.json`,
  runs `python3 /harness/train.py /work/input.json /work/output.json`, and
  returns `output.json`.
- `tryRunTool(scratch)`: an implementor's tool that runs its file in a fresh
  sandbox and returns capped output.
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
- agents save their `session`, so a crash mid-node loses at most the turn
  in flight;
- write outputs atomically (tmp file, then rename) so a crash never leaves
  a half file that a re-run would trust.

To redo a step, delete its file (or directory). If you change a prompt or
a step's code, delete the affected `work/` entries yourself: the cache is
by file name, not by content.

## 5. Context control

- **Large inputs: codemode** (`snippets/codemode.ts`). Give the agent a
  `codemode` tool: it sends a short JavaScript body that runs in QuickJS
  (pi-codemode, no fs or network) with the full data as `input`, and only
  the returned value enters the context. Put a short description of the
  data in the agent's input, not the data. The tool is a plain `Tool`, so
  it works with any `runAgent` variant.
- **Cap every tool result** (`capped(text, cap, file)`): over the cap, save
  the full text in `work/` and return the head plus the file name.
- **Turn quotas** are part of the contract (`maxTurns`, "Turn k of N").
- **Compaction** is the variant's job when dialogues get long; or keep
  agents short-lived and push only what they need.

## 6. TS / Python split

- TS: orchestration, agents, tools, decisions, file layout.
- Python: model code, training and evaluation (PyTorch), each step a script
  `harness/<step>.py input.json output.json`, deterministic given its input
  and seed, never calling a model API, run sandboxed.
- Exchange only JSON files (and artifacts such as checkpoints) inside the
  step's `work/` dir.

## 7. Pitfalls

General:
- **Per-turn text in the system prompt** breaks provider caching: append
  to the newest message.
- **Counting turns:** a failed or aborted reply is not a turn, and not
  progress to checkpoint.
- **Two agents, one model registry:** set it once in the variant (pi:
  `setModels`), not per call site.
- **Tests without paid calls:** use the SDK's fake provider. pi-ai's is
  `fauxProvider` / `setResponses` / `fauxToolCall` (see `test/faux.ts`).

pi (the reference variant):
- **Ambient context.** pi-coding-agent's session helpers load AGENTS.md,
  CLAUDE.md, user extensions and skills. For micro agents use
  `new Agent(...)` from pi-agent-core and pass `systemPrompt` and `tools`.
- **Two validation layers.** pi validates tool arguments against
  `parameters` before `execute`, with its own message ("Validation failed
  for tool …"); keep the `Value.Check` in `submit_result` anyway.
- **Errors are messages.** A provider failure ends the run with an
  assistant message `stopReason: "error"` (and `errorMessage`), not a throw;
  `agent.abort()` makes `prompt()` reject. Check both.
- **`continue()`** only works when the last message is a user message or a
  tool result: drop a failed reply before retrying.
- **`turn_end`** also fires for errored and aborted replies.
- **No compaction** in pi-agent-core: add it in `transformContext`
  (`generateSummary` from `@earendil-works/pi-coding-agent`).
- **`streamFn`** must be the registry's `streamSimple` bound to it.
- The faux provider passes the system prompt as the first message
  (`role: "system"`).

### Optional: an existing MCP server

Only for servers you already have: `@earendil-works/pi-mcp`'s `McpClient`
with a `StdioTransport` (`inheritEnv: false`, secrets only in its `env`),
then wrap each allowlisted tool as a `Tool` whose `execute` calls
`client.callTool`. Run the server process in `sandboxed()` if you can.
