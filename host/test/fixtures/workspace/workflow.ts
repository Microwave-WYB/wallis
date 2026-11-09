// Workspaces as layers (test/workspace.test.ts). The worker writes one
// file (or none) into its /w and reports what it sees there; each mode
// shapes a different tree of session values.

import { defineAgent, defineModels, defineSandbox, Type, workflow } from "wallis";

const models = defineModels({ default: "fake/default" });
const Step = Type.Object({ write: Type.Union([Type.String(), Type.Null()]), size: Type.Optional(Type.Integer()) });
const worker = defineAgent(
	{ models },
	{ name: "worker", model: "default", prompt: "Write the file, then say what is in /w.", input: Step, output: Type.Object({ saw: Type.Array(Type.String()) }), workspace: { access: "write" } },
);

/** Runs a bash script in its sandbox: /w is the kernel's overlay of its session's layers. */
const shell = defineAgent(
	{ models },
	{
		name: "shell",
		model: "default",
		prompt: "Run the script.",
		input: Type.Object({ script: Type.String() }),
		output: Type.Object({ out: Type.String() }),
		workspace: { access: "exec", sandbox: defineSandbox({}, { name: "shell", requires: ["bash"] }) },
	},
);

export default workflow({
	name: "workspace",
	models,
	agents: [worker, shell],
	input: Type.Object({ mode: Type.Union([Type.Literal("branches"), Type.Literal("from"), Type.Literal("deep"), Type.Literal("big"), Type.Literal("restart"), Type.Literal("shell")]) }),
	output: Type.Any(),
	run: async (ctx, input) => {
		if (input.mode === "shell") {
			// Files written, one deleted, then listed: each call's bash sees the layers below it.
			let [, s] = await ctx.call(ctx.session(shell), { script: "echo a > a.txt; echo b > b.txt; mkdir d; echo e > d/e" });
			[, s] = await ctx.call(s, { script: "rm b.txt; cat a.txt" });
			const [listed] = await ctx.call(s, { script: "ls -R" });
			return { listed: listed.out };
		}
		const [, s1] = await ctx.call(ctx.session(worker), { write: "a.txt" });
		switch (input.mode) {
			case "branches": {
				// Two concurrent branches from one value, and a call after one of them.
				const { x, y } = await ctx.parallel({ x: (b) => b.call(s1, { write: "x.txt" }), y: (b) => b.call(s1, { write: "y.txt" }) });
				const [afterX] = await ctx.call(x[1], { write: null });
				const [afterY] = await ctx.call(y[1], { write: null });
				return { x: x[0].saw, y: y[0].saw, afterX: afterX.saw, afterY: afterY.saw };
			}
			case "from": {
				// A new session seeded from s1's files gets them copy-on-write; s1 never sees its writes.
				const tree = ctx.files(s1);
				const [seeded] = await ctx.call(ctx.session(worker, { from: tree }), { write: "c.txt" });
				const [original] = await ctx.call(s1, { write: null });
				return { seeded: seeded.saw, original: original.saw, tree };
			}
			case "deep": {
				let s = s1;
				let saw: string[] = [];
				for (let i = 0; i < 20; i++) {
					let out;
					[out, s] = await ctx.call(s, { write: `f${String(i).padStart(2, "0")}.txt` });
					saw = out.saw;
				}
				return { saw, layers: s.layers.length };
			}
			case "big": {
				// A 50 MB file written once, then 17 calls that never touch it (the stack is squashed).
				let [, s] = await ctx.call(s1, { write: "big.bin", size: 50_000_000 });
				for (let i = 0; i < 17; i++) [, s] = await ctx.call(s, { write: `n${i}.txt` });
				return { layers: s.layers };
			}
			case "restart": {
				const [two] = await ctx.call(s1, { write: "two.txt" });
				return { two: two.saw };
			}
		}
	},
});
