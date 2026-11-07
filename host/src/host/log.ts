// The append-only JSONL event log. Run state is a fold over it.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
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
		return complete.filter((l) => l.length > 0).map((l) => JSON.parse(l) as Event);
	}

	append(event: Event): void {
		const fd = openSync(this.path, "a");
		try {
			writeSync(fd, `${JSON.stringify(event)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
}
