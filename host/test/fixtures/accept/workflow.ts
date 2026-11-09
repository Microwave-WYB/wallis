// The state-coverage acceptance workflow: each step puts the run in one
// attention kind, for the orchestrator to resolve (test/accept.test.ts).
//
//   #0    search    a body call of an MCP tool (journaled)
//   #1:0  ask       the worker calls `ask`                          agent_ask
//   #1:1  implicit  held by the turn budget, then ends its turn     run_idle (budget_reached),
//                   without a result, in the same session            ended_without_result
//   #2:0  limit     codemode until its 2 turns run out              turn_limit
//   #3:0  slow      runs until interrupted (paused first)           interrupted, run_idle (paused)
//   #4:0  upload    the host dies during a custom tool call that    stopped, then outcome_unknown
//                   is not safe to repeat; a restart retries it
//   #5    pick      an orchestrator node                            orchestrator_pending
//   #6    confirm   an orchestrator node, asked again, cancelled    orchestrator_pending
//   #7:0  flaky     a model the executor cannot serve               run_idle (executor_unavailable)
//   #8:0  fragile   gives up until restarted with a note            node_failed
//   #9    publish   the body's outward write, a custom tool
//   #10:0 last                                                      finished

import { defineAgent, defineMcp, defineModels, OrchestratorCancelled, orchestrator, ask, toolset, Type, workflow, defineSandbox } from "wallis";
import mcpConfig from "./mcp.json" with { type: "json" };

const models = defineModels({ default: "faux/faux-1", flaky: "faux/broken" });
const fx = defineMcp(mcpConfig);
const toolBox = defineSandbox({}, { name: "accept-tools", requires: ["node"] });
const lib = toolset<typeof import("./tools/lib.ts")>("./tools/lib.ts", { sandbox: toolBox, secrets: ["COUNT_FILE"] });
const env = { models };
const Step = Type.Object({ step: Type.String() });
const Ok = Type.Object({ ok: Type.String() });
const agent = (name: string, extra: { model?: "default" | "flaky"; maxTurns?: number } = {}) =>
	defineAgent(env, { name, model: extra.model ?? "default", prompt: "Do the step in your input.", input: Step, output: Ok, maxTurns: extra.maxTurns ?? 4 });

// The worker may ask, and gets the fx server's read-only tools.
const worker = defineAgent(env, { name: "worker", model: "default", prompt: "Do the step in your input.", input: Step, output: Ok, maxTurns: 4, tools: [ask, fx.fx] });
const slow = agent("slow", { maxTurns: 2 });
const flaky = agent("flaky", { model: "flaky" });
const fragile = agent("fragile");
const poster = defineAgent(env, { name: "poster", model: "default", prompt: "Upload, then report the URL.", input: Step, output: Ok, tools: [lib.upload] });
const pick = orchestrator({
	name: "pick",
	description: "Choose a look for the roll.",
	input: Type.Object({ question: Type.String() }),
	output: Type.Object({ choice: Type.Union([Type.Literal("a"), Type.Literal("b")]) }, { additionalProperties: false }),
});
const confirm = orchestrator({ name: "confirm", description: "Confirm the publication.", input: Type.Object({ text: Type.String() }), output: Type.Object({ ok: Type.Boolean() }) });

export default workflow({
	name: "accept",
	models,
	mcp: fx,
	toolsets: [lib],
	agents: [worker, slow, flaky, fragile, poster],
	orchestrators: [pick, confirm],
	budget: { turns: 2 },
	input: Type.Null(),
	output: Type.Any(),
	run: async (ctx) => {
		const found = await ctx.call(fx.fx.search, { q: "looks" }, Type.Object({ hits: Type.Array(Type.String()) }));
		const w = ctx.session(worker);
		const asked = await w.call({ step: "ask" });
		const implicit = await w.call({ step: "implicit" });
		const limit = await ctx.session(slow).call({ step: "limit" });
		const slowed = await ctx.session(worker).call({ step: "slow" });
		const uploaded = await ctx.session(poster).call({ step: "upload" });
		const picked = await ctx.call(pick, { question: "Look a (warm) or b (cool)?" });
		let confirmed: string;
		try {
			confirmed = String((await ctx.call(confirm, { text: `publish look ${picked.choice}` })).ok);
		} catch (error) {
			if (!(error instanceof OrchestratorCancelled)) throw error;
			confirmed = "cancelled";
		}
		const flakyOk = await ctx.session(flaky).call({ step: "flaky" });
		const fragileOk = await ctx.session(fragile).call({ step: "fragile" });
		const published = await ctx.call(lib.publish, { text: `look ${picked.choice}` });
		const last = await ctx.session(worker).call({ step: "last" });
		return { found: found.hits, asked: asked.ok, implicit: implicit.ok, limit: limit.ok, slowed: slowed.ok, uploaded: uploaded.ok, picked: picked.choice, confirmed, flaky: flakyOk.ok, fragile: fragileOk.ok, published: published.id, last: last.ok };
	},
});
