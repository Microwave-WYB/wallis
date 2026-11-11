// How the orchestrating agent (Claude Code, pi) iterates with the human: each step is a short
// script, or `node -e`, that imports the workflows and calls the caller API. The run ids in the
// conversation are the history; `attach` picks an earlier run's output back up.
//
//   node iterate.ts negatives <raw dir> <roll dir>
//   node iterate.ts preview <negatives run> <look.json> [frame...]
//   node iterate.ts final <negatives run> <look.json> <export dir>
//   node iterate.ts deliver <negatives run> <look.json> <album>      (only after the human said yes)
//   node iterate.ts grade <negatives run> <look.json> <reference.jpg> <frame...>

import { readFileSync } from "node:fs";
import { Artifact, attach, run, Tree, type Static } from "wallis";
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
			return { frame, halves: [`${a}.NEF`, `${b}.NEF`], crop: { angle: crops[frame].angle, box: crops[frame].box } };
		}),
		base: `base/${base}.NEF`,
		exif,
	};
};
/** Stage 1's output, typed, from the run id the conversation kept. */
const negsOf = async (id: string) => (await attach(negatives, id).done()).output.negs;

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
			if (n.type === "failed") throw new Error(JSON.stringify(n.error));
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
		const r = await run(grade, { negs: await negsOf(id!), frames, start: look(lookFile!), reference: Artifact.from(reference!, { media: "image/jpeg" }) });
		console.log(JSON.stringify(r.output, null, 1));
		break;
	}
	default:
		throw new Error(`unknown step ${step}`);
}
