// Schema checks shared by the sandbox and the host, so both sides of the
// boundary validate the same way.

import Value from "typebox/value";

/** Empty when `value` matches `schema`; otherwise readable errors. */
export function schemaErrors(schema: unknown, value: unknown): string[] {
	if (Value.Check(schema as never, value)) return [];
	const errors = Value.Errors(schema as never, value).map((e) => `${e.instancePath || "/"} ${e.message}`);
	return errors.length > 0 ? errors.slice(0, 8) : ["does not match"];
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: string[] };

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A copy of `value` as plain JSON, or why it is not JSON. */
export function toJson(value: unknown, path = ""): Parsed<JsonValue> {
	if (value === null || typeof value === "boolean" || typeof value === "string") return { ok: true, value };
	if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : { ok: false, errors: [`${path || "/"} is not a finite number`] };
	if (Array.isArray(value)) {
		const out: JsonValue[] = [];
		for (const [i, v] of value.entries()) {
			const r = toJson(v, `${path}/${i}`);
			if (!r.ok) return r;
			out.push(r.value);
		}
		return { ok: true, value: out };
	}
	if (typeof value === "object") {
		const out: { [key: string]: JsonValue } = {};
		for (const [k, v] of Object.entries(value)) {
			const r = toJson(v, `${path}/${k}`);
			if (!r.ok) return r;
			out[k] = r.value;
		}
		return { ok: true, value: out };
	}
	return { ok: false, errors: [`${path || "/"} is not JSON (${typeof value})`] };
}

/** Parses a boundary value: JSON first, then the schema. */
export function parseWith(schema: unknown, value: unknown): Parsed<JsonValue> {
	const json = toJson(value);
	if (!json.ok) return json;
	const errors = schemaErrors(schema, json.value);
	return errors.length > 0 ? { ok: false, errors } : json;
}
