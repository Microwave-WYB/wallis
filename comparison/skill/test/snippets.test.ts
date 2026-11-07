// The snippets beyond the template, on the faux provider.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Type from "typebox";
import { runAgent } from "../template/lib/agent.ts";
import { codemodeTool } from "../snippets/codemode.ts";
import { crossReview, fanOutThenJudge, scoreAll } from "../snippets/patterns.ts";
import { call, faux, newest } from "./faux.ts";

test("fan-out with Promise.all, then a judge that sees every answer", async () => {
	const { seen } = faux((s) => {
		if (s.systemPrompt?.startsWith("Pick")) return call("submit_result", { best: 1, why: "simpler" });
		const n = seen.length;
		return call("submit_result", { title: `idea ${n}`, rationale: "r" });
	});
	const r = await fanOutThenJudge("how?", ["faux/a", "faux/b", "faux/c"], "faux/a");
	assert.equal(r.ideas.length, 3);
	assert.equal(r.chosen, r.ideas[1]);
	const judged = seen.find((s) => s.systemPrompt?.startsWith("Pick"))!;
	for (const idea of r.ideas) assert.ok(newest(judged).includes(idea.title), "the judge got all ideas in its input");
});

test("parallel scoring, sorted in code", async () => {
	faux((s) => call("submit_result", { score: newest(s).includes("beta") ? 9 : 3, reason: "r" }));
	const ranked = await scoreAll(["alpha", "beta", "gamma"], "faux/a");
	assert.deepEqual(ranked.map((r) => r.candidate), ["beta", "alpha", "gamma"]);
});

test("cross-model review: a different model reviews; problems go back to the author once", async () => {
	const { seen } = faux((s) => {
		if (s.systemPrompt?.startsWith("Review")) return call("submit_result", { ok: false, problems: ["off by one"] });
		return call("submit_result", { code: s.systemPrompt?.startsWith("Revise") ? "fixed" : "draft" });
	});
	const r = await crossReview("count", "faux/a", "faux/b");
	assert.equal(r.answer, "fixed");
	assert.ok(seen.some((s) => s.systemPrompt?.startsWith("Revise") && newest(s).includes("off by one")));
});

test("codemode: the model queries a large input with a script; only the small answer enters the context", async () => {
	const big = Array.from({ length: 50_000 }, (_, i) => ({ id: i, value: i % 7 }));
	const { seen } = faux((s) => {
		const last = newest(s);
		if (last.includes("Input")) return call("codemode", { code: "return input.filter((r) => r.value === 3).length;" });
		return call("submit_result", { count: Number(/"text":"(\d+)/.exec(last)![1]) });
	});
	const spill = join(mkdtempSync(join(tmpdir(), "spill-")), "spill.txt");
	const result = await runAgent({ model: "faux/a", system: "Count rows with value 3 using codemode.", output: Type.Object({ count: Type.Integer() }), tools: [codemodeTool(big, [], 8_000, spill)] }, { rows: big.length, note: "the rows are in codemode's `input`" });
	assert.deepEqual(result.type === "submitted" && result.value, { count: big.filter((r) => r.value === 3).length });
	assert.ok(seen.every((s) => JSON.stringify(s.messages).length < 20_000), "the 50k rows never entered the context");
});
