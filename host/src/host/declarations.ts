// The workflow's declarations, as the host takes them from the workflow VM:
// `unknown` until parsed with this schema, then checked against every
// sandbox rule again. The VM runs workflow code, so its own checks
// (`declarations()` in sdk/runtime.ts) are only early errors; the host
// never trusts them.

import Type from "typebox";
import Value from "typebox/value";
import type { Refusal, TSchema } from "../sdk/index.ts";
import type { Declarations } from "../sdk/runtime.ts";
import { parseMemLimit, pidsLimitProblem } from "./limits.ts";

const Str = Type.String();
const Strs = Type.Array(Str);
const Schema = Type.Unsafe<TSchema>({});
const NullableStr = Type.Union([Str, Type.Null()]);
const Network = Type.Union([Type.Literal("none"), Type.Literal("host")]);

const ToolDesc = Type.Union([
	Type.Object({ kind: Type.Literal("ask") }),
	Type.Object({ kind: Type.Literal("custom"), toolset: Str, export: Str }),
	Type.Object({ kind: Type.Literal("mcp_server"), server: Str }),
	Type.Object({ kind: Type.Literal("mcp_tool"), server: Str, tool: Str }),
]);

const Volume = Type.Union([
	Type.Object({ kind: Type.Literal("bind"), host: Str, target: Str }),
	Type.Object({ kind: Type.Literal("named"), name: Str, target: Str }),
	Type.Object({ kind: Type.Literal("invalid"), text: Str, reason: Str }),
]);

const Sandbox = Type.Object({
	requires: Type.Array(Type.Object({ name: Str, check: Strs })),
	setup: Type.Array(Strs),
	volumes: Type.Array(Volume),
	devices: Strs,
	network: Network,
	environment: Type.Record(Str, Str),
	mem_limit: NullableStr,
	pids_limit: Type.Union([Type.Integer(), Type.Null()]),
	image: NullableStr,
});

const DeclarationsSchema = Type.Object({
	core: Type.Object({
		name: Str,
		agents: Type.Array(Type.Object({ name: Str, model: Str, max_turns: Type.Integer(), steerable: Type.Boolean() })),
		commands: Strs,
		orchestrators: Strs,
		budget: Type.Object({ turns: Type.Union([Type.Number(), Type.Null()]), compute_minutes: Type.Union([Type.Number(), Type.Null()]) }),
	}),
	models: Type.Intersect([Type.Object({ default: Str }), Type.Record(Str, Str)]),
	pin: Type.Object({ files: Strs }),
	agents: Type.Record(
		Str,
		Type.Object({
			model: Str,
			prompt: Str,
			input: Schema,
			output: Schema,
			tools: Type.Array(ToolDesc),
			access: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
			skills: Strs,
			needs: Type.Object({ structuredOutput: Type.Optional(Type.Boolean()), toolCalls: Type.Optional(Type.Boolean()), contextTokens: Type.Optional(Type.Number()) }),
			sandbox: NullableStr,
			steerable: Type.Boolean(),
			compaction: Type.Boolean(),
			max_turns: Type.Integer(),
		}),
	),
	commands: Type.Record(
		Str,
		Type.Object({
			description: Str,
			input: Schema,
			output: Schema,
			sandbox: Str,
			resources: Type.Object({ gpu: Type.Optional(Type.Number()), memoryGb: Type.Optional(Type.Number()) }),
			code: Strs,
		}),
	),
	orchestrators: Type.Record(Str, Type.Object({ description: Str, input: Schema, output: Schema })),
	toolsets: Type.Record(Str, Type.Object({ sandbox: Str, secrets: Strs, network: Network })),
	mcp: Type.Union([Type.Object({ mcpServers: Type.Record(Str, Type.Unknown()) }), Type.Null()]),
	mcpServers: Type.Record(Str, Type.Object({ sandbox: NullableStr, network: Network })),
	sandboxes: Type.Record(Str, Sandbox),
	input: Schema,
	output: Schema,
});

export class DeclarationError extends Error {
	override readonly name = "DeclarationError";
	readonly refusal: Refusal;
	constructor(message: string) {
		super(`invalid declarations: ${message}`);
		this.refusal = { type: "invalid_declaration", message };
	}
}

/** The VM's declarations, parsed, and held to the rules the host enforces (see `checkRules`); else a `DeclarationError`. */
export function parseDeclarations(raw: unknown): Declarations {
	if (!Value.Check(DeclarationsSchema, raw)) {
		const errors = [...Value.Errors(DeclarationsSchema, raw)].slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message}`);
		throw new DeclarationError(errors.join("; "));
	}
	const decl: Declarations = raw;
	checkRules(decl);
	return decl;
}

/**
 * The sandbox rules that are about the declarations as a whole, again on
 * the host: every sandbox a node names is declared; agents and commands
 * never get network; an agent with exec has a sandbox that requires bash.
 * Volumes, devices and environment keys are checked where they are
 * resolved (volumes.ts), on the host too.
 */
function checkRules(decl: Declarations): void {
	const sandbox = (name: string | null, who: string) => {
		if (name === null) return null;
		const s = decl.sandboxes[name];
		if (!s) throw new DeclarationError(`${who}: sandbox ${name} is not declared`);
		return s;
	};
	for (const [name, a] of Object.entries(decl.agents)) {
		const s = sandbox(a.sandbox, `agent ${name}`);
		if (s?.network === "host") throw new DeclarationError(`agent ${name}: agents never get network; sandbox ${a.sandbox} has network "host"`);
		if (a.access === 3 && !s?.requires.some((r) => r.name === "bash")) throw new DeclarationError(`agent ${name}: exec needs a sandbox that requires bash`);
	}
	for (const [name, c] of Object.entries(decl.commands)) {
		if (sandbox(c.sandbox, `command ${name}`)?.network === "host") throw new DeclarationError(`command ${name}: commands never get network; sandbox ${c.sandbox} has network "host"`);
	}
	// Limits: parsed here, never trusted from the VM.
	for (const [name, s] of Object.entries(decl.sandboxes)) {
		const mem = s.mem_limit === null ? null : parseMemLimit(s.mem_limit);
		if (mem && !mem.ok) throw new DeclarationError(`sandbox ${name}: ${mem.reason}`);
		const pids = s.pids_limit === null ? null : pidsLimitProblem(s.pids_limit);
		if (pids !== null) throw new DeclarationError(`sandbox ${name}: ${pids}`);
	}
	for (const [path, t] of Object.entries(decl.toolsets)) sandbox(t.sandbox, `toolset ${path}`);
	for (const [server, m] of Object.entries(decl.mcpServers)) sandbox(m.sandbox, `MCP server ${server}`);
}
