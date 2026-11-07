// Test fixture: parallel branches, a sub-workflow with retries, an explicit merge call,
// a script, a capped read, and a budget-limited loop.

import { append, defineAgent, defineModels, defineScript, defineState, lastN, replace, subWorkflow, Type, union, view, workflow } from "wallis";

const models = defineModels({ default: "fake/default" });

const train = defineScript({
	name: "train",
	input: Type.Object({ minutes: Type.Number() }),
	output: Type.Object({ budget: Type.Union([Type.Number(), Type.Null()]) }),
});

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
	findings: replace(Type.Array(Finding), []),
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
	scripts: [train],
	budget: { usd: 1, computeMinutes: 5 },
	input: Type.Null(),
	output: Type.Any(),
	run: async (ctx) => {
		const found = await ctx.parallel({
			a: (c) => c.call(scout, { area: "a" }),
			b: (c) => c.call(scout, { area: "b" }),
		});
		const verdict = await ctx.call(judge, { seen: found.a.errors.length + found.b.errors.length });
		// Merging is ordinary workflow code: an agent call, then `replace`.
		const current = (await ctx.read(view(state, { fields: ["findings"], maxChars: 4000, maxItems: 50 }))).data.findings ?? [];
		const merged = await ctx.call(merger, { current, incoming: verdict.findings, max: 2 });
		await ctx.emit("findings", lastN(merged.items, 2));
		for (const item of merged.archived) await ctx.emit("archive", item);
		const tries = await ctx.sub(retry, { max: 3 });
		const trained = await ctx.script(train, { minutes: 5 });
		// The compute budget is spent: this pauses the run until it is raised.
		const again = await ctx.script(train, { minutes: 1 });
		const seen = await ctx.read(view(state, { fields: ["findings", "archive"], maxChars: 1000, maxItems: 10 }));
		return { verdict, tries, trained, again, findings: seen.data.findings, archive: seen.data.archive };
	},
});
