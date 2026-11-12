// `workflow({ input, output, mailbox?, run })`: a plain value. Its identity
// is its definition's digest; its definition site (the module that holds it)
// is where a detached or resumed run imports it from.

import type { Static, TSchema } from "typebox";
import { DEF, definitionSite, type WorkflowDef } from "./nodes.ts";
import type { Ctx, Mailbox, Workflow } from "./runtime.ts";
import { canonical, sha256 } from "./values.ts";

export function workflow<IS extends TSchema, OS extends TSchema, MS extends TSchema = never>(def: {
	readonly input: IS;
	readonly output: OS;
	/** The body's own mailbox (for approvals it waits on). Its address is `ctx.self`. */
	readonly mailbox?: MS;
	readonly run: (ctx: Ctx<[MS] extends [never] ? never : Static<MS>>, input: Static<IS>, mailbox: Mailbox<[MS] extends [never] ? never : Static<MS>>) => Promise<Static<OS>>;
}): Workflow<IS, OS, [MS] extends [never] ? never : Static<MS>> {
	const site = definitionSite("workflow");
	const digest = sha256(canonical({ kind: "workflow", input: def.input, output: def.output, mailbox: def.mailbox ?? null, run: def.run.toString() }));
	const d: WorkflowDef = { input: def.input, output: def.output, mailbox: def.mailbox ?? null, run: def.run as WorkflowDef["run"], digest, site, label: site.label };
	return Object.freeze({ kind: "workflow" as const, input: def.input, output: def.output, [DEF]: d });
}
