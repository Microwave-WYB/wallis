// The state-coverage acceptance workflow: each step puts the run in one
// attention kind, for the orchestrator to resolve (test/accept.test.ts).
//
//   #0    search    a body MCP tool call (journaled)
//   #1:0  ask       the worker calls `ask`                       agent_ask (ask_tool)
//   #1:1  implicit  held by the turn budget, then a plain        run_idle (budget_reached),
//                   question in the same session                 agent_ask (end_of_turn)
//   #2:0  limit     codemode until its 2 turns run out           turn_limit
//   #3:0  slow      runs until interrupted (paused first)        interrupted, run_idle (paused)
//   #4:0  post      an `ask`-mode MCP tool, approved             approval_pending
//   #5:0  post      the same, rejected with a reason             approval_pending
//   #6    pick      an orchestrator node                         orchestrator_pending
//   #7:0  flaky     a model the executor cannot serve            run_idle (executor_unavailable)
//   #8:0  fragile   gives up until restarted with a note         node_failed
//   #9:0  last      the host dies here once                      stopped, then finished

import { defineAgent, defineMcp, defineModels, mcpTool, orchestrator, Type, workflow } from "wallis";
import mcpConfig from "./mcp.json" with { type: "json" };

const models = defineModels({ default: "faux/faux-1", flaky: "faux/broken" });
const mcp = defineMcp(mcpConfig);
const env = { models, mcp };
const Step = Type.Object({ step: Type.String() });
const Ok = Type.Object({ ok: Type.String() });
const agent = (name: string, extra: { model?: "default" | "flaky"; maxTurns?: number } = {}) =>
	defineAgent(env, { name, model: extra.model ?? "default", prompt: "Do the step in your input.", input: Step, output: Ok, maxTurns: extra.maxTurns ?? 4 });

const worker = agent("worker");
const slow = agent("slow", { maxTurns: 2 });
const flaky = agent("flaky", { model: "flaky" });
const fragile = agent("fragile");
const poster = defineAgent(env, { name: "poster", model: "default", prompt: "Post, then report the result.", input: Step, output: Ok, mcp: { fx: { ask: ["post"] } } });
const search = mcpTool(env, { name: "search", server: "fx", tool: "search", input: Type.Object({ q: Type.String() }), output: Type.Object({ hits: Type.Array(Type.String()) }) });
const pick = orchestrator({
	name: "pick",
	description: "Choose a look for the roll.",
	input: Type.Object({ question: Type.String() }),
	output: Type.Object({ choice: Type.Union([Type.Literal("a"), Type.Literal("b")]) }, { additionalProperties: false }),
});

export default workflow({
	name: "accept",
	models,
	mcp,
	agents: [worker, slow, flaky, fragile, poster],
	orchestrators: [pick],
	mcpTools: [search],
	budget: { turns: 2 },
	input: Type.Null(),
	output: Type.Any(),
	run: async (ctx) => {
		const found = await ctx.call(search, { q: "looks" });
		const w = ctx.session(worker);
		const asked = await w.call({ step: "ask" });
		const implicit = await w.call({ step: "implicit" });
		const limit = await ctx.session(slow).call({ step: "limit" });
		const slowed = await ctx.session(worker).call({ step: "slow" });
		const approved = await ctx.session(poster).call({ step: "post" });
		const rejected = await ctx.session(poster).call({ step: "post" });
		const picked = await ctx.call(pick, { question: "Look a (warm) or b (cool)?" });
		const flakyOk = await ctx.session(flaky).call({ step: "flaky" });
		const fragileOk = await ctx.session(fragile).call({ step: "fragile" });
		const last = await ctx.session(worker).call({ step: "last" });
		return { found: found.hits, asked: asked.ok, implicit: implicit.ok, limit: limit.ok, slowed: slowed.ok, approved: approved.ok, rejected: rejected.ok, picked: picked.choice, flaky: flakyOk.ok, fragile: fragileOk.ok, last: last.ok };
	},
});
