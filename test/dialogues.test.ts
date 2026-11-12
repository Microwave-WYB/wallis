// Dialogue blobs: a checkpoint that extends its base is a delta; after a
// compaction, or past the chain's depth, it is whole. Reading resolves the
// chain.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Json } from "../src/host/core.ts";
import { putDialogue, readDialogue } from "../src/host/dialogues.ts";
import { Store } from "../src/host/store.ts";
import { tmp } from "./util.ts";

const msgs = (n: number): Json => ({ messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `m${i}` })) });

test("a checkpoint extending its base is stored as a delta and read back whole", () => {
	const store = new Store(tmp());
	const base = putDialogue(store, msgs(2), null);
	const next = putDialogue(store, msgs(4), { digest: base, state: msgs(2) });
	assert.match(store.readText(next)!, /"delta"/);
	assert.deepEqual(readDialogue(store, next), msgs(4));
});

test("a compacted dialogue, or one that does not extend its base, is whole; a missing base reads as undefined", () => {
	const store = new Store(tmp());
	const base = putDialogue(store, msgs(2), null);
	const compacted = putDialogue(store, { ...(msgs(3) as object), compacted: { summary: "s" } } as Json, { digest: base, state: msgs(2) });
	assert.match(store.readText(compacted)!, /"whole"/);
	const other = putDialogue(store, { messages: [{ role: "user", text: "x" }] }, { digest: base, state: msgs(2) });
	assert.match(store.readText(other)!, /"whole"/);
	assert.equal(readDialogue(store, `sha256:${"2".repeat(64)}`), undefined);
});

test("the delta chain is bounded: a long chain stores a whole checkpoint", () => {
	const store = new Store(tmp());
	let digest = putDialogue(store, msgs(1), null);
	for (let n = 2; n < 40; n++) digest = putDialogue(store, msgs(n), { digest, state: msgs(n - 1) });
	assert.deepEqual(readDialogue(store, digest), msgs(39));
});
