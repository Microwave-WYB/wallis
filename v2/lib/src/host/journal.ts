// A run's journal as one process drives it: the core and its log together.
// `step` applies an event; an event the core checkpoints is appended to the
// log (fsynced) before its effects are returned, so the log is the single
// commit point and an effect never runs ahead of the event behind it.
//
// With `WALLIS_DIFFERENTIAL=1` (every test), after each event the state
// rebuilt from the log alone must equal the live state; a mismatch is a
// state change that was not logged, and throws.

import { Core, type Effect, type Event } from "./core.ts";
import { EventLog } from "./log.ts";

export class DifferentialMismatch extends Error {
	override readonly name = "DifferentialMismatch";
}

export class Journal {
	readonly log: EventLog;
	readonly #core: Core;

	private constructor(log: EventLog, core: Core) {
		this.log = log;
		this.#core = core;
	}

	/** The journal of the log at `path`: its events refolded (none for a new run). */
	static open(path: string): Journal {
		const log = new EventLog(path);
		return new Journal(log, Core.refold(log.read()));
	}

	get core(): Core {
		return this.#core;
	}

	step(event: Event): Effect[] {
		const effects = this.#core.step(event);
		if (effects.some((e) => e.type === "checkpoint")) this.log.append(event);
		if (process.env.WALLIS_DIFFERENTIAL === "1") {
			const rebuilt = Core.refold(this.log.read()).fullState();
			const live = this.#core.fullState();
			if (rebuilt !== live) throw new DifferentialMismatch(`after ${event.type}, the state rebuilt from the log differs from the live state\nlive:    ${live}\nrebuilt: ${rebuilt}`);
		}
		return effects.filter((e) => e.type !== "checkpoint");
	}
}
