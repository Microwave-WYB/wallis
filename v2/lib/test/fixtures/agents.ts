// Agents on the faux provider: one-shot and session calls, the send tool,
// mailbox turns, the turn budget.

import { Address, agent, Type, workflow } from "wallis";

const answerer = agent({
	model: "default",
	prompt: "Answer the question.",
	input: Type.Object({ question: Type.String() }),
	output: Type.Object({ answer: Type.Integer() }),
	turns: 4,
});

export const one = workflow({
	input: Type.Object({ question: Type.String() }),
	output: Type.Object({ answer: Type.Integer() }),
	run: async (ctx, i) => ctx.call(answerer, i),
});

export const dialogue = workflow({
	input: Type.Object({}),
	output: Type.Object({ first: Type.Integer(), second: Type.Integer() }),
	run: async (ctx) => {
		const [a, next] = await ctx.call(ctx.session(answerer), { question: "first" });
		const [b] = await ctx.call(next, { question: "second" });
		return { first: a.answer, second: b.answer };
	},
});

const Job = Type.Object({ frame: Type.String() });
const worker = agent({
	model: "default",
	prompt: "Ask the renderer, wait for its answer, submit it.",
	input: Type.Object({ renderer: Address(Job) }),
	output: Type.Object({ got: Type.String() }),
	mailbox: Type.Object({ result: Type.String() }),
	turns: 10,
});

export const asking = workflow({
	input: Type.Object({}),
	output: Type.Object({ got: Type.String(), jobs: Type.Integer() }),
	run: async (ctx) => {
		let jobs = 0;
		const renderer = ctx.spawn(Job, async (c, mailbox) => {
			for await (const m of mailbox) {
				jobs++;
				c.send(m.from, { result: `rendered ${m.body.frame}` }, { replyTo: m.id });
			}
		});
		const out = await ctx.call(worker, { renderer: renderer.address });
		return { ...out, jobs };
	},
});

export const mismatched = workflow({
	input: Type.Object({}),
	output: Type.Object({ got: Type.String() }),
	run: async (ctx) => {
		// An address whose mailbox takes another schema than the agent's Address(Job) input.
		const other = ctx.spawn(Type.Object({ frame: Type.Integer() }), async () => {});
		return ctx.call(worker, { renderer: other.address as never });
	},
});

const limited = agent({
	model: "default",
	prompt: "Upload everything.",
	input: Type.Object({ files: Type.Integer() }),
	output: Type.Object({ uploaded: Type.Integer() }),
	turns: 2,
});

export const budget = workflow({
	input: Type.Object({ files: Type.Integer() }),
	output: Type.Object({ uploaded: Type.Integer() }),
	run: async (ctx, i) => ctx.call(limited, i),
});
