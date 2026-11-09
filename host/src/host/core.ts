// The compiled Gleam core. Run `mise run build` first.
//
// The run state stays an opaque handle on this side; events, effects and
// snapshots cross as JSON text only. The types below mirror
// core/src/wallis_core/types.gleam.

import * as gleam from "../../../core/build/dev/javascript/wallis_core/wallis_core.mjs";
import type { AgentFailure, CommandFailure, FailReason, Json, Refusal, ToolFailure } from "../sdk/index.ts";

export type { AgentFailure, CommandFailure, FailReason, Refusal, ToolFailure };
export type Usage = { usd: number; tokens: number; turns: number };
export type Message = { role: "user" | "assistant"; text: string };
export type BudgetKind = "turns" | "compute_minutes";

export type Event =
	| { type: "started"; workflow: Json; pin: Pin; input: Json }
	| { type: "resumed"; pin: Pin }
	| { type: "requested"; id: string; request: Json; node_digest: string; occurrence: number }
	| { type: "code_changed"; from: string; to: string }
	| { type: "agent_returned"; id: string; output: Json; usage: Usage; model: string }
	| { type: "agent_idle"; id: string; message: string; usage: Usage; model: string }
	| { type: "agent_failed"; id: string; failure: AgentFailure; usage: Usage; model: string }
	| { type: "turn_limit_reached"; id: string; used: number; limit: number; usage: Usage; model: string }
	| { type: "executor_failed"; id: string; error: string }
	| { type: "agent_asked"; id: string; message: string; usage: Usage; model: string }
	| { type: "approval_requested"; id: string; server: string; tool: string; args: Json; usage: Usage; model: string }
	| { type: "turn_interrupted"; id: string; usage: Usage; model: string }
	| { type: "tool_recorded"; id: string; call: string; result: Json }
	| { type: "input_rejected"; id: string; field: string | null; chars: number; limit: number }
	| { type: "command_returned"; id: string; output: Json; minutes: number }
	| { type: "command_failed"; id: string; failure: CommandFailure; minutes: number }
	| { type: "tool_returned"; id: string; output: Json }
	| { type: "tool_failed"; id: string; failure: ToolFailure }
	| { type: "result_submitted"; node: string; value: Json; by: string }
	| { type: "observed"; at: string; label: string; value: Json }
	| { type: "sent"; node: string; text: string; message_id: string; by: string; turns: number }
	| { type: "steered"; node: string; text: string; message_id: string; by: string }
	| { type: "interrupt_requested"; node: string; by: string }
	| { type: "restarted"; node: string; note: string | null; by: string; turns: number }
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

export type Pin = { workflow_digest: string; prior_digests: string[]; models: Record<string, string>; seed: number; inputs: Record<string, string>; semantics: string };

export type Outcome = { type: "done"; value: Json } | { type: "failed"; reason: FailReason } | { type: "cancelled" };

export type IdleReason =
	| { type: "budget_reached"; kind: BudgetKind; spent: number; limit: number }
	| { type: "executor_unavailable"; alias: string; error: string }
	| { type: "paused_by_user" }
	| { type: "node_failure"; node: string; reason: FailReason };

export type RunStatus = { type: "running" } | { type: "idle"; reason: IdleReason | null } | { type: "finished"; outcome: Outcome };

export type InboxMessage = { kind: "answer" | "steer" | "interrupt" | "restart"; text: string; step: number };

/** `steerable` is a literal in each member, so `node.steerable` narrows. */
type NodeBase = { id: string; agent: string; model: string; inbox: InboxMessage[] } & ({ steerable: true } | { steerable: false });

export type RunningNode = NodeBase & { type: "node_running" };
/** Why an agent node waits for its owner. */
export type IdleCause =
	/** It ended its turn without a result: an implicit ask. */
	| { type: "question"; message: string }
	/** It called its `ask` tool; the reply becomes the tool's result. */
	| { type: "asked"; message: string }
	| { type: "turn_limit"; used: number; limit: number }
	| { type: "interrupted" }
	/** It called an MCP tool in `ask` mode: the orchestrator approves or rejects it. */
	| { type: "approval"; server: string; tool: string; args: Json };
export type IdleNodeState = NodeBase & { type: "node_idle"; cause: IdleCause };
export type DoneNode = NodeBase & { type: "node_done"; outcome: { type: "submitted" } | { type: "node_failed"; failure: AgentFailure } };
export type AgentNode = RunningNode | IdleNodeState | DoneNode;
/** A command call: no dialogue, so no idle state. */
export type CommandRunning = { type: "command_running"; id: string; command: string; inbox: InboxMessage[] };
export type CommandDone = {
	type: "command_done";
	id: string;
	command: string;
	inbox: InboxMessage[];
	outcome: { type: "succeeded" } | { type: "failed_with"; failure: CommandFailure };
};
export type CommandNode = CommandRunning | CommandDone;
/** A body MCP tool call. */
export type ToolNode = { type: "tool_running"; id: string; tool: string } | { type: "tool_done"; id: string; tool: string; outcome: { type: "tool_succeeded" } | { type: "tool_failed_with"; failure: ToolFailure } };
/** An orchestrator node: completed by the orchestrator's `submit_result`. */
export type OrchestratorNode = { type: "orchestrator_pending"; id: string; name: string; input: Json } | { type: "orchestrator_done"; id: string; name: string };
/** What cancel and restart reach. */
export type LiveNodeState = RunningNode | IdleNodeState | CommandRunning | Extract<ToolNode, { type: "tool_running" }>;
/** One call of an agent or a command; each variant carries only what is meaningful in that state. */
export type Node = AgentNode | CommandNode | ToolNode | OrchestratorNode;

export type Observation = { at: string; label: string; value: Json };

export type Snapshot = {
	status: RunStatus;
	nodes: Node[];
	observations: Observation[];
	spent: { usd: number; tokens: number; turns: number; compute_minutes: number };
	budget: { turns: number | null; compute_minutes: number | null };
	models: Record<string, string>;
	executor: string | null;
	/** A failed node the body did not handle: the run waits on it (restart or cancel). */
	held: string | null;
	/** The workflow code digests, newest first. */
	code: string[];
	owner: string | null;
};

export type CallAgentEffect = {
	type: "call_agent";
	id: string;
	agent: string;
	model: string;
	input: Json;
	turn: number;
	turn_limit: number;
	digest: string;
	transcript: Message[];
	note: string | null;
	/** The slot of the session's previous call: where this call's dialogue continues. */
	previous: string | null;
	/** MCP tool results already journaled for this call. */
	recorded: { call: string; result: Json }[];
};

export type Effect =
	| { type: "checkpoint" }
	| CallAgentEffect
	| { type: "run_command"; id: string; command: string; input: Json; compute_minutes: number | null; digest: string }
	| { type: "call_tool"; id: string; tool: string; input: Json; digest: string }
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
