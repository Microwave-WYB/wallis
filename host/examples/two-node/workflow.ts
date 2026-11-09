// A two-node workflow: plan, then write. The body reads the virtual clock
// and seeded randomness, so a replay must reproduce both exactly. Its
// memory is its own local variables; the writer gets what it needs in its
// input.

import { defineAgent, defineModels, Type, workflow } from "wallis";
import plannerPrompt from "./planner.md" with { type: "text" };
import writerPrompt from "./writer.md" with { type: "text" };

const models = defineModels({ default: "fake/default", writer: "" });

const planner = defineAgent(
	{ models },
	{
		name: "planner",
		model: "default",
		prompt: plannerPrompt,
		input: Type.Object({ topic: Type.String() }),
		output: Type.Object({ outline: Type.Array(Type.String()), note: Type.String() }),
	},
);

const writer = defineAgent(
	{ models },
	{
		name: "writer",
		model: "writer",
		prompt: writerPrompt,
		input: Type.Object({ outline: Type.Array(Type.String()), notes: Type.Array(Type.String()) }),
		output: Type.Object({ text: Type.String(), words: Type.Number() }),
	},
);

export default workflow({
	name: "two-node",
	models,
	agents: [planner, writer],
	input: Type.Object({ topic: Type.String() }),
	output: Type.Object({ text: Type.String(), note: Type.String(), at: Type.Number(), roll: Type.Number() }),
	run: async (ctx, input) => {
		const plan = await ctx.call(ctx.session(planner), { topic: input.topic });
		ctx.observe("outline", plan.outline);
		const draft = await ctx.call(ctx.session(writer), { outline: plan.outline, notes: [plan.note] });
		ctx.observe("words", draft.words);
		return { text: draft.text, note: plan.note, at: Date.now(), roll: Math.random() };
	},
});
