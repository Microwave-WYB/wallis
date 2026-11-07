// Test fixture: parallel branches, a sub-workflow with retries, llmMerge,
// a script, a capped read, and a budget-limited loop.

import { defineAgent, defineModels, defineState, llmMerge, append, Refused, subWorkflow, union, Type, view, workflow } from "wallis";

const models = defineModels({ default: "fake/default" });

const Finding = Type.Object({ content: Type.String(), confidence: Type.Number() });

const merger = defineAgent(
	{ models },
	{
		name: "merger",
		model: "default",
		prompt: "merge",
		input: Type.Object({ current: Type.Array(Finding), incoming: Type.Array(Finding), max: Type.Number() }),
		output: Type.Object({ items: Type.Array(Finding), archived: Type.Array(Finding) }),
	},
);

const state = defineState({
	errors: union(Type.String()),
	findings: llmMerge({ agent: merger, max: 2, maxCalls: 1, archive: "archive" }, Finding),
	archive: append(Finding),
	log: append(Type.String()),
});

const scout = defineAgent(
	{ models, state },
	{
		name: "scout",
		model: "default",
		prompt: "scout",
		input: Type.Object({ area: Type.String() }),
		output: Type.Object({ errors: Type.Array(Type.String()) }),
		view: { fields: ["errors"], maxChars: 1000, maxItems: 10 },
		writes: { errors: "errors" },
	},
);

const judge = defineAgent(
	{ models, state },
	{
		name: "judge",
		model: "default",
		prompt: "judge",
		input: Type.Object({ seen: Type.Number() }),
		output: Type.Object({ findings: Type.Array(Finding) }),
		view: { fields: ["errors", "findings"], maxChars: 400, maxItems: 4, omit: ["confidence"] },
		writes: { findings: "findings" },
	},
);

const attempt = defineAgent(
	{ models },
	{ name: "attempt", model: "default", prompt: "try", input: Type.Object({ n: Type.Number() }), output: Type.Object({ ok: Type.Boolean() }) },
);

const retry = subWorkflow({
	name: "retry",
	input: Type.Object({ max: Type.Number() }),
	output: Type.Object({ attempts: Type.Number() }),
	run: async (ctx, input) => {
		for (let n = 1; n <= input.max; n++) {
			if ((await ctx.call(attempt, { n })).ok) return { attempts: n };
		}
		return { attempts: input.max };
	},
});

export default workflow({
	name: "fanout",
	models,
	state,
	agents: [scout, judge, merger, attempt],
	scripts: ["train"],
	budget: { usd: 1, computeMinutes: 5 },
	input: Type.Null(),
	output: Type.Any(),
	run: async (ctx) => {
		const found = await ctx.parallel({
			a: (c) => c.call(scout, { area: "a" }),
			b: (c) => c.call(scout, { area: "b" }),
		});
		const verdict = await ctx.call(judge, { seen: found.a.errors.length + found.b.errors.length });
		const tries = await ctx.sub(retry, { max: 3 });
		const trained = await ctx.script("train", { minutes: 5 });
		let refused = "";
		try {
			await ctx.script("train", { minutes: 1 });
		} catch (e) {
			if (e instanceof Refused) refused = e.message;
		}
		const seen = await ctx.read(view(state, { fields: ["findings", "archive"], maxChars: 1000, maxItems: 10 }));
		return { verdict, tries, trained, refused, findings: seen.data.findings, archive: seen.data.archive };
	},
});
