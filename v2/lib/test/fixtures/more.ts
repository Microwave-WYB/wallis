// An MCP server as tools (for a body and for an agent), ctx.loop, and an agent that returns a file
// from its workspace as an Artifact.

import { agent, Artifact, command, mcp, sandbox, Type, workflow } from "wallis";

const servers = mcp({ mcpServers: { probe: { command: "node", args: ["/srv/mcp-server.mjs"] } } }, { probe: { sandbox: sandbox({ requires: ["node"], volumes: ["./srv:/srv:ro"] }) } });

const shouter = agent({
	model: "default",
	prompt: "Shout the text with the tool, then submit what it returned.",
	input: Type.Object({ text: Type.String() }),
	output: Type.Object({ loud: Type.String() }),
	// An index signature: with noUncheckedIndexedAccess a tool needs `!`.
	tools: [servers.probe.shout!],
	turns: 4,
});

export const withMcp = workflow({
	input: Type.Object({ text: Type.String() }),
	output: Type.Object({ words: Type.Integer(), loud: Type.String() }),
	run: async (ctx, { text }) => {
		const counted = (await ctx.call(servers.probe.count!, { text })) as { words: number };
		const { loud } = await ctx.call(shouter, { text });
		return { words: counted.words, loud };
	},
});

const box = sandbox({ requires: ["sh"] });
const inc = command({
	sandbox: box,
	input: Type.Object({ n: Type.Integer() }),
	output: Type.Object({ n: Type.Integer() }),
	run: (i) => ["sh", "-c", 'printf \'{"n": %d}\' $(( $1 + 1 ))', "sh", String(i.n)],
});
const one = command({ sandbox: box, input: Type.Object({}), output: Type.Object({ one: Type.Integer() }), run: () => ["sh", "-c", 'printf \'{"one": 1}\''] });

export const counting = workflow({
	input: Type.Object({ until: Type.Integer() }),
	output: Type.Object({ n: Type.Integer(), steps: Type.Integer() }),
	run: async (ctx, { until }) =>
		// Explicit type arguments: TS widens a union of `{ done }` and `{ next }` literals with `undefined` members.
		ctx.loop<{ n: number; steps: number }, { n: number; steps: number }>({ n: 0, steps: 0 }, async (c, s) => {
			// The same call in every iteration: each iteration is a branch, so each is its own call.
			const { one: step } = await c.call(one, {});
			const { n } = await c.call(inc, { n: s.n });
			return n >= until ? { done: { n, steps: s.steps + step } } : { next: { n, steps: s.steps + step } };
		}),
});

const writer = agent({
	model: "default",
	prompt: "Write the report file in your workspace and return it.",
	input: Type.Object({ topic: Type.String() }),
	output: Type.Object({ report: Artifact("text/markdown") }),
	turns: 4,
});

export const writing = workflow({
	input: Type.Object({ topic: Type.String() }),
	output: Type.Object({ report: Artifact("text/markdown") }),
	run: async (ctx, i) => ctx.call(writer, i),
});
