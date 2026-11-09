// Tool names (test/names.test.ts). The body calls two exports that share a
// name (`dup`): each call reaches its own export. Each variant gives its
// agent tools whose name is taken, so it is refused before it runs.

import { type AgentDef, defineAgent, defineModels, defineSandbox, toolset, Type, workflow } from "wallis";

const models = defineModels({ default: "faux/faux-1" });
const box = defineSandbox({}, { name: "names-tools", requires: ["node"] });
export const lib = toolset<typeof import("./tools/lib.ts")>("./tools/lib.ts", { sandbox: box });
export const other = toolset<typeof import("./tools/other.ts")>("./tools/other.ts", { sandbox: box });

export const agent = (name: string, tools: Parameters<typeof defineAgent>[1]["tools"]) =>
	defineAgent({ models }, { name, model: "default", prompt: "Answer.", input: Type.Null(), output: Type.Null(), tools });

const Which = Type.Object({ which: Type.String() });

export const names = (agents: readonly AgentDef[]) =>
	workflow({
		name: "names",
		models,
		toolsets: [lib, other],
		agents,
		input: Type.Null(),
		output: Type.Any(),
		run: async (ctx) => ({ first: (await ctx.call(lib.first, {}, Which)).which, second: (await ctx.call(lib.second, {}, Which)).which }),
	});
