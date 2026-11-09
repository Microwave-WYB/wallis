// Workspaces as layers (test/workspace.test.ts). The worker writes one
// file (or none) into its /w and reports what it sees there; each mode
// shapes a different tree of session values.

import { command, defineAgent, defineModels, defineSandbox, TreeValue, Type, workflow } from "wallis";

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
		input: Type.Object({ script: Type.String(), tree: Type.Optional(TreeValue()) }),
		output: Type.Object({ out: Type.String() }),
		workspace: { access: "exec", sandbox: defineSandbox({}, { name: "shell", requires: ["bash"] }) },
	},
);

/** Reads a.txt from the Tree in its input, mounted read-only under /in/trees. */
const peek = command({
	name: "peek",
	sandbox: defineSandbox({}, { name: "peek", requires: ["bash"] }),
	input: Type.Object({ tree: TreeValue() }),
	output: Type.String(),
	run: ["bash", "-c", "cat /in/trees/*/a.txt"],
	parse: (r) => r.stdout.trim(),
});

export default workflow({
	name: "workspace",
	models,
	agents: [worker, shell],
	commands: [peek],
	input: Type.Object({ mode: Type.Union([Type.Literal("branches"), Type.Literal("from"), Type.Literal("deep"), Type.Literal("big"), Type.Literal("restart"), Type.Literal("shell"), Type.Literal("tree"), Type.Literal("rewrite")]) }),
	output: Type.Any(),
	run: async (ctx, input) => {
		if (input.mode === "shell") {
			// Files written, one deleted, then listed: each call's bash sees the layers below it.
			let [, s] = await ctx.call(ctx.session(shell), { script: "echo a > a.txt; echo b > b.txt; mkdir d; echo e > d/e" });
			[, s] = await ctx.call(s, { script: "rm b.txt; cat a.txt" });
			const [listed] = await ctx.call(s, { script: "ls -R" });
			return { listed: listed.out };
		}
		if (input.mode === "rewrite") {
			// a back to its first content: the third call's layer is the first one again.
			let [, s] = await ctx.call(ctx.session(shell), { script: "echo x > a" });
			[, s] = await ctx.call(s, { script: "echo y > a" });
			[, s] = await ctx.call(s, { script: "echo x > a" });
			const [read] = await ctx.call(s, { script: "cat a" });
			return { read: read.out.trim(), layers: s.layers.length };
		}
		if (input.mode === "tree") {
			// A one-layer Tree, to a command and to an exec agent.
			const [, s] = await ctx.call(ctx.session(shell), { script: "echo from-tree > a.txt" });
			const tree = ctx.files(s);
			const command = await ctx.call(peek, { tree });
			const [agent] = await ctx.call(ctx.session(shell), { script: "cat /in/trees/*/a.txt", tree });
			return { layers: tree.layers.length, command, agent: agent.out.trim() };
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
