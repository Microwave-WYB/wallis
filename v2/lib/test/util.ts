// Shared by the lib tests. Every test runs with the differential check on:
// after every event, the state rebuilt from the log equals the live state.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

process.env.WALLIS_DIFFERENTIAL = "1";
// Named volumes and wallis's own caches go to a throwaway dir, never the user's ~/.cache.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "wallis-v2-cache-"));

const made: string[] = [process.env.XDG_CACHE_HOME];
after(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A throwaway dir, removed after the test file. */
export function tmp(prefix = "wallis-v2-"): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	made.push(d);
	return d;
}
