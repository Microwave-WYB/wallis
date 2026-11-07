// Two nodes, the first of which asks the human a question: it ends its turn
// without submitting, its node goes idle with the question, and a `send`
// continues the same conversation.

import { append, defineAgent, defineModels, defineState, sum, Type, workflow } from "wallis";
import scoutPrompt from "./scout.md" with { type: "text" };
import writerPrompt from "./writer.md" with { type: "text" };

const models = defineModels({ default: "fake/default", writer: "" });

const state = defineState({
	notes: append(Type.String()),
	words: sum(),
});

const scout = defineAgent(
	{ models, state },
	{
		name: "scout",
		model: "default",
		prompt: scoutPrompt,
		input: Type.Object({ topic: Type.String() }),
		output: Type.Object({ outline: Type.Array(Type.String(), { minItems: 1 }), note: Type.String() }),
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
	name: "ask",
	models,
	state,
	agents: [scout, writer],
	input: Type.Object({ topic: Type.String() }),
	output: Type.Object({ text: Type.String(), at: Type.Number(), roll: Type.Number() }),
	run: async (ctx, input) => {
		const plan = await ctx.call(scout, { topic: input.topic });
		const draft = await ctx.call(writer, { outline: plan.outline });
		return { text: draft.text, at: Date.now(), roll: Math.random() };
	},
});
