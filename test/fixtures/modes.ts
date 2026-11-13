// Files keep their modes through the store, and what a command leaves read-only still enters it.
import { agent, Artifact, command, sandbox, Tree, Type, workflow } from "wallis";

const box = sandbox({ requires: ["sh", "cp", "chmod", "mkdir"] });

/** Copies an input Tree into /w and edits a copied file in place (npm, make and friends do this). */
const patch = command({
	sandbox: box,
	input: Type.Object({ t: Tree() }),
	output: Type.Object({ out: Tree() }),
	run: ({ t }) => ["sh", "-c", 'cp -r "$1" src && echo patched >> src/package.json', "sh", t.path],
	parse: (r) => ({ out: r.dir("src") }),
});
export const patched = workflow({ input: Type.Object({ t: Tree() }), output: Type.Object({ out: Tree() }), run: (ctx, i) => ctx.call(patch, i) });

/** Leaves its result dir read-only, all the way down. */
const sealed = command({
	sandbox: box,
	input: Type.Object({}),
	output: Type.Object({ out: Tree() }),
	run: () => ["sh", "-c", "mkdir -p out/sub && echo a > out/sub/a.txt && chmod -R a-w out"],
	parse: (r) => ({ out: r.dir("out") }),
});
export const seal = workflow({ input: Type.Object({}), output: Type.Object({ out: Tree() }), run: (ctx) => ctx.call(sealed, {}) });

/** A file of a dir and the dir itself, in either order. */
const both = command({
	sandbox: box,
	input: Type.Object({ fileFirst: Type.Boolean() }),
	output: Type.Object({ report: Artifact("text/plain"), all: Tree() }),
	run: () => ["sh", "-c", "mkdir -p out && echo report > out/report.txt && echo other > out/other.txt"],
	parse: (r, { fileFirst }) => (fileFirst ? { report: r.file("out/report.txt"), all: r.dir("out") } : ({ all: r.dir("out"), report: r.file("out/report.txt") } as never)),
});
export const fileAndDir = workflow({ input: Type.Object({ fileFirst: Type.Boolean() }), output: Type.Object({ report: Artifact("text/plain"), all: Tree() }), run: (ctx, i) => ctx.call(both, i) });

const locker = agent({ model: "default", prompt: "Seal your workspace.", input: Type.Object({}), output: Type.Object({ ok: Type.Boolean() }), workspace: { access: "exec" }, turns: 4 });
/** An agent that leaves its /w root read-only. */
export const lockedRoot = workflow({ input: Type.Object({}), output: Type.Object({ files: Tree() }), run: async (ctx) => {
	const [, s] = await ctx.call(ctx.session(locker), {});
	return { files: ctx.files(s) };
} });
