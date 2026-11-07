// The compiled Gleam core. Run `mise run build` first.
//
// The run state stays an opaque handle on this side; events, effects and
// snapshots cross as JSON text only. The types below mirror
// core/src/wallis_core/types.gleam.

import * as gleam from "../../../core/build/dev/javascript/wallis_core/wallis_core.mjs";
import type { AgentFailure, FailReason, Json, Refusal } from "../sdk/index.ts";

export type { AgentFailure, FailReason, Refusal };
export type Usage = { usd: number; tokens: number; turns: number };
export type Message = { role: "user" | "assistant"; text: string };
export type BudgetKind = "usd" | "tokens" | "turns" | "compute_minutes";

export type Event =
	| { type: "started"; workflow: Json; pin: Pin; input: Json }
	| { type: "resumed"; pin: Pin }
	| { type: "requested"; id: string; request: Json }
	| { type: "agent_returned"; id: string; output: Json; usage: Usage; model: string }
	| { type: "agent_idle"; id: string; message: string; usage: Usage; model: string }
	| { type: "agent_failed"; id: string; failure: AgentFailure; usage: Usage; model: string }
	| { type: "executor_failed"; id: string; error: string }
	| { type: "input_rejected"; id: string; field: string | null; chars: number; limit: number }
	| { type: "script_returned"; id: string; output: Json; minutes: number }
	| { type: "script_failed"; id: string; error: string; minutes: number }
	| { type: "observed"; at: string; label: string; value: Json }
	| { type: "sent"; node: string; text: string; message_id: string; by: string }
	| { type: "steered"; node: string; text: string; message_id: string; by: string }
	| { type: "interrupted"; node: string; by: string }
	| { type: "restarted"; node: string; note: string | null; by: string }
	| { type: "node_cancelled"; node: string; by: string }
	| { type: "alias_rebound"; alias: string; from: string; to: string }
	| { type: "budget_raised"; kind: BudgetKind; limit: number }
	| { type: "executor_changed"; name: string }
	| { type: "retry_unavailable" }
	| { type: "cancel_requested"; by: string }
	| { type: "pause_requested"; by: string }
	| { type: "resume_requested"; by: string }
	| { type: "claimed"; owner: string }
	| { type: "body_finished"; output: Json }
	| { type: "body_failed"; reason: FailReason };

export type Pin = { workflow_digest: string; models: Record<string, string>; seed: number; inputs: Record<string, string>; semantics: string };

export type Outcome = { type: "done"; value: Json } | { type: "failed"; reason: FailReason } | { type: "cancelled" };

export type IdleReason =
	| { type: "budget_exhausted"; kind: BudgetKind; spent: number; limit: number }
	| { type: "executor_unavailable"; alias: string; error: string }
	| { type: "paused_by_user" };

export type RunStatus = { type: "running" } | { type: "idle"; reason: IdleReason | null } | { type: "finished"; outcome: Outcome };

export type InboxMessage = { kind: "answer" | "steer" | "interrupt" | "restart"; text: string; step: number };

/** `steerable` is a literal in each member, so `node.steerable` narrows. */
type NodeBase = { id: string; agent: string; model: string; inbox: InboxMessage[] } & ({ steerable: true } | { steerable: false });

export type RunningNode = NodeBase & { type: "node_running" };
export type IdleNodeState = NodeBase & { type: "node_idle"; question: string };
export type DoneNode = NodeBase & { type: "node_done"; outcome: { type: "submitted" } | { type: "node_failed"; failure: AgentFailure } };
/** What cancel and restart reach. */
export type LiveNodeState = RunningNode | IdleNodeState;
/** One agent call and its dialogue; each variant carries only what is meaningful in that state. */
export type Node = RunningNode | IdleNodeState | DoneNode;

export type Observation = { at: string; label: string; value: Json };

export type Snapshot = {
	status: RunStatus;
	nodes: Node[];
	observations: Observation[];
	spent: { usd: number; tokens: number; turns: number; compute_minutes: number };
	budget: { usd: number | null; tokens: number | null; turns: number | null; compute_minutes: number | null };
	models: Record<string, string>;
	executor: string | null;
	owner: string | null;
};

export type CallAgentEffect = {
	type: "call_agent";
	id: string;
	agent: string;
	model: string;
	input: Json;
	max_turns: number;
	digest: string;
	transcript: Message[];
	note: string | null;
};

export type Effect =
	| { type: "checkpoint" }
	| CallAgentEffect
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

	/** JSON of status, nodes, observations, spend, budget and models. */
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
