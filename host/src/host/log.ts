// The append-only JSONL event log. Run state is a fold over it.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, truncateSync, writeSync } from "node:fs";
import type { Event } from "./core.ts";

export class EventLog {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	/** Complete lines only: a line cut short by a crash is dropped. */
	read(): Event[] {
		if (!existsSync(this.path)) return [];
		const text = readFileSync(this.path, "utf8");
		const lines = text.split("\n");
		// The last element is empty (text ends with a newline) or a partial line.
		const complete = lines.slice(0, -1);
		// Parsed at the boundary: each line an object with its type (the core decodes the rest).
		return complete.flatMap((l, i): Event[] => {
			if (l.length === 0) return [];
			const raw: unknown = JSON.parse(l);
			if (raw === null || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as { type?: unknown }).type !== "string") throw new Error(`${this.path}:${i + 1} is not an event`);
			return [raw as Event];
		});
	}

	/**
	 * Appends one event. A line a crash cut short is cut off first (back to
	 * the last newline), so the new line never continues it.
	 */
	append(event: Event): void {
		if (existsSync(this.path)) {
			const size = statSync(this.path).size;
			if (size > 0) {
				const text = readFileSync(this.path);
				const end = text.lastIndexOf(0x0a) + 1;
				if (end !== size) truncateSync(this.path, end);
			}
		}
		const fd = openSync(this.path, "a");
		try {
			writeSync(fd, `${JSON.stringify(event)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
}
