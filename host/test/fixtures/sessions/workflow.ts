// Sessions: two calls of one session (the second continues the first's
// dialogue); a call made while the previous one is in flight (it waits);
// a call from a parallel branch (refused); a call after a cancelled one.

import { ask, AgentFailed, defineAgent, defineModels, Refused, Type, workflow } from "wallis";

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
				const first = s.call({ say: "one" });
				const second = s.call({ say: "quiet" });
				return { first: await first, second: await second };
			}
			case "foreign": {
				const branches = await ctx.parallel({ a: () => s.call({ say: "one" }).then(() => "accepted", refusal) });
				return { branch: branches.a, after: await s.call({ say: "one" }) };
			}
			case "cancel": {
				const one = await s.call({ say: "one" });
				const two = await s.call({ say: "two" }).catch(refusal);
				return { one, two, three: await s.call({ say: "quiet" }) };
			}
			case "two": {
				const one = await s.call({ say: "one" });
				const two = await s.call({ say: "two" });
				return { one, two };
			}
		}
	},
});
