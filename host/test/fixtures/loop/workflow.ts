// ctx.loop (test/loop.test.ts): the colorist pattern. Each iteration calls
// the session the previous one left; the loop ends approved once the look is
// warm enough, or abandoned after `max` rounds. The state (the session and
// the round) stays inside; only the ending is the output.

import { defineAgent, defineModels, done, next, Type, workflow } from "wallis";

const models = defineModels({ default: "fake/default" });
const colorist = defineAgent(
	{ models },
	{
		name: "colorist",
		model: "default",
		prompt: "Grade the sheet; take the feedback into account.",
		input: Type.Object({ round: Type.Integer(), feedback: Type.Union([Type.String(), Type.Null()]) }),
		output: Type.Object({ look: Type.String(), warmth: Type.Integer() }),
	},
);

export default workflow({
	name: "loop",
	models,
	agents: [colorist],
	input: Type.Object({ max: Type.Integer() }),
	output: Type.Any(),
	run: async (ctx, input) =>
		ctx.loop({ session: ctx.session(colorist), round: 0, feedback: null as string | null }, async (c, state) => {
			const [look, session] = await c.call(state.session, { round: state.round, feedback: state.feedback });
			if (look.warmth <= 1) return done({ ending: "approved" as const, look: look.look, rounds: state.round + 1 });
			if (state.round + 1 >= input.max) return done({ ending: "abandoned" as const, rounds: state.round + 1 });
			return next({ session, round: state.round + 1, feedback: `too warm (${look.warmth})` });
		}),
});
