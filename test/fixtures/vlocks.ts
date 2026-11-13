// Named volumes, Docker-style: `:ro` readers share a volume, a writer has it alone.
import { command, sandbox, Type, workflow } from "wallis";

const reader = sandbox({ requires: ["sh", "sleep", "cat"], volumes: ["env:/opt/env:ro"] });
const writer = sandbox({ requires: ["sh", "sleep"], volumes: ["env:/opt/env"] });
const Out = Type.Object({ ms: Type.Integer() });

const read = command({ sandbox: reader, input: Type.Object({ n: Type.Integer() }), output: Out, run: () => ["sh", "-c", 'cat /opt/env/v >/dev/null 2>&1; sleep 0.6; echo "{\\"ms\\": 0}"'] });
const write = command({ sandbox: writer, input: Type.Object({ s: Type.Number() }), output: Out, run: ({ s }) => ["sh", "-c", `echo x > /opt/env/v; sleep ${s}; echo '{"ms": 0}'`] });
const tryWrite = command({ sandbox: reader, input: Type.Object({}), output: Out, run: () => ["sh", "-c", 'echo x > /opt/env/v && echo "{\\"ms\\": 0}"'] });

/** Three readers at once. */
export const readers = workflow({ input: Type.Object({}), output: Type.Object({ ms: Type.Integer() }), run: async (ctx) => {
	const t = Date.now();
	await Promise.all([1, 2, 3].map((n) => ctx.call(read, { n })));
	return { ms: Date.now() - t };
} });

/** A writer and a reader at once. */
export const mixed = workflow({ input: Type.Object({}), output: Type.Object({ ms: Type.Integer() }), run: async (ctx) => {
	const t = Date.now();
	await Promise.all([ctx.call(write, { s: 0.6 }), ctx.call(read, { n: 1 })]);
	return { ms: Date.now() - t };
} });

/** A long writer and a second writer that waits for it. */
export const contended = workflow({ input: Type.Object({}), output: Type.Object({}), run: async (ctx) => {
	await Promise.all([ctx.call(write, { s: 30 }), ctx.call(write, { s: 0 })]);
	return {};
} });

/** A `:ro` mount cannot be written. */
export const readOnly = workflow({ input: Type.Object({}), output: Out, run: (ctx) => ctx.call(tryWrite, {}) });
