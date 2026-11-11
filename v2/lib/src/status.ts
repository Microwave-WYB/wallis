// What a caller reads about a run, derived from its log alone (the run
// directory is the single source of truth, so any process can read it):
// its state, its calls with their labels and enclosing calls, its failed
// calls and how each recovers, outbox messages, transcripts.

import { existsSync, statSync } from "node:fs";
import { type CallView, Core, type Event, type FailReason, type Json, type Snapshot } from "./host/core.ts";
import { readDialogue } from "./host/dialogues.ts";
import { EventLog } from "./host/log.ts";
import { lockHolder, type RunPaths } from "./host/runs.ts";
import type { Store } from "./host/store.ts";
import { type CallId, type CallRef, type FailedCall, publicReason } from "./errors.ts";

export type Duration = `${number}${"s" | "m" | "h"}`;

export interface Status {
	readonly state: "running" | "stopped" | "finished" | "failed";
	readonly elapsed: Duration;
	readonly completed: number;
	readonly running: readonly CallRef[];
	/** Calls whose newest attempt failed (the body may have caught some and gone on). */
	readonly failed: readonly FailedCall[];
}

export function duration(ms: number): Duration {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 120) return `${s}s`;
	if (s < 7200) return `${Math.round(s / 60)}m`;
	return `${Math.round(s / 360) / 10}h`;
}

export function parseDuration(d: string): number {
	const m = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(d);
	if (!m) throw new Error(`not a duration: ${d} (e.g. "30s", "110m", "2h")`);
	return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
}

/** A run as its log says, read once. */
export class RunView {
	readonly paths: RunPaths;
	readonly events: readonly Event[];
	readonly core: Core;
	readonly snapshot: Snapshot;
	readonly #bySlot: Map<string, CallView>;

	constructor(paths: RunPaths) {
		this.paths = paths;
		this.events = existsSync(paths.log) ? new EventLog(paths.log).read() : [];
		this.core = Core.refold(this.events);
		this.snapshot = this.core.snapshot();
		this.#bySlot = new Map("calls" in this.snapshot ? this.snapshot.calls.map((c) => [c.slot, c]) : []);
	}

	get facts(): Record<string, Json> {
		return this.core.facts();
	}

	get started(): boolean {
		return "calls" in this.snapshot;
	}

	get ended(): { type: "done"; value: Json } | { type: "failed"; reason: FailReason } | null {
		if (!("status" in this.snapshot) || typeof this.snapshot.status === "string") return null;
		return this.snapshot.status.type === "ended" ? this.snapshot.status.outcome : null;
	}

	get live(): boolean {
		return lockHolder(this.paths) !== null;
	}

	get state(): Status["state"] {
		const ended = this.ended;
		if (ended) return ended.type === "done" ? "finished" : "failed";
		return this.live ? "running" : "stopped";
	}

	get workflowLabel(): string {
		const wf = this.facts.workflow as { label?: string } | undefined;
		return wf?.label ?? "workflow";
	}

	/** The labels of the calls around a scope, outermost first. */
	pathOf(scope: string): string[] {
		const path: string[] = [];
		let s = scope;
		while (s !== "") {
			const slot = s.split("|")[0]!;
			const call = this.#bySlot.get(slot);
			if (!call) break;
			path.unshift(call.name);
			s = call.scope;
		}
		return path;
	}

	ref(c: CallView): CallRef {
		return { id: c.slot as CallId, label: c.name, path: this.pathOf(c.scope), attempt: c.attempts.length };
	}

	get calls(): CallView[] {
		return "calls" in this.snapshot ? this.snapshot.calls : [];
	}

	/** The newest dialogue blob an agent call's attempts left (checkpoint, result or failure). */
	dialogues(slot: string): string[] {
		const out: string[] = [];
		for (const e of this.events) {
			if (e.type !== "agent_progressed" && e.type !== "agent_returned" && e.type !== "agent_failed") continue;
			if (this.core.slotOf(e.id) !== slot) continue;
			const d = e.type === "agent_progressed" ? e.checkpoint : e.dialogue;
			if (d) out.push(d);
		}
		return out;
	}

	tail(store: Store, c: CallView, reason: FailReason): string {
		const leaf = (r: FailReason): FailReason => (r.type === "workflow_error" ? leaf(r.reason) : r);
		const r = leaf(reason);
		if (r.type === "command_error") {
			const f = r.failure;
			return "stderr_head" in f ? f.stderr_head : "errors" in f ? f.errors.join("\n") : "error" in f ? f.error : "message" in f ? f.message : "name" in f ? `missing ${f.name}` : "";
		}
		if (c.kind === "agent") {
			const last = this.dialogues(c.slot).at(-1);
			const state = last ? (readDialogue(store, last) as { messages?: unknown[] } | undefined) : undefined;
			return transcriptText(state?.messages ?? []).split("\n").slice(-12).join("\n");
		}
		if (r.type === "tool_error") return r.message;
		if (r.type === "body_error") return r.message;
		return "";
	}

	failed(store: Store): FailedCall[] {
		const out: FailedCall[] = [];
		for (const c of this.calls) {
			const last = c.attempts.at(-1);
			if (last?.type !== "failed") continue;
			// A nested workflow that failed because a call in it failed: that call is listed instead.
			if (c.kind === "workflow" && last.reason.type === "workflow_error" && last.reason.reason.type !== "body_error" && last.reason.reason.type !== "schema_mismatch") continue;
			out.push({ ...this.ref(c), reason: publicReason(last.reason, (id) => ({ kind: "session", agent: c.node, id, layers: [] })), recovery: last.decided ? "retry" : "resume", tail: this.tail(store, c, last.reason) });
		}
		const ended = this.ended;
		if (ended?.type === "failed" && (ended.reason.type === "body_error" || ended.reason.type === "schema_mismatch")) {
			out.push({ id: "workflow" as CallId, label: this.workflowLabel, path: [], attempt: 1, reason: publicReason(ended.reason, () => ({ kind: "session", agent: "", id: null, layers: [] })), recovery: "resume", tail: ended.reason.type === "body_error" ? ended.reason.message : ended.reason.errors.join("\n") });
		}
		return out;
	}

	status(store: Store): Status {
		const created = Date.parse(String(this.facts.created ?? "")) || (existsSync(this.paths.log) ? statSync(this.paths.log).birthtimeMs : Date.now());
		const ended = Date.parse(String(this.facts.ended_at ?? "")) || null;
		const state = this.state;
		return {
			state,
			elapsed: duration((ended ?? Date.now()) - created),
			completed: this.calls.filter((c) => c.attempts.at(-1)?.type === "answered").length,
			running: state === "running" ? this.calls.filter((c) => c.attempts.at(-1)?.type === "running").map((c) => this.ref(c)) : [],
			failed: this.failed(store),
		};
	}

	/** Outbox messages in the order they were sent: `[outbox name, message id, replyTo, body]`. */
	outboxMessages(): { outbox: string; id: string; replyTo: string | null; body: Json }[] {
		return this.events.flatMap((e) => (e.type === "sent" && e.to.startsWith("outbox:") ? [{ outbox: e.to.slice("outbox:".length), id: this.core.sentId(e.key), replyTo: e.reply_to, body: e.body }] : []));
	}

	/** The call tree: every call under the call it was made in, with its attempts. */
	tree(): unknown {
		const node = (c: CallView): unknown => ({
			id: c.slot,
			label: c.name,
			kind: c.kind,
			attempts: c.attempts,
			calls: this.calls.filter((d) => d.scope.split("|")[0] === c.slot).map(node),
		});
		return { workflow: this.workflowLabel, state: this.state, calls: this.calls.filter((c) => c.scope === "" || !this.#bySlot.has(c.scope.split("|")[0]!)).map(node) };
	}
}

/** A dialogue as text: each message's role and its text parts, tool calls and results. */
export function transcriptText(messages: readonly unknown[]): string {
	return messages
		.map((m) => {
			const msg = m as { role?: string; content?: unknown; toolName?: string; isError?: boolean };
			const parts = typeof msg.content === "string" ? [msg.content] : Array.isArray(msg.content) ? msg.content.map((p: { type?: string; text?: string; name?: string; arguments?: unknown }) => (p.type === "text" ? p.text : p.type === "toolCall" ? `→ ${p.name}(${JSON.stringify(p.arguments)})` : p.type === "image" ? "[image]" : "")) : [];
			const who = msg.role === "toolResult" ? `${msg.toolName}${msg.isError ? " (error)" : ""}` : msg.role;
			return `${who}: ${parts.filter(Boolean).join(" ")}`;
		})
		.join("\n");
}
