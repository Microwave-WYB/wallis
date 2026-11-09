// A second toolset that also exports a tool named `search`.

import { Type, type WallisTool } from "wallis";

const Empty = Type.Object({});
export const search = {
	name: "search",
	label: "search",
	description: "Says other.",
	parameters: Empty,
	annotations: { readOnlyHint: true },
	execute: async () => ({ content: [{ type: "text", text: "other" }], details: undefined }),
} satisfies WallisTool<typeof Empty>;
