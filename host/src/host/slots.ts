// Machine-wide resource slots, like ~/.local/bin/build-guard: a script that
// declares `resources` takes flock slots shared by every wallis process on
// the machine (one lock file per unit of GPU or per GB of memory) and runs
// in its own systemd scope with a memory cap. Per-provider LLM concurrency
// uses the same locks.

import { hostEnv, hostProgram } from "./hostbin.ts";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Resources } from "../sdk/index.ts";

export interface Slots {
	withSlot<T>(resources: Resources, run: () => Promise<T>): Promise<T>;
}

export const NO_SLOTS: Slots = { withSlot: (_r, run) => run() };

export function locksDir(): string {
	return join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "wallis", "slots");
}

/** Holds `flock -n` on a lock file through a child process; resolves to a release function, or null if taken. */
function tryLock(file: string): Promise<(() => void) | null> {
	return new Promise((resolve) => {
		closeSync(openSync(file, "a"));
		const child = spawn("flock", ["-n", file, "sh", "-c", "echo locked; exec cat"], { stdio: ["pipe", "pipe", "ignore"] });
		let settled = false;
		child.stdout.once("data", () => {
			settled = true;
			resolve(() => child.stdin.end());
		});
		child.on("exit", () => {
			if (!settled) resolve(null);
		});
	});
}

/** Takes `count` of `total` slots named `kind`, waiting while they are busy. */
export async function acquire(kind: string, count: number, total: number, pollMs = 500): Promise<() => void> {
	const dir = join(locksDir(), kind);
	mkdirSync(dir, { recursive: true });
	if (count > total) throw new Error(`needs ${count} ${kind} but the machine has ${total}`);
	for (;;) {
		const held: (() => void)[] = [];
		for (let i = 0; i < total && held.length < count; i++) {
			const release = await tryLock(join(dir, `slot${i}`));
			if (release) held.push(release);
		}
		if (held.length === count) return () => held.forEach((r) => r());
		held.forEach((r) => r());
		await new Promise((r) => setTimeout(r, pollMs));
	}
}

let systemdChecked: boolean | null = null;

/** Whether `systemd-run --user --scope` works here. */
export function systemdAvailable(): boolean {
	if (systemdChecked === null) {
		const r = spawnSync(hostProgram("systemd-run"), ["--user", "--scope", "--quiet", "--collect", "--", "/bin/true"], { stdio: "ignore", env: hostEnv() });
		systemdChecked = r.status === 0;
	}
	return systemdChecked;
}

export class MachineSlots implements Slots {
	readonly #gpu: number;
	readonly #memoryGb: number;

	constructor(capacity: { gpu?: number; memoryGb?: number } = {}) {
		this.#gpu = capacity.gpu ?? 0;
		this.#memoryGb = capacity.memoryGb ?? 0;
	}

	async withSlot<T>(resources: Resources, run: () => Promise<T>): Promise<T> {
		const releases: (() => void)[] = [];
		try {
			if (resources.gpu) releases.push(await acquire("gpu", resources.gpu, this.#gpu));
			if (resources.memoryGb && this.#memoryGb > 0) releases.push(await acquire("memory", Math.ceil(resources.memoryGb), this.#memoryGb));
			return await run();
		} finally {
			releases.forEach((r) => r());
		}
	}
}


// --- Per-provider LLM concurrency ---------------------------------------------------

/**
 * Wraps an executor so each turn holds one of the provider's slots (from the
 * local profile's `providers`, e.g. `{ "openai": 4 }`), machine-wide.
 * Providers without a limit are not throttled.
 */
export function limitProviders<E extends import("./executor.ts").Executor>(executor: E, limits: Readonly<Record<string, number>>): E {
	if (Object.keys(limits).length === 0) return executor;
	const provider = (model: string) => model.slice(0, Math.max(0, model.indexOf("/")));
	return {
		...executor,
		id: executor.id,
		capabilities: executor.capabilities,
		start: async (spec) => {
			const inner = await executor.start(spec);
			let model = spec.model;
			const throttled = async <T>(run: () => Promise<T>): Promise<T> => {
				const limit = limits[provider(model)];
				if (!limit) return run();
				const release = await acquire(`provider-${provider(model)}`, 1, limit);
				try {
					return await run();
				} finally {
					release();
				}
			};
			return {
				...inner,
				turn: (message) => throttled(() => inner.turn(message)),
				rebind: inner.rebind
					? (next) => {
							model = next;
							inner.rebind!(next);
						}
					: undefined,
				steer: inner.steer?.bind(inner),
				interrupt: inner.interrupt?.bind(inner),
				handle: () => inner.handle(),
				close: () => inner.close(),
			};
		},
	};
}
