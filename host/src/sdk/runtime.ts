// The guest half of the sandbox bridge. The bundler appends
// `install(workflow)` to every bundled workflow. Inside QuickJS the host
// provides `__wallis_send`, `__wallis_done` and `__wallis_fail`; it calls
// `__wallis_declare`, `__wallis_start` and `__wallis_deliver`, and, for a
// command call, `__wallis_argv` (the command's `run`) and `__wallis_parse`
// (its `parse`), both pure.
//
// Request ids come from the branch path and a per-branch counter, taken
// synchronously when `ctx.call` is invoked, so they are the same on every
// replay regardless of the order results arrive in.

import type { AgentDef, CallableNode, CommandDef, CommandResult, Ctx, FailReason, Json, Refusal, SandboxDef, Session, Tool, TSchema, WorkflowDef, WorkflowNode } from "./index.ts";
import { AgentFailed, CommandFailed, mcpDecl, OrchestratorCancelled, Refused, SchemaError, ToolFailed, toolDesc, toolsetDecl, WorkflowFailed } from "./index.ts";
import { schemaErrors } from "./validate.ts";

/** What the host answers a request with. */
export type Reply =
	| { type: "deliver"; value: Json }
	| { type: "fail"; reason: FailReason }
	| { type: "refuse"; refusal: Refusal }
	| { type: "schema"; subject: string; errors: string[] };

interface Host {
	__wallis_send(json: string): void;
	__wallis_done(json: string): void;
	__wallis_fail(json: string): void;
}

const pending = new Map<string, (reply: Reply) => void>();

function host(): Host {
	return globalThis as unknown as Host;
}

function request(id: string, req: Json): Promise<Reply> {
	return new Promise((resolve) => {
		pending.set(id, resolve);
		host().__wallis_send(JSON.stringify({ type: "requested", id, request: req }));
	});
}

function thrown(reason: FailReason): Error {
	switch (reason.type) {
		case "agent_gave_up":
			return new AgentFailed(reason.agent, reason.failure);
		case "command_crashed":
			return new CommandFailed(reason.command, reason.failure);
		case "tool_crashed":
			return new ToolFailed(reason.tool, reason.failure);
		case "orchestrator_cancelled":
			return new OrchestratorCancelled(reason.name);
		case "workflow_failed":
			return new WorkflowFailed(reason.workflow, reason.reason);
		case "body_error":
			return new Error(reason.message);
	}
}

function unwrap(reply: Reply): Json {
	switch (reply.type) {
		case "deliver":
			return reply.value;
		case "fail":
			throw thrown(reply.reason);
		case "refuse":
			throw new Refused(reply.refusal);
		case "schema":
			throw new SchemaError(reply.subject, reply.errors);
	}
}

function check(schema: unknown, value: unknown, subject: string): void {
	const errors = schemaErrors(schema, value);
	if (errors.length > 0) throw new SchemaError(subject, errors);
}

function failReason(error: unknown): FailReason {
	if (error instanceof AgentFailed) return { type: "agent_gave_up", agent: error.agent, failure: error.failure };
	if (error instanceof CommandFailed) return { type: "command_crashed", command: error.command, failure: error.failure };
	if (error instanceof ToolFailed) return { type: "tool_crashed", tool: error.tool, failure: error.failure };
	if (error instanceof OrchestratorCancelled) return { type: "orchestrator_cancelled", name: error.orchestrator };
	if (error instanceof WorkflowFailed) return { type: "workflow_failed", workflow: error.workflow, reason: error.reason };
	return { type: "body_error", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
}

/**
 * Request ids: `<path>#<n>`, taken synchronously by `call`, `parallel` and
 * `map` before anything is awaited. A branch of `parallel` or `map` gets
 * its own path (`#2.key`, `#2.0`), so its later steps never depend on the
 * order other branches' results arrive in. Observations take their own
 * counter (`<path>~<n>`), so adding or removing one never shifts a request id.
 */
/** A tool's id in requests: `custom:<toolset path>#<export>` or `mcp:<server>/<tool>`. */
export function toolId(desc: { kind: "custom"; toolset: string; export: string } | { kind: "mcp_tool"; server: string; tool: string }): string {
	return desc.kind === "custom" ? `custom:${desc.toolset}#${desc.export}` : `mcp:${desc.server}/${desc.tool}`;
}

function makeCtx(path: string, seed: number): Ctx {
	let counter = 0;
	let observed = 0;
	/** `parallel` and `map` of this ctx not settled yet: its sessions are not called meanwhile (only this branch may call them). */
	let branching = 0;
	// Counted before the branches start: their synchronous first steps are inside too.
	const branch = <T>(start: () => Promise<T>): Promise<T> => {
		branching++;
		return start().finally(() => {
			branching--;
		});
	};
	const next = () => `${path}#${counter++}`;
	const callAgent = async (id: string, agent: AgentDef, input: unknown, session: string, index: number) => {
		const output = unwrap(await request(id, { type: "call", agent: agent.name, input: input as Json, session, index }));
		const errors = schemaErrors(agent.output, output);
		if (errors.length > 0) throw new AgentFailed(agent.name, { type: "gave_up", error: `output does not match its schema: ${errors.join("; ")}` });
		return output;
	};
	/** An orchestrator node: its answer is checked against `output` here too. */
	const callOrchestrator = async (id: string, node: { name: string; output: unknown }, input: unknown) => {
		const output = unwrap(await request(id, { type: "orchestrator", name: node.name, input: input as Json }));
		const errors = schemaErrors(node.output, output);
		if (errors.length > 0) throw new SchemaError(`answer of orchestrator node ${node.name}`, errors);
		return output;
	};
	/** A tool: the host checks the input against its parameters and the output against its outputSchema; `schema` parses it here. */
	const callTool = async (id: string, tool: string, input: unknown, schema: TSchema | undefined) => {
		const output = unwrap(await request(id, { type: "tool", tool, input: input as Json }));
		const errors = schema === undefined ? [] : schemaErrors(schema, output);
		if (errors.length > 0) throw new ToolFailed(tool, { type: "tool_output_mismatch", errors });
		return output;
	};
	const callCommand = async (id: string, command: CommandDef, input: unknown) => {
		const output = unwrap(await request(id, { type: "command", command: command.name, input: input as Json }));
		const errors = schemaErrors(command.output, output);
		if (errors.length > 0) throw new CommandFailed(command.name, { type: "output_mismatch", errors });
		return output;
	};
	const callWorkflow = async (id: string, sub: WorkflowNode, input: unknown) => {
		let output: unknown;
		try {
			output = await sub.run(makeCtx(`${id}>${sub.name}`, seed), input as never);
			check(sub.output, output, `output of workflow ${sub.name}`);
		} catch (error) {
			// A nested workflow's failure propagates, typed, with its cause.
			throw new WorkflowFailed(sub.name, failReason(error));
		}
		return output;
	};
	const ctx: Ctx = {
		seed,
		// One implementation behind the typed overloads: nodes, then tool values.
		call: ((node: CallableNode | Tool | undefined, input: unknown, schema?: TSchema) => {
			if (node === undefined || !("kind" in node)) {
				const desc = toolDesc(node);
				if (desc === null) return Promise.reject(new SchemaError("ctx.call", ["not a node or a tool"]));
				if (desc.kind !== "custom" && desc.kind !== "mcp_tool") return Promise.reject(new SchemaError("ctx.call", ["only toolset tools and MCP tools can be called from the body"]));
				return callTool(next(), toolId(desc), input, schema) as never;
			}
			// Agents are called through sessions only; the type says so, and so does the runtime.
			if ((node as { kind: string }).kind === "agent") return Promise.reject(new Refused({ type: "session_required", agent: node.name }));
			// Checked and numbered now, synchronously: the id never depends on arrival order.
			const subject = `input of ${node.kind} ${node.name}`;
			const errors = schemaErrors(node.input, input);
			if (errors.length > 0) return Promise.reject(new SchemaError(subject, errors));
			const id = next();
			switch (node.kind) {
				case "command":
					return callCommand(id, node, input) as never;
				case "workflow":
					return callWorkflow(id, node, input) as never;
				case "orchestrator":
					return callOrchestrator(id, node, input) as never;
			}
		}) as unknown as Ctx["call"],
		session(agent) {
			// The session's identity is where it was created, taken now like a request id.
			const id = next();
			let index = 0;
			// Calls run in the order they are made: one made while another is in flight waits for it.
			let tail: Promise<unknown> | null = null;
			const session: Session = {
				id,
				agent: agent.name,
				call(input) {
					// The call's index is taken when it is made; across branches that order would depend on arrival.
					if (branching > 0) return Promise.reject(new Refused({ type: "foreign_session", session: id }));
					const errors = schemaErrors(agent.input, input);
					if (errors.length > 0) return Promise.reject(new SchemaError(`input of agent ${agent.name}`, errors));
					const k = index++;
					const go = () => callAgent(`${id}:${k}`, agent, input, id, k);
					const run = tail === null ? go() : tail.then(go, go);
					const settled: Promise<unknown> = run.then(
						() => undefined,
						() => undefined,
					);
					tail = settled;
					void settled.then(() => {
						if (tail === settled) tail = null;
					});
					return run as never;
				},
			};
			return session as never;
		},
		parallel(branches) {
			const at = next();
			const keys = Object.keys(branches);
			return branch(() => Promise.all(keys.map((key) => branches[key]!(makeCtx(`${at}.${key}`, seed))))).then(
				(results) => Object.fromEntries(keys.map((key, i) => [key, results[i]])) as never,
			);
		},
		map(items, each) {
			const at = next();
			return branch(() => Promise.all(items.map((item, i) => each(makeCtx(`${at}.${i}`, seed), item, i))));
		},
		observe(label, value) {
			host().__wallis_send(JSON.stringify({ type: "observed", at: `${path}~${observed++}`, label, value }));
		},
	};
	return ctx;
}

/** mulberry32: small, seedable, deterministic. */
function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function sandboxDeclaration(s: SandboxDef) {
	return { requires: s.requires, setup: s.setup, mounts: s.mounts, base: s.base };
}

/** Declarations: the core's workflow plus what the host and executors need. */
export function declarations(def: WorkflowDef) {
	const spec = def.spec;
	const names = new Set<string>();
	for (const node of [...spec.agents, ...(spec.commands ?? []), ...(spec.orchestrators ?? [])]) {
		if (names.has(node.name)) throw new Error(`duplicate node name ${node.name}`);
		names.add(node.name);
	}
	const commands = spec.commands ?? [];
	const orchestrators = spec.orchestrators ?? [];
	const mcp = spec.mcp ? mcpDecl(spec.mcp) : null;
	const toolsets = (spec.toolsets ?? []).map((t) => {
		const d = toolsetDecl(t);
		if (!d) throw new Error("toolsets takes only toolset(...) values");
		return d;
	});
	const mounts = spec.mounts?.table ?? {};
	const overlay = mcp?.overlay ?? {};
	const servers = Object.keys(mcp?.config.mcpServers ?? {});
	for (const a of spec.agents) {
		for (const t of a.tools) {
			if (t.kind === "custom" && !toolsets.some((s) => s.path === t.toolset)) throw new Error(`agent ${a.name}: toolset ${t.toolset} is not in the workflow's toolsets`);
			if ((t.kind === "mcp_server" || t.kind === "mcp_tool") && !servers.includes(t.server)) throw new Error(`agent ${a.name}: MCP server ${t.server} is not in the workflow's mcp`);
		}
	}
	// Every sandbox, by name: from commands, agents and MCP servers.
	const sandboxes = new Map<string, SandboxDef>();
	const use = (s: SandboxDef | null | undefined): string | null => {
		if (!s) return null;
		const prior = sandboxes.get(s.name);
		if (prior && JSON.stringify(sandboxDeclaration(prior)) !== JSON.stringify(sandboxDeclaration(s))) throw new Error(`two different sandboxes are named ${s.name}`);
		for (const m of s.mounts) if (!(m in mounts)) throw new Error(`sandbox ${s.name}: mount ${m} is not in the workflow's mount table`);
		sandboxes.set(s.name, s);
		return s.name;
	};
	for (const a of spec.agents) {
		if (a.access === 3 && !a.sandbox?.requires.some((r) => r.name === "bash")) throw new Error(`agent ${a.name}: exec needs a sandbox that requires bash`);
	}
	return {
		core: {
			name: spec.name,
			agents: spec.agents.map((a) => ({ name: a.name, model: a.model, max_turns: a.maxTurns, steerable: a.steerable })),
			commands: commands.map((c) => c.name),
			orchestrators: orchestrators.map((o) => o.name),
			budget: { turns: spec.budget?.turns ?? null, compute_minutes: spec.budget?.computeMinutes ?? null },
		},
		models: spec.models.table,
		mounts,
		pin: { files: [...(spec.pin?.files ?? [])] },
		agents: Object.fromEntries(
			spec.agents.map((a) => [
				a.name,
				{
					model: a.model,
					prompt: a.prompt,
					input: a.input,
					output: a.output,
					tools: a.tools,
					access: a.access,
					skills: a.skills,
					needs: a.needs ?? {},
					sandbox: use(a.sandbox),
					steerable: a.steerable,
					compaction: a.compaction,
					max_turns: a.maxTurns,
				},
			]),
		),
		commands: Object.fromEntries(
			commands.map((c) => [
				c.name,
				{
					description: c.description,
					input: c.input,
					output: c.output,
					sandbox: use(c.sandbox)!,
					resources: c.resources,
					// The adapter's code, for the node digest: a change to `run` or `parse` misses the journal.
					code: [typeof c.run === "function" ? c.run.toString() : JSON.stringify(c.run), c.parse ? c.parse.toString() : "stdout-json"],
				},
			]),
		),
		orchestrators: Object.fromEntries(orchestrators.map((o) => [o.name, { description: o.description, input: o.input, output: o.output }])),
		toolsets: Object.fromEntries(toolsets.map((t) => [t.path, { sandbox: use(t.sandbox)!, secrets: [...(t.secrets ?? [])], network: t.network ?? "full" }])),
		mcp: mcp?.config ?? null,
		mcpServers: Object.fromEntries(servers.map((server) => [server, { sandbox: use(overlay[server]?.sandbox), network: overlay[server]?.network ?? "full" }])),
		sandboxes: Object.fromEntries([...sandboxes].map(([name, s]) => [name, sandboxDeclaration(s)])),
		input: spec.input,
		output: spec.output,
	};
}

export type Declarations = ReturnType<typeof declarations>;

/** The commands of a workflow, by name, for the host's `run` and `parse` calls. */
function commandsOf(def: WorkflowDef): Map<string, CommandDef> {
	return new Map((def.spec.commands ?? []).map((c) => [c.name, c]));
}

export function install(def: WorkflowDef): void {
	const g = globalThis as Record<string, unknown>;
	const commands = commandsOf(def);
	g.__wallis_declare = () => JSON.stringify(declarations(def));
	// False when no request of this body waits for `id` (a result for an
	// earlier execution of the body; it is in the journal and hits later).
	g.__wallis_deliver = (id: string, json: string) => {
		const resolve = pending.get(id);
		if (!resolve) return false;
		pending.delete(id);
		resolve(JSON.parse(json) as Reply);
		return true;
	};
	// The command's argv for this (mounted) input: `{ ok, argv }` or `{ ok: false, error }`.
	g.__wallis_argv = (name: string, inputJson: string) => {
		try {
			const c = commands.get(name);
			if (!c) throw new Error(`no command ${name}`);
			const argv = typeof c.run === "function" ? c.run(JSON.parse(inputJson) as never) : c.run;
			return JSON.stringify({ ok: true, argv });
		} catch (error) {
			return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	};
	// The command's output from its process result; files it names become artifact drafts.
	g.__wallis_parse = (name: string, resultJson: string) => {
		try {
			const c = commands.get(name);
			if (!c) throw new Error(`no command ${name}`);
			const raw = JSON.parse(resultJson) as { exit: number; stdout: string; stderr: string };
			const result: CommandResult = {
				...raw,
				file: (file, media) => ({ artifact: file, media: media ?? "application/octet-stream" }) as never,
			};
			const output = c.parse ? c.parse(result) : JSON.parse(raw.stdout);
			return JSON.stringify({ ok: true, output: output ?? null });
		} catch (error) {
			return JSON.stringify({ ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
		}
	};
	g.__wallis_start = (inputJson: string, seed: number) => {
		Math.random = seededRandom(seed);
		const input = JSON.parse(inputJson) as Json;
		const run = async () => {
			check(def.spec.input, input, "workflow input");
			const output = await def.spec.run(makeCtx("", seed), input as never);
			check(def.spec.output, output, "workflow output");
			return output;
		};
		run().then(
			(output) => host().__wallis_done(JSON.stringify(output ?? null)),
			(error: unknown) => host().__wallis_fail(JSON.stringify(failReason(error))),
		);
	};
}
