// Patterns beyond the template's loop: fan-out with a judge, parallel
// scoring, cross-model review. Orchestration is plain TS. Memory is local variables; every agent gets
// what it needs pushed into its input and never reads anything else.

import Type from "typebox";
import { type Models, runAgent } from "../template/lib/agent.ts";

const Idea = Type.Object({ title: Type.String(), rationale: Type.String() });
const Verdict = Type.Object({ best: Type.Integer({ minimum: 0 }), why: Type.String() });

/** Fan-out with Promise.all (each call is independent), then a judge sees all answers. */
export async function fanOutThenJudge(models: Models, question: string, workers: string[], judge: string) {
	const ideas = await Promise.all(
		workers.map((model) => runAgent(models, { model, system: "Propose one idea for the question.", output: Idea }, { question })),
	);
	const verdict = await runAgent(models, { model: judge, system: "Pick the best idea by index.", output: Verdict }, { question, ideas });
	return { ideas, chosen: ideas[verdict.best], verdict };
}

const Patch = Type.Object({ code: Type.String() });
const Check = Type.Object({ ok: Type.Boolean(), problems: Type.Array(Type.String()) });

const Score = Type.Object({ score: Type.Number({ minimum: 0, maximum: 10 }), reason: Type.String() });

/** Parallel scoring: one scorer call per candidate, concurrently; sort in code. */
export async function scoreAll(models: Models, candidates: string[], scorer: string) {
	const scores = await Promise.all(
		candidates.map((candidate) => runAgent(models, { model: scorer, system: "Score the candidate from 0 to 10.", output: Score }, { candidate })),
	);
	return candidates.map((candidate, i) => ({ candidate, ...scores[i]! })).sort((a, b) => b.score - a.score);
}

/** Cross-model review: the author and the reviewer are different models; disagreement goes back once. */
export async function crossReview(models: Models, task: string, author: string, reviewer: string) {
	const draft = await runAgent(models, { model: author, system: "Write the answer.", output: Patch }, { task });
	const review = await runAgent(models, { model: reviewer, system: "Review the answer; list problems.", output: Check }, { task, answer: draft.code });
	if (review.ok) return { answer: draft.code, review };
	const revised = await runAgent(models, { model: author, system: "Revise the answer to fix the problems.", output: Patch }, { task, answer: draft.code, problems: review.problems });
	return { answer: revised.code, review };
}
