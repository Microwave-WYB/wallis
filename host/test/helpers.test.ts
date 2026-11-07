import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeBy, lastN, perKey, topKBy } from "../src/sdk/index.ts";

test("pruning helpers are plain deterministic functions", () => {
	assert.deepEqual(lastN([1, 2, 3, 4], 2), [3, 4]);
	assert.deepEqual(lastN([1, 2], 0), []);
	assert.deepEqual(perKey(["a1", "b1", "a2"], (s) => s[0]!), { a: ["a1", "a2"], b: ["b1"] });
	assert.deepEqual(perKey(["a1", "b1", "a2"], (s) => s[0]!, (g) => g.length), { a: 2, b: 1 });
	const items = [{ n: "x", s: 1 }, { n: "y", s: null }, { n: "z", s: 3 }, { n: "w", s: 1 }];
	assert.deepEqual(topKBy(items, 3, (i) => i.s, "descending").map((i) => i.n), ["z", "x", "w"], "ties keep input order");
	assert.deepEqual(topKBy(items, 4, (i) => i.s, "ascending").map((i) => i.n), ["x", "w", "z", "y"], "unscored last");
	assert.deepEqual(dedupeBy([{ k: 1, v: [1] }, { k: 2, v: [2] }, { k: 1, v: [3] }], (i) => String(i.k), (a, b) => ({ k: a.k, v: [...a.v, ...b.v] })), [{ k: 1, v: [1, 3] }, { k: 2, v: [2] }]);
});
