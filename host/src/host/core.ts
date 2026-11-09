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
	/** `occurrence`: `<branch path>/<n>`, the nth call of the same node, session and input in that branch. */
	| { type: "requested"; id: string; request: Json; node_digest: string; occurrence: string }
	| { type: "code_changed"; from: string; to: string }
	/** `dialogue`: the session's dialogue after the call, a blob written before this event. */
	| { type: "agent_returned"; id: string; output: Json; usage: Usage; model: string; dialogue: string | null; layers: string[] | null }
	| { type: "agent_idle"; id: string; message: string; usage: Usage; model: string }
	| { type: "agent_failed"; id: string; failure: AgentFailure; usage: Usage; model: string }
	| { type: "turn_limit_reached"; id: string; used: number; limit: number; usage: Usage; model: string }
	| { type: "executor_failed"; id: string; error: string }
	| { type: "agent_asked"; id: string; message: string; usage: Usage; model: string }
	| { type: "call_outcome_unknown"; id: string; tool: string; args: Json; usage: Usage; model: string }
	| { type: "previous_dialogue_missing"; id: string }
	/** A running agent call's dialogue so far: a blob written before this event. */
	| { type: "agent_progressed"; id: string; dialogue: string }
	/** A resumed agent call's tool calls in flight at a crash: the core decides each. */
	| { type: "tool_calls_in_flight"; id: string; calls: InFlightCall[] }
	| { type: "turn_interrupted"; id: string; usage: Usage; model: string }
	| { type: "tool_recorded"; id: string; call: string; result: Json }
	| { type: "input_rejected"; id: string; field: string | null; chars: number; limit: number }
	| { type: "command_returned"; id: string; output: Json; minutes: number }
	| { type: "command_failed"; id: string; failure: CommandFailure; minutes: number }
	| { type: "tool_returned"; id: string; output: Json }
	| { type: "tool_failed"; id: string; failure: ToolFailure }
	| { type: "tool_call_unknown"; id: string }
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
	/** A host fact (`meta.json` is derived from these); the latest value of a key wins. */
	| { type: "noted"; key: string; value: Json }
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
	/** It called its `ask` tool; the reply becomes the tool's result. */
	| { type: "question"; message: string }
	/** It ended its turn with neither a result nor a question. */
	| { type: "ended_without_result"; text: string }
	| { type: "turn_limit"; used: number; limit: number }
	| { type: "interrupted" }
	/** After a crash, a tool call in flight that is not safe to make again: restart or cancel. */
	| { type: "outcome_unknown"; tool: string; args: Json };
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
export type ToolNode =
	| { type: "tool_running"; id: string; tool: string }
	| { type: "tool_held"; id: string; tool: string; reason: IdleReason }
	/** In flight at a crash and not safe to reissue: restart (call it again) or cancel. */
	| { type: "tool_outcome_unknown"; id: string; tool: string; input: Json }
	| { type: "tool_done"; id: string; tool: string; outcome: { type: "tool_succeeded" } | { type: "tool_failed_with"; failure: ToolFailure } };
/** An orchestrator node: completed by the orchestrator's `submit_result`. */
export type OrchestratorNode =
	| { type: "orchestrator_pending"; id: string; name: string; input: Json }
	| { type: "orchestrator_done"; id: string; name: string }
	/** Cancelled by its owner instead of answered. */
	| { type: "orchestrator_dropped"; id: string; name: string };
/** An agent call held back before it started: by a pause, the budget, or an executor fault. */
export type HeldNode = NodeBase & { type: "node_held"; reason: IdleReason };
export type CommandHeld = { type: "command_held"; id: string; command: string; inbox: InboxMessage[]; reason: IdleReason };
/** A call refused before it ran: its input, a missing dialogue, an unknown node. */
export type RefusedNode = { type: "node_refused"; id: string; refusal: Refusal };
/** What cancel and restart reach. */
export type LiveNodeState = RunningNode | IdleNodeState | HeldNode | CommandRunning | CommandHeld | Exclude<ToolNode, { type: "tool_done" }> | Extract<OrchestratorNode, { type: "orchestrator_pending" }>;
/** One call of an agent or a command; each variant carries only what is meaningful in that state. */
export type Node = AgentNode | HeldNode | CommandNode | CommandHeld | ToolNode | OrchestratorNode | RefusedNode;

/** A tool call in flight at a crash: its journal key, the tool (an id for custom and MCP tools), its arguments, and its kind. */
export type InFlightCall = {
	call: string;
	tool: string;
	args: Json;
	kind: { type: "external_call"; replay: "replay_safe" | "replay_never" } | { type: "reads_only" } | { type: "sandbox_only" };
};

export type InFlightDecision = { type: "run_again"; call: string } | { type: "error_to_model"; call: string } | { type: "outcome_is_unknown"; call: string };

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
	/** Every session value an agent call answered with: the call, and the session it continued. */
	sessions: { id: string; agent: string; call: string; from: string | null }[];
};

export type CallAgentEffect = {
	type: "call_agent";
	id: string;
	agent: string;
	model: string;
	input: Json;
	turn: number;
	turn_limit: number;
	/** The call's journal slot. */
	slot: string;
	transcript: Message[];
	note: string | null;
	/** The session value the call continues (null: a new session). */
	session: string | null;
	/** The session's workspace: its layers (digests), bottom first. */
	layers: string[];
	/** The session's dialogue before this call (a blob digest): where a new attempt starts. */
	history: string | null;
	/** This attempt's newest dialogue (a blob digest): where a reissued attempt resumes. */
	checkpoint: string | null;
	/** MCP tool results already journaled for this call. */
	recorded: { call: string; result: Json }[];
	/** The attempt this call is for (1 for the first): what results and interrupts are matched against. */
	attempt: number;
};

export type Effect =
	| { type: "checkpoint" }
	| CallAgentEffect
	| { type: "run_command"; id: string; command: string; input: Json; compute_minutes: number | null; slot: string }
	| { type: "call_tool"; id: string; tool: string; input: Json; slot: string }
	/** A body tool call in flight at a crash, not safe to repeat: step `tool_call_unknown`, so the log has it. */
	| { type: "log_unknown_tool"; id: string }
	/** Abort the current turn of this attempt of an agent call, now or when it starts. */
	| { type: "interrupt_turn"; id: string; attempt: number }
	| { type: "in_flight_decided"; id: string; decisions: InFlightDecision[] }
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

	/** The host facts the log noted (`noted` events), by key. */
	facts(): Record<string, Json> {
		return JSON.parse(gleam.facts_json(this.#state)) as Record<string, Json>;
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
