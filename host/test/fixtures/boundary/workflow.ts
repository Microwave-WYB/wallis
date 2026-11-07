// Test fixture: every schema boundary. `input.mode` picks the case.

import { AgentFailed, append, defineAgent, defineModels, defineScript, defineState, SchemaError, ScriptFailed, Type, union, workflow } from "wallis";

const models = defineModels({ default: "fake/default" });

const state = defineState({
	scores: append(Type.Number()),
	tags: union(Type.String({ maxLength: 4 })),
});

const measure = defineScript({
	name: "measure",
	input: Type.Object({ n: Type.Number() }),
	output: Type.Object({ score: Type.Number() }),
});

const tagger = defineAgent(
	{ models, state },
	{
		name: "tagger",
		model: "default",
		prompt: "tag",
		input: Type.Null(),
		output: Type.Object({ tags: Type.Array(Type.String()) }),
		writes: { tags: "tags", scores: { emit: true } },
	},
);

const strict = defineAgent(
	{ models },
	{
		name: "strict",
		model: "default",
		prompt: "answer",
		input: Type.Null(),
		output: Type.Object({ answer: Type.Integer({ minimum: 1 }) }),
		maxTurns: 4,
	},
);

function caught(error: unknown) {
	if (error instanceof SchemaError) return { error: "SchemaError", subject: error.subject };
	if (error instanceof ScriptFailed) return { error: "ScriptFailed", script: error.script, message: error.error };
	if (error instanceof AgentFailed) return { error: "AgentFailed", agent: error.agent, message: error.error };
	throw error;
}

export default workflow({
	name: "boundary",
	models,
	state,
	agents: [tagger, strict],
	scripts: [measure],
	input: Type.Object({ mode: Type.String() }),
	output: Type.Any(),
	run: async (ctx, input) => {
		try {
			switch (input.mode) {
				case "script":
					return await ctx.script(measure, { n: 1 });
				case "script_bad_args":
					return await ctx.script(measure, { n: "one" } as never);
				case "emit_bad":
					return await ctx.emit("scores", "high" as never);
				case "agent":
					return await ctx.call(tagger, null);
				case "submit":
					return await ctx.call(strict, null);
			}
		} catch (error) {
			return caught(error);
		}
		return null;
	},
});
