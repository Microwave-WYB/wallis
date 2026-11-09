// Test fixture: concurrency. Plain `Promise.all` over single calls (ids are
// taken synchronously, so it is deterministic), three identical calls, and
// multi-step branches in `ctx.map` (each branch has its own counter).

import { defineAgent, defineModels, Type, workflow } from "wallis";

const models = defineModels({ default: "fake/default" });

/** Answers with the id of the call that served it, so tests can see which recorded result came back. */
const echo = defineAgent(
	{ models },
	{ name: "echo", model: "default", prompt: "echo", input: Type.Object({ n: Type.Number() }), output: Type.Object({ n: Type.Number(), by: Type.String() }) },
);

export default workflow({
	name: "concurrent",
	models,
	agents: [echo],
	input: Type.Null(),
	output: Type.Any(),
	run: async (ctx) => {
		const [[a], [b], [c]] = await Promise.all([ctx.call(ctx.session(echo), { n: 1 }), ctx.call(ctx.session(echo), { n: 1 }), ctx.call(ctx.session(echo), { n: 2 })]);
		const steps = await ctx.map([10, 20], async (branch, x) => {
			const [one] = await branch.call(branch.session(echo), { n: x });
			const [two] = await branch.call(branch.session(echo), { n: one.n + 1 });
			return [one.by, two.by];
		});
		return { a: a.by, b: b.by, c: c.by, steps };
	},
});
