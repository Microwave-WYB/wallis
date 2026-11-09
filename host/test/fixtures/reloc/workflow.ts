// A relocatable program (test/workspace.test.ts): it reads its data
// relative to its real path, like darktable's ../share.

import { command, defineModels, defineSandbox, Type, workflow } from "wallis";

const relocated = command({
	name: "relocated",
	sandbox: defineSandbox({}, { name: "relocated", requires: ["reloc"] }),
	input: Type.Null(),
	output: Type.String(),
	run: ["reloc"],
	parse: (r) => r.stdout.trim(),
});

export default workflow({
	name: "reloc",
	models: defineModels({ default: "fake/default" }),
	agents: [],
	commands: [relocated],
	input: Type.Null(),
	output: Type.Any(),
	run: async (ctx) => ({ out: await ctx.call(relocated, null) }),
});
