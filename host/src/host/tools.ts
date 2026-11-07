// The wallis tool layer: every tool an agent can call, built per node and
// handed to an executor. It enforces the agent's allowlist, logs every call
// to the node's transcript, counts calls against the node's tool budget,
// and injects secrets only into MCP server processes.
//
// Built-in tools: submit_result (validated; errors go back to the model),
// state_read (capped, against the call's snapshot), emit (declared emit
// fields only), export_artifact and fs/exec tools confined to the node's
// dirs (by sandbox level), declared defineTools (served by scripts) and the
// allowlisted tools of upstream MCP servers.
//
// codemode (default on for agents that have tools beyond submit_result and
// state_read): the model gets `codemode` and `submit_result`; a codemode
// script can call the agent's allowlisted tools, including submit_result
// and state_read, and every nested call goes through the same allowlist,
// logging and budget.

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CodemodeSandbox, type CodemodeTool, renderDeclarations, toCodemodeIdentifier } from "@earendil-works/pi-codemode";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import type { Json } from "../sdk/index.ts";
import type { Write } from "./core.ts";
import { type NodeSpec, type ScriptRunner, validateSubmission } from "./executor.ts";
import { bwrapArgs, bwrapAvailable } from "./scripts.ts";

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
}

const STATE_READ_CAP = 20_000;
const FILE_CAP = 100_000;

export class NodeTools {
	readonly spec: NodeSpec;
	submitted: Json | undefined = undefined;
	readonly emits: Write[] = [];
	calls = 0;
	readonly #tools = new Map<string, WallisTool>();
	readonly #maxCalls: number;
	readonly #clients: McpClient[] = [];
	readonly codemode: boolean;

	constructor(spec: NodeSpec, maxCalls: number) {
		this.spec = spec;
		this.#maxCalls = maxCalls;
		this.codemode = (spec.declaration as { codemode?: boolean }).codemode !== false;
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

	/** The tools the model is offered, as pi `AgentTool`s. */
	agentTools(): AgentTool[] {
		const direct = this.codemode && this.#hasCapabilityTools() ? ["submit_result", "codemode"] : this.names;
		if (direct.includes("codemode") && !this.#tools.has("codemode")) this.add(this.#codemodeTool());
		return direct.map((name) => {
			const tool = this.#tools.get(name)!;
			return {
				name: tool.name,
				label: tool.name,
				description: tool.description,
				parameters: tool.parameters as object,
				execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
					const r = await this.invoke(tool.name, params as Json, false, signal);
					return { content: [{ type: "text" as const, text: r.text }], details: undefined, isError: r.isError === true, terminate: this.submitted !== undefined };
				},
			};
		});
	}

	#hasCapabilityTools(): boolean {
		return this.names.some((n) => n !== "submit_result" && n !== "state_read" && n !== "codemode");
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
				`Tool names: ${nestedTools.map((t) => `${t.name} -> tools.${toCodemodeIdentifier(t.name)}`).join(", ")}.`,
				renderDeclarations({ tools: nestedTools }),
			].join("\n\n"),
			parameters: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
			run: async (args, signal) => {
				const sandbox = new CodemodeSandbox({ tools: nestedTools });
				try {
					const result = await sandbox.execute(String((args as { code?: unknown }).code ?? ""), { signal });
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
	const tools = new NodeTools(spec, options.maxCalls ?? Math.max(16, spec.maxTurns * 10));
	const ws = spec.workspace;

	tools.add({
		name: "submit_result",
		description: "Submit your final result. It must match the result schema; on a mismatch you get the errors and may resubmit.",
		parameters: spec.outputSchema,
		run: async (args) => {
			const errors = validateSubmission(spec, args);
			if (errors.length > 0) return { text: `submit_result does not match the result schema:\n${errors.join("\n")}`, isError: true };
			tools.submitted = args;
			return { text: "submitted", value: null };
		},
	});

	tools.add({
		name: "state_read",
		description: "Read your snapshot of the run state (the view taken when this call started), capped.",
		parameters: { type: "object", properties: { max_chars: { type: "integer", minimum: 1 } } },
		run: async (args) => {
			const max = Math.min(STATE_READ_CAP, Number((args as { max_chars?: number }).max_chars ?? STATE_READ_CAP));
			return { text: spec.view.slice(0, max) || "(empty view)", value: spec.view.slice(0, max) };
		},
	});

	const emitFields = Object.entries(spec.declaration.writes)
		.filter(([, source]) => typeof source !== "string")
		.map(([field]) => field);
	if (emitFields.length > 0) {
		tools.add({
			name: "emit",
			description: `Write a value to a state field when this call ends. Fields: ${emitFields.join(", ")}.`,
			parameters: { type: "object", required: ["field", "value"], properties: { field: { enum: emitFields }, value: {} } },
			run: async (args) => {
				const { field, value } = args as { field: string; value: Json };
				if (!emitFields.includes(field)) return { text: `field ${field} may not be written`, isError: true };
				tools.emits.push({ field, value });
				return { text: `buffered a write to ${field}` };
			},
		});
	}

	if (ws.level !== "none") {
		const readable = [ws.inputs, ...Object.values(ws.data), ...(ws.scratch ? [ws.scratch] : [])];
		const inside = (path: string, roots: readonly string[]) => {
			const abs = resolve(ws.scratch ?? ws.inputs, path);
			if (!within(roots, abs)) throw new Error(`${path} is outside this node's dirs`);
			return abs;
		};
		tools.add({
			name: "read_file",
			description: `Read a text file from your input artifacts (${ws.inputs}), data dirs${ws.scratch ? " or scratch dir" : ""}.`,
			parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
			run: async (args) => {
				const content = readFileSync(inside(String((args as { path: string }).path), readable), "utf8");
				return { text: content.slice(0, FILE_CAP), value: content.slice(0, FILE_CAP) };
			},
		});
		tools.add({
			name: "list_dir",
			description: "List a directory among your input artifacts, data dirs or scratch dir.",
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
				description: "Run a shell command confined to your dirs (scratch writable, inputs and data read-only, no network). 60 s limit.",
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
				return { text: text(r.output), value: r.output };
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
