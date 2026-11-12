// A workflow module that starts a run when it is imported (with SELF_RUN set): the mistake the
// runner guards against. The detached run's process imports this module too.
import { run, Type, workflow } from "wallis";

export const noop = workflow({ input: Type.Object({}), output: Type.Object({}), run: async () => ({}) });

if (process.env.SELF_RUN) {
	const r = await run(noop, {}, { detach: true });
	(globalThis as { selfRun?: unknown }).selfRun = r;
}
