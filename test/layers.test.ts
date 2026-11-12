// Layers: a call's upper dir becomes an immutable layer (renamed in, only
// its changes hashed); stacks are squashed beyond MAX_DEPTH by hardlinks and
// merged manifests; a commit marker lets a reissued call continue with its
// committed changes.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitLayer, layerDir, layersAfter, MAX_DEPTH, prepareWork, readManifest, removeWork, squash, xattrToolsMissing } from "../src/host/layers.ts";
import { tmp } from "./util.ts";

function layerOf(store: string, build: (upper: string) => void): string {
	const root = join(store, "work", `hand-${Math.random().toString(16).slice(2)}`);
	const work = prepareWork(store, root, []);
	if ("missing" in work) throw new Error("no work");
	build(work.upper);
	return commitLayer(store, work, root)!;
}

test("a call's upper dir is renamed into the store as a layer; nothing changed is no layer", () => {
	const store = tmp();
	const root = join(store, "work", "c");
	const work = prepareWork(store, root, []);
	if ("missing" in work) throw new Error("no work");
	writeFileSync(join(work.upper, "a.txt"), "a");
	const ino = statSync(join(work.upper, "a.txt")).ino;
	const l = commitLayer(store, work, root)!;
	assert.equal(statSync(join(layerDir(store, l), "a.txt")).ino, ino);
	assert.deepEqual(Object.keys(readManifest(store, l)), ["a.txt"]);
	const empty = prepareWork(store, join(store, "work", "d"), []);
	if ("missing" in empty) throw new Error("no work");
	assert.equal(commitLayer(store, empty, join(store, "work", "d")), null);
	assert.deepEqual(prepareWork(store, root, [`sha256:${"1".repeat(64)}`]), { missing: `sha256:${"1".repeat(64)}` });
});

test("a file or symlink over a lower layer's directory replaces it in a squash", () => {
	const dir = tmp();
	const lower = layerOf(dir, (u) => {
		mkdirSync(join(u, "a"));
		writeFileSync(join(u, "a", "x"), "x");
		mkdirSync(join(u, "b"));
		writeFileSync(join(u, "b", "y"), "y");
	});
	const upper = layerOf(dir, (u) => {
		writeFileSync(join(u, "a"), "f");
		symlinkSync("a", join(u, "b"));
	});
	const squashed = readManifest(dir, squash(dir, [lower, upper]));
	assert.deepEqual(Object.keys(squashed).sort(), ["a", "b"]);
	assert.equal(squashed.a!.type, "file");
	assert.equal(squashed.b!.type, "symlink");
});

test("past MAX_DEPTH layers the stack is squashed into one by hardlinks: an unchanged file is never copied", () => {
	const dir = tmp();
	let stack: string[] = [];
	const big = layerOf(dir, (u) => writeFileSync(join(u, "big.bin"), Buffer.alloc(1 << 20, 7)));
	stack = layersAfter(dir, stack, big);
	for (let i = 0; i < MAX_DEPTH; i++) stack = layersAfter(dir, stack, layerOf(dir, (u) => writeFileSync(join(u, `f${i}.txt`), String(i))));
	assert.equal(stack.length, 1);
	const files = readdirSync(layerDir(dir, stack[0]!)).sort();
	assert.equal(files.length, MAX_DEPTH + 1);
	assert.equal(statSync(join(layerDir(dir, stack[0]!), "big.bin")).ino, statSync(join(layerDir(dir, big), "big.bin")).ino);
	// A layer already in the stack (content written back) squashes too: an overlay names a dir once.
	const a = layerOf(dir, (u) => writeFileSync(join(u, "s"), "1"));
	const b = layerOf(dir, (u) => writeFileSync(join(u, "s"), "2"));
	assert.equal(layersAfter(dir, [a, b], a).length, 1);
});

test("a commit marker restores only its own attempt, from the layer, replacing any upper dir left beside it", () => {
	const dir = tmp();
	const committed = layerOf(dir, (u) => writeFileSync(join(u, "done.txt"), "done"));
	const root = join(dir, "work", "_7");
	mkdirSync(join(root, "upper"), { recursive: true });
	writeFileSync(join(root, "upper", "stray.txt"), "half a copy");
	writeFileSync(join(root, "committed"), `${committed} 1`);
	const other = prepareWork(dir, root, [], 2);
	if ("missing" in other) throw new Error("no work");
	assert.ok(!existsSync(join(root, "committed")));
	writeFileSync(join(root, "committed"), `${committed} 2`);
	const mine = prepareWork(dir, root, [], 2);
	if ("missing" in mine) throw new Error("no work");
	assert.deepEqual(readdirSync(mine.upper), ["done.txt"]);
	assert.equal(readFileSync(join(mine.upper, "done.txt"), "utf8"), "done");
});

/** A layer holding a read-only tree (a Go module cache: 0444 files in 0555 dirs). */
function readOnlyLayer(store: string, name: string): string {
	return layerOf(store, (u) => {
		mkdirSync(join(u, "pkg", "mod"), { recursive: true });
		writeFileSync(join(u, "pkg", "mod", `${name}.go`), name);
		chmodSync(join(u, "pkg", "mod", `${name}.go`), 0o444);
		chmodSync(join(u, "pkg", "mod"), 0o555);
	});
}

test("read-only dirs in a layer: a duplicate commit, a squash and a removal all work", () => {
	const store = tmp();
	const a = readOnlyLayer(store, "a");
	// The same content again: the second upper dir is dropped (it holds a 0555 dir).
	assert.equal(readOnlyLayer(store, "a"), a);
	const b = layerOf(store, (u) => writeFileSync(join(u, "b"), "b"));
	const squashed = squash(store, [a, b]);
	assert.equal(statSync(join(layerDir(store, squashed), "pkg", "mod")).mode & 0o777, 0o555);
	assert.equal(readFileSync(join(layerDir(store, squashed), "pkg", "mod", "a.go"), "utf8"), "a");
	removeWork(layerDir(store, squashed));
	assert.ok(!existsSync(layerDir(store, squashed)));
});

test("without getfattr an overlay layer's opaque dirs cannot be told: a clear error, never a silent merge", () => {
	const store = tmp();
	const path = process.env.PATH;
	process.env.PATH = "/nonexistent";
	try {
		assert.equal(xattrToolsMissing(), "getfattr");
		assert.throws(() => layerOf(store, (u) => mkdirSync(join(u, "d"))), /getfattr.*attr/);
	} finally {
		process.env.PATH = path;
	}
});
