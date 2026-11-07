// The wallis tool layer: every tool an agent can call, built per node and
// handed to an executor. It enforces the agent's allowlist, logs every call
// to the node's transcript, counts calls against the node's tool budget,
// caps every result that enters the model's context, and injects secrets
// only into MCP server processes.
//
// Every agent gets `codemode` and `submit_result`, plus its declared tools
// (fs tools by sandbox level, `defineTool`s, allowlisted MCP tools), which
// are callable directly and from codemode. Codemode runs in QuickJS with no
// fs or network, so it adds no capability to a `sandbox: "none"` agent.
// Inside codemode the full input is the `input` variable.
//
// Context protection: a direct tool result or a codemode output longer than
// the cap is cut, and its full text is spilled to the node's spill dir with
// an explicit marker; the next script pages it with `read_spill`. Nothing
// is dropped silently.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CodemodeSandbox, type CodemodeTool, renderDeclarations, toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import type { Json } from "../sdk/index.ts";
import { type NodeSpec, type ScriptRunner, validateSubmission } from "./executor.ts";
import { bwrapArgs, bwrapAvailable } from "./scripts.ts";
import { parseWith } from "../sdk/validate.ts";

/** A tool as wallis runs it, before it is adapted to an executor. */
export interface WallisTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: Json;
	run(args: Json, signal?: AbortSignal): Promise<ToolOutcome>;
}

export interface ToolOutcome {
	readonly text: string;
	readonly value?: Json;
	readonly isError?: boolean;
}

export interface ToolLayerOptions {
	/** Script runner for declared `defineTool`s. */
	readonly scripts?: ScriptRunner;
	/** Where `${VAR}` secret references in MCP server env are resolved. Default: process.env. */
	readonly secrets?: Readonly<Record<string, string | undefined>>;
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

export class NodeTools {
	readonly spec: NodeSpec;
	submitted: Json | undefined = undefined;
	calls = 0;
	readonly #tools = new Map<string, WallisTool>();
	readonly #maxCalls: number;
	readonly #cap: number;
	readonly #clients: McpClient[] = [];
	#spills = 0;

	constructor(spec: NodeSpec, maxCalls: number, cap: number) {
		this.spec = spec;
		this.#maxCalls = maxCalls;
		this.#cap = cap;
	}

	add(tool: WallisTool): void {
		this.#tools.set(tool.name, tool);
	}

	addClient(client: McpClient): void {
		this.#clients.push(client);
	}

	get names(): string[] {
		return [...this.#tools.keys()];
	}

	/** Every call, direct or nested, goes through here. */
	async invoke(name: string, args: Json, nested: boolean, signal?: AbortSignal): Promise<ToolOutcome> {
		const tool = this.#tools.get(name);
		this.spec.log({ kind: "tool_call", tool: name, args, nested });
		let outcome: ToolOutcome;
		if (!tool) outcome = { text: `tool ${name} is not allowed for agent ${this.spec.agent}`, isError: true };
		else if (++this.calls > this.#maxCalls) outcome = { text: `tool budget exhausted (${this.#maxCalls} calls)`, isError: true };
		else {
			try {
				outcome = await tool.run(args, signal);
			} catch (error) {
				outcome = { text: error instanceof Error ? error.message : String(error), isError: true };
			}
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
				execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
					const r = await this.invoke(tool.name, params as Json, false, signal);
					return { content: [{ type: "text" as const, text: this.cap(r.text) }], details: undefined, isError: r.isError === true, terminate: this.submitted !== undefined };
				},
			};
		});
	}

	#codemodeTool(): WallisTool {
		const nestedTools: CodemodeTool[] = this.names
			.filter((n) => n !== "codemode")
			.map((name) => {
				const tool = this.#tools.get(name)!;
				return {
					name,
					description: tool.description,
					inputSchema: tool.parameters as never,
					execute: async (args: unknown, ctx: { signal: AbortSignal }) => {
						const r = await this.invoke(name, args as Json, true, ctx.signal);
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
			run: async (args, signal) => {
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

function text(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function resolveSecrets(env: Readonly<Record<string, string>> | undefined, secrets: Readonly<Record<string, string | undefined>>): Record<string, string> {
	return Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, v.replace(/\$\{(\w+)\}/g, (_m, name: string) => secrets[name] ?? "")]));
}

export async function buildNodeTools(spec: NodeSpec, options: ToolLayerOptions = {}): Promise<NodeTools> {
	const tools = new NodeTools(spec, options.maxCalls ?? Math.max(16, spec.maxTurns * 10), options.resultCap ?? RESULT_CAP);
	const ws = spec.workspace;

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
		parameters: {
			type: "object",
			required: ["name"],
			properties: { name: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 } },
		},
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

	if (ws.level !== "none") {
		const readable = [ws.inputs, ...Object.values(ws.mounts), ...(ws.scratch ? [ws.scratch] : [])];
		const inside = (path: string, roots: readonly string[]) => {
			const abs = resolve(ws.scratch ?? ws.inputs, path);
			if (!within(roots, abs)) throw new Error(`${path} is outside this node's dirs`);
			return abs;
		};
		const mounts = Object.entries(ws.mounts).map(([n, d]) => `${n}: ${d}`).join(", ") || "none";
		tools.add({
			name: "read_file",
			description: `Read a text file from your input artifacts (${ws.inputs}), mounts (${mounts})${ws.scratch ? " or scratch dir" : ""}.`,
			parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
			run: async (args) => {
				const content = readFileSync(inside(String((args as { path: string }).path), readable), "utf8");
				return { text: content.slice(0, FILE_CAP), value: content.slice(0, FILE_CAP) };
			},
		});
		tools.add({
			name: "list_dir",
			description: "List a directory among your input artifacts, mounts or scratch dir.",
			parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
			run: async (args) => {
				const dir = inside(String((args as { path: string }).path), readable);
				const entries = readdirSync(dir).map((name) => (statSync(resolve(dir, name)).isDirectory() ? `${name}/` : name));
				return { text: entries.join("\n"), value: entries };
			},
		});
	}
	if (ws.scratch) {
		const scratch = ws.scratch;
		tools.add({
			name: "write_file",
			description: `Write a text file in your scratch dir (${scratch}). Only exported artifacts outlive this node.`,
			parameters: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
			run: async (args) => {
				const { path, content } = args as { path: string; content: string };
				const abs = resolve(scratch, path);
				if (!within([scratch], abs)) return { text: `${path} is outside your scratch dir`, isError: true };
				mkdirSync(dirname(abs), { recursive: true });
				writeFileSync(abs, content);
				return { text: `wrote ${relative(scratch, abs)}` };
			},
		});
		tools.add({
			name: "export_artifact",
			description: "Export a file from your scratch dir as an artifact; put the returned ref in submit_result.",
			parameters: { type: "object", required: ["path", "media"], properties: { path: { type: "string" }, media: { type: "string" }, name: { type: "string" } } },
			run: async (args) => {
				const { path, media, name } = args as { path: string; media: string; name?: string };
				const ref = spec.exportArtifact(path, media, name);
				return { text: JSON.stringify(ref), value: ref as unknown as Json };
			},
		});
		if (bwrapAvailable()) {
			tools.add({
				name: "exec",
				description: "Run a shell command confined to your dirs (scratch writable, inputs and mounts read-only, no network). 60 s limit.",
				parameters: { type: "object", required: ["command"], properties: { command: { type: "string" } } },
				run: async (args) => {
					const r = spawnSync("bwrap", [...bwrapArgs(ws, []), "--setenv", "PATH", "/usr/bin:/bin", "--", "/bin/sh", "-c", String((args as { command: string }).command)], {
						encoding: "utf8",
						timeout: 60_000,
					});
					const out = `${r.stdout ?? ""}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`.slice(0, FILE_CAP);
					return { text: `exit ${r.status ?? r.signal}\n${out}`, value: { exit: r.status, stdout: r.stdout, stderr: r.stderr }, isError: r.status !== 0 };
				},
			});
		}
	}

	for (const tool of spec.declaration.tools) {
		tools.add({
			name: tool.name,
			description: tool.description,
			parameters: tool.input as unknown as Json,
			run: async (args) => {
				if (!options.scripts) return { text: `tool ${tool.name} needs a script runner`, isError: true };
				const r = await options.scripts.run({
					id: `${spec.id}/tool/${tool.name}`,
					script: tool.script,
					args,
					computeMinutes: null,
					digest: "",
					outputSchema: tool.output as unknown as Json,
					workspace: { ...spec.workspace, scratch: null, level: "read-only" },
					resources: {},
				});
				const parsed = parseWith(tool.output, r.output);
				if (!parsed.ok) return { text: `tool ${tool.name} returned an output that does not match its schema: ${parsed.errors.join("; ")}`, isError: true };
				return { text: text(parsed.value), value: parsed.value };
			},
		});
	}

	// Upstream MCP servers, through pi-mcp. Secrets reach the server process only.
	const servers = (spec.mcp ?? {}) as Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }>;
	for (const [server, allow] of Object.entries(spec.declaration.mcp)) {
		const config = servers[server];
		if (!config) continue;
		const secrets = options.secrets ?? process.env;
		const transport = config.url
			? new StreamableHttpTransport({ url: config.url, headers: resolveSecrets(config.headers, secrets) })
			: new StdioTransport({ command: config.command!, args: config.args ?? [], env: resolveSecrets(config.env, secrets), stderr: "pipe" });
		const client = new McpClient({ name: "wallis", version: "0.0.0" });
		await client.connect(transport);
		tools.addClient(client);
		for (const t of await client.listTools()) {
			if (allow !== "*" && !allow.includes(t.name)) continue;
			tools.add({
				name: `mcp__${server}__${t.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
				description: t.description ?? t.name,
				parameters: { ...t.inputSchema, type: "object", properties: t.inputSchema.properties ?? {} } as unknown as Json,
				run: async (args, signal) => {
					const r = await client.callTool(t.name, args as Record<string, unknown>, { signal });
					const content = toLlmContent(r)
						.map((c) => (c.type === "text" ? c.text : "[image]"))
						.join("\n");
					return { text: content, value: (r.structuredContent ?? content) as Json, isError: r.isError === true };
				},
			});
		}
	}
	return tools;
}
