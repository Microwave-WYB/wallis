// Compile-time checks of the SDK's typing. `tsc --noEmit` fails if any
// `@ts-expect-error` line stops being an error.

import { append, defineAgent, defineMcp, defineModels, defineState, sum, Type, workflow } from "wallis";

const models = defineModels({ default: "p/m", judge: "" });
const mcp = defineMcp({ mcpServers: { arxiv: { command: "uvx", args: ["arxiv-mcp-server==0.2.10"] } } });
const state = defineState({ notes: append(Type.String()), total: sum() });

const ok = defineAgent(
	{ models, state, mcp },
	{
		name: "ok",
		model: "judge",
		prompt: "p",
		input: Type.Object({ q: Type.String() }),
		output: Type.Object({ answer: Type.String(), n: Type.Number() }),
		view: { fields: ["notes"], maxChars: 100, maxItems: 4 },
		writes: { notes: "answer", total: { emit: true } },
		mcp: { arxiv: ["search"] },
	},
);

// @ts-expect-error: model must be an alias in the table
defineAgent({ models }, { name: "x", model: "nope", prompt: "", input: Type.Null(), output: Type.Null() });

// @ts-expect-error: MCP server must exist in mcp.json
defineAgent({ models, mcp }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), mcp: { scholar: "*" } });

// @ts-expect-error: view fields must be state fields
defineAgent({ models, state }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), view: { fields: ["ghost"], maxChars: 1, maxItems: 1 } });

defineAgent(
	{ models, state },
	// @ts-expect-error: a write source must be an output key
	{ name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Object({ a: Type.String() }), writes: { notes: "b" } },
);

export default workflow({
	name: "types",
	models,
	state,
	agents: [ok],
	input: Type.Null(),
	output: Type.Number(),
	run: async (ctx) => {
		const out = await ctx.call(ok, { q: "?" });
		const answer: string = out.answer;
		// @ts-expect-error: call input is typed by the agent's input schema
		await ctx.call(ok, { q: 1 });
		// @ts-expect-error: outputs are typed too
		const wrong: number = out.answer;
		await ctx.emit("total", 3);
		// @ts-expect-error: emit is typed by the field's reducer
		await ctx.emit("total", "three");
		// @ts-expect-error: unknown field
		await ctx.emit("ghost", 1);
		void answer;
		void wrong;
		return out.n;
	},
});
