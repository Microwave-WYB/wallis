// Alias resolution: call-time > local profile (per-workflow beats global) >
// workflow value > `default`. Callers may remap aliases but not add them.

export interface Profile {
	readonly global?: Readonly<Record<string, string>>;
	readonly workflows?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export function resolveModels(
	workflow: string,
	table: Readonly<Record<string, string>>,
	options: { callTime?: Readonly<Record<string, string>>; profile?: Profile } = {},
): Record<string, string> {
	const layers = [options.callTime ?? {}, options.profile?.workflows?.[workflow] ?? {}, options.profile?.global ?? {}];
	for (const [i, layer] of layers.entries()) {
		for (const alias of Object.keys(layer)) {
			// A global profile may name aliases other workflows use.
			if (!(alias in table) && i < 2) throw new Error(`unknown model alias ${alias}`);
		}
	}
	const pick = (alias: string) => {
		for (const layer of layers) {
			const v = layer[alias];
			if (v) return v;
		}
		return table[alias] ?? "";
	};
	const def = pick("default");
	if (!def) throw new Error("model alias default is unresolved");
	return Object.fromEntries(Object.keys(table).sort().map((alias) => [alias, pick(alias) || def]));
}
