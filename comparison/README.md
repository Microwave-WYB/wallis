# comparison

Does a predictable agent workflow need a framework? This directory holds the
framework-free alternative to wallis and the experiment used to compare them.

| Path | Contents |
| --- | --- |
| `skill/` | `pi-orchestration`: a skill that teaches an agent to orchestrate pi micro agents in a small custom TypeScript program. `SKILL.md` has the patterns; `template/` is copy-in code the project then owns (shadcn/ui style); `snippets/` covers patterns the template doesn't. Only `template/lib/agent.pi.ts` imports an agent SDK. `npm test` runs it all on pi-ai's faux provider. |
| `harness/` | A small fixed Python harness (scikit-learn digits; check, train, evaluate, health) from an earlier version of the task. |
| `TASK.md` | That earlier task spec. |
| `runner/` | The runner for the experiment, itself built from the skill's template: `host.ts` serves a JavaScript console on a Unix socket for live, REPL-driven orchestration (`node ctl.ts eval '<js>'`); `arms.ts` runs a coding agent in a bwrap sandbox in phases (a fresh pi session per phase, a notes file as memory) with status, steering and stop; `trace.ts` prints a trajectory from the saved sessions; `prompts/` holds the builders' instructions. |

## The experiment

Two DeepSeek V4.1 Flash agents, each in its own bwrap sandbox, were asked to
replicate SIDERIUS as faithfully as possible, writing code and tests only:

- **arm A** with the skill, as a custom pi program;
- **arm B** with wallis, as a workflow (from a copy without our own SIDERIUS example).

An independent reviewer then verified, scored and compared both.

`runner/arms.ts` hard-codes a few paths of the machine it ran on (mise's Node
and Gleam installs, a local SIDERIUS clone in `/tmp`); adjust them to rerun.
