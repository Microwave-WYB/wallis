// Test fixture for the pi executor: an agent with filesystem tools, so it
// works through codemode.

import { defineAgent, defineModels, defineState, replace, Type, workflow } from "wallis";

const models = defineModels({ default: "faux/faux-1" });
const state = defineState({ note: replace(Type.String(), "state note") });

const reader = defineAgent(
	{ models, state },
	{
		name: "reader",
		model: "default",
		prompt: "Read your view and summarize it.",
		input: Type.Object({ topic: Type.String() }),
		output: Type.Object({ summary: Type.String({ minLength: 1 }) }),
		view: { fields: ["note"], maxChars: 1000, maxItems: 10 },
		sandbox: "read-only",
	},
);

export default workflow({
	name: "pi-fixture",
	models,
	state,
	agents: [reader],
	input: Type.Object({ topic: Type.String() }),
	output: Type.Any(),
	run: async (ctx, input) => ctx.call(reader, { topic: input.topic }),
});
