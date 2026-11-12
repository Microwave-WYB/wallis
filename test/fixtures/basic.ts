// Commands, nesting, files and failures, on `sh` alone. `./ctl` is a live
// read-only bind: a test makes a call fail by writing `ctl/fail-<n>`.

import { Artifact, command, sandbox, Tree, Type, workflow } from "wallis";

const box = sandbox({ requires: ["sh", "sleep", "cat", "ls"], volumes: ["./ctl:/ctl:ro"] });

export const twice = command({
	sandbox: box,
	input: Type.Object({ n: Type.Integer() }),
	output: Type.Object({ twice: Type.Integer() }),
	run: (i) => ["sh", "-c", 'printf \'{"twice": %d}\' $(( $1 * 2 ))', "sh", String(i.n)],
});

export const flaky = command({
	sandbox: box,
	input: Type.Object({ n: Type.Integer(), sleep: Type.Optional(Type.Number()) }),
	output: Type.Object({ n: Type.Integer() }),
	run: (i) => ["sh", "-c", 'sleep "$2"; if [ -e "/ctl/fail-$1" ]; then echo "frame $1 failed on purpose" >&2; exit 3; fi; printf \'{"n": %d}\' "$1"', "sh", String(i.n), String(i.sleep ?? 0)],
});

export const make = command({
	sandbox: box,
	input: Type.Object({ text: Type.String() }),
	output: Type.Object({ file: Artifact("text/plain"), dir: Tree() }),
	run: (i) => ["sh", "-c", 'echo "$1" > out.txt; mkdir -p d/sub; echo "$1" > d/sub/x.txt', "sh", i.text],
	parse: (r) => ({ file: r.file("out.txt"), dir: r.dir("d") }),
});

export const look = command({
	sandbox: box,
	input: Type.Object({ tree: Tree(), file: Artifact() }),
	output: Type.Object({ listing: Type.String(), text: Type.String() }),
	run: (i) => ["sh", "-c", 'printf \'{"listing": "%s", "text": "%s"}\' "$(ls "$1" | tr "\\n" " ")" "$(cat "$2")"', "sh", i.tree.path, i.file.path],
});

export const inner = workflow({
	input: Type.Object({ n: Type.Integer() }),
	output: Type.Object({ twice: Type.Integer() }),
	run: async (ctx, i) => ctx.call(twice, i),
});

export const nested = workflow({
	input: Type.Object({ n: Type.Integer() }),
	output: Type.Object({ outer: Type.Integer(), inner: Type.Integer() }),
	run: async (ctx, { n }) => ({ outer: (await ctx.call(twice, { n })).twice, inner: (await ctx.call(inner, { n })).twice }),
});

export const frames = workflow({
	input: Type.Object({ n: Type.Integer(), sleep: Type.Optional(Type.Number()) }),
	output: Type.Object({ done: Type.Array(Type.Integer()) }),
	run: async (ctx, { n, sleep }) => {
		const done: number[] = [];
		for (let i = 1; i <= n; i++) done.push((await ctx.call(flaky, { n: i, sleep: sleep ?? 0 })).n);
		return { done };
	},
});

export const files = workflow({
	input: Type.Object({ tree: Tree(), file: Artifact("text/plain") }),
	output: Type.Object({ seen: Type.String(), made: Type.Object({ file: Artifact("text/plain"), dir: Tree() }), again: Type.String() }),
	run: async (ctx, { tree, file }) => {
		const seen = await ctx.call(look, { tree, file });
		const made = await ctx.call(make, { text: "hello" });
		const again = await ctx.call(look, { tree: made.dir, file: made.file });
		return { seen: `${seen.listing}|${seen.text}`, made, again: `${again.listing}|${again.text}` };
	},
});

export const thrower = workflow({
	input: Type.Object({}),
	output: Type.Object({}),
	run: async () => {
		throw new Error("the body gave up");
	},
});

const show = command({ sandbox: box, input: Type.Object({ data: Tree() }), output: Type.Object({ text: Type.String() }), run: ({ data }) => ["cat", `${data.path}/a.txt`], parse: (r) => ({ text: r.stdout }) });

/** Reads its input Tree: what prune must not delete while the run starts. */
export const reading = workflow({ input: Type.Object({ data: Tree() }), output: Type.Object({ text: Type.String() }), run: async (ctx, { data }) => ctx.call(show, { data }) });
