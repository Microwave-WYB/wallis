// Two nodes, the first of which asks a question with its `ask` tool: its
// node goes idle with the question, and the reply becomes the tool's result
// in the same dialogue.

import { ask, defineAgent, defineModels, Type, workflow } from "wallis";
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
		tools: [ask],
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
		const plan = await ctx.call(ctx.session(scout), { topic: input.topic });
		const draft = await ctx.call(ctx.session(writer), { outline: plan.outline, note: plan.note });
		return { text: draft.text, at: Date.now(), roll: Math.random() };
	},
});
