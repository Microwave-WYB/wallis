// The guest half of the sandbox bridge. The bundler appends
// `install(workflow)` to every bundled workflow. Inside QuickJS the host
// provides `__wallis_send`, `__wallis_done` and `__wallis_fail`; it calls
// `__wallis_declare`, `__wallis_start` and `__wallis_deliver`.
//
// Request ids come from the branch path and a per-branch counter, so they
// are the same on every replay regardless of the order results arrive in.

import Value from "typebox/value";
import type { AgentDef, Ctx, Fields, Json, SubWorkflowDef, ViewSpec, WorkflowDef } from "./index.ts";
import { AgentFailed, Refused } from "./index.ts";

type Reply = { type: "deliver"; value: Json } | { type: "fail"; error: string } | { type: "refuse"; reason: string };

interface Host {
	__wallis_send(json: string): void;
	__wallis_done(json: string): void;
	__wallis_fail(message: string): void;
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
			throw new AgentFailed(reply.error);
		case "refuse":
			throw new Refused(reply.reason);
	}
}

function check(schema: unknown, value: unknown, what: string): void {
	if (!Value.Check(schema as never, value)) {
		const first = Value.Errors(schema as never, value)[0];
		throw new TypeError(`${what} does not match its schema${first ? `: ${first.instancePath} ${first.message}` : ""}`);
	}
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

function makeCtx<F extends Fields>(path: string, branch: string | null, seed: number): Ctx<F> {
	let counter = 0;
	const next = () => `${path}#${counter++}`;
	const ctx: Ctx<F> = {
		seed,
		async call(agent, input) {
			check(agent.input, input, `input of ${agent.name}`);
			const output = unwrap(await request(next(), branch, { type: "call", agent: agent.name, input: input as Json }));
			check(agent.output, output, `output of ${agent.name}`);
			return output as never;
		},
		async script(name, args) {
			return unwrap(await request(next(), branch, { type: "script", script: name, args: args ?? null }));
		},
		async read(spec) {
			return unwrap(await request(next(), branch, { type: "read", view: wireView(spec) })) as never;
		},
		async emit(field, value) {
			unwrap(await request(next(), branch, { type: "commit", writes: [{ field, value: value as Json }] }));
		},
		async parallel(branches) {
			const at = next();
			const keys = Object.keys(branches);
			const results = await Promise.all(keys.map((key) => branches[key]!(makeCtx<F>(`${at}.${key}`, `${at}.${key}`, seed))));
			return Object.fromEntries(keys.map((key, i) => [key, results[i]])) as never;
		},
		async sub(sub: SubWorkflowDef, input) {
			check(sub.input, input, `input of sub-workflow ${sub.name}`);
			const output = await sub.run(makeCtx<{}>(`${next()}>${sub.name}`, branch, seed), input as never);
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
			scripts: [...(spec.scripts ?? [])],
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
		mcp: spec.mcp?.config ?? null,
		input: spec.input,
		output: spec.output,
	};
}

export type Declarations = ReturnType<typeof declarations>;

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
			const output = await def.spec.run(makeCtx("", null, seed), input as never);
			check(def.spec.output, output, "workflow output");
			return output;
		};
		run().then(
			(output) => host().__wallis_done(JSON.stringify(output ?? null)),
			(error: unknown) => host().__wallis_fail(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
		);
	};
}
