// Tools whose names clash: `first` and `second` are both named `dup`;
// `reader` takes the built-in name `read`; `search` is exported by
// other.ts too.

import { Type, type WallisTool } from "wallis";

const Empty = Type.Object({});
const which = (name: string, export_: string) =>
	({
		name,
		label: name,
		description: `Says ${export_}.`,
		parameters: Empty,
		outputSchema: Type.Object({ which: Type.String() }),
		annotations: { readOnlyHint: true },
		execute: async () => ({ content: [{ type: "text", text: export_ }], details: undefined, structuredContent: { which: export_ } }),
	}) satisfies WallisTool<typeof Empty>;

export const first = which("dup", "first");
export const second = which("dup", "second");
export const reader = which("read", "reader");
export const search = which("search", "lib");
