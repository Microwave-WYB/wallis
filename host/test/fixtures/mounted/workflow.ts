// A bind volume whose default host dir does not exist, so the caller must
// give one, and a question, so the run idles and is resumed by another host
// (test/host.test.ts).

import { command, defineModels, defineSandbox, orchestrator, Type, workflow } from "wallis";

const pick = orchestrator({ name: "pick", input: Type.Null(), output: Type.Object({ ok: Type.Boolean() }) });
const data = defineSandbox({}, { name: "data", requires: ["ls"], volumes: ["./not-here:/data:ro"] });
const list = command({ name: "list", sandbox: data, input: Type.Null(), output: Type.Any(), run: ["ls", "/data"] });

export default workflow({
	name: "mounted",
	models: defineModels({ default: "fake/default" }),
	agents: [],
	commands: [list],
	orchestrators: [pick],
	input: Type.Null(),
	output: Type.Any(),
	run: async (ctx) => ctx.call(pick, null),
});
