// Project configuration: `<project>/.wallis/config.json`.
//
//   { "models": { "default": "anthropic/claude-sonnet-5-5", "fast": "…" },
//     "executor": "./executor.ts" }
//
// `models` maps the aliases agents declare to `provider/model[:thinking]`.
// `executor` (optional, relative to the project) is a module whose default
// export returns `{ models, getApiKey? }`: a pi-ai model registry (a faux
// one in tests). Without it, pi-ai's built-in providers are used, with
// their usual environment variables for keys.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PiModels } from "./agents.ts";

export interface ProjectConfig {
	readonly models: Readonly<Record<string, string>>;
	readonly executor: string | null;
	readonly retryDelaysMs?: readonly number[];
}

export function readConfig(root: string): ProjectConfig {
	const file = join(root, ".wallis", "config.json");
	if (!existsSync(file)) return { models: {}, executor: null };
	const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file}: not an object`);
	const { models, executor, retryDelaysMs } = raw as { models?: unknown; executor?: unknown; retryDelaysMs?: unknown };
	const table: Record<string, string> = {};
	if (models !== undefined) {
		if (models === null || typeof models !== "object") throw new Error(`${file}: "models" is an object of alias -> provider/model`);
		for (const [k, v] of Object.entries(models)) {
			if (typeof v !== "string") throw new Error(`${file}: models.${k} is not a string`);
			table[k] = v;
		}
	}
	if (executor !== undefined && typeof executor !== "string") throw new Error(`${file}: "executor" is a module path`);
	const delays = Array.isArray(retryDelaysMs) && retryDelaysMs.every((d) => typeof d === "number") ? (retryDelaysMs as number[]) : undefined;
	return { models: table, executor: typeof executor === "string" ? resolve(root, executor) : null, ...(delays ? { retryDelaysMs: delays } : {}) };
}

export interface ExecutorKit {
	readonly models: PiModels;
	readonly getApiKey?: (provider: string) => string | undefined;
}

export async function loadExecutor(config: ProjectConfig): Promise<ExecutorKit> {
	if (config.executor === null) {
		const { builtinModels } = await import("@earendil-works/pi-ai/providers/all");
		return { models: builtinModels() as unknown as PiModels };
	}
	const mod = (await import(pathToFileURL(config.executor).href)) as { default?: unknown };
	const made = typeof mod.default === "function" ? await (mod.default as () => unknown)() : mod.default;
	if (made === null || typeof made !== "object" || typeof (made as { models?: { getModel?: unknown } }).models?.getModel !== "function") throw new Error(`${config.executor}: its default export must return { models, getApiKey? }`);
	return made as ExecutorKit;
}
