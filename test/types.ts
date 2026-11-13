// Compile-time guarantees (typechecked, never run): each `@ts-expect-error` line must keep failing.
import { Address, agent, NodeFailed, sessionOf, Type, workflow } from "../src/index.ts";

const uploader = agent({ model: "default", prompt: "x", input: Type.Object({ album: Type.String() }), output: Type.Object({ uploaded: Type.Integer(), notes: Type.String() }), mailbox: Type.String() });
const quiet = agent({ model: "default", prompt: "x", input: Type.Object({}), output: Type.Object({}) });
const asker = agent({ model: "default", prompt: "x", input: Type.Object({ to: Address(Type.String()) }), output: Type.Object({}) });

// An agent's output schema is typed: a workflow returning it checks against it.
export const typed = workflow({
	input: Type.Object({}),
	output: uploader.output,
	run: async () => ({ uploaded: 1, notes: "ok" }),
});
export const wrong = workflow({
	input: Type.Object({}),
	output: uploader.output,
	// @ts-expect-error: `uploaded` is an integer
	run: async () => ({ uploaded: "one", notes: "ok" }),
});

workflow({
	input: Type.Object({}),
	output: Type.Object({}),
	run: async (ctx) => {
		const numbers = ctx.spawn(Type.Number(), async () => {});
		const strings = ctx.spawn(Type.String(), async () => {});
		await ctx.call(asker, { to: strings.address });
		// @ts-expect-error: an Address<number> is no Address<string>
		await ctx.call(asker, { to: numbers.address });
		// An envelope's `from` (an Address<unknown>) goes into an Address(T) input: checked at call start.
		const relay = ctx.spawn(Type.Object({ ask: Type.String() }), async (c, mailbox) => {
			for await (const m of mailbox) await c.call(asker, { to: m.from });
		});
		void relay;
		// @ts-expect-error: an agent without a mailbox has no address to send to
		await ctx.call(asker, { to: ctx.start(quiet, {}).address });
		try {
			await ctx.call(uploader, { album: "a" });
		} catch (e) {
			if (e instanceof NodeFailed && e.reason.type === "turn_limit_reached") {
				// The failure's session is of an unknown agent: its output is `unknown` until typed.
				const [raw] = await ctx.call(e.reason.session, { album: "a" }, { turns: 10 });
				// @ts-expect-error: an unknown agent's output has no known fields
				void raw.uploaded;
				// sessionOf types it by its agent (checked at run time): its input and output are the agent's.
				const s = sessionOf(uploader, e.reason.session);
				const [out] = await ctx.call(s, { album: "a" }, { turns: 10 });
				const n: number = out.uploaded;
				void n;
				// @ts-expect-error: the uploader takes an album
				await ctx.call(s, { albums: 1 }, { turns: 10 });
			}
		}
		return {};
	},
});
