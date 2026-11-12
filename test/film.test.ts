// The film example (examples/film, unchanged) end to end on a synthetic roll of three frames:
// negatives once, a single-frame develop preview on its output, delivery with the scripted
// uploader and the fake album (steered through `guidance`), and grading with the scripted grader
// driving the render actor (several jobs before waiting, an invalid one corrected, every render
// looked at). No model is called.

import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { bwrapAvailable } from "../src/host/sandbox.ts";
import { Artifact, attach, run, Tree } from "../src/index.ts";
import { here, project } from "./util.ts";

const skip = !(await bwrapAvailable()) && "bwrap cannot create a sandbox here";
const example = join(here, "../examples/film");

function tree(dir: string, prefix: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			if (statSync(p).isDirectory()) walk(p);
			else out[`${prefix}/${relative(dir, p)}`] = readFileSync(p, "utf8");
		}
	};
	walk(dir);
	return out;
}

const pgm = (w: number, h: number, f: (x: number, y: number) => number, dto: string) => `P2\n# dto ${dto}\n${w} ${h}\n255\n${Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => f(x, y)).join(" ")).join("\n")}\n`;

function roll(root: string) {
	const raw = join(root, "scans");
	const dir = join(root, "roll");
	mkdirSync(raw, { recursive: true });
	mkdirSync(join(dir, "pto"), { recursive: true });
	mkdirSync(join(dir, "base"), { recursive: true });
	const pairs: [string, string][] = [];
	const crops: Record<string, { angle: number; box: number[] }> = {};
	for (let i = 0; i < 3; i++) {
		const [a, b] = [`DSC_000${2 * i + 1}`, `DSC_000${2 * i + 2}`];
		writeFileSync(join(raw, `${a}.pgm`), pgm(6, 4, (x, y) => 40 + 20 * i + 5 * x + y, `2026:01:0${i + 1} 10:00:00`));
		writeFileSync(join(raw, `${b}.pgm`), pgm(6, 4, (x, y) => 60 + 20 * i + 3 * x + y, `2026:01:0${i + 1} 10:00:01`));
		writeFileSync(join(dir, "pto", `f${a.slice(4)}.pto`), "overlap 1\n");
		pairs.push([a, b]);
		crops[a.slice(4)] = { angle: 0, box: [0, 0, 1, 1] };
	}
	writeFileSync(join(dir, "base", "DSC_0000.pgm"), pgm(4, 4, () => 220, "2026:01:01 09:00:00"));
	writeFileSync(join(dir, "pairs.json"), JSON.stringify(pairs));
	writeFileSync(join(dir, "crops.json"), JSON.stringify(crops));
	writeFileSync(join(dir, "roll.json"), JSON.stringify({ base: "DSC_0000", exif: { "Exif.Image.Model": "Synthetic" } }));
	return {
		raw,
		dir,
		meta: { frames: pairs.map(([a, b]) => ({ frame: a.slice(4), halves: [`${a}.pgm`, `${b}.pgm`] as [string, string], crop: crops[a.slice(4)]! })), base: "base/DSC_0000.pgm", exif: { "Exif.Image.Model": "Synthetic" } },
	};
}

const look = { BLACK_SHIFT_D: "0.06", NEG_GAMMA: "2.2", DMIN_SCALE: "[1,1,0.90]", WB_SCALE: "[1.02,0.965,1.00]", CBRGB: "mC=0.015" };

test("the film example on a synthetic roll: negatives, a preview, delivery steered, grading", { skip, timeout: 240_000 }, async () => {
	const root = project({ ...tree(example, "film") }, { models: { default: "faux/scripted" }, executor: join(here, "fixtures/film-executor.ts") });
	const wf = (await import(pathToFileURL(join(root, "film/workflow.ts")).href)) as typeof import("../examples/film/workflow.ts");
	const r0 = roll(root);

	const negatives = await run(wf.negatives, { raw: Tree.from(r0.raw), roll: Tree.from(r0.dir), meta: r0.meta });
	const negs = negatives.output.negs;
	assert.deepEqual(negs.frames.map((f) => f.frame), ["0001", "0003", "0005"]);
	assert.equal(negs.frames[1]!.dto, "2026:01:02 10:00:00");
	assert.match(readFileSync(negs.frames[0]!.negative.path, "utf8"), /^P2\n11 4\n/, "two 6-px halves with a 1-px overlap");

	// The negatives are an input, not recomputed: a preview runs only develop's own calls.
	const preview = await run(wf.develop, { negs, look, only: ["0003"], size: 100 });
	assert.deepEqual(preview.output.images.map((i) => i.frame), ["0003"]);
	assert.equal(readFileSync(preview.output.images[0]!.jpg.path).subarray(1, 4).toString(), "PNG");
	assert.ok(preview.output.sheet);

	// Delivery: the uploader waits for guidance, the caller steers it through `guidance`.
	process.env.FAUX_UPLOADER_WAIT_GUIDANCE = "1";
	try {
		const finishing = run(wf.deliver, { negs, look, album: `test_${Date.now()}` });
		let id = "";
		for (let i = 0; i < 400 && !id; i++) {
			await new Promise((d) => setTimeout(d, 50));
			id = readdirSync(join(root, ".wallis/runs")).find((x) => x.startsWith("deliver")) ?? "";
		}
		const r = attach(wf.deliver, id);
		for (let i = 0; ; i++) {
			try {
				await r.send("guidance", "mention the synthetic roll");
				break;
			} catch (e) {
				if (!/registered no address/.test(String(e)) || i > 400) throw e;
				await new Promise((d) => setTimeout(d, 50));
			}
		}
		const delivered = await finishing;
		assert.equal(delivered.output.verified, 3);
		assert.match(delivered.output.notes, /3\/3 confirmed/);
		assert.match(delivered.output.notes, /retried: DSC_0003\.png/);
		assert.match(delivered.output.notes, /Guidance followed: mention the synthetic roll/);
	} finally {
		delete process.env.FAUX_UPLOADER_WAIT_GUIDANCE;
	}

	// Grading: the grader drives the render actor.
	const graded = await run(wf.grade, { negs, frames: ["0001", "0005"], start: look, reference: Artifact.from(preview.output.images[0]!.jpg.path, { media: "image/png", name: "reference.png" }) });
	// `grade`'s output is `grader.output`, typed TSchema by the agent API: its Static is unknown.
	const out = graded.output as { look: { WB_SCALE: string }; notes: string };
	assert.equal(out.look.WB_SCALE, "[1.04,0.965,0.98]");
	assert.match(out.notes, /Looked at 2 renders/);
	const tree0 = (await graded.tree()) as { calls: { id: string; label: string }[] };
	const grader = tree0.calls.find((c) => c.label.startsWith("grader"))!;
	const transcript = (await graded.transcript(grader.id as never)) as { text: string };
	assert.match(transcript.text, /send \(error\)/, "the invalid job came back as a tool error");
	assert.equal((transcript.text.match(/read: \[image\]/g) ?? []).length, 2, "it looked at both renders");
});
