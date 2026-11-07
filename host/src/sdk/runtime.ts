// The guest half of the sandbox bridge. The bundler appends
// `install(workflow)` to every bundled workflow. Inside QuickJS the host
// provides `__wallis_send`, `__wallis_done` and `__wallis_fail`; it calls
// `__wallis_declare`, `__wallis_start` and `__wallis_deliver`.
//
// Request ids come from the branch path and a per-branch counter, so they
// are the same on every replay regardless of the order results arrive in.

import type { AgentDef, Ctx, FailReason, Fields, Json, Refusal, ScriptDef, SubWorkflowDef, ViewSpec, WorkflowDef } from "./index.ts";
import { AgentFailed, Refused, SchemaError, ScriptFailed } from "./index.ts";
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

function request(id: string, branch: string | null, req: Json): Promise<Reply> {
	return new Promise((resolve) => {
		pending.set(id, resolve);
		host().__wallis_send(JSON.stringify({ type: "requested", id, branch, request: req }));
	});
}

function unwrap(reply: Reply): Json {
	switch (reply.type) {
		case "deliver":
			return reply.value;
		case "fail":
			switch (reply.reason.type) {
				case "agent_gave_up":
					throw new AgentFailed(reply.reason.agent, reply.reason.error);
				case "script_crashed":
					throw new ScriptFailed(reply.reason.script, reply.reason.error);
				case "body_error":
					throw new Error(reply.reason.message);
			}
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

export function wireView(spec: ViewSpec): Json {
	return {
		fields: [...spec.fields],
		max_chars: spec.maxChars,
		max_items: spec.maxItems,
		chunk: spec.chunk ?? Math.max(1, Math.floor(spec.maxItems / 4)),
		omit: [...(spec.omit ?? [])],
	};
}

function makeCtx<F extends Fields>(path: string, branch: string | null, seed: number, fields: Fields): Ctx<F> {
	let counter = 0;
	const next = () => `${path}#${counter++}`;
	const ctx: Ctx<F> = {
		seed,
		async call(agent: AgentDef, input) {
			check(agent.input, input, `input of agent ${agent.name}`);
			const output = unwrap(await request(next(), branch, { type: "call", agent: agent.name, input: input as Json }));
			const errors = schemaErrors(agent.output, output);
			if (errors.length > 0) throw new AgentFailed(agent.name, `output does not match its schema: ${errors.join("; ")}`);
			return output as never;
		},
		async script(script: ScriptDef, args) {
			check(script.input, args, `args of script ${script.name}`);
			const output = unwrap(await request(next(), branch, { type: "script", script: script.name, args: args as Json }));
			const errors = schemaErrors(script.output, output);
			if (errors.length > 0) throw new ScriptFailed(script.name, `output does not match its schema: ${errors.join("; ")}`);
			return output as never;
		},
		async read(spec) {
			return unwrap(await request(next(), branch, { type: "read", view: wireView(spec) })) as never;
		},
		async emit(field, value) {
			const reducer = fields[field];
			if (!reducer) throw new SchemaError(`state field ${field}`, ["no such field"]);
			check(reducer.schema, value, `write to state field ${field}`);
			unwrap(await request(next(), branch, { type: "commit", writes: [{ field, value: value as Json }] }));
		},
		async parallel(branches) {
			const at = next();
			const keys = Object.keys(branches);
			const results = await Promise.all(keys.map((key) => branches[key]!(makeCtx<F>(`${at}.${key}`, `${at}.${key}`, seed, fields))));
			return Object.fromEntries(keys.map((key, i) => [key, results[i]])) as never;
		},
		async sub(sub: SubWorkflowDef, input) {
			check(sub.input, input, `input of sub-workflow ${sub.name}`);
			const output = await sub.run(makeCtx<{}>(`${next()}>${sub.name}`, branch, seed, {}), input as never);
			check(sub.output, output, `output of sub-workflow ${sub.name}`);
			return output as never;
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

function agentDeclaration(agent: AgentDef) {
	return {
		model: agent.model,
		prompt: agent.prompt,
		input: agent.input,
		output: agent.output,
		writes: agent.writes,
		mcp: agent.mcp,
		tools: agent.tools.map((t) => ({ name: t.name, description: t.description, input: t.input, output: t.output, script: t.script })),
		skills: agent.skills,
		needs: agent.needs ?? {},
		sandbox: agent.sandbox,
		max_turns: agent.maxTurns,
	};
}

/** Declarations: the core's workflow plus what the host and executors need. */
export function declarations(def: WorkflowDef) {
	const spec = def.spec;
	const names = new Set<string>();
	for (const agent of spec.agents) {
		if (names.has(agent.name)) throw new Error(`duplicate agent name ${agent.name}`);
		names.add(agent.name);
	}
	const scripts = spec.scripts ?? [];
	return {
		core: {
			name: spec.name,
			fields: Object.entries(spec.state.fields).map(([name, r]) => ({ name, reducer: r.spec, initial: r.initial })),
			agents: spec.agents.map((a) => ({
				name: a.name,
				model: a.model,
				view: wireView(a.view),
				writes: Object.entries(a.writes).map(([field, src]) => ({ field, from: typeof src === "string" ? src : null })),
				max_turns: a.maxTurns,
			})),
			scripts: scripts.map((s) => s.name),
			budget: {
				usd: spec.budget?.usd ?? null,
				tokens: spec.budget?.tokens ?? null,
				turns: spec.budget?.turns ?? null,
				compute_minutes: spec.budget?.computeMinutes ?? null,
			},
		},
		models: spec.models.table,
		pin: { files: [...(spec.pin?.files ?? [])] },
		agents: Object.fromEntries(spec.agents.map((a) => [a.name, agentDeclaration(a)])),
		scripts: Object.fromEntries(scripts.map((s) => [s.name, { description: s.description, input: s.input, output: s.output }])),
		/** Per state field: the schema every write must match. */
		fields: Object.fromEntries(Object.entries(spec.state.fields).map(([name, r]) => [name, r.schema])),
		mcp: spec.mcp?.config ?? null,
		input: spec.input,
		output: spec.output,
	};
}

export type Declarations = ReturnType<typeof declarations>;

function failReason(error: unknown): FailReason {
	if (error instanceof AgentFailed) return { type: "agent_gave_up", agent: error.agent, error: error.error };
	if (error instanceof ScriptFailed) return { type: "script_crashed", script: error.script, error: error.error };
	return { type: "body_error", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
}

export function install(def: WorkflowDef): void {
	const g = globalThis as Record<string, unknown>;
	g.__wallis_declare = () => JSON.stringify(declarations(def));
	g.__wallis_deliver = (id: string, json: string) => {
		const resolve = pending.get(id);
		if (!resolve) throw new Error(`no pending request ${id}`);
		pending.delete(id);
		resolve(JSON.parse(json) as Reply);
	};
	g.__wallis_start = (inputJson: string, seed: number) => {
		Math.random = seededRandom(seed);
		const input = JSON.parse(inputJson) as Json;
		const run = async () => {
			check(def.spec.input, input, "workflow input");
			const output = await def.spec.run(makeCtx("", null, seed, def.spec.state.fields), input as never);
			check(def.spec.output, output, "workflow output");
			return output;
		};
		run().then(
			(output) => host().__wallis_done(JSON.stringify(output ?? null)),
			(error: unknown) => host().__wallis_fail(JSON.stringify(failReason(error))),
		);
	};
}
