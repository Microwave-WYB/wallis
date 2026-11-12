// Commands that stress their scratch dir: concurrent identical calls, read-only trees, symlinks out
// of /w, long multibyte stdout. `ctl/` is a live read-only bind for the test's host paths.

import { agent, Artifact, command, sandbox, Type, workflow } from "wallis";

const box = sandbox({ requires: ["sh", "sleep", "cat", "head", "od", "tr", "chmod", "mkdir", "ln", "python3"] });

const sample = command({
	sandbox: box,
	input: Type.Object({ seed: Type.String() }),
	output: Type.Object({ out: Artifact("text/plain") }),
	run: () => ["sh", "-c", 'head -c 8 /dev/urandom | od -An -tx1 | tr -d " \\n" > out.txt; sleep 1; cat out.txt >&2'],
	parse: (r) => ({ out: r.file("out.txt") }),
});

/** Two identical calls at once (majority voting): each needs its own /w. */
export const vote = workflow({
	input: Type.Object({}),
	output: Type.Object({ a: Artifact("text/plain"), b: Artifact("text/plain") }),
	run: async (ctx) => {
		const [a, b] = await Promise.all([ctx.call(sample, { seed: "x" }), ctx.call(sample, { seed: "x" })]);
		return { a: a.out, b: b.out };
	},
});

const readOnly = command({
	sandbox: box,
	input: Type.Object({ n: Type.Integer() }),
	output: Type.Object({ ok: Type.Boolean() }),
	run: () => ["sh", "-c", "mkdir -p go/pkg/mod/x && echo hi > go/pkg/mod/x/f && chmod -R a-w go/pkg/mod && echo '{\"ok\": true}'"],
});

/** A command that leaves a read-only tree in /w (a Go module cache): twice. */
export const modcache = workflow({
	input: Type.Object({}),
	output: Type.Object({ ok: Type.Boolean() }),
	run: async (ctx) => {
		await ctx.call(readOnly, { n: 1 });
		return ctx.call(readOnly, { n: 2 });
	},
});

const escape = command({
	sandbox: box,
	input: Type.Object({ host: Type.String(), name: Type.String() }),
	output: Type.Object({ f: Artifact("text/plain") }),
	run: (i) => ["sh", "-c", 'ln -s "$1" out && echo "{}"', "sh", i.host],
	parse: (r, i) => ({ f: r.file(`out/${i.name}`) }),
});

/** r.file through a symlink out of /w: refused; the host file stays. */
export const leaking = workflow({
	input: Type.Object({ host: Type.String(), name: Type.String() }),
	output: Type.Object({ f: Artifact("text/plain") }),
	run: async (ctx, i) => ctx.call(escape, i),
});

const linked = command({
	sandbox: box,
	input: Type.Object({}),
	output: Type.Object({ f: Artifact("text/plain"), d: Type.Unknown() }),
	run: () => ["sh", "-c", 'mkdir -p real && echo inside > real/x.txt && ln -s real alias && echo "{}"'],
	parse: (r) => ({ f: r.file("alias/x.txt"), d: r.dir("alias") }),
});

/** A symlink that stays inside /w is followed, and what it names is copied. */
export const aliased = workflow({
	input: Type.Object({}),
	output: Type.Object({ f: Artifact("text/plain"), d: Type.Unknown() }),
	run: async (ctx) => ctx.call(linked, {}),
});

const big = command({
	sandbox: box,
	input: Type.Object({}),
	output: Type.Object({ text: Type.String() }),
	run: () => ["python3", "-c", "import json; print(json.dumps({'text': '€' * 200000}, ensure_ascii=False))"],
});

/** Long multibyte stdout: decoded as one stream. */
export const multibyte = workflow({
	input: Type.Object({}),
	output: Type.Object({ text: Type.String() }),
	run: async (ctx) => ctx.call(big, {}),
});

const voter = agent({
	model: "default",
	prompt: "Write your vote in vote.txt and return it.",
	input: Type.Object({ question: Type.String() }),
	output: Type.Object({ vote: Artifact("text/plain") }),
	turns: 4,
});

/** Majority voting with agents: identical one-shot calls at once, each in its own workspace. */
export const votes = workflow({
	input: Type.Object({}),
	output: Type.Object({ votes: Type.Array(Artifact("text/plain")) }),
	run: async (ctx) => ({ votes: (await Promise.all([1, 2, 3].map(() => ctx.call(voter, { question: "yes or no?" })))).map((v) => v.vote) }),
});
