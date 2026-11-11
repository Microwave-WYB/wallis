// Tool sources as bodies and agents use them. A toolset is bundled once per
// source text (a blob in the store, recorded in the run's facts so a
// resumed run runs the same bundle); every use opens its own connection, in
// its own scratch dir. A body's tool call returns the tool's structured
// result (checked against its `outputSchema` when it declares one), or its
// text parsed as JSON, or its text.

import type { McpClient } from "@earendil-works/pi-mcp";
import type { Json } from "./host/core.ts";
import { bundleToolset, type Source, type ToolInfo, ToolSources } from "./host/sources.ts";
import type { Store } from "./host/store.ts";
import type { ToolDef, ToolSourceDef } from "./nodes.ts";
import type { Plans } from "./plans.ts";
import { canonical, schemaErrors, sha256 } from "./values.ts";

export type ToolResult = { ok: true; output: Json } | { ok: false; message: string };

/** One open connection to a source, with its tools listed. */
export interface Connection {
	readonly source: Source;
	readonly tools: readonly ToolInfo[];
	readonly client: McpClient;
}

const sourceKey = (s: ToolSourceDef) => sha256(canonical(s.kind === "toolset" ? { toolset: sha256(s.source), sandbox: s.sandbox.digest } : { mcp: s.server, command: s.command, args: s.args }));

export class ToolCaller {
	readonly #store: Store;
	readonly #sources: ToolSources;
	readonly #plans: Plans;
	readonly #bundles = new Map<string, Promise<string>>();
	readonly #listings = new Map<string, readonly ToolInfo[]>();
	readonly #open = new Set<McpClient>();
	/** A recorded bundle (by source key), and a way to record a new one. */
	readonly #recorded: (key: string) => string | undefined;
	readonly #record: (key: string, bundle: string) => void;

	constructor(options: { store: Store; work: string; plans: Plans; recorded: (key: string) => string | undefined; record: (key: string, bundle: string) => void }) {
		this.#store = options.store;
		this.#sources = new ToolSources(options.store, options.work);
		this.#plans = options.plans;
		this.#recorded = options.recorded;
		this.#record = options.record;
	}

	#bundle(s: Extract<ToolSourceDef, { kind: "toolset" }>): Promise<string> {
		const key = sourceKey(s);
		let b = this.#bundles.get(key);
		if (!b) {
			const pinned = this.#recorded(key);
			b = pinned !== undefined && this.#store.hasBlob(pinned) ? Promise.resolve(pinned) : bundleToolset(this.#store, s.file).then((d) => (this.#record(key, d), d));
			this.#bundles.set(key, b);
		}
		return b;
	}

	async connect(s: ToolSourceDef): Promise<Connection> {
		let client: McpClient;
		let source: Source;
		if (s.kind === "toolset") {
			const bundle = await this.#bundle(s);
			const plan = { ...this.#plans.plan(s.sandbox, ["node"]), network: s.network };
			const secrets = Object.fromEntries(s.secrets.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));
			client = await this.#sources.connectToolset(bundle, plan, secrets);
			source = { kind: "toolset", bundle };
		} else {
			const plan = { ...this.#plans.plan(s.sandbox, [s.command]), network: s.network };
			client = await this.#sources.connectServer({ command: s.command, args: s.args, env: s.env }, plan);
			source = { kind: "mcp", server: s.server };
		}
		this.#open.add(client);
		const tools = await ToolSources.list(client, source);
		this.#listings.set(sourceKey(s), tools);
		return { source, tools, client };
	}

	async disconnect(c: Connection): Promise<void> {
		this.#open.delete(c.client);
		await c.client.close().catch(() => {});
	}

	/** Lists a tool's source once, so `replaySafe` knows (a body tool call is requested after this). */
	async prepare(def: ToolDef): Promise<void> {
		if (this.#listings.has(sourceKey(def.source))) return;
		await this.disconnect(await this.connect(def.source));
	}

	/** Whether a tool may be made again when it was in flight as the run stopped. */
	replaySafe(def: ToolDef): boolean {
		const info = this.#listings.get(sourceKey(def.source))?.find((t) => t.remote === def.remote);
		return info?.replay === "safe";
	}

	/** A body's call of one tool. */
	async call(def: ToolDef, input: Json): Promise<ToolResult> {
		if (def.remote === null) return { ok: false, message: `${def.label} is a whole MCP server; call one of its tools` };
		const c = await this.connect(def.source);
		try {
			const info = c.tools.find((t) => t.remote === def.remote);
			if (!info) return { ok: false, message: `no tool ${def.remote} in ${def.label}` };
			const r = (await c.client.callTool(def.remote, (input ?? {}) as Record<string, unknown>)) as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
			const text = (r.content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
			if (r.isError) return { ok: false, message: text || "the tool failed" };
			let output: unknown = r.structuredContent;
			if (output === undefined) {
				try {
					output = JSON.parse(text);
				} catch {
					output = text;
				}
			}
			if (info.outputSchema !== null) {
				const errors = schemaErrors(info.outputSchema as never, output);
				if (errors.length > 0) return { ok: false, message: `its result does not match its outputSchema: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}` };
			}
			return { ok: true, output: JSON.parse(JSON.stringify(output ?? null)) as Json };
		} finally {
			await this.disconnect(c);
		}
	}

	async close(): Promise<void> {
		await Promise.all([...this.#open].map((c) => c.close().catch(() => {})));
		this.#open.clear();
	}
}
