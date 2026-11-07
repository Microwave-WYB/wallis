// A two-node workflow: plan, then write. The body reads the virtual clock
// and seeded randomness, so a replay must reproduce both exactly.

import { append, defineAgent, defineModels, defineState, sum, Type, workflow } from "wallis";
import plannerPrompt from "./planner.md" with { type: "text" };
import writerPrompt from "./writer.md" with { type: "text" };

const models = defineModels({ default: "fake/default", writer: "" });

const state = defineState({
	notes: append(Type.String()),
	words: sum(),
});

const planner = defineAgent(
	{ models, state },
	{
		name: "planner",
		model: "default",
		prompt: plannerPrompt,
		input: Type.Object({ topic: Type.String() }),
		output: Type.Object({ outline: Type.Array(Type.String()), note: Type.String() }),
		view: { fields: ["notes"], maxChars: 2000, maxItems: 10 },
		writes: { notes: "note" },
	},
);

const writer = defineAgent(
	{ models, state },
	{
		name: "writer",
		model: "writer",
		prompt: writerPrompt,
		input: Type.Object({ outline: Type.Array(Type.String()) }),
		output: Type.Object({ text: Type.String(), words: Type.Number() }),
		view: { fields: ["notes", "words"], maxChars: 2000, maxItems: 10 },
		writes: { words: "words" },
	},
);

export default workflow({
	name: "two-node",
	models,
	state,
	agents: [planner, writer],
	input: Type.Object({ topic: Type.String() }),
	output: Type.Object({ text: Type.String(), at: Type.Number(), roll: Type.Number() }),
	run: async (ctx, input) => {
		const plan = await ctx.call(planner, { topic: input.topic });
		const draft = await ctx.call(writer, { outline: plan.outline });
		await ctx.emit("notes", `written at ${new Date().toISOString()}`);
		return { text: draft.text, at: Date.now(), roll: Math.random() };
	},
});
