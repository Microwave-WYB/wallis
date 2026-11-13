// Failing actors (docs/design.md §6): never swallowed. Plus actors in ctx.loop, and which failure
// a failed run names first.

import { Address, agent, command, MessageRejected, sandbox, Type, workflow } from "wallis";
import type { Address as AddressOf } from "wallis";

const box = sandbox({ requires: ["sh", "sleep"] });
const wait = command({ sandbox: box, input: Type.Object({ s: Type.Number() }), output: Type.Object({}), run: (i) => ["sh", "-c", 'sleep "$1"; echo "{}"', "sh", String(i.s)] });
const broken = command({ sandbox: box, input: Type.Object({ n: Type.Integer() }), output: Type.Object({}), run: (i) => ["sh", "-c", 'echo "broken $1" >&2; exit 3', "sh", String(i.n)] });

/** Nobody awaits the actor: its failure fails the body. */
export const unawaited = workflow({
	input: Type.Object({}),
	output: Type.Object({}),
	run: async (ctx) => {
		const crasher = ctx.spawn(Type.String(), async () => {
			throw new Error("boom");
		});
		void crasher;
		await ctx.call(wait, { s: 2 });
		return {};
	},
});

/** The spawner awaits it: the failure is the spawner's to handle. */
export const awaited = workflow({
	input: Type.Object({}),
	output: Type.Object({ caught: Type.String(), after: Type.String() }),
	run: async (ctx) => {
		const worker = ctx.spawn(Type.String(), async (_c, mailbox) => {
			for await (const m of mailbox) throw new Error(`cannot handle ${m.body}`);
		});
		ctx.send(worker.address, "job 1");
		let caught = "";
		try {
			await worker.result;
		} catch (e) {
			caught = (e as Error).message;
		}
		// Its mailbox closed with it: a later send is rejected.
		let after = "delivered";
		try {
			ctx.send(worker.address, "job 2");
		} catch (e) {
			if (e instanceof MessageRejected) after = e.reason;
		}
		return { caught, after };
	},
});

const Job = Type.Object({ frame: Type.String() });
const grader = agent({
	model: "default",
	prompt: "Send a job to the renderer and wait for the image.",
	input: Type.Object({ renderer: Address(Job) }),
	output: Type.Object({ look: Type.String() }),
	mailbox: Type.Object({ jpg: Type.String() }),
	turns: 10,
});

/** The grade scenario with a renderer that throws outside its per-job try: the run ends, it does not idle. */
export const grade = workflow({
	input: Type.Object({}),
	output: Type.Object({ look: Type.String() }),
	run: async (ctx) => {
		const renderer = ctx.spawn(Job, async (_c, mailbox) => {
			for await (const m of mailbox) throw new Error(`renderer crashed on ${m.body.frame}`);
		});
		return ctx.call(grader, { renderer: renderer.address });
	},
});

/** An actor spawned inside a ctx.loop step closes when that step returns. */
export const looping = workflow({
	input: Type.Object({}),
	output: Type.Object({ reason: Type.String() }),
	run: async (ctx) => {
		const a = await ctx.loop<number, AddressOf<string>>(0, async (c) => {
			const x = c.spawn(Type.String(), async (_c, mb) => {
				for await (const _ of mb) {
					// reads until closed
				}
			});
			return { done: x.address };
		});
		try {
			ctx.send(a, "hi");
			return { reason: "accepted" };
		} catch (e) {
			return { reason: e instanceof MessageRejected ? e.reason : String(e) };
		}
	},
});

/** One failure the body handles, then another it does not: the second is the run's. */
export const twoFailures = workflow({
	input: Type.Object({}),
	output: Type.Object({}),
	run: async (ctx) => {
		try {
			await ctx.call(broken, { n: 1 });
		} catch {
			// handled: the body goes on
		}
		await ctx.call(broken, { n: 2 });
		return {};
	},
});

/** The documented pattern: the handler is attached at spawn, so a failure during a later await is handled. */
export const handledAtSpawn = workflow({
	input: Type.Object({}),
	output: Type.Object({ caught: Type.String() }),
	run: async (ctx) => {
		const a = ctx.spawn(Type.String(), async () => {
			throw new Error("boom");
		});
		const done = a.result.then(
			() => "no failure",
			(e: unknown) => (e as Error).message,
		);
		await ctx.call(wait, { s: 1 });
		return { caught: await done };
	},
});

/** The pitfall: a catch reached only after a long await comes too late; the failure is unhandled by then. */
export const handledTooLate = workflow({
	input: Type.Object({}),
	output: Type.Object({ caught: Type.String() }),
	run: async (ctx) => {
		const a = ctx.spawn(Type.String(), async () => {
			throw new Error("boom");
		});
		await ctx.call(wait, { s: 1 });
		try {
			await a.result;
			return { caught: "no failure" };
		} catch (e) {
			return { caught: (e as Error).message };
		}
	},
});
