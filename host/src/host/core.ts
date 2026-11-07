// The compiled Gleam core. Run `mise run build` first.
//
// The run state stays an opaque handle on this side; events, effects and
// snapshots cross as JSON text only. The types below mirror
// core/src/wallis_core/types.gleam.

import * as gleam from "../../../core/build/dev/javascript/wallis_core/wallis_core.mjs";
import type { FailReason, Json, Refusal } from "../sdk/index.ts";

export type { FailReason, Refusal };
export type Usage = { usd: number; tokens: number; turns: number };
export type Write = { field: string; value: Json };
export type Message = { role: "user" | "assistant"; text: string };
export type BudgetKind = "usd" | "tokens" | "turns" | "compute_minutes";

export type Event =
	| { type: "started"; workflow: Json; pin: Pin; input: Json }
	| { type: "resumed"; pin: Pin }
	| { type: "requested"; id: string; branch: string | null; request: Json }
	| { type: "agent_returned"; id: string; output: Json; emits: Write[]; usage: Usage; model: string }
	| { type: "agent_idle"; id: string; message: string; usage: Usage; model: string }
	| { type: "agent_failed"; id: string; error: string; usage: Usage; model: string }
	| { type: "executor_failed"; id: string; error: string }
	| { type: "script_returned"; id: string; output: Json; minutes: number }
	| { type: "script_failed"; id: string; error: string; minutes: number }
	| { type: "sent"; node: string; text: string; message_id: string }
	| { type: "alias_rebound"; alias: string; from: string; to: string }
	| { type: "budget_raised"; kind: BudgetKind; limit: number }
	| { type: "executor_changed"; name: string }
	| { type: "retry_unavailable" }
	| { type: "cancel_requested" }
	| { type: "body_finished"; output: Json }
	| { type: "body_failed"; reason: FailReason };

export type Pin = { workflow_digest: string; models: Record<string, string>; seed: number; inputs: Record<string, string>; semantics: string };

export type Outcome = { type: "done"; value: Json } | { type: "failed"; reason: FailReason } | { type: "cancelled" };

export type IdleReason =
	| { type: "budget_exhausted"; kind: BudgetKind; spent: number; limit: number }
	| { type: "executor_unavailable"; alias: string; error: string };

export type RunStatus = { type: "running" } | { type: "idle"; reason: IdleReason | null } | { type: "finished"; outcome: Outcome };

export type NodeStatus =
	| { type: "node_running" }
	| { type: "node_idle"; last_message: string }
	| { type: "node_done"; outcome: { type: "submitted" } | { type: "gave_up"; error: string } };

export type Node = { id: string; agent: string; model: string; status: NodeStatus };

export type Snapshot = {
	status: RunStatus;
	nodes: Node[];
	state: Record<string, Json>;
	spent: { usd: number; tokens: number; turns: number; compute_minutes: number };
	budget: { usd: number | null; tokens: number | null; turns: number | null; compute_minutes: number | null };
	models: Record<string, string>;
	executor: string | null;
};

export type Effect =
	| { type: "checkpoint" }
	| {
			type: "call_agent";
			id: string;
			agent: string;
			model: string;
			view: string;
			omitted: Record<string, number>;
			input: Json;
			max_turns: number;
			digest: string;
			transcript: Message[];
	  }
	| { type: "run_script"; id: string; script: string; args: Json; compute_minutes: number | null; digest: string }
	| { type: "deliver"; id: string; value: Json }
	| { type: "fail"; id: string; reason: FailReason }
	| { type: "refuse"; id: string | null; refusal: Refusal }
	| { type: "finish"; outcome: Outcome };

export const SEMANTICS: string = gleam.semantics();

export class Core {
	#state = gleam.init();

	step(event: Event): Effect[] {
		const [state, effects] = gleam.step_json(this.#state, JSON.stringify(event));
		this.#state = state;
		return JSON.parse(effects) as Effect[];
	}

	/** JSON of status, nodes, state, spend, budget and models. */
	snapshotText(): string {
		return gleam.snapshot_json(this.#state);
	}

	snapshot(): Snapshot {
		return JSON.parse(this.snapshotText()) as Snapshot;
	}

	/** Steps every event, ignoring effects: the run state is a fold over its log. */
	static refold(events: readonly Event[]): Core {
		const core = new Core();
		for (const event of events) core.step(event);
		return core;
	}
}
