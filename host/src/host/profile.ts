// The local profile: per machine, never committed. `~/.config/wallis/profile.json`
// merged with `<project>/.wallis/profile.json` (the project wins).
//
//   {
//     "models":    { "global": { alias: model }, "workflows": { name: { alias: model } } },
//     "mounts":    { "global": { name: dir }, "workflows": { name: { mount: dir } } },
//     "bins":      { "global": { name: path }, "workflows": { name: { bin: path } } },
//     "retries":   [5, 30, 120],          // transient executor errors, seconds between attempts
//     "providers": { "openai": 4 },        // concurrent LLM calls per provider
//     "slots":     { "gpu": 1, "memoryGb": 48 }   // machine-wide script resources
//   }

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Profile } from "./models.ts";
import type { BinProfile } from "./confine.ts";
import type { MountProfile } from "./mounts.ts";

export interface LocalProfile {
	readonly models?: Profile;
	readonly mounts?: MountProfile;
	readonly bins?: BinProfile;
	/** Transient executor errors: retry delays in seconds (default [5, 30, 120]). */
	readonly retries?: readonly number[];
	readonly providers?: Readonly<Record<string, number>>;
	readonly slots?: { readonly gpu?: number; readonly memoryGb?: number };
}

function read(path: string): LocalProfile {
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LocalProfile) : {};
}

export function loadProfile(root: string, home = process.env.WALLIS_HOME ?? join(homedir(), ".config", "wallis")): LocalProfile {
	const global = read(join(home, "profile.json"));
	const local = read(join(resolve(root), ".wallis", "profile.json"));
	return {
		models: {
			global: { ...global.models?.global, ...local.models?.global },
			workflows: { ...global.models?.workflows, ...local.models?.workflows },
		},
		bins: {
			global: { ...global.bins?.global, ...local.bins?.global },
			workflows: { ...global.bins?.workflows, ...local.bins?.workflows },
		},
		retries: local.retries ?? global.retries,
		mounts: {
			global: { ...global.mounts?.global, ...local.mounts?.global },
			workflows: { ...global.mounts?.workflows, ...local.mounts?.workflows },
		},
		providers: { ...global.providers, ...local.providers },
		slots: { ...global.slots, ...local.slots },
	};
}
