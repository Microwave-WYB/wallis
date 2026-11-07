// Two nodes, the first of which asks the human a question: it ends its turn
// without submitting, its node goes idle with the question, and an answer
// continues the same dialogue.

import { defineAgent, defineModels, Type, workflow } from "wallis";
import scoutPrompt from "./scout.md" with { type: "text" };
import writerPrompt from "./writer.md" with { type: "text" };

const models = defineModels({ default: "fake/default", writer: "" });

const scout = defineAgent(
	{ models },
	{
		name: "scout",
		model: "default",
		prompt: scoutPrompt,
		input: Type.Object({ topic: Type.String() }),
		output: Type.Object({ outline: Type.Array(Type.String(), { minItems: 1 }), note: Type.String() }),
	},
);

const writer = defineAgent(
	{ models },
	{
		name: "writer",
		model: "writer",
		prompt: writerPrompt,
		input: Type.Object({ outline: Type.Array(Type.String()), note: Type.String() }),
		output: Type.Object({ text: Type.String(), words: Type.Number() }),
	},
);

export default workflow({
	name: "ask",
	models,
	agents: [scout, writer],
	input: Type.Object({ topic: Type.String() }),
	output: Type.Object({ text: Type.String(), at: Type.Number(), roll: Type.Number() }),
	run: async (ctx, input) => {
		const plan = await ctx.call(scout, { topic: input.topic });
		const draft = await ctx.call(writer, { outline: plan.outline, note: plan.note });
		return { text: draft.text, at: Date.now(), roll: Math.random() };
	},
});
