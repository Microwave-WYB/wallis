// A declared sandbox, resolved for this host: its programs' real paths and
// its volumes (relative binds against the file that declared it). Resolved
// once per sandbox digest; a missing program or host dir is an error that
// names it and says what to fix.

import { resolvePrograms, type SandboxPlan } from "./host/sandbox.ts";
import { join } from "node:path";
import { resolveVolumes } from "./host/volumes.ts";
import type { SandboxDef } from "./nodes.ts";

export class Plans {
	readonly #plans = new Map<string, SandboxPlan>();
	readonly #root: string;

	/** `root`: the project (its `.wallis` is no bind's, and holds its named volumes). */
	constructor(root: string) {
		this.#root = root;
	}

	plan(def: SandboxDef, extra: readonly string[] = []): SandboxPlan {
		const key = `${def.digest}\n${def.dir}\n${extra.join(",")}`;
		let plan = this.#plans.get(key);
		if (!plan) {
			plan = {
				programs: resolvePrograms([...def.spec.requires, ...extra]),
				volumes: resolveVolumes(def.spec.volumes, def.dir, { stores: [join(this.#root, ".wallis")], root: this.#root }),
				environment: def.spec.environment,
				devices: def.spec.devices,
				network: def.spec.network,
			};
			this.#plans.set(key, plan);
		}
		return plan;
	}
}
