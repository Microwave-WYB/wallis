// RED TEAM: `requires` exposes a program and only the parts of its install
// prefix it may find relative to itself (lib/lib64/libexec/share) — never the
// prefix itself, never $HOME, a dir directly in it (~/.local, ~/.cargo), /opt,
// or a dir holding the project. And nothing a workflow declares may choose or
// steer the host program wallis spawns (bwrap, systemd-run): those resolve
// from wallis's OWN PATH, by absolute path.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { installPrefix, programBinds } from "../../src/host/confine.ts";
import { hostProgram, sandboxEnvProblem, secretEnvProblem } from "../../src/host/hostbin.ts";

const made: string[] = [];
function tmp(prefix = "escape-"): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	made.push(d);
	return d;
}
after(() => {
	for (const d of made) rmSync(d, { recursive: true, force: true });
});

const HOME = "/home/alice";

test("a program directly under $HOME or a dir in it exposes only the program, never the home dir", () => {
	// ~/.local/bin/tool -> prefix ~/.local (a dir directly in $HOME): unsafe, program alone.
	assert.deepEqual(programBinds("/home/alice/.local/bin/tool", { home: HOME }), ["/home/alice/.local/bin/tool"]);
	assert.deepEqual(programBinds("/home/alice/.cargo/bin/rg", { home: HOME }), ["/home/alice/.cargo/bin/rg"]);
	// ~/bin/x -> prefix $HOME itself: unsafe.
	assert.deepEqual(programBinds("/home/alice/bin/x", { home: HOME }), ["/home/alice/bin/x"]);
	// A program that is literally in $HOME's child with no bin/ dir: prefix is its dir === a child of home -> unsafe.
	assert.deepEqual(programBinds("/home/alice/tools/x", { home: HOME }), ["/home/alice/tools/x"]);
});

test("a program under /opt exposes neither /opt nor the prefix itself", () => {
	// /opt/bin/foo -> prefix /opt: unsafe, program alone.
	assert.deepEqual(programBinds("/opt/bin/foo", { home: HOME }), ["/opt/bin/foo"]);
	// /opt/thing/bin/foo -> prefix /opt/thing is allowed, but only its lib*/share subdirs (that exist) are bound, never /opt/thing itself.
	const binds = programBinds("/opt/thing/bin/foo", { home: HOME });
	assert.equal(binds[0], "/opt/thing/bin/foo");
	assert.ok(!binds.includes("/opt"), "never /opt");
	assert.ok(!binds.includes("/opt/thing"), "never the prefix itself");
	for (const b of binds.slice(1)) assert.match(b, /\/opt\/thing\/(lib|lib64|libexec|share)$/);
});

test("a program whose prefix holds the project exposes only the program", () => {
	const root = "/work/project";
	// A node_modules bin under the project: prefix would be /work/project/node_modules, which contains the root? No —
	// the rule refuses when the prefix EQUALS or is an ancestor of root. Use a prefix that is the root's ancestor.
	assert.deepEqual(programBinds("/work/project/.bin/tool", { home: HOME, root }), ["/work/project/.bin/tool"]);
	// A program whose install prefix is an ancestor of the project (prefix /work, root /work/project): unsafe.
	assert.deepEqual(programBinds("/work/bin/tool", { home: HOME, root: "/work/project" }), ["/work/bin/tool"]);
});

test("a program under the host base (/usr, ...) needs no binds: the base is already there", () => {
	assert.deepEqual(programBinds("/usr/bin/python3", { home: HOME }), []);
	assert.deepEqual(programBinds("/bin/sh", { home: HOME }), []);
});

test("installPrefix: the dir above bin/, else the program's own dir", () => {
	assert.equal(installPrefix("/opt/thing/bin/foo"), "/opt/thing");
	assert.equal(installPrefix("/opt/thing/foo"), "/opt/thing");
});

test("host programs resolve by absolute path from wallis's own PATH, not from any declaration", () => {
	// hostProgram returns an absolute path (or the bare name only if genuinely not found).
	const bwrap = hostProgram("bwrap");
	assert.ok(bwrap === "bwrap" || bwrap.startsWith("/"), bwrap);
	// A name that cannot be on any PATH resolves to the bare name (never a relative/injected path).
	assert.equal(hostProgram("definitely-not-a-real-host-binary-xyz"), "definitely-not-a-real-host-binary-xyz");
});

test("the environment-key guards reject PATH/HOME/WALLIS_*/LD_*, and secrets also reject host-steering names", () => {
	for (const key of ["PATH", "HOME", "WALLIS_ENV", "LD_PRELOAD", "LD_LIBRARY_PATH", "9BAD", "a-b"]) {
		assert.notEqual(sandboxEnvProblem(key), null, key);
	}
	assert.equal(sandboxEnvProblem("DARKTABLE_FLAGS"), null);
	// Secrets reject everything the sandbox guard does, plus loader/libc/systemd/D-Bus steering.
	for (const key of ["GCONV_PATH", "GLIBC_TUNABLES", "LOCPATH", "TZDIR", "MALLOC_CONF", "SYSTEMD_X", "DBUS_X", "BWRAP_X"]) {
		assert.notEqual(secretEnvProblem(key), null, key);
	}
	assert.equal(secretEnvProblem("S2_API_KEY"), null);
});
