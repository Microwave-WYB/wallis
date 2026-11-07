// Recovery without a framework: everything lands in work/, every expensive
// step writes one file and is skipped when that file exists, and agents
// save their session (lib/agent.ts `session`). Re-running the
// program is the resume.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Runs `fn` once: its JSON result is stored at `file` (atomically) and reused on later runs. */
export async function step<T>(file: string, fn: () => Promise<T>): Promise<T> {
	if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
	const value = await fn();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
	renameSync(`${file}.tmp`, file);
	return value;
}
