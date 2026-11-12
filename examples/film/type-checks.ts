// Counterexamples: each line must fail to typecheck (the API rejects these mistakes).
import { run, Tree, workflow, Type } from "wallis";
import { develop, Look, Negs } from "./workflow.ts";

declare const look: import("wallis").Static<typeof Look>;
declare const negs: import("wallis").Static<typeof Negs>;

// @ts-expect-error: develop needs negs, not a raw Tree
await run(develop, { negs: Tree.from("x"), look, size: 800 });
// @ts-expect-error: size is a number or "final"
await run(develop, { negs, look, size: "big" });
// @ts-expect-error: develop's output has no `negs`
(await run(develop, { negs, look, size: 800 })).output.negs;

workflow({
	input: Type.Object({}),
	output: Type.Object({ n: Type.Integer() }),
	run: async (ctx) => {
		const a = ctx.spawn(Type.Object({ frame: Type.String() }), async (_c, mailbox) => {
			for await (const m of mailbox) {
				// @ts-expect-error: the message body has no `size`
				m.body.size;
			}
			return 1;
		});
		// @ts-expect-error: wrong message type for this address
		ctx.send(a.address, { frame: 1 });
		ctx.send(a.address, { frame: "2835" });
		// @ts-expect-error: the actor's result is a number, not a string
		const s: string = await a.result;
		return { n: s.length };
	},
});
