// Notifications: which run, which node, the question or a result summary
// (truncated), and how to answer. Backends now: the background `wallis
// wait`, the `wallis pending` hook, and pending items appended to MCP tool
// results. A Paseo backend comes later.

import { type Attention, describe } from "./query.ts";

export interface Notifier {
	notify(items: readonly Attention[]): void | Promise<void>;
}

/** Writes agent-readable text, as `wallis wait` and `wallis pending` do. */
export class TextNotifier implements Notifier {
	readonly #write: (text: string) => void;

	constructor(write: (text: string) => void = (t) => process.stdout.write(`${t}\n`)) {
		this.#write = write;
	}

	notify(items: readonly Attention[]): void {
		if (items.length > 0) this.#write(describe(items));
	}
}

/** Collects text for appending to a tool result. */
export class AppendNotifier implements Notifier {
	text = "";

	notify(items: readonly Attention[]): void {
		this.text = items.length > 0 ? describe(items) : "";
	}
}
