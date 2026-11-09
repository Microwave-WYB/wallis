// Sessions as values: a call of the session value the first call answered
// with (it continues that dialogue); the same value called again, in this
// ctx and in parallel ones (branches); a call after a cancelled one.

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
	input: Type.Object({ mode: Type.Union([Type.Literal("two"), Type.Literal("branch"), Type.Literal("cancel")]) }),
	output: Type.Any(),
	run: async (ctx, input) => {
		const refusal = (e: unknown) => (e instanceof Refused ? e.refusal.type : e instanceof AgentFailed ? e.failure.type : String(e));
		// Each call answers with the session after it; the value called is unchanged.
		const [one, s1] = await ctx.call(ctx.session(chat), { say: "one" });
		switch (input.mode) {
			case "branch": {
				// The same value, called again: branches from one dialogue, in this ctx and in parallel ones.
				const [[here], [there], [other]] = await Promise.all([
					ctx.call(s1, { say: "quiet" }),
					ctx.parallel({ x: (b) => b.call(s1, { say: "quiet" }) }).then((r) => r.x),
					ctx.map([0], (b) => b.call(s1, { say: "quiet" })).then((r) => r[0]!),
				]);
				return { one, here, there, other };
			}
			case "cancel": {
				const two = await ctx.call(s1, { say: "two" }).then(([out]) => out, refusal);
				// A cancelled call answers with no session: the next call is of s1 again.
				const [three] = await ctx.call(s1, { say: "quiet" });
				return { one, two, three };
			}
			case "two": {
				const [two] = await ctx.call(s1, { say: "two" });
				return { one, two };
			}
		}
	},
});
