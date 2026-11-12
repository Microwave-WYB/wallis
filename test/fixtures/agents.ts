// Agents on the faux provider: one-shot and session calls, the send tool,
// mailbox turns, the turn budget.

import { Address, agent, Tree, Type, workflow } from "wallis";

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

const steerable = agent({
	model: "default",
	prompt: "Work until told otherwise.",
	input: Type.Object({}),
	output: Type.Object({ heard: Type.String() }),
	mailbox: Type.String(),
	turns: 6,
});

export const steered = workflow({
	input: Type.Object({}),
	output: Type.Object({ heard: Type.String() }),
	run: async (ctx) => {
		const job = ctx.start(steerable, {});
		ctx.register("steer", job.address);
		return job.result;
	},
});

export const toClosed = workflow({
	input: Type.Object({}),
	output: Type.Object({ got: Type.String(), jobs: Type.Integer() }),
	run: async (ctx) => {
		// An actor that has already returned: its mailbox is closed.
		const gone = ctx.spawn(Job, async () => {});
		await gone.result;
		const out = await ctx.call(worker, { renderer: gone.address });
		return { ...out, jobs: 0 };
	},
});

export const lingering = workflow({
	input: Type.Object({}),
	output: Type.Object({ heard: Type.String() }),
	mailbox: Type.String(),
	run: async (ctx, _input, mailbox) => {
		const job = ctx.start(steerable, {});
		ctx.register("steer", job.address);
		ctx.register("self", ctx.self);
		const out = await job.result;
		// The agent has returned; the body waits for the caller's last word.
		await mailbox.receive();
		return out;
	},
});

const noter = agent({
	model: "default",
	prompt: "Keep notes.",
	input: Type.Object({ n: Type.Integer() }),
	output: Type.Object({ text: Type.String() }),
	workspace: { access: "write" },
	turns: 6,
});

export const notes = workflow({
	input: Type.Object({}),
	output: Type.Object({ text: Type.String(), tree: Tree() }),
	run: async (ctx) => {
		const [, s1] = await ctx.call(ctx.session(noter), { n: 1 });
		const [out, s2] = await ctx.call(s1, { n: 2 });
		return { text: out.text, tree: ctx.files(s2) };
	},
});
