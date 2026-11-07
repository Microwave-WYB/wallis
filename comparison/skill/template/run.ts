// A minimal research loop: a proposer suggests a config, the Python
// harness evaluates it in a sandbox, a critic reads the history and says
// what to try next. Memory is local variables, pushed into each agent's
// input. Every step writes a file in work/ and is skipped when it exists,
// and agents save their session: re-running is the resume. No agent SDK is
// imported here: lib/agent.ts is the only seam.
//
//   node run.ts            (provider credentials from the usual env vars)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Type, { type Static } from "typebox";
import { runAgent, submitted } from "./lib/agent.ts";
import { python } from "./lib/sandbox.ts";
import { step } from "./lib/steps.ts";

const prompt = (name: string) => readFileSync(new URL(`prompts/${name}.md`, import.meta.url), "utf8");
const harness = fileURLToPath(new URL("harness", import.meta.url));

const Config = Type.Object({ lr: Type.Number({ exclusiveMinimum: 0, maximum: 1 }), epochs: Type.Integer({ minimum: 1, maximum: 100 }) });
const Result = Type.Object({ score: Type.Number() });
const Review = Type.Object({ advice: Type.String(), stop: Type.Boolean() });
type Trial = Static<typeof Config> & Static<typeof Result>;

export interface Options {
	readonly task: string;
	readonly iterations: number;
	readonly proposer: string;
	readonly critic: string;
}

export async function main(o: Options) {
	const history: Trial[] = [];
	let advice = "";
	for (let i = 0; i < o.iterations; i++) {
		const dir = `work/iter-${i}`;
		const config = await step(`${dir}/config.json`, async () =>
			submitted(await runAgent({ model: o.proposer, system: prompt("propose"), output: Config, session: `${dir}/propose.session.json`, maxTurns: 6 }, { task: o.task, history, advice })),
		);
		const result = await step(`${dir}/result.json`, () => python<Static<typeof Result>>(harness, "evaluate.py", `${dir}/eval`, config));
		history.push({ ...config, ...result });
		const review = await step(`${dir}/review.json`, async () =>
			submitted(await runAgent({ model: o.critic, system: prompt("critique"), output: Review, session: `${dir}/critique.session.json`, maxTurns: 4 }, { task: o.task, history })),
		);
		advice = review.advice;
		if (review.stop) break;
	}
	const best = history.reduce((a, b) => (b.score > a.score ? b : a));
	return { best, history };
}

if (import.meta.main) {
	const out = await main({
		task: "Tune the learning rate and epochs of the toy model in harness/evaluate.py.",
		iterations: 5,
		proposer: "anthropic/claude-sonnet-5-5",
		critic: "openai/gpt-5.6",
	});
	console.log(JSON.stringify(out.best));
}
