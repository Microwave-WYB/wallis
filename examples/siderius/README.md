# SIDERIUS as a wallis workflow

```sh
mise run install && npm run demo:siderius   # scripted: no models, no API keys; Linux with bubblewrap
```

`workflow.ts` re-expresses the SIDERIUS research loop
(github.com/yuema137/SIDERIUS, commit 5ccb436) in wallis: interpretation,
the evidence stage and judge, proposal, implementation with validation,
Trial and Formal tuning with Health gates, and the carried history, with the
same stop conditions. It is an approximate re-expression, not a port. The
prompts in `prompts/` and the scripts in `trainer/` and `checks/` are
placeholders, and nothing here has run against real models or real
training. What it shows is the shape: how SIDERIUS's stages, state and
invariants fit wallis's nodes, sandboxes, journal and mailboxes.
`MAPPING.md` lists each SIDERIUS concept, its construct here, and every
place where the two differ.

## Run it (no API keys)

`npm run demo:siderius` builds the package and runs `demo.ts`, in about 15
seconds. The demo copies this directory into a throwaway project, swaps the
placeholder scripts for tiny scripted ones (`demo/scripts/`: training
sleeps a second and writes a fake checkpoint; scores are fixed per model;
Health fails model `m2`), and answers every agent from a script
(`demo/executor.ts`, pi-ai's faux provider). No model is called. The
sandboxes are real, so you need Linux with bubblewrap. It:

1. starts the run detached, in its own process;
2. answers the JudgeStop questions that arrive in the `stop_check` outbox:
   `continue` at iteration 2, `stop` at iteration 4;
3. kills the run's process group with SIGKILL while iteration 3 trains;
4. resumes the run in place and lets it finish;
5. prints each iteration from the run's journal (`log.jsonl`), and checks
   that no training call that finished before the crash ran again.

Abridged output:

```
[outbox stop_check] iteration 2: the judge recommends stopping ("the evidence has repeated for two iterations")
[mailbox decision]  answered: continue
[crash]  SIGKILL to the run's process group (pid 1392630) during training: 6 training calls finished, 1 in flight
[state]  stopped; resuming in place
[outbox stop_check] iteration 4: the judge recommends stopping ("the evidence has repeated for two iterations")
[mailbox decision]  answered: stop
[done]   stop_reason operator_stop after 5 iterations; incumbent m1 at 0.9

iteration 1
  judge     continue
  proposal  m1: a zero-inflated negative-binomial decoder
  trial     score 0.30
            Health valid
  formal    score 0.90
            Health valid
iteration 2
  judge     recommends stopping
  question  to the operator: stop? (the evidence has repeated for two iterations)
  answer    continue
  proposal  m2: a ZINB decoder with a variance penalty
  trial     score 0.80
            Health invalid (variance_collapse)
  formal    score 0.70
            Health invalid (variance_collapse)
iteration 3
  judge     continue
  proposal  m3: a diffusion denoiser
  -- crash  resumed in place: everything above came from the journal; the training call in flight runs again
  trial     score 0.05
  ...
training calls: 8
finished before the crash: 6; of those, run again after the resume: 0
```

m2 scores 0.8 but fails Health, so it never becomes the incumbent; m1's
0.9 is the Health-valid Formal best.

The same workflow is also tested (`node --test test/siderius.test.ts`):
seven iterations with assertions on the carried history (the 5-entry
knowledge cache, consolidated findings and the archive, prediction memory,
deduped error signatures, the 3-iteration collapse window, the judge's
projection), and JudgeStop's `request_input` with a malformed answer
rejected.

## Run it with real models

Agents name model aliases, one per SIDERIUS `llm.json` route family
(the findings consolidator uses `interpret`, as in SIDERIUS). Map them in
`.wallis/config.json` at the project root (the nearest directory with
`.wallis/` or `package.json`):

```json
{
  "models": {
    "interpret": "anthropic/claude-opus-5-5",
    "analysis": "anthropic/claude-sonnet-5-5",
    "literature": "anthropic/claude-sonnet-5-5",
    "judge": "anthropic/claude-opus-5-5",
    "propose": "anthropic/claude-opus-5-5",
    "implement": "anthropic/claude-sonnet-5-5",
    "validate": "anthropic/claude-sonnet-5-5",
    "tune": "anthropic/claude-sonnet-5-5"
  }
}
```

pi-ai serves them with the provider's usual API key (`ANTHROPIC_API_KEY`
and so on). An unmapped alias is an error. To run the whole loop, first
replace the placeholders in `trainer/` and `checks/` with your task
package's train, evaluate, Health, fingerprint, metric-order and validator
entry points (each reads JSON on stdin and writes JSON on stdout; the
schemas are the `command`s in `workflow.ts`), and put the dataset in
`data/` and the run's files in `config/`. Then, from a caller script:

```ts
import { run } from "wallis";
import siderius from "./workflow.ts";

const r = await run(siderius, input, { detach: true });   // `input`: see `Input` in workflow.ts
for (;;) {
	const n = await r.next({ timeout: "100m" });
	if (n.type === "message") await r.send("decision", { decision: "continue", note: "" }); // a JudgeStop question
	else if (n.type !== "timeout") break;                                                     // finished, failed or stopped
}
```

## A tour of `workflow.ts`

Read in this order:

1. **The loop** (`export default workflow`, near the end). One `for`
   iteration is one SIDERIUS iteration, with numbered steps: target check,
   interpretation and findings consolidation, evidence and judge (with
   JudgeStop), proposal and implementation, tuning, Health fingerprints,
   folding the iteration into the history, NoImprovementStop. The run memory
   (SIDERIUS's `ChainState`) is the local variables declared at its top.
2. **The sandboxes** (`trainerBox`, `checksBox`, `codingBox`,
   `analysisBox`, `readingBox`, `reviewBox`, `literatureBox`). Each lists
   exactly what its node can see.
3. **The nested workflows** `implementAndValidate` (implementor, then the
   deterministic checks, then the LLM review, bounded retries) and `tune`
   (Trial rounds, then the forced Formal round; attempts in sequence
   until one is scored, then Health on that checkpoint).
4. **The deterministic folds** (`rankPrune`, `mergeSignatures`,
   `pruneCollapse`, `capCache`, `evaluatePrediction`, `judgeProjection`):
   SIDERIUS's bookkeeping, as plain functions over the local state.
5. **The agents and commands**: one definition each, with typed input and
   output.

| SIDERIUS stage | In `workflow.ts` |
| --- | --- |
| Interpretation (`ResultInterpretationAgent`) | `interpreter`, step 2 |
| Findings consolidation (`cache_consolidator`) | `consolidator`, `rankPrune`, step 2b |
| Evidence stage, judge, JudgeStop | `dataAnalyst`, `literature`, `evidenceJudge`, `judgeProjection`, step 3 |
| Proposal (`MLModelProposalAgent`) | `proposer`, step 4 |
| Implementation and validation | `implementAndValidate`: `implementor`, `validateScript`, `validator` |
| Tuning (`HyperparamTuningAgent`), Health | `tune`: `tunePlanner`, `trainScript`, `evaluateScript`, `healthScript`, `tuneReflector`; step 5 |
| Collapse fingerprints | `fingerprintScript`, `pruneCollapse`, step 6 |
| `advance_completed_history`, incumbent, prediction memory | `capCache`, `mergeSignatures`, `evaluatePrediction`, step 7 |
| NoImprovementStop, stop reasons | step 8, `StopReason` |

## What wallis adds

- **Resume in place.** Every call's input and output is journaled. After a
  crash or a stop, `attach(siderius, id).resume()` runs the body again: each
  finished call (a training run, an agent turn sequence) is answered from
  the journal, so the local variables come back as they were and finished
  training is not redone. Only the calls that were in flight or failed run
  again. An agent cut off mid-call continues from its last checkpointed
  turn. In the code: nothing; the loop is plain code over `ctx.call`
  (docs/design.md §5.3).
- **Per-node sandboxes.** The `sandbox(...)` definitions: `checksBox`
  alone binds `./checks` (the Health code), `trainerBox` alone binds
  `./trainer`, and `prompts/` is bound nowhere. The implementor
  (`codingBox`) sees only the data; the LLM validator (`reviewBox`) sees
  only the plugin it reviews; the literature agent has no filesystem, and
  its tools are the only code with the network. A node that reaches for
  something it was not given gets an error, not a silent dependency.
- **Typed inputs and outputs.** Every agent and command declares TypeBox
  schemas (the `S` module near the top). An agent's output is checked
  before the body sees it, and the agent is asked to correct an invalid one;
  a command whose JSON does not match fails with `output_invalid`.
- **JudgeStop through an outbox and a mailbox.** Step 3: on a stop
  recommendation with `request_input`, the body sends the question to the
  outbox `stop_check` and waits on its own mailbox, registered as
  `decision`. The caller (you, or an agent driving the run) reads it with
  `next()` and answers with `send("decision", …)`; the answer is checked
  against `StopAnswer`. The run can be stopped while it waits; an answer
  sent meanwhile is delivered on resume.
- **Recovery of failed calls.** A failed call throws `NodeFailed` with a
  typed reason. Step 4 catches it for a proposal attempt and records it in
  `previous_failures`; anything uncaught fails the run, and
  `run.status()` names the failed call with a stderr or transcript tail.
  Fix the cause, then `resume()`. An agent that ran out of turns is re-run
  only when named: `resume({ retry: [id], turns: 20 })` continues its own
  session.
