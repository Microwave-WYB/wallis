// Test fixture: artifacts handed between scripts and an agent, a mounted
// dataset, and a probe of the script sandbox.

import { Artifact, defineAgent, defineModels, defineMounts, defineScript, Type, workflow } from "wallis";

const models = defineModels({ default: "fake/default" });
/** The corpus has no default: the caller or the local profile supplies it. */
const mounts = defineMounts({ corpus: "", fixtures: "./scripts" });

const make = defineScript({
	name: "make",
	input: Type.Object({ text: Type.String() }),
	output: Type.Object({ model: Artifact("text/plain") }),
});

const train = defineScript({ mounts }, {
	name: "train",
	input: Type.Object({ model: Artifact("text/plain") }),
	output: Type.Object({ checkpoint: Artifact("application/octet-stream") }),
	mounts: ["corpus"],
	resources: { memoryGb: 1 },
});

const probe = defineScript({
	name: "probe",
	input: Type.Object({ model: Artifact("text/plain"), outside: Type.String() }),
	output: Type.Record(Type.String(), Type.Boolean()),
});

const writer = defineAgent(
	{ models, mounts },
	{
		name: "writer",
		model: "default",
		prompt: "write a report",
		input: Type.Object({ checkpoint: Artifact("application/octet-stream") }),
		output: Type.Object({ report: Artifact("text/markdown") }),
		sandbox: "workspace",
		mounts: ["fixtures"],
	},
);

export default workflow({
	name: "artifacts",
	models,
	mounts,
	agents: [writer],
	scripts: [make, train, probe],
	input: Type.Object({ outside: Type.String() }),
	output: Type.Any(),
	run: async (ctx, input) => {
		const made = await ctx.script(make, { text: "weights" });
		const trained = await ctx.script(train, { model: made.model });
		const probed = await ctx.script(probe, { model: made.model, outside: input.outside });
		const written = await ctx.call(writer, { checkpoint: trained.checkpoint });
		return { model: made.model, checkpoint: trained.checkpoint, report: written.report, probed };
	},
});
