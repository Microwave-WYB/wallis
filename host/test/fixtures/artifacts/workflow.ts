// Test fixture: artifacts handed between commands and an agent, read-only
// mounts, and a probe of the command sandbox. Nothing is implicit: the
// commands' code arrives through the `scripts` mount.

import { Artifact, command, defineAgent, defineModels, defineMounts, defineSandbox, Type, workflow } from "wallis";

const models = defineModels({ default: "fake/default" });
/** The corpus has no default: the caller or the local profile supplies it. */
const mounts = defineMounts({ corpus: "", scripts: "./scripts" });

const node = defineSandbox({ mounts }, { name: "node", requires: ["node"], mounts: ["scripts"] });
const trainer = defineSandbox({ mounts }, { name: "trainer", requires: ["node"], mounts: ["scripts", "corpus"] });
const writing = defineSandbox({ mounts }, { name: "writing", requires: ["bash"], mounts: ["scripts"] });

/** The default protocol: input JSON on stdin; the output JSON (with artifact drafts) on stdout. */
const make = command({
	name: "make",
	sandbox: node,
	input: Type.Object({ text: Type.String() }),
	output: Type.Object({ model: Artifact("text/plain") }),
	run: ["node", "scripts/make.mjs"],
});

/** A typed adapter: argv built from the mounted input, the output parsed from stdout and a file. */
const train = command({
	name: "train",
	sandbox: trainer,
	input: Type.Object({ model: Artifact("text/plain") }),
	output: Type.Object({ checkpoint: Artifact("application/octet-stream"), size: Type.Number() }),
	run: (i) => ["node", "scripts/train.mjs", i.model.path],
	parse: (r) => ({ checkpoint: r.file("ckpt.bin", "application/octet-stream"), size: Number(r.stdout.trim()) }),
	resources: { memoryGb: 1 },
});

/** Names a file it never writes: a typed `missing_file`. */
const lost = command({
	name: "lost",
	sandbox: node,
	input: Type.Null(),
	output: Type.Object({ file: Artifact() }),
	run: ["node", "-e", "0"],
	parse: (r) => ({ file: r.file("nothing.bin") }),
});

const probe = command({
	name: "probe",
	sandbox: node,
	input: Type.Object({ model: Artifact("text/plain"), outside: Type.String() }),
	output: Type.Record(Type.String(), Type.Boolean()),
	run: ["node", "scripts/probe.mjs"],
});

const writer = defineAgent(
	{ models },
	{
		name: "writer",
		model: "default",
		prompt: "write a report",
		input: Type.Object({ checkpoint: Artifact("application/octet-stream") }),
		output: Type.Object({ report: Artifact("text/markdown") }),
		workspace: { access: "write", sandbox: writing },
	},
);

export default workflow({
	name: "artifacts",
	models,
	mounts,
	agents: [writer],
	commands: [make, train, lost, probe],
	input: Type.Object({ outside: Type.String() }),
	output: Type.Any(),
	run: async (ctx, input) => {
		const made = await ctx.call(make, { text: "weights" });
		const trained = await ctx.call(train, { model: made.model });
		const probed = await ctx.call(probe, { model: made.model, outside: input.outside });
		let missing: unknown = null;
		try {
			await ctx.call(lost, null);
		} catch (error) {
			missing = (error as { failure?: unknown }).failure ?? String(error);
		}
		const written = await ctx.call(ctx.session(writer), { checkpoint: trained.checkpoint });
		return { model: made.model, checkpoint: trained.checkpoint, size: trained.size, report: written.report, probed, missing };
	},
});
