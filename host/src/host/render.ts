// Renders an agent's input for its first prompt. Fields render in full by
// default. A field marked `Foldable(T, { maxChars })` renders in full when
// its canonical JSON fits in maxChars; otherwise it renders as a
// deterministic, size-bounded skeleton: item counts, field names and the
// head of long strings. The full input is always the `input` variable in
// codemode, and the prompt says which fields were folded.

import { FOLD, type Json } from "../sdk/index.ts";

/** Conservative: 3 characters per token. */
export const CHARS_PER_TOKEN = 3;

const HEAD = 200;
const KEYS = 20;
const DEPTH = 2;

export interface RenderedInput {
	readonly text: string;
	readonly folded: readonly { readonly path: string; readonly chars: number }[];
	/** Rendered size of each top-level field (objects only). */
	readonly fields: Readonly<Record<string, number>>;
}

/** JSON with sorted keys: equal values render equally. */
export function canonical(value: Json): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(value[k]!)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function skeleton(value: Json, depth: number): Json {
	if (typeof value === "string") return value.length <= HEAD ? value : { folded: "string", chars: value.length, head: value.slice(0, HEAD) };
	if (Array.isArray(value)) {
		const out: { [k: string]: Json } = { folded: "array", items: value.length };
		if (value.length > 0 && depth < DEPTH) out.first = skeleton(value[0]!, depth + 1);
		return out;
	}
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value).sort();
		const shown = keys.slice(0, KEYS);
		return depth < DEPTH
			? { folded: "object", keys: keys.length, fields: Object.fromEntries(shown.map((k) => [k, skeleton(value[k]!, depth + 1)])) }
			: { folded: "object", keys: keys.length, names: shown };
	}
	return value;
}

type Schema = { readonly [k: string]: unknown };

function fold(schema: unknown, value: Json, path: string, folded: { path: string; chars: number }[]): Json {
	if (schema === null || typeof schema !== "object") return value;
	const s = schema as Schema;
	const mark = s[FOLD] as { maxChars?: unknown } | undefined;
	if (mark && typeof mark.maxChars === "number") {
		const chars = canonical(value).length;
		if (chars > mark.maxChars) {
			folded.push({ path: path || "/", chars });
			return skeleton(value, 0);
		}
		return value;
	}
	const props = s.properties as Schema | undefined;
	if (props && value !== null && typeof value === "object" && !Array.isArray(value)) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fold(props[k], v, `${path}/${k}`, folded)]));
	}
	if (s.items && Array.isArray(value)) return value.map((v, i) => fold(s.items, v, `${path}/${i}`, folded));
	return value;
}

/** Whether a schema marks any field foldable. */
export function hasFoldable(schema: unknown): boolean {
	if (schema === null || typeof schema !== "object") return false;
	const s = schema as Schema;
	if (FOLD in s) return true;
	return Object.values(s).some((v) => (Array.isArray(v) ? v.some(hasFoldable) : hasFoldable(v)));
}

export function renderInput(schema: unknown, input: Json): RenderedInput {
	const folded: { path: string; chars: number }[] = [];
	const shown = fold(schema, input, "", folded);
	const parts = [`Input:\n${JSON.stringify(shown, null, 2)}`];
	if (folded.length > 0) {
		parts.push(
			`Folded fields (shown as skeletons; the full values are in the codemode variable \`input\`): ${folded.map((f) => `${f.path} (${f.chars} chars)`).join(", ")}.`,
		);
	}
	const fields =
		shown !== null && typeof shown === "object" && !Array.isArray(shown) ? Object.fromEntries(Object.entries(shown).map(([k, v]) => [k, JSON.stringify(v).length])) : {};
	return { text: parts.join("\n\n"), folded, fields };
}

/**
 * The window check made before a call's first request: the prompt and the
 * rendered input against the model's window. Over it, the call is refused
 * as `input_too_large`, naming the largest top-level field.
 */
export function windowCheck(
	promptChars: number,
	rendered: RenderedInput,
	contextTokens: number | undefined,
): { readonly field: string | null; readonly chars: number; readonly limit: number } | null {
	if (contextTokens === undefined) return null;
	const chars = promptChars + rendered.text.length;
	const limit = contextTokens * CHARS_PER_TOKEN;
	if (chars <= limit) return null;
	const largest = Object.entries(rendered.fields).sort((a, b) => b[1] - a[1])[0];
	return { field: largest ? largest[0] : null, chars, limit };
}
