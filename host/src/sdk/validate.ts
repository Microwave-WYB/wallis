// Schema checks shared by the sandbox and the host, so both sides of the
// boundary validate the same way.

import Value from "typebox/value";

/** Empty when `value` matches `schema`; otherwise readable errors. */
export function schemaErrors(schema: unknown, value: unknown): string[] {
	if (Value.Check(schema as never, value)) return [];
	const errors = Value.Errors(schema as never, value).map((e) => `${e.instancePath || "/"} ${e.message}`);
	return errors.length > 0 ? errors.slice(0, 8) : ["does not match"];
}
