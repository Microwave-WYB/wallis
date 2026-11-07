// Patterns beyond the template's loop: fan-out with a judge, parallel
// scoring, cross-model review. Orchestration is plain TS over `runAgent`
// (any SDK behind lib/agent.ts). Memory is local variables; every agent gets
// what it needs pushed into its input and never reads anything else.

import Type from "typebox";
import { runAgent, submitted } from "../template/lib/agent.ts";

const Idea = Type.Object({ title: Type.String(), rationale: Type.String() });
const Verdict = Type.Object({ best: Type.Integer({ minimum: 0 }), why: Type.String() });

/** Fan-out with Promise.all (each call is independent), then a judge sees all answers. */
export async function fanOutThenJudge(question: string, workers: string[], judge: string) {
	const ideas = await Promise.all(workers.map(async (model) => submitted(await runAgent({ model, system: "Propose one idea for the question.", output: Idea }, { question }))));
	const verdict = submitted(await runAgent({ model: judge, system: "Pick the best idea by index.", output: Verdict }, { question, ideas }));
	return { ideas, chosen: ideas[verdict.best], verdict };
}

const Score = Type.Object({ score: Type.Number({ minimum: 0, maximum: 10 }), reason: Type.String() });

/** Parallel scoring: one scorer call per candidate, concurrently; sort in code. */
export async function scoreAll(candidates: string[], scorer: string) {
	const scores = await Promise.all(candidates.map(async (candidate) => submitted(await runAgent({ model: scorer, system: "Score the candidate from 0 to 10.", output: Score }, { candidate }))));
	return candidates.map((candidate, i) => ({ candidate, ...scores[i]! })).sort((a, b) => b.score - a.score);
}

const Answer = Type.Object({ code: Type.String() });
const Check = Type.Object({ ok: Type.Boolean(), problems: Type.Array(Type.String()) });

/** Cross-model review: the author and the reviewer are different models; problems go back once. */
export async function crossReview(task: string, author: string, reviewer: string) {
	const draft = submitted(await runAgent({ model: author, system: "Write the answer.", output: Answer }, { task }));
	const review = submitted(await runAgent({ model: reviewer, system: "Review the answer; list problems.", output: Check }, { task, answer: draft.code }));
	if (review.ok) return { answer: draft.code, review };
	const revised = submitted(await runAgent({ model: author, system: "Revise the answer to fix the problems.", output: Answer }, { task, answer: draft.code, problems: review.problems }));
	return { answer: revised.code, review };
}
