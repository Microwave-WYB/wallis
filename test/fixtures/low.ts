// Small things that must hold: ~ in host paths, onExit across a resume, exportOutput's errors, a
// failed session's workspace after a resume, and odd characters in the workflow's path.
import { existsSync } from "node:fs";
import { Address, agent, command, NodeFailed, sandbox, sessionOf, Tree, Type, workflow } from "wallis";

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

const ghost = command({ sandbox: box, input: Type.Object({}), output: Type.Object({}), run: () => ["/no/such/program"] });

/** Calls a command the sandbox cannot start. */
export const haunted = workflow({ input: Type.Object({}), output: Type.Object({}), run: (ctx) => ctx.call(ghost, {}) });

const other = agent({ model: "default", prompt: "Other.", input: Type.Object({}), output: Type.Object({ ok: Type.Boolean() }) });

/** Continues a turn-limited session typed by its agent; refuses it as another agent's. */
export const continued = workflow({
	input: Type.Object({}),
	output: Type.Object({ ok: Type.Boolean(), refused: Type.String() }),
	run: async (ctx) => {
		try {
			await ctx.call(drafter, {});
			throw new Error("expected the turn limit");
		} catch (e) {
			if (!(e instanceof NodeFailed) || e.reason.type !== "turn_limit_reached") throw e;
			let refused = "";
			try {
				sessionOf(other, e.reason.session);
			} catch (x) {
				refused = (x as Error).message;
			}
			const [out] = await ctx.call(sessionOf(drafter, e.reason.session), {}, { turns: 4 });
			return { ok: out.ok, refused };
		}
	},
});

const asker = agent({ model: "default", prompt: "Say hi to `to`.", input: Type.Object({ to: Address(Type.String()) }), output: Type.Object({ ok: Type.Boolean() }) });

/** A relay passes each sender's address (m.from) to an agent's Address(String) input: checked when the call starts. */
export const relayed = workflow({
	input: Type.Object({ numbers: Type.Boolean() }),
	output: Type.Object({ heard: Type.String() }),
	run: async (ctx, { numbers }) => {
		const relay = ctx.spawn(Type.Object({ ask: Type.String() }), async (c, mailbox) => {
			for await (const m of mailbox) await c.call(asker, { to: m.from });
		});
		const client = numbers
			? ctx.spawn(Type.Number(), async (c, mailbox) => {
					c.send(relay.address, { ask: "hi" });
					return String((await mailbox.receive()) as unknown);
				})
			: ctx.spawn(Type.String(), async (c, mailbox) => {
					c.send(relay.address, { ask: "hi" });
					const m = await mailbox.receive();
					return "closed" in m ? "closed" : m.body;
				});
		return { heard: await client.result };
	},
});
