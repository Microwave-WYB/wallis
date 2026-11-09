// A mount the caller must give (no default), and a question, so the run
// idles and is resumed by another host (test/host.test.ts).

import { defineModels, defineMounts, orchestrator, Type, workflow } from "wallis";

const pick = orchestrator({ name: "pick", input: Type.Null(), output: Type.Object({ ok: Type.Boolean() }) });

export default workflow({
	name: "mounted",
	models: defineModels({ default: "fake/default" }),
	mounts: defineMounts({ data: "" }),
	agents: [],
	orchestrators: [pick],
	input: Type.Null(),
	output: Type.Any(),
	run: async (ctx) => ctx.call(pick, null),
});
