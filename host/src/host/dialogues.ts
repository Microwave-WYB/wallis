// Dialogue blobs. A checkpoint of an agent call is stored as a delta from
// the session's dialogue before the call (its base) when it extends it:
// how many of the base's messages it keeps, and the messages after them.
// It is stored whole after a compaction (which rewrites the start of the
// dialogue), when it does not extend its base, and when the chain of bases
// is already deep, so reading one never follows a long chain.
//
// The blob is content-addressed and written before the event that names it
// (`putBlob`); reading resolves the chain back to a whole value.

import type { Json } from "../sdk/index.ts";
import { putBlob, readBlob } from "./artifacts.ts";

const MAX_DEPTH = 16;

type Messages = { readonly messages: readonly Json[]; readonly compacted?: Json };
type Delta = { readonly base: string; readonly keep: number; readonly depth: number };

function asDialogue(value: Json): Messages | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const messages = (value as { messages?: Json }).messages;
	return Array.isArray(messages) ? (value as unknown as Messages) : null;
}

function deltaOf(value: Json): Delta | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const d = (value as { wallis_delta?: Json }).wallis_delta;
	if (d === null || typeof d !== "object" || Array.isArray(d)) return null;
	const { base, keep, depth } = d as { base?: Json; keep?: Json; depth?: Json };
	return typeof base === "string" && typeof keep === "number" && typeof depth === "number" ? { base, keep, depth } : null;
}

/** Writes a checkpoint, as a delta from `base` (the session's dialogue before the call) where it extends it. */
export function putDialogue(runDir: string, state: Json, base: { readonly digest: string; readonly state: Json } | null): string {
	const now = asDialogue(state);
	const before = base === null ? null : asDialogue(base.state);
	const compacted = now?.compacted !== undefined && now.compacted !== null;
	const depth = base === null ? 0 : (deltaOf(JSON.parse(readBlob(runDir, base.digest) ?? "null") as Json)?.depth ?? 0) + 1;
	if (now === null || before === null || base === null || compacted || depth > MAX_DEPTH) return putBlob(runDir, JSON.stringify(state));
	let keep = 0;
	while (keep < before.messages.length && keep < now.messages.length && JSON.stringify(before.messages[keep]) === JSON.stringify(now.messages[keep])) keep++;
	// Nothing in common: whole.
	if (keep === 0) return putBlob(runDir, JSON.stringify(state));
	const delta = { ...(state as object), messages: now.messages.slice(keep), wallis_delta: { base: base.digest, keep, depth } };
	return putBlob(runDir, JSON.stringify(delta));
}

/** A dialogue blob as a whole value; undefined when the store lacks it or a base of it. */
export function readDialogue(runDir: string, digest: string): Json | undefined {
	const text = readBlob(runDir, digest);
	if (text === null) return undefined;
	const value = JSON.parse(text) as Json;
	const delta = deltaOf(value);
	if (delta === null) return value;
	const base = readDialogue(runDir, delta.base);
	const before = base === undefined ? null : asDialogue(base);
	if (before === null) return undefined;
	const { wallis_delta: _delta, ...rest } = value as { wallis_delta: Json; messages: Json[] };
	return { ...rest, messages: [...before.messages.slice(0, delta.keep), ...rest.messages] } as Json;
}
