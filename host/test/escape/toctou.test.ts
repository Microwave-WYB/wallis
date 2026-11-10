// RED TEAM: the host file tools resolve a path with `locate` (lstat per
// component, refusing host symlinks) and THEN open it. The claim is that they
// are safe against "races (TOCTOU between check and open)". They are not: an
// agent's own `bash` shares the `/w` upper directory with the host file tools,
// so it can swap an intermediate path component for a symlink to the host root
// in the window between `locate`'s lstat and the tool's `openSync`. `O_NOFOLLOW`
// only guards the FINAL component, so the open follows the swapped intermediate
// symlink out of the sandbox.
//
// ESCAPE-02 is closed: the tools now open every component relative to its
// parent's fd with O_NOFOLLOW (`openBeneath`, layers.ts), so a swap fails
// the open. These were todos while the hole was open; they are the gate now.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { locate, readViewFile, ViewError, type ViewRoot } from "../../src/host/layers.ts";

const racer = join(import.meta.dirname, "fixtures", "swap-racer.mjs");
const made: string[] = [];
function tmp(prefix = "escape-"): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	made.push(d);
	return d;
}
after(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

/**
 * Runs the swap racer against `<up>/a` and, for up to `budgetMs`, repeatedly
 * resolves `/w/a/<decoy>` through the view and reads it. Returns the first
 * out-of-sandbox content read, or null if the race was not won in time.
 */
function raceRead(up: string, outside: string, decoy: string, budgetMs: number): string | null {
	const child = spawn(process.execPath, [racer, up, outside, decoy], { stdio: "ignore" });
	try {
		const root: ViewRoot = { at: "/w", stack: [up], upper: up };
		const start = Date.now();
		while (Date.now() - start < budgetMs) {
			try {
				const content = readViewFile(locate([root], "/w/a/" + decoy, true), "/w/a/" + decoy).toString("utf8");
				if (!content.includes("INSIDE-THE-SANDBOX")) return content; // read something from outside /w
			} catch (error) {
				if (!(error instanceof ViewError)) continue; // ENOENT mid-swap: just retry
			}
		}
		return null;
	} finally {
		child.kill("SIGKILL");
	}
}

test(
	"host `read` tool cannot be raced into reading a file outside /w (TOCTOU on an intermediate dir)",
	() => {
		const up = tmp("toctou-up-");
		const outside = tmp("toctou-outside-");
		writeFileSync(join(outside, "loot"), "HOST-FILE-CONTENTS-STOLEN\n");
		const stolen = raceRead(up, outside, "loot", 12_000);
		// If the claim held, the read could never return the outside file's contents.
		assert.equal(stolen, null, `the read tool was raced into reading outside /w: ${JSON.stringify(stolen)}`);
	},
);

test(
	"host `read` tool cannot be raced into reading a host system file (/etc) via an intermediate symlink swap",
	() => {
		const up = tmp("toctou-up-");
		// The decoy name matches a real file under /etc, so when `a` becomes a symlink to /etc the open succeeds.
		const stolen = raceRead(up, "/etc", "hostname", 12_000);
		assert.equal(stolen, null, `the read tool was raced into reading /etc/hostname: ${JSON.stringify(stolen)}`);
	},
);

/** The racer against a write (`write`/`edit`) or an artifact draft (`export_artifact`), for `budgetMs`. */
function raceUse(up: string, outside: string, decoy: string, budgetMs: number, use: (root: ViewRoot) => void): void {
	const child = spawn(process.execPath, [racer, up, outside, decoy], { stdio: "ignore" });
	try {
		const root: ViewRoot = { at: "/w", stack: [up], upper: up };
		const start = Date.now();
		while (Date.now() - start < budgetMs) {
			try {
				use(root);
			} catch (error) {
				if (!(error instanceof ViewError) && !(error instanceof Error && /artifact|ENOENT|EEXIST/.test(error.message))) throw error;
			}
		}
	} finally {
		child.kill("SIGKILL");
	}
}

test("host `write` tool cannot be raced into writing a file outside /w (TOCTOU on an intermediate dir)", async () => {
	const { writeViewFile } = await import("../../src/host/layers.ts");
	const { existsSync } = await import("node:fs");
	const up = tmp("toctou-up-");
	const outside = tmp("toctou-outside-");
	writeFileSync(join(outside, "victim"), "ORIGINAL\n");
	raceUse(up, outside, "victim", 4_000, (root) => writeViewFile(locate([root], "/w/a/victim", true, true), "/w/a/victim", "PWNED\n"));
	assert.equal(readFileSync(join(outside, "victim"), "utf8"), "ORIGINAL\n", "a host file outside /w was overwritten");
	raceUse(up, outside, "victim", 2_000, (root) => writeViewFile(locate([root], "/w/a/new-file", true, true), "/w/a/new-file", "PWNED\n"));
	assert.ok(!existsSync(join(outside, "new-file")), "a file was created outside /w");
});

test("export_artifact cannot be raced into storing a host file outside /w", async () => {
	const { resolveDrafts } = await import("../../src/host/artifacts.ts");
	const up = tmp("toctou-up-");
	const outside = tmp("toctou-outside-");
	writeFileSync(join(outside, "loot"), "HOST-FILE-CONTENTS-STOLEN\n");
	const run = tmp("toctou-run-");
	mkdirSync(join(run, "blobs"), { recursive: true });
	raceUse(up, outside, "loot", 4_000, () => {
		const ref = resolveDrafts({ artifact: "a/loot", media: "text/plain" }, run, up) as { digest: string };
		const content = readFileSync(join(run, "blobs", ref.digest.slice("sha256:".length)), "utf8");
		assert.ok(content.includes("INSIDE-THE-SANDBOX"), `stored a file from outside /w: ${JSON.stringify(content)}`);
	});
});

test("host `ls` tool cannot be raced into listing a dir outside /w", async () => {
	const { listView } = await import("../../src/host/layers.ts");
	const up = tmp("toctou-up-");
	const outside = tmp("toctou-outside-");
	writeFileSync(join(outside, "secret-name"), "x");
	raceUse(up, outside, "decoy", 4_000, (root) => {
		const names = listView(locate([root], "/w/a", true), "/w/a");
		assert.ok(!names.includes("secret-name"), `listed a dir outside /w: ${names.join(", ")}`);
	});
});
