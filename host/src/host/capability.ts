// Capabilities: proofs that a check passed. Each is a class with a private
// constructor (and a `#proof` field in their base), so the only way to get one is its
// `check`; the node checks take an `OwnedRun`, so ownership cannot be
// skipped. They mirror core/src/wallis_core/capability.gleam: the host
// checks before it sends an event, and the core checks again when it
// applies it (time passes in between).
//
// Callers narrow a check's result with `instanceof`. Raw ids from the CLI or MCP are branded once parsed (`RunId`, `NodeId`);
// nothing else is branded.

import type { Refusal } from "../sdk/index.ts";
import type { CommandDone, Core, DoneNode, IdleCause, IdleNodeState, LiveNodeState, OrchestratorNode, Pin, RunningNode, Snapshot, ToolNode } from "./core.ts";

type ToolDone = Extract<ToolNode, { type: "tool_done" }>;

/** A run id parsed from outside input. */
export type RunId = string & { readonly __brand: "RunId" };
/** A node id (a request id) parsed from outside input. */
export type NodeId = string & { readonly __brand: "NodeId" };

export class BadId extends Error {
	override readonly name = "BadId";
}

/** `<workflow>-<stamp>-<hex>` or any plain directory name: no slashes, no dots alone. */
export function parseRunId(raw: unknown): RunId {
	if (typeof raw !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw)) throw new BadId(`not a run id: ${JSON.stringify(raw)}`);
	return raw as RunId;
}

/** Request ids: `#0`, `#2.a#0`, `#3>retry#1`; a session's calls are `#1:0`, `#1:1`. */
export function parseNodeId(raw: unknown): NodeId {
	if (typeof raw !== "string" || !/^(#\d+|:\d+|\.[A-Za-z0-9_-]+|>[A-Za-z0-9_-]+)+$/.test(raw) || !raw.startsWith("#")) {
		throw new BadId(`not a node id: ${JSON.stringify(raw)}`);
	}
	return raw as NodeId;
}

/** The identity that controls every run. */
export const HUMAN = "human";

/** Every capability is one; only the subclasses' checks construct them. */
export abstract class Capability {
	readonly #proof = true;
}

/** The capability, or the check's typed refusal thrown as `refuse` makes it. */
export function must<T extends Capability>(result: T | Refusal, refuse: (refusal: Refusal) => Error): T {
	if (result instanceof Capability) return result;
	throw refuse(result);
}

export class OwnedRun extends Capability {
	readonly by: string;
	readonly snapshot: Snapshot;
	private constructor(by: string, snapshot: Snapshot) {
		super();
		this.by = by;
		this.snapshot = snapshot;
	}

	/** The human controls every run; anyone else only the runs it owns. */
	static check(snapshot: Snapshot, by: string): OwnedRun | Refusal {
		if (by === HUMAN || (snapshot.owner !== null && snapshot.owner === by)) return new OwnedRun(by, snapshot);
		return { type: "not_owner", by, owner: snapshot.owner };
	}

}

/** An idle node of a steerable agent (never a command): the only node an answer may go to. */
export class IdleNode extends Capability {
	readonly owned: OwnedRun;
	readonly node: IdleNodeState & { steerable: true };
	private constructor(owned: OwnedRun, node: IdleNodeState & { steerable: true }) {
		super();
		this.owned = owned;
		this.node = node;
	}

	static check(owned: OwnedRun, id: string): IdleNode | Refusal {
		const node = owned.snapshot.nodes.find((n) => n.id === id);
		// An approval takes a decision (`submit_result`), not a message.
		if (node?.type === "node_idle" && node.cause.type === "approval") return { type: "not_idle", node: id };
		if (node?.type === "node_idle" && node.steerable) return new IdleNode(owned, node);
		if (node?.type === "node_idle") return { type: "not_steerable", node: id };
		if (node !== undefined && !("agent" in node)) return { type: "not_an_agent", node: id };
		return { type: "not_idle", node: id };
	}

}

/** A running node of a steerable agent (never a command): the only node steer and interrupt reach. */
export class SteerableNode extends Capability {
	readonly owned: OwnedRun;
	readonly node: RunningNode & { steerable: true };
	private constructor(owned: OwnedRun, node: RunningNode & { steerable: true }) {
		super();
		this.owned = owned;
		this.node = node;
	}

	static check(owned: OwnedRun, id: string): SteerableNode | Refusal {
		const node = owned.snapshot.nodes.find((n) => n.id === id);
		if (node?.type === "node_running" && node.steerable) return new SteerableNode(owned, node);
		if (node?.type === "node_running") return { type: "not_steerable", node: id };
		if (node !== undefined && !("agent" in node)) return { type: "not_an_agent", node: id };
		return { type: "node_not_running", node: id };
	}

}

/** A node that is not done, or a failed one the run is held on: what cancel and restart reach. */
export class LiveNode extends Capability {
	readonly owned: OwnedRun;
	readonly node: LiveNodeState | DoneNode | CommandDone | ToolDone;
	private constructor(owned: OwnedRun, node: LiveNodeState | DoneNode | CommandDone | ToolDone) {
		super();
		this.owned = owned;
		this.node = node;
	}

	static check(owned: OwnedRun, id: string): LiveNode | Refusal {
		const node = owned.snapshot.nodes.find((n) => n.id === id);
		if (node === undefined) return { type: "not_live", node: id };
		if (owned.snapshot.held === id && (node.type === "node_done" || node.type === "command_done" || node.type === "tool_done")) return new LiveNode(owned, node);
		if (node.type === "node_running" || node.type === "node_idle" || node.type === "command_running" || node.type === "tool_running") return new LiveNode(owned, node);
		return { type: "not_live", node: id };
	}

}

/**
 * What `submit_result` reaches: an orchestrator node waiting for its result,
 * or an agent node waiting for a decision on an `ask`-mode tool. `kind` says
 * which schema the value is checked against.
 */
export class SubmittableNode extends Capability {
	readonly owned: OwnedRun;
	readonly target:
		| { readonly kind: "answer"; readonly node: Extract<OrchestratorNode, { type: "orchestrator_pending" }> }
		| { readonly kind: "decision"; readonly node: IdleNodeState; readonly approval: Extract<IdleCause, { type: "approval" }> };
	private constructor(owned: OwnedRun, target: SubmittableNode["target"]) {
		super();
		this.owned = owned;
		this.target = target;
	}

	static check(owned: OwnedRun, id: string): SubmittableNode | Refusal {
		const node = owned.snapshot.nodes.find((n) => n.id === id);
		if (node?.type === "orchestrator_pending") return new SubmittableNode(owned, { kind: "answer", node });
		if (node?.type === "node_idle" && node.cause.type === "approval") return new SubmittableNode(owned, { kind: "decision", node, approval: node.cause });
		return { type: "not_pending", node: id };
	}
}

/** A refolded run whose pin matched: the only run a session replays. */
export class ResumableRun extends Capability {
	readonly pin: Pin;
	private constructor(pin: Pin) {
		super();
		this.pin = pin;
	}

	/** Steps `resumed` into the refolded core; the core compares the result-defining fields. */
	static check(core: Core, pin: Pin): ResumableRun | Refusal {
		const refused = core.step({ type: "resumed", pin }).find((e) => e.type === "refuse");
		return refused?.type === "refuse" ? refused.refusal : new ResumableRun(pin);
	}
}
