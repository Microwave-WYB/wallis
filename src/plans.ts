// A declared sandbox, resolved for this host: its programs' real paths and
// its volumes (relative binds against the file that declared it). Resolved
// once per sandbox digest; a missing program or host dir is an error that
// names it and says what to fix.

import { resolvePrograms, type SandboxPlan } from "./host/sandbox.ts";
import { resolveVolumes } from "./host/volumes.ts";
import type { SandboxDef } from "./nodes.ts";

export class Plans {
	readonly #plans = new Map<string, SandboxPlan>();
	readonly #stores: readonly string[];

	/** `stores`: dirs no bind may overlap (the project's `.wallis`). */
	constructor(stores: readonly string[]) {
		this.#stores = stores;
	}

	plan(def: SandboxDef, extra: readonly string[] = []): SandboxPlan {
		const key = `${def.digest}\n${def.dir}\n${extra.join(",")}`;
		let plan = this.#plans.get(key);
		if (!plan) {
			plan = {
				programs: resolvePrograms([...def.spec.requires, ...extra]),
				volumes: resolveVolumes(def.spec.volumes, def.dir, { stores: this.#stores }),
				environment: def.spec.environment,
				devices: def.spec.devices,
				network: def.spec.network,
			};
			this.#plans.set(key, plan);
		}
		return plan;
	}
}
