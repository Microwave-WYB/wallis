// A starter workflow: a sandboxed command, a one-shot agent and a nested workflow, in one file.
// Copy it next to your scripts, rename the nodes, and run it from a caller script:
//
//   import { run, Tree } from "wallis";
//   import { pipeline } from "./workflow.ts";
//   const r = await run(pipeline, { data: Tree.from("./data"), question: "What changed?" });
//   console.log(r.output);
//
// Model aliases ("default") come from .wallis/config.json in the project.

import { agent, Artifact, command, sandbox, Tree, Type, workflow } from "wallis";

/** What the commands may see: python3 and the scripts beside this file, read-only. No network. */
const box = sandbox({ requires: ["python3"], volumes: ["./scripts:/scripts:ro"] });

/** A summary of the data: a JSON report on stdout, and a file it writes in /w as an Artifact. */
const summarize = command({
	sandbox: box,
	input: Type.Object({ data: Tree() }),
	output: Type.Object({ rows: Type.Integer(), report: Artifact("text/markdown") }),
	run: ({ data }) => ["python3", "/scripts/summarize.py", data.path, "report.md"],
	parse: (r) => ({ ...(JSON.parse(r.stdout) as { rows: number }), report: r.file("report.md") }),
});

/** An agent that reads the report (an Artifact input gives it read access) and answers. */
const analyst = agent({
	model: "default",
	prompt: "Read the report and answer the question in two sentences.",
	input: Type.Object({ report: Artifact("text/markdown"), question: Type.String() }),
	output: Type.Object({ answer: Type.String() }),
	turns: 10,
});

/** Stage 1: expensive, run once; its output is reused by later runs as input. */
export const prepare = workflow({
	input: Type.Object({ data: Tree() }),
	output: Type.Object({ rows: Type.Integer(), report: Artifact("text/markdown") }),
	run: async (ctx, { data }) => ctx.call(summarize, { data }),
});

/** The whole pipeline: the nested stage, then the agent. */
export const pipeline = workflow({
	input: Type.Object({ data: Tree(), question: Type.String() }),
	output: Type.Object({ rows: Type.Integer(), answer: Type.String() }),
	run: async (ctx, { data, question }) => {
		const { rows, report } = await ctx.call(prepare, { data });
		const { answer } = await ctx.call(analyst, { report, question });
		return { rows, answer };
	},
});
