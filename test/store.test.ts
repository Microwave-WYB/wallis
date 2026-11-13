// The project's content-addressed store: blobs and Trees (layers), ingested
// by move (a discardable scratch dir: no copy) or by reflink copy (with a
// (path, size, mtime) hash cache), and prune, which deletes only what no
// run's log names.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { putDialogue } from "../src/host/dialogues.ts";
import { Store } from "../src/host/store.ts";
import { tmp } from "./util.ts";

const project = () => {
	const root = tmp();
	return { root, store: new Store(root) };
};

test("a value is a read-only blob named by its sha256, stored once", () => {
	const { store } = project();
	const d = store.putText("hello");
	assert.equal(d, "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
	assert.equal(store.putText("hello"), d);
	assert.equal(store.readText(d), "hello");
	assert.equal(statSync(store.blobPath(d)).mode & 0o777, 0o444);
	assert.equal(store.readText(`sha256:${"0".repeat(64)}`), null);
	assert.equal(readdirSync(store.blobs).length, 1);
});

test("ingesting by move renames the file in (no copy); by copy leaves the source", () => {
	const { root, store } = project();
	const scratch = join(root, "scratch");
	mkdirSync(scratch);
	writeFileSync(join(scratch, "neg.tif"), "pixels");
	const ino = statSync(join(scratch, "neg.tif")).ino;
	const d = store.ingestFile(join(scratch, "neg.tif"), { move: true });
	assert.ok(!existsSync(join(scratch, "neg.tif")));
	assert.equal(statSync(store.blobPath(d)).ino, ino, "the same inode: renamed, not copied");
	const src = join(root, "kept.txt");
	writeFileSync(src, "pixels");
	assert.equal(store.ingestFile(src, { move: false }), d);
	assert.equal(readFileSync(src, "utf8"), "pixels");
	// A second move of the same content drops the source.
	writeFileSync(join(scratch, "again.tif"), "pixels");
	assert.equal(store.ingestFile(join(scratch, "again.tif"), { move: true }), d);
	assert.ok(!existsSync(join(scratch, "again.tif")));
	assert.throws(() => store.ingestFile(scratch, { move: false }), /not a regular file/);
});

test("a copied file is hashed again only when its path, size or mtime changed", () => {
	const { root, store } = project();
	const src = join(root, "a.txt");
	writeFileSync(src, "one");
	const t = new Date(2026, 0, 1);
	utimesSync(src, t, t);
	const first = store.hashOf(src);
	// Same size and mtime, other bytes: the cache answers (this is its contract, and why it is only a cache).
	writeFileSync(src, "two");
	utimesSync(src, t, t);
	assert.equal(store.hashOf(src), first);
	utimesSync(src, new Date(2026, 0, 2), new Date(2026, 0, 2));
	assert.notEqual(store.hashOf(src), first);
});

test("a directory is a one-layer Tree named by its manifest; move and copy agree", () => {
	const { root, store } = project();
	const make = (dir: string) => {
		mkdirSync(join(dir, "sub"), { recursive: true });
		writeFileSync(join(dir, "sub", "f.txt"), "f");
		writeFileSync(join(dir, "g.txt"), "g");
		symlinkSync("sub/f.txt", join(dir, "link"));
	};
	const a = join(root, "a");
	make(a);
	const copied = store.ingestTree(a, { move: false });
	assert.equal(copied.length, 1);
	assert.ok(existsSync(join(a, "g.txt")), "a copy leaves its source");
	assert.equal(readFileSync(join(store.layerDir(copied[0]!), "sub", "f.txt"), "utf8"), "f");
	const b = join(root, "b");
	make(b);
	assert.deepEqual(store.ingestTree(b, { move: true }), copied);
	assert.ok(!existsSync(b), "a move takes its source");
	const c = join(root, "c");
	make(c);
	writeFileSync(join(c, "g.txt"), "changed");
	assert.notDeepEqual(store.ingestTree(c, { move: true }), copied);
	const empty = join(root, "e");
	mkdirSync(empty);
	assert.deepEqual(store.ingestTree(empty, { move: true }), []);
});

test("prune deletes only what no run's log names, directly or through a dialogue chain, and nothing young", () => {
	const { root, store } = project();
	const kept = store.putText("kept artifact");
	const gone = store.putText("orphan");
	const base = putDialogue(store, { messages: [{ role: "user", text: "a" }] }, null);
	const delta = putDialogue(store, { messages: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }] }, { digest: base, state: { messages: [{ role: "user", text: "a" }] } });
	assert.notEqual(base, delta);
	const dir = join(root, "t");
	mkdirSync(dir);
	writeFileSync(join(dir, "x"), "x");
	const [layer] = store.ingestTree(dir, { move: true });
	const orphanDir = join(root, "o");
	mkdirSync(orphanDir);
	writeFileSync(join(orphanDir, "y"), "y");
	const [orphanLayer] = store.ingestTree(orphanDir, { move: true });
	const log = join(root, "log.jsonl");
	writeFileSync(log, `${JSON.stringify({ type: "command_returned", id: "0", output: { a: { digest: kept }, t: { layers: [layer] }, d: delta } })}\n`);
	// Everything is younger than a live run that started before it: kept.
	assert.deepEqual(store.prune([log], 0), { blobs: 0, layers: 0, bytes: 0 });
	const r = store.prune([log], null);
	assert.equal(r.blobs, 1);
	assert.equal(r.layers, 1);
	assert.ok(store.hasBlob(kept) && store.hasBlob(base) && store.hasBlob(delta));
	assert.ok(!store.hasBlob(gone));
	assert.ok(store.hasLayer(layer!) && !store.hasLayer(orphanLayer!));
});

test("a Tree is one digest naming its layers; prune keeps the layers a kept Tree names", () => {
	const { root, store } = project();
	const dir = join(root, "d");
	mkdirSync(dir);
	writeFileSync(join(dir, "a"), "a");
	const tree = store.snapshot(dir, { move: false });
	const layers = store.treeLayers(tree)!;
	assert.equal(layers.length, 1);
	assert.equal(store.snapshot(dir, { move: false }), tree, "the same content is the same Tree");
	assert.equal(store.treeLayers(store.putText("not a tree")), null);
	assert.throws(() => store.putTree([`sha256:${"3".repeat(64)}`]), /not in the store/);
	const log = join(root, "log.jsonl");
	writeFileSync(log, `${JSON.stringify({ type: "body_finished", output: { kind: "tree", digest: tree } })}\n`);
	store.prune([log], null);
	assert.ok(store.hasLayer(layers[0]!));
	writeFileSync(log, "");
	store.prune([log], null);
	assert.ok(!store.hasLayer(layers[0]!) && !store.hasBlob(tree));
});

test("prune removes layers that hold read-only dirs", () => {
	const { root, store } = project();
	const dir = join(root, "ro");
	mkdirSync(join(dir, "pkg"), { recursive: true });
	writeFileSync(join(dir, "pkg", "f"), "f");
	chmodSync(join(dir, "pkg"), 0o555);
	const [layer] = store.ingestTree(dir, { move: true });
	const log = join(root, "log.jsonl");
	writeFileSync(log, "");
	assert.equal(store.prune([log], null).layers, 1);
	assert.ok(!store.hasLayer(layer!));
});

test("prune removes the temp files and dirs a dead process left, never a live one's", () => {
	const root = tmp();
	const store = new Store(root);
	store.putText("x");
	const blobs = join(root, ".wallis/store/blobs");
	const layers = join(root, ".wallis/store/layers");
	mkdirSync(layers, { recursive: true });
	// A pid that is not running (pid_max is at most 2^22).
	const dead = 4_194_303;
	const leftovers = [join(blobs, `.in-${dead}-abcd`), join(layers, `${"a".repeat(64)}.${dead}.tmp`), join(layers, `${"b".repeat(64)}.json.${dead}.tmp`)];
	const live = [join(blobs, `.in-${process.pid}-abcd`), join(layers, `${"c".repeat(64)}.${process.pid}.tmp`)];
	writeFileSync(leftovers[0]!, "partial");
	mkdirSync(join(leftovers[1]!, "sub"), { recursive: true });
	writeFileSync(join(leftovers[1]!, "sub", "f"), "f");
	chmodSync(join(leftovers[1]!, "sub"), 0o555);
	writeFileSync(leftovers[2]!, "{");
	writeFileSync(live[0]!, "being written");
	mkdirSync(live[1]!);
	store.prune([], null);
	for (const p of leftovers) assert.ok(!existsSync(p), `${p} is gone`);
	for (const p of live) assert.ok(existsSync(p), `${p} is kept`);
});

test("exportOutput copies a Tree of several layers as one dir: a file over an earlier layer's dir replaces it", async () => {
	const { exportRefs } = await import("../src/caller.ts");
	const root = tmp();
	const store = new Store(root);
	const a = join(root, "a");
	mkdirSync(join(a, "d"), { recursive: true });
	writeFileSync(join(a, "d", "old.txt"), "old");
	writeFileSync(join(a, "keep.txt"), "keep");
	const b = join(root, "b");
	mkdirSync(b);
	writeFileSync(join(b, "d"), "now a file");
	const [l1] = store.ingestTree(a, { move: false });
	const [l2] = store.ingestTree(b, { move: false });
	const tree = store.putTree([l1!, l2!]);
	const out = join(root, "out");
	mkdirSync(out);
	exportRefs(store, { t: { kind: "tree", digest: tree } }, out);
	const dir = join(out, tree.slice(7, 19));
	assert.equal(readFileSync(join(dir, "d"), "utf8"), "now a file");
	assert.equal(readFileSync(join(dir, "keep.txt"), "utf8"), "keep");
});
