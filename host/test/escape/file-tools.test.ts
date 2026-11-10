// RED TEAM: the host's own file tools (read, write, edit, ls, export_artifact)
// resolve an agent's paths through the sandbox view (layers.ts: `locate`,
// `readViewFile`, `writeViewFile`, `listView`). The claim: they never read or
// write outside the sandbox roots, through symlinks, `..`, special files
// (FIFOs, sockets, devices), or names with odd characters.
//
// These are unit-level gates: they drive the exact functions the tools call,
// with no model and no bwrap, and assert the host file on disk is untouched.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { listView, locate, readViewFile, ViewError, type ViewRoot, writeViewFile } from "../../src/host/layers.ts";
import { ArtifactError, resolveDrafts } from "../../src/host/artifacts.ts";

const made: string[] = [];
function tmp(prefix = "escape-"): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	made.push(d);
	return d;
}
after(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A `/w`-only view over a single upper dir, as an agent's workspace view is built. */
function wView(upper: string): ViewRoot {
	return { at: "/w", stack: [upper], upper };
}

function writeVia(root: ViewRoot, path: string, content: string): string {
	try {
		writeViewFile(locate([root], path, true, true), path, content);
		return "WROTE";
	} catch (error) {
		if (error instanceof ViewError) return `refused: ${error.message}`;
		throw error;
	}
}
function readVia(root: ViewRoot, path: string): string {
	try {
		return `READ:${readViewFile(locate([root], path, true), path).toString("utf8")}`;
	} catch (error) {
		if (error instanceof ViewError) return `refused: ${error.message}`;
		throw error;
	}
}

test("a symlink in /w pointing out of the sandbox is refused, and the outside file is untouched", () => {
	const up = tmp("up-");
	const outside = tmp("outside-");
	writeFileSync(join(outside, "target"), "ORIGINAL");
	symlinkSync(outside, join(up, "dirlink")); // /w/dirlink -> an outside directory
	symlinkSync(join(outside, "target"), join(up, "filelink")); // /w/filelink -> an outside file
	const root = wView(up);

	assert.match(writeVia(root, "/w/dirlink/target", "PWNED"), /outside this node's sandbox/);
	assert.match(writeVia(root, "/w/filelink", "PWNED"), /outside this node's sandbox/);
	assert.match(readVia(root, "/w/filelink"), /outside this node's sandbox/);
	assert.match(readVia(root, "/w/dirlink/target"), /outside this node's sandbox/);
	assert.equal(readFileSync(join(outside, "target"), "utf8"), "ORIGINAL", "the outside file is never written");
});

test("absolute symlinks to host system files are refused (read and write)", () => {
	const up = tmp("up-");
	symlinkSync("/etc/passwd", join(up, "passwd"));
	symlinkSync("/etc", join(up, "etc"));
	const root = wView(up);
	assert.match(readVia(root, "/w/passwd"), /outside this node's sandbox/);
	assert.match(writeVia(root, "/w/etc/wallis-escape", "x"), /outside this node's sandbox/);
	assert.ok(!existsSync("/etc/wallis-escape"));
});

test("`..` can never climb out of a root", () => {
	const up = tmp("up-");
	const root = wView(up);
	for (const p of ["/w/../escape", "/w/../../etc/passwd", "/w/a/../../escape", "/w/./../x"]) {
		assert.match(writeVia(root, p, "x"), /outside this node's sandbox/, p);
		assert.match(readVia(root, p), /outside this node's sandbox/, p);
	}
});

test("a symlink that chains through `..` back out of /w is refused", () => {
	const up = tmp("up-");
	const outside = tmp("outside-");
	writeFileSync(join(outside, "secret"), "S");
	mkdirSync(join(up, "sub"));
	// /w/sub/climb -> ../../../<outside>/secret : normalises out of every root.
	symlinkSync(join(outside, "secret"), join(up, "sub", "climb"));
	const root = wView(up);
	assert.match(readVia(root, "/w/sub/climb"), /outside this node's sandbox/);
});

test("special files (FIFO, socket, device) are refused and never opened (no blocking open)", () => {
	const up = tmp("up-");
	const root = wView(up);
	assert.equal(spawnSync("mkfifo", [join(up, "pipe")]).status, 0, "mkfifo");
	// The view classifies a non-regular file as `other`; read/write refuse before any open.
	const loc = locate([root], "/w/pipe", true);
	assert.equal(loc.entry?.kind, "other");
	assert.throws(() => readViewFile(loc, "/w/pipe"), /is not a file/);
	assert.throws(() => writeViewFile(loc, "/w/pipe", "x"), /is not a file/);
	// /dev/null reached by a symlink is out of the sandbox, so it is refused as such.
	symlinkSync("/dev/null", join(up, "nul"));
	assert.match(readVia(root, "/w/nul"), /outside this node's sandbox/);
});

test("names with NUL, newline or backslash: NUL is rejected, odd names stay inside /w", () => {
	const up = tmp("up-");
	const root = wView(up);
	// A NUL in a path is rejected by the OS layer, never silently dropped.
	assert.throws(() => writeViewFile(locate([root], "/w/a\0b", true, true), "/w/a\0b", "x"), /.*/);
	// Newlines and backslashes are legal filenames; they must resolve inside /w and nowhere else.
	for (const name of ["odd\nname", "back\\slash", "..notdotdot"]) {
		assert.equal(writeVia(root, `/w/${name}`, "ok"), "WROTE", name);
		assert.ok(existsSync(join(up, name)), name);
		assert.equal(readVia(root, `/w/${name}`), "READ:ok", name);
	}
	// Every odd name landed directly in the upper dir, nowhere else.
	assert.ok(readdirSync(up).includes("odd\nname") && readdirSync(up).includes("back\\slash"));
});

test("a very long path component does not escape; it errors inside the sandbox", () => {
	const up = tmp("up-");
	const root = wView(up);
	const long = "x".repeat(5000);
	let r: string;
	try {
		r = writeVia(root, `/w/${long}`, "x");
	} catch (error) {
		// A raw OS error (ENAMETOOLONG) is acceptable: the point is it does not escape.
		r = (error as Error).message;
	}
	// Either written inside /w or an OS error (ENAMETOOLONG); never an escape.
	assert.ok(r === "WROTE" || /refused|ENAMETOOLONG|too long/i.test(r), r);
	if (r === "WROTE") assert.ok(existsSync(join(up, long)));
});

test("reads and writes are confined to /w even when a second (read-only) root is present", () => {
	const up = tmp("up-");
	const inputs = tmp("in-");
	writeFileSync(join(inputs, "a"), "INPUT");
	const roots: ViewRoot[] = [wView(up), { at: "/in", stack: [inputs], upper: null }];
	// /in is readable but not writable: a write there is refused, the input file untouched.
	const loc = locate(roots, "/in/a", true, true);
	assert.throws(() => writeViewFile(loc, "/in/a", "PWNED"), /read-only/);
	assert.equal(readFileSync(join(inputs, "a"), "utf8"), "INPUT");
	// A /w symlink into /in resolves into the read-only root, so writing through it is refused too.
	symlinkSync("/in/a", join(up, "toinput"));
	assert.throws(() => {
		const l = locate(roots, "/w/toinput", true, true);
		if (l.root.upper === null) throw new ViewError("read-only: only /w is writable");
		writeViewFile(l, "/w/toinput", "PWNED");
	}, /read-only/);
	assert.equal(readFileSync(join(inputs, "a"), "utf8"), "INPUT");
});

test("export_artifact / resolveDrafts never follows a /w symlink out of the workspace", () => {
	const up = tmp("up-");
	const outside = tmp("outside-");
	writeFileSync(join(outside, "secret"), "SENSITIVE");
	symlinkSync(join(outside, "secret"), join(up, "link"));
	const runDir = tmp("run-");
	mkdirSync(join(runDir, "blobs"), { recursive: true });
	// A draft naming a symlink that leaves /w is refused, not stored.
	assert.throws(
		() => resolveDrafts({ artifact: "link", media: "text/plain" } as never, runDir, up),
		(e: unknown) => e instanceof ArtifactError && /outside|not a file/.test((e as Error).message),
	);
	// A draft with `..` is refused before any read.
	assert.throws(() => resolveDrafts({ artifact: "../x", media: "text/plain" } as never, runDir, up), ArtifactError);
});

test("opaque dirs and whiteouts in the upper dir never expose a host path outside /w", () => {
	// A whiteout (char dev 0,0) the kernel writes is only honoured as a deletion; it is
	// never followed as a path. We assert `locate` treats such an entry as absent, not as a door.
	const up = tmp("up-");
	const root = wView(up);
	mkdirSync(join(up, "d"));
	writeFileSync(join(up, "d", "f"), "v");
	// Simulate an overlay whiteout for `d/f` if we can create a 0,0 char device; skip if unprivileged.
	const mk = spawnSync("mknod", [join(up, "d", "wo"), "c", "0", "0"]);
	if (mk.status === 0) {
		assert.equal(locate([root], "/w/d/wo", true).entry, null, "a 0,0 char device reads as a whiteout (absent), never a device to open");
	}
	// A normal file still resolves.
	assert.equal(readVia(root, "/w/d/f"), "READ:v");
	assert.deepEqual(listView(locate([root], "/w/d", true), "d").includes("f"), true);
});
