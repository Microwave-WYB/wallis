// The wallis tool layer: every tool an agent can call, built per agent call
// and handed to an executor. It gives the agent exactly the tools it was
// declared with, logs every call to the node's transcript, counts calls
// against the node's tool budget, caps every result that enters the
// model's context, and journals every external result.
//
// Every agent gets `codemode`, `submit_result` and `read_spill`; then its
// declared tools:
// - file tools from its workspace access, named as in pi: `read` gives
//   read and ls, `write` adds write, edit and export_artifact, `exec` adds
//   bash (in its sandbox). `/w` is the scratch dir; mounts and
//   `/run/wallis/inputs` are read-only. `read` returns images as image
//   content;
// - `ask(message)`, opt-in: the turn ends and the reply becomes its result;
// - custom tools and MCP tools, from their sources (toolsets.ts), over one
//   connection per agent call. Their results are journaled (`{ tool, args,
//   outcome }` under `<turn>/<tool call id>`, nested codemode calls under
//   `<key>/<n>`) before the model sees them; a reissued call answers a
//   journaled call from the journal when tool and arguments match.
// Every tool is callable directly and from codemode, except `ask`, which
// pauses the turn. Once a call has paused a turn, later calls in the same
// message are not run.
//
// Context protection: a result longer than the cap is cut, and its full
// text is spilled to the node's spill dir with an explicit marker; the next
// script pages it with `read_spill`. Nothing is dropped silently.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CodemodeSandbox, type CodemodeTool, renderDeclarations, toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import { type McpClient, toLlmContent } from "@earendil-works/pi-mcp";
import { type Json, Type } from "../sdk/index.ts";
import Value from "typebox/value";
import { LAYOUT, runSpawn } from "./confine.ts";
import { type NodeSpec, validateSubmission } from "./executor.ts";
import { canonical } from "./render.ts";
import { resolveAgentTools, type Source, sourceKey, type ToolInfo, toolInfos } from "./toolsets.ts";

/** A tool as wallis runs it, before it is adapted to an executor. */
export interface WallisToolRun {
	readonly name: string;
	readonly description: string;
	readonly parameters: Json;
	/** `call` is the journal key of the call: `<turn>/<tool call id>`, or `<key>/<n>` nested in codemode. */
	run(args: Json, signal: AbortSignal | undefined, call: string): Promise<ToolOutcome>;
}

/** What pauses a turn: a question to the caller. */
export type Pending = { readonly type: "ask"; readonly message: string };

export interface ToolOutcome {
	readonly text: string;
	readonly value?: Json;
	readonly isError?: boolean;
	/** Set by `ask`: the turn ends here and waits. */
	readonly pending?: Pending;
	/** Image content for the model (direct calls only; codemode sees the text). */
	readonly images?: readonly { readonly data: string; readonly mimeType: string }[];
}

const Outcome = Type.Object({ text: Type.String(), value: Type.Optional(Type.Unknown()), isError: Type.Optional(Type.Boolean()) });
/** A journaled external result, parsed when it is read back. */
const Recorded = Type.Object({ tool: Type.String(), args: Type.Unknown(), outcome: Outcome });

/** What a tool call in flight at a crash does when the call is reissued. */
export type CrashPolicy = "rerun" | "sandbox" | "unknown";

export interface ToolLayerOptions {
	/** Tool calls one node may make, nested calls included. Default: 10 per allowed turn. */
	readonly maxCalls?: number;
	/** Characters of one tool result or codemode output that enter the context. */
	readonly resultCap?: number;
}

/** Prototype choice: 16k characters (about 5k tokens at 3 chars per token). */
export const RESULT_CAP = 16_000;
/** A submitted result over this many characters of JSON goes back to the model as a validation error. */
export const OUTPUT_CAP = 100_000;
const FILE_CAP = 100_000;
const SPILL_PAGE = 8_000;
const LS_LIMIT = 500;
const IMAGES: Readonly<Record<string, string>> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };

/** Run again after a crash: they only read, only ask, or only record. */
const RERUN = new Set(["read", "ls", "read_spill", "ask", "submit_result"]);

export class NodeTools {
	readonly spec: NodeSpec;
	submitted: Json | undefined = undefined;
	/** The tool call the turn waits on, if any: at most one per turn. */
	pending: { readonly call: string; readonly pending: Pending } | null = null;
	calls = 0;
	/** Completed model turns when the current turn's tools run: the first part of their journal keys. */
	turn = 0;
	/** External tools by agent-visible name. */
	readonly external = new Map<string, ToolInfo>();
	readonly #tools = new Map<string, WallisToolRun>();
	readonly #maxCalls: number;
	readonly #cap: number;
	readonly #clients: McpClient[] = [];
	#spills = 0;
	/** The codemode call running now, and its nested calls so far: their journal keys. */
	#codemodeCall = "";
	#nested = 0;

	constructor(spec: NodeSpec, maxCalls: number, cap: number) {
		this.spec = spec;
		this.#maxCalls = maxCalls;
		this.#cap = cap;
	}

	add(tool: WallisToolRun): void {
		this.#tools.set(tool.name, tool);
	}

	addClient(client: McpClient): void {
		this.#clients.push(client);
	}

	get names(): string[] {
		return [...this.#tools.keys()];
	}

	/** The journal key of a direct call. */
	key(callId: string): string {
		return `${this.turn}/${callId}`;
	}

	/** The journaled result of this external call, if one matches its tool and arguments. A mismatch is a miss, logged. */
	recorded(key: string, info: ToolInfo, args: Json): ToolOutcome | null {
		const raw = this.spec.recorded.get(key);
		if (raw === undefined) return null;
		// Parsed, not cast: a record that does not match its schema is a miss.
		const rec = Value.Check(Recorded, raw) ? raw : null;
		if (rec !== null && rec.tool === info.id && canonical(rec.args as Json) === canonical(args)) return { text: rec.outcome.text, value: rec.outcome.value as Json, isError: rec.outcome.isError === true };
		this.spec.log({ kind: "note", text: `journaled result ${key} is for another call (${rec ? `${rec.tool} ${canonical(rec.args as Json)}` : "unreadable"}): calling ${info.id}` });
		return null;
	}

	/**
	 * A call in flight at a crash: run it again if it only reads, asks or
	 * records, if it is an external tool that is safe or already journaled,
	 * or if it is codemode and every external tool is safe; give the model an
	 * error if it worked only on the sandbox; else its outcome is unknown.
	 */
	crashPolicy(name: string, key: string, args: Json): CrashPolicy {
		if (RERUN.has(name)) return "rerun";
		const info = this.external.get(name);
		if (info) return info.replay === "safe" || this.recorded(key, info, args) !== null ? "rerun" : "unknown";
		if (name === "codemode") return [...this.external.values()].every((t) => t.replay === "safe") ? "rerun" : "unknown";
		return "sandbox";
	}

	/** Every call, direct or nested, goes through here. */
	async invoke(name: string, args: Json, nested: boolean, signal: AbortSignal | undefined, call: string): Promise<ToolOutcome> {
		const tool = this.#tools.get(name);
		this.spec.log({ kind: "tool_call", tool: name, args, nested });
		let outcome: ToolOutcome;
		if (!tool) outcome = { text: `tool ${name} is not available to agent ${this.spec.agent}`, isError: true };
		else if (this.pending !== null && !nested) outcome = { text: `not run: this turn waits for the reply to ${this.pending.call}`, isError: true };
		else if (++this.calls > this.#maxCalls) outcome = { text: `tool budget exhausted (${this.#maxCalls} calls)`, isError: true };
		else {
			try {
				outcome = await tool.run(args, signal, call);
			} catch (error) {
				outcome = { text: error instanceof Error ? error.message : String(error), isError: true };
			}
		}
		if (outcome.pending !== undefined) {
			if (nested) outcome = { text: `${name} pauses the turn, so it cannot run from codemode: call it directly`, isError: true };
			else this.pending = { call, pending: outcome.pending };
		}
		this.spec.log({ kind: "tool_result", tool: name, result: outcome.value ?? outcome.text, isError: outcome.isError === true, nested });
		return outcome;
	}

	/**
	 * Cuts text that would enter the context at the cap. The full text goes
	 * to the spill dir, and the marker says how to page it.
	 */
	cap(text: string): string {
		if (text.length <= this.#cap) return text;
		const name = `${++this.#spills}.txt`;
		mkdirSync(this.spec.workspace.spill, { recursive: true });
		writeFileSync(join(this.spec.workspace.spill, name), text);
		this.spec.log({ kind: "note", text: `spilled ${text.length} chars to spill/${name}` });
		const page = `await tools.read_spill({ name: ${JSON.stringify(name)}, offset: ${this.#cap} })`;
		return `${text.slice(0, this.#cap)}\n[output truncated at ${this.#cap} of ${text.length} chars; the full text is spill ${JSON.stringify(name)}. Page it from the next script: ${page}]`;
	}

	/** The tools the model is offered, as pi `AgentTool`s: every tool, plus codemode. */
	agentTools(): AgentTool[] {
		if (!this.#tools.has("codemode")) this.add(this.#codemodeTool());
		return this.names.map((name) => {
			const tool = this.#tools.get(name)!;
			return {
				name: tool.name,
				label: tool.name,
				description: tool.description,
				parameters: tool.parameters as object,
				execute: async (id: string, params: unknown, signal?: AbortSignal) => {
					const r = await this.invoke(tool.name, params as Json, false, signal, this.key(id));
					// A pausing call's result is a placeholder, replaced by the reply when it arrives.
					const details = r.pending === undefined ? undefined : { wallis_pending: r.pending as unknown as Json };
					const images = (r.images ?? []).map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));
					return { content: [{ type: "text" as const, text: this.cap(r.text) }, ...images], details, isError: r.isError === true, terminate: this.submitted !== undefined };
				},
			};
		});
	}

	#codemodeTool(): WallisToolRun {
		const nestedTools: CodemodeTool[] = this.names
			.filter((n) => n !== "codemode" && n !== "ask")
			.map((name) => {
				const tool = this.#tools.get(name)!;
				return {
					name,
					description: tool.description,
					inputSchema: tool.parameters as never,
					execute: async (args: unknown, ctx: { signal: AbortSignal }) => {
						const r = await this.invoke(name, args as Json, true, ctx.signal, `${this.#codemodeCall}/${this.#nested++}`);
						if (r.isError) throw new Error(r.text);
						return r.value ?? r.text;
					},
				};
			});
		return {
			name: "codemode",
			description: [
				"Run a JavaScript async function body that calls this agent's tools as `await tools.<name>(args)` and returns a value.",
				"Your full input is the variable `input`; folded fields of the prompt are complete there.",
				`Output longer than ${this.#cap} characters is cut; its full text is spilled and paged with tools.read_spill.`,
				`Tool names: ${nestedTools.map((t) => `${t.name} -> tools.${toCodemodeIdentifier(t.name)}`).join(", ")}.`,
				renderDeclarations({ tools: nestedTools }),
			].join("\n\n"),
			parameters: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
			run: async (args, signal, call) => {
				this.#codemodeCall = call;
				this.#nested = 0;
				const sandbox = new CodemodeSandbox({ tools: nestedTools });
				try {
					const code = `const input = load("input");\n${String((args as { code?: unknown }).code ?? "")}`;
					const result = await sandbox.execute(code, { signal, store: { input: this.spec.input } });
					const parts = result.output.map((o) => (o.type === "text" ? o.text : "[image]"));
					if (result.ok) {
						if (result.value !== undefined) parts.push(JSON.stringify(result.value));
						return { text: parts.join("\n") || "(no output)", value: (result.value ?? null) as Json };
					}
					return { text: [...parts, result.error.stack ?? result.error.message].join("\n"), isError: true };
				} finally {
					await sandbox.close();
				}
			},
		};
	}

	async close(): Promise<void> {
		await Promise.allSettled(this.#clients.map((c) => c.close()));
	}
}

// --- Building a node's tools ------------------------------------------------------

function within(roots: readonly string[], path: string): boolean {
	return roots.some((root) => {
		const rel = relative(root, path);
		return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !rel.startsWith("/"));
	});
}

export async function buildNodeTools(spec: NodeSpec, options: ToolLayerOptions = {}): Promise<NodeTools> {
	const tools = new NodeTools(spec, options.maxCalls ?? Math.max(16, spec.turnLimit * 10), options.resultCap ?? RESULT_CAP);
	const ws = spec.workspace;
	const declared = spec.declaration.tools;

	tools.add({
		name: "submit_result",
		description: "Submit your final result. It must match the result schema; on a mismatch you get the errors and may resubmit.",
		parameters: spec.outputSchema,
		run: async (args) => {
			const size = JSON.stringify(args).length;
			const errors = size > OUTPUT_CAP ? [`/ result is ${size} chars; the cap is ${OUTPUT_CAP}`] : validateSubmission(spec, args);
			if (errors.length > 0) return { text: `submit_result does not match the result schema:\n${errors.join("\n")}`, isError: true };
			tools.submitted = args;
			return { text: "submitted", value: null };
		},
	});

	tools.add({
		name: "read_spill",
		description: "Read a page of output that was cut at the context cap and spilled (the marker names it).",
		parameters: { type: "object", required: ["name"], properties: { name: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 } } },
		run: async (args) => {
			const { name, offset, limit } = args as { name: string; offset?: number; limit?: number };
			const path = resolve(ws.spill, name);
			if (!within([ws.spill], path)) return { text: `${name} is not a spill of this node`, isError: true };
			const text = readFileSync(path, "utf8");
			const from = offset ?? 0;
			const page = text.slice(from, from + Math.min(limit ?? SPILL_PAGE, SPILL_PAGE));
			return { text: page, value: { text: page, next: from + page.length, total: text.length } };
		},
	});

	if (declared.some((d) => d.kind === "ask")) {
		tools.add({
			name: "ask",
			description: "Ask a question in plain language and wait for the reply, which becomes this tool's result. Make the question self-contained.",
			parameters: { type: "object", required: ["message"], properties: { message: { type: "string", minLength: 1 } } },
			run: async (args) => ({ text: "(waiting for the reply)", pending: { type: "ask", message: String((args as { message?: unknown }).message ?? "") } }),
		});
	}

	const access = spec.declaration.access;
	if (access > 0) {
		const box = spec.sandbox;
		/** A path as the agent sees it (`/w/...`, `/w/<mount>/...`, `/run/wallis/inputs/...`) mapped to the host. */
		const toHost = (path: string): { abs: string; writable: boolean } => {
			const p = posix.normalize(path.startsWith("/") ? path : `${LAYOUT.work}/${path}`);
			const under = (root: string) => p === root || p.startsWith(`${root}/`);
			if (under(LAYOUT.inputs)) return { abs: join(ws.inputs, p.slice(LAYOUT.inputs.length)), writable: false };
			if (!under(LAYOUT.work)) throw new Error(`${path} is outside this node's sandbox`);
			const rest = p.slice(LAYOUT.work.length).replace(/^\//, "");
			const [first, ...more] = rest.split("/");
			if (first && first in ws.mounts) return { abs: join(ws.mounts[first]!, ...more), writable: false };
			return { abs: join(ws.scratch, rest), writable: true };
		};
		const writable = (path: string) => {
			const target = toHost(path);
			if (!target.writable || !within([ws.scratch], target.abs)) throw new Error(`${path} is read-only: only your scratch dir (${LAYOUT.work}) is writable`);
			return target.abs;
		};
		const mounts = Object.keys(ws.mounts).map((m) => `${LAYOUT.work}/${m}`).join(", ") || "none";
		const where = `${LAYOUT.work} is your scratch dir (writable, the working directory); mounts ${mounts} and ${LAYOUT.inputs} are read-only`;
		const builtins: Record<string, WallisToolRun> = {
			read: {
				name: "read",
				description: `Read a file: text, with offset (1-based line) and limit (lines) for large files; images (jpg, png, gif, webp) as images. ${where}.`,
				parameters: { type: "object", required: ["path"], properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } } },
				run: async (args) => {
					const { path, offset, limit } = args as { path: string; offset?: number; limit?: number };
					const abs = toHost(path).abs;
					const mimeType = IMAGES[extname(abs).toLowerCase()];
					if (mimeType) return { text: `image ${path}`, images: [{ data: readFileSync(abs).toString("base64"), mimeType }] };
					const lines = readFileSync(abs, "utf8").split("\n");
					const from = (offset ?? 1) - 1;
					const text = lines.slice(from, limit === undefined ? undefined : from + limit).join("\n").slice(0, FILE_CAP);
					return { text, value: text };
				},
			},
			write: {
				name: "write",
				description: `Write a file, creating parent directories; it replaces the file's content. ${where}.`,
				parameters: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
				run: async (args) => {
					const { path, content } = args as { path: string; content: string };
					const abs = writable(path);
					mkdirSync(dirname(abs), { recursive: true });
					writeFileSync(abs, content);
					return { text: `wrote ${content.length} characters to ${path}` };
				},
			},
			edit: {
				name: "edit",
				description: `Edit a file by replacing oldText, which must occur exactly once, with newText. ${where}.`,
				parameters: { type: "object", required: ["path", "oldText", "newText"], properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } } },
				run: async (args) => {
					const { path, oldText, newText } = args as { path: string; oldText: string; newText: string };
					const abs = writable(path);
					const text = readFileSync(abs, "utf8");
					const count = oldText === "" ? 0 : text.split(oldText).length - 1;
					if (count !== 1) return { text: `oldText occurs ${count} times in ${path}; it must occur exactly once`, isError: true };
					writeFileSync(abs, text.replace(oldText, () => newText));
					return { text: `edited ${path}` };
				},
			},
			ls: {
				name: "ls",
				description: `List a directory (default ${LAYOUT.work}); directories end with /. ${where}.`,
				parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1 } } },
				run: async (args) => {
					const { path, limit } = args as { path?: string; limit?: number };
					const dir = toHost(path ?? LAYOUT.work).abs;
					const entries = readdirSync(dir)
						.sort()
						.slice(0, limit ?? LS_LIMIT)
						.map((name) => (statSync(resolve(dir, name)).isDirectory() ? `${name}/` : name));
					return { text: entries.join("\n"), value: entries };
				},
			},
			bash: {
				name: "bash",
				description: `Run a bash command in your sandbox${box.type === "none" ? "" : ` (${box.name})`}, no network. ${where}. timeout in seconds (default 120).`,
				parameters: { type: "object", required: ["command"], properties: { command: { type: "string" }, timeout: { type: "number", exclusiveMinimum: 0 } } },
				run: async (args, signal) => {
					if (box.type === "unavailable") return { text: `no sandbox: ${box.reason}`, isError: true };
					if (box.type === "none") return { text: "no sandbox", isError: true };
					const { command, timeout } = args as { command: string; timeout?: number };
					const r = await runSpawn(box.spawn(["bash", "-c", command]), "", { timeoutMs: (timeout ?? 120) * 1000, signal });
					const out = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`;
					return { text: `exit ${r.exit}${r.timedOut ? " (timed out)" : ""}\n${out}`, value: { exit: r.exit, stdout: r.stdout, stderr: r.stderr }, isError: r.exit !== 0 };
				},
			},
		};
		const granted = [["read", "ls"], ["write", "edit"], ["bash"]].slice(0, access).flat();
		for (const name of granted) tools.add(builtins[name]!);
		if (access >= 2) tools.add({
			name: "export_artifact",
			description: "Export a file from your scratch dir as an artifact; put the returned ref in submit_result.",
			parameters: { type: "object", required: ["path", "media"], properties: { path: { type: "string" }, media: { type: "string" }, name: { type: "string" } } },
			run: async (args) => {
				const { path, media, name } = args as { path: string; media: string; name?: string };
				const ref = spec.exportArtifact(relative(ws.scratch, toHost(path).abs), media, name);
				return { text: JSON.stringify(ref), value: ref as unknown as Json };
			},
		});
	}

	// Custom and MCP tools: one connection per source for this agent call; the write rule is applied again.
	const sources = new Map<string, Source>();
	for (const d of declared) {
		if (d.kind === "custom") sources.set(sourceKey({ kind: "toolset", path: d.toolset }), { kind: "toolset", path: d.toolset });
		if (d.kind === "mcp_server" || d.kind === "mcp_tool") sources.set(sourceKey({ kind: "mcp", server: d.server }), { kind: "mcp", server: d.server });
	}
	const clients = new Map<string, McpClient>();
	const listing = new Map<string, ToolInfo[]>();
	for (const [key, source] of sources) {
		const client = await spec.connect(source);
		tools.addClient(client);
		clients.set(key, client);
		listing.set(key, toolInfos(source, (await client.listTools()) as never));
	}
	const resolved = resolveAgentTools(spec.agent, declared, listing);
	for (const w of resolved.warnings) spec.warn(w);
	if (resolved.unknown !== null) spec.warn(`agent ${spec.agent}: tool ${resolved.unknown} is not offered by its source`);
	for (const info of resolved.tools) {
		const client = clients.get(sourceKey(info.source))!;
		tools.external.set(info.name, info);
		tools.add({
			name: info.name,
			description: info.description,
			parameters: { ...(info.inputSchema as object), type: "object", properties: (info.inputSchema as { properties?: Json }).properties ?? {} } as unknown as Json,
			run: async (args, signal, call) => {
				const recorded = tools.recorded(call, info, args);
				if (recorded !== null) return recorded;
				const r = await client.callTool(info.remote, args as Record<string, unknown>, { signal });
				const text = toLlmContent(r)
					.map((c) => (c.type === "text" ? c.text : "[image]"))
					.join("\n");
				const outcome: ToolOutcome = { text, value: (r.structuredContent ?? text) as Json, isError: r.isError === true };
				spec.record(call, { tool: info.id, args, outcome } as unknown as Json);
				return outcome;
			},
		});
	}
	return tools;
}
