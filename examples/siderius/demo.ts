// The SIDERIUS workflow on scripted agents and scripted training: no models, no API keys.
//
//   npm run demo:siderius
//
// (The script builds the package first: the workflow imports `wallis`, i.e. dist/.)
//
// It copies this example into a throwaway project, swaps the placeholder trainer/ and checks/
// for the tiny scripts in demo/scripts, and points every model alias at demo/executor.ts. The
// sandboxes are real (Linux with bubblewrap). Then it:
//
// 1. starts the run detached, in its own process;
// 2. answers the JudgeStop questions that arrive in the `stop_check` outbox (continue, then stop);
// 3. kills the run's process group with SIGKILL while iteration 3 is training (a crash);
// 4. resumes the run in place, and lets it finish;
// 5. prints a trace of each iteration from the run's log (the journal), and how many training
//    calls that finished before the crash ran again after the resume (none should).

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { attach, run, type Run } from "wallis";
import type Siderius from "./workflow.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

// --- A throwaway project ---------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "siderius-demo-"));
const dir = join(root, "siderius");
writeFileSync(join(root, "package.json"), '{ "type": "module" }\n');
for (const sub of ["prompts", "tools", "config", "data"]) cpSync(join(here, sub), join(dir, sub), { recursive: true });
for (const f of ["train.py", "evaluate.py"]) cpSync(join(here, "demo/scripts", f), join(dir, "trainer", f));
for (const f of ["health.py", "fingerprint.py", "metric_order.py", "validate.py"]) cpSync(join(here, "demo/scripts", f), join(dir, "checks", f));
// The workflow imports the same wallis module as this script.
const wallis = JSON.stringify(import.meta.resolve("wallis"));
writeFileSync(join(dir, "workflow.ts"), readFileSync(join(here, "workflow.ts"), "utf8").replaceAll('from "wallis"', `from ${wallis}`));
const aliases = ["interpret", "analysis", "literature", "judge", "propose", "implement", "validate", "tune", "consolidate"];
mkdirSync(join(root, ".wallis"));
writeFileSync(join(root, ".wallis/config.json"), JSON.stringify({ models: Object.fromEntries(aliases.map((a) => [a, "faux/m"])), executor: join(here, "demo/executor.ts") }));

const wf = ((await import(pathToFileURL(join(dir, "workflow.ts")).href)) as { default: typeof Siderius }).default;

const input = {
	task: "improve the primary metric on the task package's dataset",
	seed: 11,
	maxIterations: 6,
	targetScore: null,
	evidence: { dataAnalysis: true, literature: true, order: "parallel" as const, literatureMaxRounds: 2 },
	stops: { noImprovementBodies: 0, judgeCriterion: "stop when the evidence repeats", judgeOnMet: "request_input" as const },
	maxProposalAttempts: 3,
	maxImplAttempts: 3,
	tuning: { maxRounds: 2, maxFailRounds: 3, attemptsPerTrialRound: 1, attemptsPerFormalRound: 5, trialMinutes: 2, formalMinutes: 5, trialMaxEpochs: 1, formalMaxEpochs: 2, vramBudgetGb: 24 },
};

// --- The run's log, read back ----------------------------------------------------------
//
// `.wallis/runs/<id>/log.jsonl` is the journal and the single source of truth: one JSON event per
// line, appended, never rewritten. The trace below reads four kinds: `requested` (a call and its
// input), `*_returned` (its output), `sent` (a message) and `resumed` (a resume began).

type Event =
	| { type: "requested"; id: string; name: string; input: Record<string, unknown>; scope: string }
	| { type: "returned"; id: string; output: Record<string, unknown> }
	| { type: "sent"; to: string; body: Record<string, unknown> }
	| { type: "resumed" }
	| { type: "other" };

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function parseEvent(line: string): Event {
	const e = obj(JSON.parse(line));
	const id = String(e.id);
	if (e.type === "requested") {
		const req = obj(e.request);
		return { type: "requested", id, name: String(req.name).split(" ")[0]!, input: obj(req.input), scope: String(e.scope) };
	}
	if (e.type === "command_returned" || e.type === "agent_returned" || e.type === "workflow_returned") return { type: "returned", id, output: obj(e.output) };
	if (e.type === "sent") return { type: "sent", to: String(e.to), body: obj(e.body) };
	if (e.type === "resumed") return { type: "resumed" };
	return { type: "other" };
}

const events = (id: string): Event[] => {
	const file = join(root, ".wallis/runs", id, "log.jsonl");
	return (existsSync(file) ? readFileSync(file, "utf8") : "")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map(parseEvent);
};

/** Training calls by request id: requested, and returned or not. */
function trainCalls(id: string): { requested: string[]; returned: Set<string> } {
	const ev = events(id);
	const requested = ev.flatMap((e) => (e.type === "requested" && e.name === "trainScript" ? [e.id] : []));
	const returned = new Set(ev.flatMap((e) => (e.type === "returned" && requested.includes(e.id) ? [e.id] : [])));
	return { requested, returned };
}

// --- Drive the run -----------------------------------------------------------------------

const log = (s = "") => console.log(s);
const answers = ["continue", "stop"] as const;
const handled = new Set<string>();
let beforeCrash: { requested: string[]; returned: Set<string> } | null = null;

log("SIDERIUS on wallis: scripted agents and training, no models, no API keys");
log(`project ${root}`);
let r: Run<unknown> = await run(wf, input, { detach: true });
log(`run     ${r.id} (detached: its own process)\n`);

for (;;) {
	const n = await r.next({ timeout: "0.2s" });
	if (n.type === "message" && !handled.has(n.id)) {
		handled.add(n.id);
		const q = obj(n.body);
		const decision = answers[handled.size - 1] ?? "stop";
		log(`[outbox stop_check] iteration ${q.iteration}: the judge recommends stopping ("${q.recommendation}")`);
		await r.send("decision", { decision, note: "answered by demo.ts" });
		log(`[mailbox decision]  answered: ${decision}`);
	} else if (n.type === "timeout" && beforeCrash === null) {
		const t = trainCalls(r.id);
		if (t.returned.size >= 6 && t.requested.length > t.returned.size) {
			const pid = Number(readFileSync(join(root, ".wallis/runs", r.id, "lock"), "utf8").split(/\s+/)[0]);
			process.kill(-pid, "SIGKILL");
			beforeCrash = t;
			log(`[crash]  SIGKILL to the run's process group (pid ${pid}) during training: ${t.returned.size} training calls finished, ${t.requested.length - t.returned.size} in flight`);
		}
	} else if (n.type === "stopped") {
		log(`[state]  ${(await r.status()).state}; resuming in place`);
		r = await attach(wf, r.id).resume({ detach: true });
	} else if (n.type === "finished") {
		const o = obj(n.output);
		const inc = obj(o.incumbent);
		log(`[done]   stop_reason ${o.stop_reason} after ${o.iterations} iterations; incumbent ${inc.model_type} at ${inc.score}\n`);
		break;
	} else if (n.type === "failed") {
		log(`[failed] ${JSON.stringify(n.failed, null, 2)}`);
		process.exit(1);
	}
}

// --- The trace, from the log ------------------------------------------------------------

const ev = events(r.id);
const out = new Map(ev.flatMap((e) => (e.type === "returned" ? [[e.id, e.output] as const] : [])));
/** How many times each training call returned: a call that finished before the crash and ran again would return twice. */
const returns = new Map<string, number>();
for (const e of ev) if (e.type === "returned") returns.set(e.id, (returns.get(e.id) ?? 0) + 1);
const pad = (s: string) => s.padEnd(9);
const lastTrain = new Map<string, string>();

for (const e of ev) {
	if (e.type === "sent" && e.to === "outbox:stop_check") log(`  ${pad("question")} to the operator: stop? (${e.body.recommendation})`);
	if (e.type === "sent" && e.to === "wf:") log(`  ${pad("answer")} ${e.body.decision}`);
	if (e.type === "resumed") log(`  ${pad("-- crash")} resumed in place: everything above came from the journal; the training call in flight runs again`);
	if (e.type !== "requested") continue;
	const o = out.get(e.id) ?? {};
	switch (e.name) {
		case "interpreter":
			log(`iteration ${e.input.iteration}`);
			break;
		case "evidenceJudge": {
			const stop = obj(o.stop);
			log(`  ${pad("judge")} ${stop.recommend ? "recommends stopping" : "continue"}`);
			break;
		}
		case "proposer":
			log(`  ${pad("proposal")} ${o.model_type}: ${o.model_name}`);
			break;
		case "trainScript": {
			lastTrain.set(e.scope, String(e.input.scope));
			break;
		}
		case "evaluateScript":
			log(`  ${pad(lastTrain.get(e.scope) ?? "")} score ${Number(o.score).toFixed(2)}`);
			break;
		case "healthScript": {
			const failed = Array.isArray(o.failed_checks) ? o.failed_checks.map((c) => obj(c).check_name).join(", ") : "";
			log(`  ${pad("")} Health ${o.valid ? "valid" : `invalid (${failed})`}`);
			break;
		}
	}
}

const after = trainCalls(r.id);
const redone = [...(beforeCrash?.returned ?? [])].filter((id) => (returns.get(id) ?? 0) > 1);
log(`\ntraining calls: ${after.returned.size}`);
log(`finished before the crash: ${beforeCrash?.returned.size ?? 0}; of those, run again after the resume: ${redone.length}`);
log(`the journal: ${join(root, ".wallis/runs", r.id, "log.jsonl")}`);
