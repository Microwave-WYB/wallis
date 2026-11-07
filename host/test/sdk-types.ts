// Compile-time checks of the SDK's and the host's typing. `tsc --noEmit`
// fails if any `@ts-expect-error` line stops being an error.

import { defineAgent, defineMcp, defineModels, defineMounts, defineScript, Foldable, Type, workflow } from "wallis";
import { IdleNode, LiveNode, OwnedRun, SteerableNode } from "../src/host/capability.ts";
import type { IdleNodeState, Node, RunningNode, Snapshot } from "../src/host/core.ts";
import type { Session } from "../src/host/session.ts";

const models = defineModels({ default: "p/m", judge: "" });
const mcp = defineMcp({ mcpServers: { arxiv: { command: "uvx", args: ["arxiv-mcp-server==0.2.10"] } } });
const mounts = defineMounts({ kb: "./knowledge", data: "" });

const ok = defineAgent(
	{ models, mcp, mounts },
	{
		name: "ok",
		model: "judge",
		prompt: "p",
		input: Type.Object({ q: Type.String(), papers: Foldable(Type.Array(Type.String()), { maxChars: 4000 }) }),
		output: Type.Object({ answer: Type.String(), n: Type.Number() }),
		mcp: { arxiv: ["search"] },
		mounts: ["kb"],
		steerable: false,
	},
);

// @ts-expect-error: model must be an alias in the table
defineAgent({ models }, { name: "x", model: "nope", prompt: "", input: Type.Null(), output: Type.Null() });

// @ts-expect-error: MCP server must exist in mcp.json
defineAgent({ models, mcp }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), mcp: { scholar: "*" } });

// @ts-expect-error: a mount must be in the mount table
defineAgent({ models, mounts }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), mounts: ["ghost"] });

// @ts-expect-error: scripts name mounts from the table too
defineScript({ mounts }, { name: "s", input: Type.Null(), output: Type.Null(), mounts: ["ghost"] });

// @ts-expect-error: agents have no views or state writes any more
defineAgent({ models }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), writes: {} });

export default workflow({
	name: "types",
	models,
	mounts,
	agents: [ok],
	input: Type.Null(),
	output: Type.Number(),
	run: async (ctx) => {
		const out = await ctx.call(ok, { q: "?", papers: [] });
		const answer: string = out.answer;
		// @ts-expect-error: call input is typed by the agent's input schema
		await ctx.call(ok, { q: 1, papers: [] });
		// @ts-expect-error: outputs are typed too
		const wrong: number = out.answer;
		ctx.observe("answer", answer);
		// @ts-expect-error: ctx has no state-writing API
		await ctx.emit("total", 3);
		// @ts-expect-error: nor state reads
		await ctx.read({ fields: ["total"], maxChars: 1, maxItems: 1 });
		void wrong;
		return out.n;
	},
});

// --- Capabilities ---

declare const session: Session;
declare const snapshot: Snapshot;
declare const node: Node;

const owned = OwnedRun.check(snapshot, "human");
if (owned instanceof OwnedRun) {
	const idle = IdleNode.check(owned, "#0");
	if (idle instanceof IdleNode) session.answer(idle, "yes");
	// @ts-expect-error: answer needs an IdleNode, not a raw node id
	session.answer("#0", "yes");
	// @ts-expect-error: nor a node from a snapshot that was never checked
	session.answer({ owned, node: node as IdleNodeState }, "yes");

	const steerable = SteerableNode.check(owned, "#0");
	if (steerable instanceof SteerableNode) session.steer(steerable, "go left");
	// @ts-expect-error: steer needs a SteerableNode; an IdleNode is not one
	if (idle instanceof IdleNode) session.steer(idle, "go left");
	// @ts-expect-error: and an unchecked running node is not one either
	session.interrupt({ owned, node: node as RunningNode & { steerable: true } });

	const liveNode = LiveNode.check(owned, "#0");
	if (liveNode instanceof LiveNode) session.restart(liveNode, "note");
}
// @ts-expect-error: the node checks take an OwnedRun, so ownership cannot be skipped
SteerableNode.check(snapshot, "#0");
// @ts-expect-error: capabilities have no public constructor
new OwnedRun("human", snapshot);

// Narrowing the node union gives the steerable running variant.
if (node.type === "node_running" && node.steerable) {
	const steerableNode: RunningNode & { steerable: true } = node;
	void steerableNode;
}
if (node.type === "node_running") {
	// @ts-expect-error: without the steerable check the variant may be non-steerable
	const unchecked: RunningNode & { steerable: true } = node;
	void unchecked;
}
