// Runs command calls. The session computes everything a call needs (its
// argv from the command's pure `run`, the sandboxed process from
// `Sandboxes.spawn`), so a runner only starts the process, waits for a
// resource slot first, and reports the raw result. The session then parses
// it with the command's pure `parse` and checks it.

import type { Json } from "../sdk/index.ts";
import type { NodeDirs } from "./artifacts.ts";
import { runSpawn, type Spawn } from "./confine.ts";
import { scoped, type Slots } from "./slots.ts";

export interface CommandCall {
	readonly id: string;
	readonly command: string;
	/** The mounted input (artifacts with their `path`); also the process's stdin, as JSON. */
	readonly input: Json;
	/** The argv from the command's `run`, before sandboxing. */
	readonly argv: readonly string[];
	/** The sandboxed process; null when no sandbox can be built here (no bwrap). */
	readonly spawn: Spawn | null;
	/** Remaining compute budget: the process is killed when it is spent. */
	readonly computeMinutes: number | null;
	readonly resources: { readonly gpu?: number; readonly memoryGb?: number };
	readonly workspace: NodeDirs;
	/** Aborted on restart or cancel. */
	readonly signal: AbortSignal;
}

/** A process result; `timedOut` when the compute budget killed it. */
export interface CommandRun {
	readonly exit: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly minutes: number;
	readonly timedOut: boolean;
}

export interface CommandRunner {
	run(call: CommandCall): Promise<CommandRun>;
}

export class CommandError extends Error {
	override readonly name = "CommandError";
}

/** Starts sandboxed processes, under machine-wide resource slots. */
export class ProcessCommands implements CommandRunner {
	readonly #slots: Slots | undefined;

	constructor(options: { readonly slots?: Slots } = {}) {
		this.#slots = options.slots;
	}

	async run(call: CommandCall): Promise<CommandRun> {
		const go = () => this.#spawn(call);
		return this.#slots ? this.#slots.withSlot(call.resources, go) : go();
	}

	async #spawn(call: CommandCall): Promise<CommandRun> {
		if (!call.spawn) throw new CommandError("no sandbox: bubblewrap cannot create one here");
		// A memory scope's systemd-run needs the session bus; the sandbox does not get it.
		const bus = Object.fromEntries(["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
		const inner = call.resources.memoryGb ? [...Object.keys(bus).flatMap((k) => ["--unsetenv", k]), ...call.spawn.args] : [...call.spawn.args];
		const [command, args] = scoped(call.spawn.command, inner, call.resources.memoryGb);
		const env = command === call.spawn.command ? call.spawn.env : { ...call.spawn.env, ...bus };
		const r = await runSpawn({ ...call.spawn, command, args, env }, JSON.stringify(call.input), {
			timeoutMs: call.computeMinutes === null ? null : Math.max(1000, call.computeMinutes * 60_000),
			signal: call.signal,
		});
		return { exit: r.exit, stdout: r.stdout, stderr: r.stderr, minutes: r.minutes, timedOut: r.timedOut };
	}
}
