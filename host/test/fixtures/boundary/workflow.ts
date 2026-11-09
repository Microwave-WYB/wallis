// Test fixture: every schema boundary. `input.mode` picks the case.

import { AgentFailed, Artifact, CommandFailed, command, defineAgent, defineModels, defineSandbox, failureText, SchemaError, Type, workflow } from "wallis";

const models = defineModels({ default: "fake/default" });

const box = defineSandbox({}, { name: "box", requires: ["sh"] });

const measure = command({
	name: "measure",
	sandbox: box,
	input: Type.Object({ n: Type.Number() }),
	output: Type.Object({ score: Type.Number() }),
	run: ["sh", "-c", "cat"],
});

const tagger = defineAgent(
	{ models },
	{
		name: "tagger",
		model: "default",
		prompt: "tag",
		input: Type.Null(),
		output: Type.Object({ tags: Type.Array(Type.String({ maxLength: 4 })) }),
	},
);

/** Submits an artifact ref; the host verifies it against the run's store. */
const reporter = defineAgent(
	{ models },
	{ name: "reporter", model: "default", prompt: "report", input: Type.Null(), output: Type.Object({ report: Artifact("text/markdown") }) },
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
	if (error instanceof CommandFailed) return { error: "CommandFailed", command: error.command, failure: error.failure.type, message: failureText(error.failure) };
	if (error instanceof AgentFailed) return { error: "AgentFailed", agent: error.agent, failure: error.failure.type, message: failureText(error.failure) };
	throw error;
}

export default workflow({
	name: "boundary",
	models,
	agents: [tagger, strict, reporter],
	commands: [measure],
	input: Type.Object({ mode: Type.String() }),
	output: Type.Any(),
	run: async (ctx, input) => {
		try {
			switch (input.mode) {
				case "command":
					return await ctx.call(measure, { n: 1 });
				case "command_bad_input":
					return await ctx.call(measure, { n: "one" } as never);
				case "report":
					return (await ctx.call(ctx.session(reporter), null))[0];
				case "agent":
					return (await ctx.call(ctx.session(tagger), null))[0];
				case "submit":
					return (await ctx.call(ctx.session(strict), null))[0];
			}
		} catch (error) {
			return caught(error);
		}
		return null;
	},
});
