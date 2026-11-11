// Dialogue blobs. A checkpoint of an agent call is stored as a delta from
// the session's dialogue before the call (its base) when it extends it:
// how many of the base's messages it keeps, and the messages after them.
// It is stored whole after a compaction (which rewrites the start of the
// dialogue), when it does not extend its base, and when the chain of bases
// is already deep, so reading one never follows a long chain.
//
// The blob is content-addressed and written before the event that names it
// (`Store.putText`), in the project's store; reading resolves the chain back to a whole value.

import type { Json } from "./core.ts";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import type { Store } from "./store.ts";

const MAX_DEPTH = 16;

/**
 * A dialogue blob: the executor's state whole, or as a delta from a base
 * blob (the base's first `keep` messages, then `messages`). The envelope
 * keeps wallis's fields apart from the executor's own, so no key of its
 * state is ever taken for one of ours.
 */
const Blob = Type.Union([
	Type.Object({ wallis_dialogue: Type.Literal("whole"), state: Type.Unsafe<Json>({}) }),
	Type.Object({
		wallis_dialogue: Type.Literal("delta"),
		base: Type.String(),
		keep: Type.Integer({ minimum: 0 }),
		depth: Type.Integer({ minimum: 1 }),
		state: Type.Object({ messages: Type.Array(Type.Unsafe<Json>({})) }),
	}),
]);

type Messages = { readonly messages: readonly Json[]; readonly compacted?: Json };

function asDialogue(value: Json): Messages | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const messages = (value as { messages?: Json }).messages;
	return Array.isArray(messages) ? (value as unknown as Messages) : null;
}

function parse(store: Store, digest: string): Static<typeof Blob> | undefined {
	const text = store.readText(digest);
	if (text === null) return undefined;
	const raw: unknown = JSON.parse(text);
	if (!Value.Check(Blob, raw)) throw new Error(`dialogue blob ${digest} is not a dialogue`);
	return raw;
}

/** Writes a checkpoint, as a delta from `base` (the session's dialogue before the call) where it extends it. */
export function putDialogue(store: Store, state: Json, base: { readonly digest: string; readonly state: Json } | null): string {
	const now = asDialogue(state);
	const before = base === null ? null : asDialogue(base.state);
	const compacted = now?.compacted !== undefined && now.compacted !== null;
	const below = base === null ? undefined : parse(store, base.digest);
	const depth = below === undefined ? 1 : below.wallis_dialogue === "delta" ? below.depth + 1 : 1;
	const whole = () => store.putText(JSON.stringify({ wallis_dialogue: "whole", state }));
	if (now === null || before === null || base === null || compacted || depth > MAX_DEPTH) return whole();
	let keep = 0;
	while (keep < before.messages.length && keep < now.messages.length && JSON.stringify(before.messages[keep]) === JSON.stringify(now.messages[keep])) keep++;
	// Nothing in common: whole.
	if (keep === 0) return whole();
	return store.putText(JSON.stringify({ wallis_dialogue: "delta", base: base.digest, keep, depth, state: { ...(state as object), messages: now.messages.slice(keep) } }));
}

/** A dialogue blob as a whole value; undefined when the store lacks it or a base of it. */
export function readDialogue(store: Store, digest: string): Json | undefined {
	const blob = parse(store, digest);
	if (blob === undefined) return undefined;
	if (blob.wallis_dialogue === "whole") return blob.state;
	const base = readDialogue(store, blob.base);
	const before = base === undefined ? null : asDialogue(base);
	if (before === null) return undefined;
	return { ...blob.state, messages: [...before.messages.slice(0, blob.keep), ...blob.state.messages] } as Json;
}
