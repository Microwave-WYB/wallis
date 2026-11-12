// Shared by the lib tests. Every test runs with the differential check on:
// after every event, the state rebuilt from the log equals the live state.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { removeWork } from "../src/host/layers.ts";

process.env.WALLIS_DIFFERENTIAL = "1";
// Named volumes and wallis's own caches go to a throwaway dir, never the user's ~/.cache.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "wallis-v2-cache-"));

const made: string[] = [process.env.XDG_CACHE_HOME];
after(() => {
	// Tests leave read-only trees (0555 dirs) behind: made writable first.
	for (const d of made) removeWork(d);
});

/** A throwaway dir, removed after the test file. */
export function tmp(prefix = "wallis-v2-"): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	made.push(d);
	return d;
}

import { mkdirSync as mkdir, writeFileSync as write } from "node:fs";
import { dirname as dirOf } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX = new URL("../src/index.ts", import.meta.url).href;
const TESTING = new URL("../src/testing.ts", import.meta.url).href;

/**
 * A throwaway project: `files` written under a fresh dir with a
 * package.json (so it is the project root); `from "wallis"` imports point at
 * this lib. `config` becomes `.wallis/config.json`.
 */
export function project(files: Record<string, string>, config?: object): string {
	const root = tmp("wallis-v2-project-");
	write(join(root, "package.json"), '{ "type": "module" }\n');
	for (const [name, text] of Object.entries(files)) {
		mkdir(dirOf(join(root, name)), { recursive: true });
		// A toolset module keeps its bare "wallis" import: the bundler gives it the schema builder.
		const toolset = /(^|\/)tools\//.test(name);
		write(join(root, name), toolset ? text : text.replaceAll('from "wallis/testing"', `from ${JSON.stringify(TESTING)}`).replaceAll('from "wallis"', `from ${JSON.stringify(INDEX)}`));
	}
	if (config) {
		mkdir(join(root, ".wallis"), { recursive: true });
		write(join(root, ".wallis", "config.json"), JSON.stringify(config));
	}
	return root;
}

export const here = dirOf(fileURLToPath(import.meta.url));
