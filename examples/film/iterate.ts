// How the orchestrating agent (Claude Code, pi) iterates with the human: each step is a short
// script, or `node -e`, that imports the workflows and calls the caller API. The run ids in the
// conversation are the history; `attach` picks an earlier run's output back up.
//
//   node iterate.ts negatives <raw dir> <roll dir>
//   node iterate.ts preview <negatives run> <look.json> [frame...]
//   node iterate.ts final <negatives run> <look.json> <export dir>
//   node iterate.ts deliver <negatives run> <look.json> <album>      (only after the human said yes)
//   node iterate.ts grade <negatives run> <look.json> <reference.jpg> <frame...>
//   node iterate.ts recover <run> [<call id> <turns>]                 after a failure (see below)

import { readFileSync } from "node:fs";
import { Artifact, attach, run, Tree, type CallId, type FailedCall, type Static } from "wallis";
import { deliver, develop, grade, Look, negatives, RollMeta } from "./workflow.ts";

const [step, ...args] = process.argv.slice(2);
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const look = (path: string): Static<typeof Look> => json(path);
/** The roll directory's JSON files, as plain input data (the run checks it against RollMeta). */
const rollMeta = (dir: string): Static<typeof RollMeta> => {
	const pairs: [string, string][] = json(`${dir}/pairs.json`);
	const crops = json(`${dir}/crops.json`);
	const { base, exif } = json(`${dir}/roll.json`);
	return {
		frames: pairs.map(([a, b]) => {
			const frame = a.replace(/^DSC_/, "");
			return { frame, halves: [`${a}.pgm`, `${b}.pgm`], crop: { angle: crops[frame].angle, box: crops[frame].box } };
		}),
		base: `base/${base}.pgm`,
		exif,
	};
};
/** Stage 1's output, typed, from the run id the conversation kept. */
const negsOf = async (id: string) => (await attach(negatives, id).done()).output.negs;

/** What the orchestrating agent reads to decide: which call, why, and whether resume alone re-runs it. */
const report = (failed: readonly FailedCall[]) => {
	for (const f of failed) console.log(`${[...f.path, f.label].join(" > ")} attempt ${f.attempt}: ${f.reason.type} (${f.recovery}) id=${f.id}\n${f.tail}`);
};

switch (step) {
	case "negatives": {
		// About 10 minutes, once per roll. Detached: the harness's 2 h limit on background commands
		// does not matter, and `next` reports progress until it finishes.
		const [raw, roll] = args;
		const r = await run(negatives, { raw: Tree.from(raw!), roll: Tree.from(roll!), meta: rollMeta(roll!) }, { detach: true });
		console.log(r.id);
		for (;;) {
			const n = await r.next({ timeout: "100m" });
			if (n.type === "finished") break;
			if (n.type === "failed") { report(n.failed); process.exit(1); }
			if (n.type === "stopped") throw new Error(`stopped; resume with attach(negatives, "${r.id}").resume()`);
			if (n.type === "timeout") console.log(n.progress);
		}
		break;
	}
	case "preview": {
		// Seconds per frame: only develop runs; the negatives are inputs, not recomputed.
		const [id, lookFile, ...only] = args;
		const r = await run(develop, { negs: await negsOf(id!), look: look(lookFile!), size: 1500, ...(only.length > 0 ? { only } : {}) });
		console.log(r.id, r.output.sheet?.path ?? r.output.images); // the agent reads the sheet and shows the human
		break;
	}
	case "final": {
		const [id, lookFile, dir] = args;
		const r = await run(develop, { negs: await negsOf(id!), look: look(lookFile!), size: "final" });
		await r.exportOutput(dir!);
		break;
	}
	case "deliver": {
		const [id, lookFile, album] = args;
		const r = await run(deliver, { negs: await negsOf(id!), look: look(lookFile!), album: album! }, { detach: true });
		console.log(r.id); // to steer the uploader: attach(id).send("guidance", "…")
		const n = await r.next({ timeout: "100m" });
		console.log(n);
		break;
	}
	case "grade": {
		const [id, lookFile, reference, ...frames] = args;
		const r = await run(grade, { negs: await negsOf(id!), frames, start: look(lookFile!), reference: Artifact.from(reference!, { media: "image/png" }) });
		console.log(JSON.stringify(r.output, null, 1));
		break;
	}
	case "recover": {
		// Recovery, in place. The agent reads the failure, fixes the cause, then resumes:
		// - stitch OOM-killed, or a script bug fixed in scripts/: plain resume; finished frames are
		//   answered from the journal and only the failed stitch runs again;
		// - the uploader hit its turn budget (recovery "retry"): resume with that call retried and
		//   more turns; it continues its own session, nothing else re-runs.
		const [id, call, turns] = args;
		const r = attach(id!);
		report((await r.status()).failed);
		const resumed = await r.resume({ detach: true, ...(call ? { retry: [call as CallId], turns: Number(turns ?? 40) } : {}) });
		const n = await resumed.next({ timeout: "100m" });
		if (n.type === "failed") report(n.failed); else console.log(n.type);
		break;
	}
	default:
		throw new Error(`unknown step ${step}`);
}
