// Custom tools of the acceptance workflow. Each call appends its name to
// COUNT_FILE (the only secret this toolset gets), so the test counts calls
// of the outside world.
//   upload   unannotated (so: may write outside); not safe to repeat. The
//            first call blocks until the host is killed; later ones return.
//   publish  the body's outward write; not safe to repeat either. Its first
//            call blocks too.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Type, type WallisTool } from "wallis";

const count = (tool: string) => {
	const file = process.env.COUNT_FILE!;
	const before = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l === tool).length : 0;
	appendFileSync(file, `${tool}\n`);
	return before;
};

const Upload = Type.Object({ name: Type.String() });
export const upload = {
	name: "upload",
	label: "upload",
	description: "Upload a file by name; returns its URL.",
	parameters: Upload,
	outputSchema: Type.Object({ url: Type.String() }),
	execute: async (_id, params, signal) => {
		if (count("upload") === 0) await new Promise((r) => (signal?.addEventListener("abort", r), setTimeout(r, 120_000)));
		const url = `https://example.test/${params.name}`;
		return { content: [{ type: "text", text: url }], details: undefined, structuredContent: { url } };
	},
} satisfies WallisTool<typeof Upload>;

const Publish = Type.Object({ text: Type.String() });
export const publish = {
	name: "publish",
	label: "publish",
	description: "Publish a note.",
	parameters: Publish,
	outputSchema: Type.Object({ id: Type.String() }),
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	execute: async (_id, params, signal) => {
		if (count("publish") === 0) await new Promise((r) => (signal?.addEventListener("abort", r), setTimeout(r, 120_000)));
		return { content: [{ type: "text", text: "published" }], details: undefined, structuredContent: { id: `note-${params.text.length}` } };
	},
} satisfies WallisTool<typeof Publish>;
