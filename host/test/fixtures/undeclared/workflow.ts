// A nested workflow (its ctx is untyped) calls values the workflow does not
// declare, some under a declared node's name: each is `Refused` at run time
// (test/identity.test.ts), never run as the declared node.

import { command, type Ctx, defineAgent, defineModels, defineSandbox, orchestrator, Refused, subWorkflow, toolset, Type, workflow } from "wallis";

const models = defineModels({ default: "fake/default" });
const box = defineSandbox({}, { name: "box", requires: ["sh"] });
const echo = command({ name: "echo", sandbox: box, input: Type.Null(), output: Type.Any(), run: ["sh", "-c", "cat"] });
const other = command({ name: "echo", sandbox: box, input: Type.Null(), output: Type.Any(), run: ["sh", "-c", "echo other"] });
const writer = defineAgent({ models }, { name: "writer", model: "default", prompt: "p", input: Type.Null(), output: Type.Any() });
const impostor = defineAgent({ models }, { name: "writer", model: "default", prompt: "another prompt", input: Type.Null(), output: Type.Any() });
const pick = orchestrator({ name: "pick", input: Type.Null(), output: Type.Any() });
const elsewhere = toolset<{ none: { execute: () => void; parameters: object } }>("./tools/none.ts", { sandbox: box });

const refusal = async (f: () => Promise<unknown>) => {
	try {
		await f();
		return "ran";
	} catch (error) {
		return error instanceof Refused ? error.refusal.type : String(error);
	}
};

const probe = subWorkflow({
	name: "probe",
	input: Type.Null(),
	output: Type.Any(),
	run: async (ctx: Ctx) => ({
		command: await refusal(() => ctx.call(other, null)),
		agent: await refusal(async () => ctx.session(impostor)),
		orchestrator: await refusal(() => ctx.call(orchestrator({ name: "pick", input: Type.Null(), output: Type.Any() }), null)),
		tool: await refusal(() => ctx.call(elsewhere.none as never, {})),
	}),
});

export default workflow({
	name: "undeclared",
	models,
	agents: [writer],
	commands: [echo],
	orchestrators: [pick],
	input: Type.Null(),
	output: Type.Any(),
	run: async (ctx) => ctx.call(probe, null),
});
