// Sessions: two calls of one session (the second continues the first's
// dialogue); a call made while the previous one is in flight (it waits);
// a call from a parallel branch (refused); a call after a cancelled one.

import { ask, AgentFailed, defineAgent, defineModels, Refused, type Session, Type, workflow } from "wallis";

const models = defineModels({ default: "faux/faux-1" });
const chat = defineAgent(
	{ models },
	{
		name: "chat",
		model: "default",
		prompt: "Say how many inputs you have heard in this conversation.",
		input: Type.Object({ say: Type.String() }),
		output: Type.Object({ heard: Type.Integer(), saw_ask: Type.Boolean(), reply: Type.String() }),
		tools: [ask],
	},
);

export default workflow({
	name: "sessions",
	models,
	agents: [chat],
	input: Type.Object({ mode: Type.Union([Type.Literal("two"), Type.Literal("queued"), Type.Literal("foreign"), Type.Literal("cancel")]) }),
	output: Type.Any(),
	run: async (ctx, input) => {
		const s = ctx.session(chat);
		const refusal = (e: unknown) => (e instanceof Refused ? e.refusal.type : e instanceof AgentFailed ? e.failure.type : String(e));
		switch (input.mode) {
			case "queued": {
				// Made before the first returned: it waits for it, in the order the calls were made.
				const first = ctx.call(s, { say: "one" });
				const second = ctx.call(s, { say: "quiet" });
				return { first: await first, second: await second };
			}
			case "foreign": {
				// Only the ctx that made a session calls it: not a branch it started, not a sibling branch.
				let made: Session | undefined;
				const branches = await ctx.parallel({
					a: (b) => b.call(s, { say: "one" }).then(() => "accepted", refusal),
					x: async (b) => {
						made = b.session(chat);
						return "made";
					},
					y: (b) => (made === undefined ? Promise.resolve("not made") : b.call(made, { say: "one" }).then(() => "accepted", refusal)),
				});
				return { branch: branches.a, sibling: branches.y, after: await ctx.call(s, { say: "one" }) };
			}
			case "cancel": {
				const one = await ctx.call(s, { say: "one" });
				const two = await ctx.call(s, { say: "two" }).catch(refusal);
				return { one, two, three: await ctx.call(s, { say: "quiet" }) };
			}
			case "two": {
				const one = await ctx.call(s, { say: "one" });
				const two = await ctx.call(s, { say: "two" });
				return { one, two };
			}
		}
	},
});
