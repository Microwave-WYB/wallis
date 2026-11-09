// Test fixture for the pi executor: an agent with filesystem tools and a
// foldable input, so it works through codemode and reads its full input
// there.

import { defineAgent, defineModels, defineSandbox, Foldable, Type, workflow } from "wallis";

const models = defineModels({ default: "faux/faux-1" });
const shell = defineSandbox({}, { name: "shell", requires: ["bash"] });

const reader = defineAgent(
	{ models },
	{
		name: "reader",
		model: "default",
		prompt: "Read your input and summarize it.",
		input: Type.Object({ topic: Type.String(), notes: Foldable(Type.Array(Type.String()), { maxChars: 40 }) }),
		output: Type.Object({ summary: Type.String({ minLength: 1 }) }),
		workspace: { access: "exec", sandbox: shell },
	},
);

export default workflow({
	name: "pi-fixture",
	models,
	agents: [reader],
	input: Type.Object({ topic: Type.String(), notes: Type.Array(Type.String()) }),
	output: Type.Any(),
	run: async (ctx, input) => (await ctx.call(ctx.session(reader), input))[0],
});
