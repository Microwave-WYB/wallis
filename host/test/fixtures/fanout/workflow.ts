// Test fixture: parallel branches, a nested workflow with retries, an explicit
// merge call, commands, observations and a budget-limited loop. Run memory is
// local variables; every agent gets what it needs in its input.

import { command, defineAgent, defineModels, defineSandbox, subWorkflow, Type, workflow } from "wallis";

const models = defineModels({ default: "fake/default" });

const box = defineSandbox({}, { name: "box", requires: ["sh"] });

/** The default protocol: input JSON on stdin, output JSON on stdout. */
const train = command({
	name: "train",
	sandbox: box,
	input: Type.Object({ minutes: Type.Number() }),
	output: Type.Object({ budget: Type.Union([Type.Number(), Type.Null()]) }),
	run: ["sh", "-c", "cat >/dev/null; echo '{\"budget\":null}'"],
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

const scout = defineAgent(
	{ models },
	{
		name: "scout",
		model: "default",
		prompt: "scout",
		input: Type.Object({ area: Type.String(), known: Type.Array(Type.String()) }),
		output: Type.Object({ errors: Type.Array(Type.String()) }),
	},
);

const judge = defineAgent(
	{ models },
	{
		name: "judge",
		model: "default",
		prompt: "judge",
		input: Type.Object({ errors: Type.Array(Type.String()) }),
		output: Type.Object({ findings: Type.Array(Finding) }),
		steerable: false,
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
			ctx.observe("attempt", n);
			if ((await ctx.session(attempt).call({ n })).ok) return { attempts: n };
		}
		return { attempts: input.max };
	},
});

export default workflow({
	name: "fanout",
	models,
	agents: [scout, judge, merger, attempt],
	commands: [train],
	budget: { turns: 100, computeMinutes: 5 },
	input: Type.Null(),
	output: Type.Any(),
	run: async (ctx) => {
		// Run memory: plain local variables.
		let errors: string[] = [];
		let findings: { content: string; confidence: number }[] = [];
		const archive: { content: string; confidence: number }[] = [];
		const found = await ctx.parallel({
			a: (c) => c.session(scout).call({ area: "a", known: errors }),
			b: (c) => c.session(scout).call({ area: "b", known: errors }),
		});
		errors = [...new Set([...errors, ...found.a.errors, ...found.b.errors])].sort();
		ctx.observe("errors", errors);
		const verdict = await ctx.session(judge).call({ errors });
		// Merging is ordinary workflow code: an agent call, then plain JS.
		const merged = await ctx.session(merger).call({ current: findings, incoming: verdict.findings, max: 2 });
		findings = merged.items.slice(-2);
		archive.push(...merged.archived);
		const tries = await ctx.call(retry, { max: 3 });
		const trained = await ctx.call(train, { minutes: 5 });
		// The compute budget is spent: this pauses the run until it is raised.
		const again = await ctx.call(train, { minutes: 1 });
		return { errors, verdict, tries, trained, again, findings, archive };
	},
});
