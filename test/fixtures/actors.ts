// Actors and messages on commands alone: a coordinator collecting worker
// reports, a rejected message, and a run the caller talks to.

import { command, MessageRejected, sandbox, Type, workflow } from "wallis";

const box = sandbox({ requires: ["sh", "sleep"] });

const work = command({
	sandbox: box,
	input: Type.Object({ n: Type.Integer(), sleep: Type.Number() }),
	output: Type.Object({ n: Type.Integer() }),
	run: (i) => ["sh", "-c", 'sleep "$2"; printf \'{"n": %d}\' "$(( $1 * 10 ))"', "sh", String(i.n), String(i.sleep)],
});

const Report = Type.Object({ worker: Type.Integer(), value: Type.Integer() });

export const coordinator = workflow({
	input: Type.Object({ workers: Type.Integer(), sleep: Type.Number() }),
	output: Type.Object({ order: Type.Array(Type.Integer()), sum: Type.Integer(), rejected: Type.Array(Type.String()) }),
	run: async (ctx, { workers, sleep }) => {
		const coord = ctx.spawn(Report, async (_c, mailbox) => {
			const got: { worker: number; value: number }[] = [];
			for await (const m of mailbox) {
				got.push(m.body);
				if (got.length === workers) break;
			}
			return got;
		});
		const rejected: string[] = [];
		try {
			ctx.send(coord.address, { worker: "one", value: 1 } as never);
		} catch (e) {
			if (!(e instanceof MessageRejected)) throw e;
			rejected.push(...e.errors.map((x) => x.path));
		}
		// Later workers sleep less, so reports arrive out of worker order.
		await ctx.map(
			Array.from({ length: workers }, (_, i) => i),
			async (c, i) => {
				const r = await c.call(work, { n: i, sleep: sleep * (workers - i) });
				c.send(coord.address, { worker: i, value: r.n });
			},
		);
		const got = await coord.result;
		return { order: got.map((g) => g.worker), sum: got.reduce((n, g) => n + g.value, 0), rejected };
	},
});

export const echo = workflow({
	input: Type.Object({}),
	output: Type.Object({ heard: Type.Integer() }),
	run: async (ctx) => {
		const reply = ctx.outbox("reply", Type.String());
		const listener = ctx.spawn(Type.String(), async (c, mailbox) => {
			let heard = 0;
			for await (const m of mailbox) {
				if (m.body === "bye") break;
				heard++;
				c.send(reply, `echo: ${m.body}`, { replyTo: m.id });
			}
			return heard;
		});
		ctx.register("user", listener.address);
		return { heard: await listener.result };
	},
});

export const late = workflow({
	input: Type.Object({}),
	output: Type.Object({ reason: Type.String() }),
	run: async (ctx) => {
		const quick = ctx.spawn(Type.String(), async () => 1);
		await quick.result;
		try {
			ctx.send(quick.address, "too late");
			return { reason: "delivered" };
		} catch (e) {
			if (!(e instanceof MessageRejected)) throw e;
			return { reason: e.reason };
		}
	},
});
