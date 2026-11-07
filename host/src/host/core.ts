// The compiled Gleam core. Run `mise run build` first.
//
// The run state stays an opaque handle on this side; events and effects
// cross as JSON text only.

import * as gleam from "../../../core/build/dev/javascript/wallis_core/wallis_core.mjs";
import type { Json } from "../sdk/index.ts";

export type Usage = { usd: number; tokens: number; turns: number };
export type Write = { field: string; value: Json };

export type Event =
	| { type: "started"; workflow: Json; pin: Pin; input: Json }
	| { type: "resumed"; pin: Pin }
	| { type: "requested"; id: string; branch: string | null; request: Json }
	| { type: "agent_returned"; id: string; output: Json; emits: Write[]; usage: Usage }
	| { type: "agent_failed"; id: string; error: string; usage: Usage }
	| { type: "script_returned"; id: string; output: Json; minutes: number }
	| { type: "script_failed"; id: string; error: string; minutes: number }
	| { type: "body_finished"; output: Json }
	| { type: "body_failed"; error: string };

export type Pin = { workflow_digest: string; models: Record<string, string>; seed: number; inputs: Record<string, string> };

export type Outcome = { type: "done"; value: Json } | { type: "failed"; error: string };

export type Effect =
	| { type: "checkpoint" }
	| { type: "call_agent"; id: string; agent: string; model: string; view: string; omitted: Record<string, number>; input: Json; max_turns: number; digest: string }
	| { type: "run_script"; id: string; script: string; args: Json; compute_minutes: number | null; digest: string }
	| { type: "deliver"; id: string; value: Json }
	| { type: "fail"; id: string; error: string }
	| { type: "refuse"; id: string | null; reason: string }
	| { type: "finish"; outcome: Outcome };

export class Core {
	#state = gleam.init();

	step(event: Event): Effect[] {
		const [state, effects] = gleam.step_json(this.#state, JSON.stringify(event));
		this.#state = state;
		return JSON.parse(effects) as Effect[];
	}

	/** Canonical JSON of status, state, spend and in-flight requests. */
	snapshot(): string {
		return gleam.snapshot_json(this.#state);
	}
}
