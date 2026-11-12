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

	/** The byte length of the complete lines, once known: appends then never read the file. */
	#end: number | null = null;

	/**
	 * Appends one event. A line a crash cut short is cut off first (back to
	 * the last newline), so the new line never continues it. The file is read
	 * for that only when its size is not the end this log last wrote.
	 */
	append(event: Event): void {
		const size = existsSync(this.path) ? statSync(this.path).size : 0;
		if (size !== this.#end) {
			const end = size === 0 ? 0 : readFileSync(this.path).lastIndexOf(0x0a) + 1;
			if (end !== size) truncateSync(this.path, end);
			this.#end = end;
		}
		const line = Buffer.from(`${JSON.stringify(event)}\n`);
		const fd = openSync(this.path, "a");
		try {
			writeSync(fd, line);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		this.#end += line.length;
	}
}
