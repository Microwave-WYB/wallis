// Sessions: two calls of one session (the second continues the first's
// dialogue), and a second call while the first is in flight.

import { defineAgent, defineModels, Refused, Type, workflow } from "wallis";

const models = defineModels({ default: "faux/faux-1" });
const chat = defineAgent(
	{ models },
	{
		name: "chat",
		model: "default",
		prompt: "Say how many inputs you have heard in this conversation.",
		input: Type.Object({ say: Type.String() }),
		output: Type.Object({ heard: Type.Integer(), saw_ask: Type.Boolean(), reply: Type.String() }),
	},
);

export default workflow({
	name: "sessions",
	models,
	agents: [chat],
	input: Type.Object({ mode: Type.Union([Type.Literal("two"), Type.Literal("busy")]) }),
	output: Type.Any(),
	run: async (ctx, input) => {
		const s = ctx.session(chat);
		if (input.mode === "busy") {
			const first = s.call({ say: "one" });
			const second = await s.call({ say: "two" }).then(
				() => "accepted",
				(e: unknown) => (e instanceof Refused ? e.refusal.type : String(e)),
			);
			await first;
			return { second };
		}
		const one = await s.call({ say: "one" });
		const two = await s.call({ say: "two" });
		return { one, two };
	},
});
