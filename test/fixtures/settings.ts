// What a sandbox and an agent declare is what they get: no silent substitutions.
import { agent, Artifact, command, sandbox, Type, workflow } from "wallis";

const lost = agent({ model: "nope", prompt: "x", input: Type.Object({}), output: Type.Object({}) });
export const unknownAlias = workflow({ input: Type.Object({}), output: Type.Object({}), run: async (ctx) => ctx.call(lost, {}) });

const shared = sandbox({ requires: ["sh", "sleep"], volumes: ["env:/opt/env"] });
const setup = command({
	sandbox: shared,
	input: Type.Object({ n: Type.Integer() }),
	output: Type.Object({}),
	run: (i) => ["sh", "-c", 'echo "start $1" >> /opt/env/log; sleep 0.4; echo "end $1" >> /opt/env/log; echo "{}"', "sh", String(i.n)],
});
/** Two commands that write one named volume at once: serialized. */
export const twoSetups = workflow({
	input: Type.Object({}),
	output: Type.Object({}),
	run: async (ctx) => {
		await Promise.all([ctx.call(setup, { n: 1 }), ctx.call(setup, { n: 2 })]);
		return {};
	},
});

const outBox = sandbox({ requires: ["sh", "sleep", "cp"], volumes: ["mine:/out"] });
const writer = agent({
	model: "default",
	prompt: "Write and return the report; run what you are asked.",
	input: Type.Object({ cmd: Type.String() }),
	output: Type.Object({ report: Artifact("text/plain"), said: Type.String() }),
	workspace: { access: "exec", sandbox: outBox, bashTimeout: "1s" },
	turns: 6,
});
/** An author volume at /out, and a bash command over its timeout. */
export const outAndTimeout = workflow({ input: Type.Object({ cmd: Type.String() }), output: Type.Object({ report: Artifact("text/plain"), said: Type.String() }), run: async (ctx, i) => ctx.call(writer, i) });
