// Small things that must hold: ~ in host paths, onExit across a resume, exportOutput's errors, a
// failed session's workspace after a resume, and odd characters in the workflow's path.
import { existsSync } from "node:fs";
import { agent, command, NodeFailed, sandbox, Tree, Type, workflow } from "wallis";

const box = sandbox({ requires: ["sh", "cat"], volumes: ["./data:/data:ro"] });
const look = command({ sandbox: box, input: Type.Object({ t: Tree() }), output: Type.Object({ text: Type.String() }), run: ({ t }) => ["sh", "-c", 'cat "$1"/a.txt /data/x.txt', "sh", t.path], parse: (r) => ({ text: r.stdout }) });

/** Reads a Tree input and the ./data bind. */
export const reads = workflow({ input: Type.Object({ t: Tree() }), output: Type.Object({ text: Type.String(), t: Tree() }), run: async (ctx, { t }) => ({ ...(await ctx.call(look, { t })), t }) });

/** Fails while a flag file exists. */
export const flaky = workflow({
	input: Type.Object({ flag: Type.String() }),
	output: Type.Object({}),
	run: async (_ctx, { flag }) => {
		if (existsSync(flag)) throw new Error("not yet");
		return {};
	},
});

const drafter = agent({ model: "default", prompt: "Draft.", input: Type.Object({}), output: Type.Object({ ok: Type.Boolean() }), workspace: { access: "write" }, turns: 2 });

/** Keeps the workspace of an agent that ran out of turns, then fails while a flag exists. */
export const keepDraft = workflow({
	input: Type.Object({ flag: Type.String() }),
	output: Type.Object({ draft: Tree() }),
	run: async (ctx, { flag }) => {
		try {
			await ctx.call(drafter, {});
			throw new Error("expected the turn limit");
		} catch (e) {
			if (!(e instanceof NodeFailed) || e.reason.type !== "turn_limit_reached") throw e;
			const draft = ctx.files(e.reason.session);
			if (existsSync(flag)) throw new Error("not yet");
			return { draft };
		}
	},
});
