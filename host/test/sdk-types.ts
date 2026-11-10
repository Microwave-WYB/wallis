// Compile-time checks of the SDK's and the host's typing. `tsc --noEmit`
// fails if any `@ts-expect-error` line stops being an error.

import { type Session as SessionValue, ask, command, done, next, defineAgent, defineMcp, defineModels, defineSandbox, Foldable, orchestrator, subWorkflow, toolset, Type, workflow } from "wallis";
import { IdleNode, LiveNode, OwnedRun, SteerableNode, SubmittableNode } from "../src/host/capability.ts";
import type { CommandRunning, IdleNodeState, Node, RunningNode, Snapshot } from "../src/host/core.ts";
import type { Session } from "../src/host/session.ts";

const models = defineModels({ default: "p/m", judge: "" });
const mcp = defineMcp({ mcpServers: { arxiv: { command: "uvx", args: ["arxiv-mcp-server==0.2.10"] } } });
const py = defineSandbox({}, { name: "py", requires: ["uv", { name: "bash", check: ["bash", "--version"] }], volumes: ["./knowledge:/kb:ro", "uv-cache:/root/.cache/uv"], devices: ["/dev/dri"], environment: { UV_OFFLINE: "1" } });
const nodeBox = defineSandbox({}, { name: "tools", requires: ["node"] });
const lib = toolset<typeof import("./fixtures/accept/tools/lib.ts")>("./tools/lib.ts", { sandbox: nodeBox, secrets: ["COUNT_FILE"] });

const train = command({
	name: "train",
	sandbox: py,
	input: Type.Object({ model: Type.Object({ digest: Type.String(), name: Type.String(), media: Type.String() }), epochs: Type.Integer() }),
	output: Type.Object({ score: Type.Number() }),
	// An input artifact appears in `run` as its mounted form, with its path.
	run: (i) => ["uv", "run", "--offline", "train.py", "--model", i.model.path, "--epochs", String(i.epochs)],
	parse: (r) => ({ score: Number(r.stdout.trim()) }),
});

const ok = defineAgent(
	{ models },
	{
		name: "ok",
		model: "judge",
		prompt: "p",
		input: Type.Object({ q: Type.String(), papers: Foldable(Type.Array(Type.String()), { maxChars: 4000 }) }),
		output: Type.Object({ answer: Type.String(), n: Type.Number() }),
		// Tools beyond the workspace: ask, a toolset tool, an MCP tool, a whole MCP server.
		tools: [ask, lib.upload, mcp.arxiv.search, mcp.arxiv],
		workspace: { access: "exec", sandbox: py },
		steerable: false,
	},
);

// A workspace without a sandbox: read or write on a minimal one (the inputs and a scratch dir).
defineAgent({ models }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), workspace: { access: "write" } });

// @ts-expect-error: exec runs commands, so it needs a declared sandbox
defineAgent({ models }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), workspace: { access: "exec" } });

// @ts-expect-error: there is no separate sandbox field on an agent: it is part of the workspace
defineAgent({ models }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), sandbox: py });

// @ts-expect-error: model must be an alias in the table
defineAgent({ models }, { name: "x", model: "nope", prompt: "", input: Type.Null(), output: Type.Null() });

// @ts-expect-error: an MCP server must exist in mcp.json
defineAgent({ models }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), tools: [mcp.scholar] });

// @ts-expect-error: a command cannot be handed to an agent as a tool; only workflow code calls it
defineAgent({ models }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), tools: [train] });

// @ts-expect-error: tools takes only values wallis made: not a look-alike object
defineAgent({ models }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), tools: [{ kind: "ask" }] });

// @ts-expect-error: nor a pi AgentTool directly: custom tools come through a toolset
defineAgent({ models }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), tools: [{ name: "t", label: "t", description: "", parameters: {}, execute: async () => ({ content: [], details: undefined }) }] });

// @ts-expect-error: the old agent `mcp` selection is gone
defineAgent({ models }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), mcp: { arxiv: ["search"] } });

// Volumes in compose vocabulary: a bind's mode must be written, and only :ro exists.
defineSandbox({}, { name: "s", volumes: ["./a:/a:ro", "~/b:/b:ro", "../c:/c:ro", "cache:/cache"] });

// @ts-expect-error: a bind volume needs its mode
defineSandbox({}, { name: "s", volumes: ["./scripts:/scripts"] });

// @ts-expect-error: :rw does not exist (a volume is never writable)
defineSandbox({}, { name: "s", volumes: ["./scripts:/scripts:rw"] });

// @ts-expect-error: nor does any other mode
defineSandbox({}, { name: "s", volumes: ["./scripts:/scripts:z"] });

// @ts-expect-error: a bind's host path is relative or starts with ~/
defineSandbox({}, { name: "s", volumes: ["/etc:/x:ro"] });

// @ts-expect-error: the container target must be absolute
defineSandbox({}, { name: "s", volumes: ["./scripts:scripts:ro"] });

// @ts-expect-error: a named volume's target must be absolute too
defineSandbox({}, { name: "s", volumes: ["cache:cache"] });

// @ts-expect-error: a target may not overlap a dir the bwrap backend owns
defineSandbox({}, { name: "s", volumes: ["./x:/usr/local:ro"] });

// @ts-expect-error: nor be above one
defineSandbox({}, { name: "s", volumes: ["cache:/run"] });

// Devices: plain paths under /dev, never shared-state dirs.
defineSandbox({}, { name: "s", devices: ["/dev/dri", "/dev/null"] });

// @ts-expect-error: a device path with .. (it would bind /tmp, writable)
defineSandbox({}, { name: "s", devices: ["/dev/../tmp/x"] });

// @ts-expect-error: /dev/shm is shared state with the host, not a device
defineSandbox({}, { name: "s", devices: ["/dev/shm"] });

// @ts-expect-error: nor anything outside /dev
defineSandbox({}, { name: "s", devices: ["/tmp"] });

// @ts-expect-error: the old mount names are gone
defineSandbox({}, { name: "s", mounts: ["kb"] });

// @ts-expect-error: a sandbox's network is "none" or "host", not domains
defineSandbox({}, { name: "s", network: ["arxiv.org"] });

// @ts-expect-error: the overlay declares a server's network, "none" or "host", not domains
defineMcp({ mcpServers: { arxiv: {} } }, { arxiv: { network: ["arxiv.org"] } });

// @ts-expect-error: nor tools allowed to write outside
defineMcp({ mcpServers: { arxiv: {} } }, { arxiv: { allowWrites: ["download"] } });

// @ts-expect-error: a sandbox is a declared value, not a name
defineAgent({ models }, { name: "x", model: "default", prompt: "", input: Type.Null(), output: Type.Null(), workspace: { access: "read", sandbox: "py" } });

command({
	name: "bad",
	sandbox: py,
	input: Type.Null(),
	output: Type.Null(),
	// @ts-expect-error: argv[0] must be a binary the sandbox requires
	run: ["python3", "train.py"],
});

const inner = subWorkflow({ name: "inner", input: Type.Null(), output: Type.Number(), run: async () => 1 });
// Nodes, toolsets and servers the workflow does not declare: the typed ctx refuses them.
const stray = command({ name: "stray", sandbox: py, input: Type.Null(), output: Type.Null(), run: ["uv", "run"] });
const strayAgent = defineAgent({ models }, { name: "stray_agent", model: "default", prompt: "", input: Type.Null(), output: Type.Null() });
const strayQuestion = orchestrator({ name: "stray_question", input: Type.Null(), output: Type.Null() });
const strayTools = toolset<typeof import("./fixtures/names/tools/other.ts")>("./tools/other.ts", { sandbox: nodeBox });
const strayMcp = defineMcp({ mcpServers: { elsewhere: { command: "x" } } });
const pick = orchestrator({ name: "pick", input: Type.Object({ question: Type.String() }), output: Type.Object({ choice: Type.Union([Type.Literal("a"), Type.Literal("b")]) }) });

export default workflow({
	name: "types",
	models,
	agents: [ok],
	commands: [train],
	orchestrators: [pick],
	mcp,
	toolsets: [lib],
	input: Type.Null(),
	output: Type.Number(),
	run: async (ctx) => {
		// One `ctx.call` for every kind of node.
		const [out, after] = await ctx.call(ctx.session(ok), { q: "?", papers: [] });
		const trained = await ctx.call(train, { model: { digest: "d", name: "m", media: "x" }, epochs: 2 });
		const n: number = await ctx.call(inner, null);
		const answer: string = out.answer;
		// @ts-expect-error: agents are called through sessions only
		await ctx.call(ok, { q: "?", papers: [] });
		// @ts-expect-error: a command the workflow does not declare
		await ctx.call(stray, null);
		// @ts-expect-error: an orchestrator node it does not declare
		await ctx.call(strayQuestion, null);
		// @ts-expect-error: a session of an agent it does not declare
		ctx.session(strayAgent);
		// @ts-expect-error: a tool of a toolset it does not declare
		await ctx.call(strayTools.search, {});
		// @ts-expect-error: a tool of an MCP server it does not declare
		await ctx.call(strayMcp.elsewhere.find, {});
		// Branches, iterations and map items get the same typed ctx.
		await ctx.parallel({
			// @ts-expect-error: inside a branch too
			a: (c) => c.call(stray, null),
			b: (c) => c.call(train, { model: { digest: "d", name: "m", media: "x" }, epochs: 1 }),
		});
		// An orchestrator node's answer is typed by its output schema.
		const picked: "a" | "b" = (await ctx.call(pick, { question: "a or b?" })).choice;
		// @ts-expect-error: and an answer of another type does not fit it
		const pickedWrong: number = (await ctx.call(pick, { question: "a or b?" })).choice;
		// @ts-expect-error: its question is typed by its input schema
		await ctx.call(pick, { prompt: "a or b?" });
		// A toolset tool from the body: input typed by its parameters, output by its outputSchema.
		const url: string = (await ctx.call(lib.upload, { name: "sheet.jpg" })).url;
		// @ts-expect-error: a wrong input to a toolset tool
		await ctx.call(lib.upload, { file: "sheet.jpg" });
		// An MCP tool's result is unknown unless a schema parses it.
		const ids: string[] = (await ctx.call(mcp.arxiv.search_papers, { query: "folds" }, Type.Object({ ids: Type.Array(Type.String()) }))).ids;
		// @ts-expect-error: unparsed, it is unknown
		const raw: number = await ctx.call(mcp.arxiv.search_papers, { query: "folds" });
		void url;
		void raw;
		// A session is a value: the call returns the next one; the value called is unchanged,
		// so calling it again is a branch.
		const [, following] = await ctx.call(after, { q: "and then?", papers: [] });
		const [again] = await ctx.call(after, { q: "or else?", papers: [] });
		const s: SessionValue<typeof ok.input, typeof ok.output> = following;
		const said: string = again.answer;
		void said;
		// @ts-expect-error: a session value has no call of its own
		await s.call({ q: "and then?", papers: [] });
		// @ts-expect-error: the next session is the same agent's, typed the same
		await ctx.call(following, { q: 1, papers: [] });
		void picked;
		void pickedWrong;
		void ids;
		// @ts-expect-error: call input is typed by the node's input schema
		await ctx.call(ctx.session(ok), { q: 1, papers: [] });
		// @ts-expect-error: outputs are typed too
		const wrong: number = out.answer;
		ctx.observe("answer", answer);
		// ctx.loop: the state is the init's type; the output is the union of the done(...) values.
		const ending = await ctx.loop({ s: ctx.session(ok), round: 0 }, async (c, state) => {
			const [out, s] = await c.call(state.s, { q: "again?", papers: [] });
			if (out.answer === "yes") return done({ type: "approved" as const, answer: out.answer });
			if (state.round > 3) return done({ type: "abandoned" as const, rounds: state.round });
			return next({ s, round: state.round + 1 });
		});
		if (ending.type === "approved") {
			const approved: string = ending.answer;
			void approved;
		} else {
			const rounds: number = ending.rounds;
			void rounds;
		}
		// @ts-expect-error: the result is a union: an ending's fields need narrowing first
		void ending.answer;
		// @ts-expect-error: the body must go round with the init's state type
		await ctx.loop({ round: 0 }, async (_c, state) => next({ round: String(state.round) }));
		// The explicit form, as written in the API.
		const explicit: string = await ctx.loop<number, string>(0, async (_c, n) => (n > 2 ? done("ok") : next(n + 1)));
		void explicit;
		const each: number[] = await ctx.map([1, 2], async (c, i) => (await c.call(train, { model: { digest: "d", name: "m", media: "x" }, epochs: i })).score);
		// @ts-expect-error: ctx has no state-writing API
		await ctx.emit("total", 3);
		// @ts-expect-error: and no ctx.script or ctx.sub: ctx.call is the only way to invoke a node
		await ctx.script(train, {});
		void wrong;
		void each;
		return out.n + trained.score + n;
	},
});

// --- Capabilities ---

declare const session: Session;
declare const snapshot: Snapshot;
declare const node: Node;
declare const commandNode: CommandRunning;

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
	// @ts-expect-error: a command can never be steered: SteerableNode holds only agents
	session.steer({ owned, node: commandNode }, "faster");

	const liveNode = LiveNode.check(owned, "#0");
	if (liveNode instanceof LiveNode) session.restart(liveNode, "note");

	const pending = SubmittableNode.check(owned, "#6");
	if (pending instanceof SubmittableNode) session.submit(pending, { choice: "a" });
	// @ts-expect-error: submit needs a SubmittableNode; an IdleNode is not one
	if (idle instanceof IdleNode) session.submit(idle, { type: "approve" });
	// @ts-expect-error: interrupt takes no message: interrupt, then send
	if (steerable instanceof SteerableNode) session.interrupt(steerable, "go right");
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
if (node.type === "command_running") {
	// @ts-expect-error: a command node has no steerable flag at all
	void node.steerable;
}
