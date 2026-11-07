// Runs a bundled workflow in QuickJS: no fs, no network, a virtual clock,
// UTC, and Math.random seeded from the pin. The guest talks to the host
// only through the three functions installed here; the host calls into it
// to start, deliver, and evaluate a command's pure `run` and `parse`.

import { readFileSync } from "node:fs";
import { QuickJS } from "quickjs-wasi";
import type { Json } from "../sdk/index.ts";
import type { Declarations } from "../sdk/runtime.ts";

const asset = (name: string) => readFileSync(new URL(import.meta.resolve(`quickjs-wasi/${name}`)));
const wasm = asset("quickjs.wasm");
// TextEncoder/TextDecoder, which TypeBox needs. No fetch, fs or crypto.
const encoding = asset("encoding.so");

/** The virtual clock starts here and advances 1 ms per read. */
export const VIRTUAL_EPOCH_MS = Date.UTC(2025, 0, 1);

export interface GuestHooks {
	send(json: string): void;
	done(json: string): void;
	fail(message: string): void;
}

export class Sandbox {
	readonly #vm: QuickJS;

	private constructor(vm: QuickJS) {
		this.#vm = vm;
	}

	static async create(code: string, hooks: GuestHooks): Promise<Sandbox> {
		let now = BigInt(VIRTUAL_EPOCH_MS);
		const vm = await QuickJS.create({
			wasm,
			memoryLimit: 256 * 1024 * 1024,
			extensions: [{ name: "encoding", wasm: encoding }],
			timezoneOffset: 0,
			wasi: (memory: { readonly buffer: ArrayBufferLike }) => ({
				clock_time_get(_clock: number, _precision: bigint, resultPtr: number) {
					new DataView(memory.buffer).setBigUint64(resultPtr, now * 1_000_000n, true);
					now += 1n;
					return 0;
				},
				random_get(ptr: number, len: number) {
					new Uint8Array(memory.buffer, ptr, len).fill(0);
					return 0;
				},
			}),
		});
		const install = (name: string, fn: (arg: string) => void) => {
			using f = vm.newFunction(name, (arg) => {
				fn(arg!.toString());
				return vm.undefined;
			});
			vm.setProp(vm.global, name, f);
		};
		install("__wallis_send", hooks.send);
		install("__wallis_done", hooks.done);
		install("__wallis_fail", hooks.fail);
		vm.evalCode(code, "workflow.js").dispose();
		return new Sandbox(vm);
	}

	declare(): Declarations {
		return JSON.parse(this.#vm.evalCode("__wallis_declare()").consume((h) => h.toString())) as Declarations;
	}

	start(input: Json, seed: number): void {
		this.#call("__wallis_start", [JSON.stringify(input), seed]);
	}

	/** A command's `run`, evaluated in the workflow VM: pure, synchronous. */
	argv(command: string, input: Json): { ok: true; argv: string[] } | { ok: false; error: string } {
		return JSON.parse(this.#invoke("__wallis_argv", [command, JSON.stringify(input)])) as never;
	}

	/** A command's `parse`, evaluated in the workflow VM: pure, synchronous. */
	parse(command: string, result: { exit: number; stdout: string; stderr: string }): { ok: true; output: unknown } | { ok: false; error: string } {
		return JSON.parse(this.#invoke("__wallis_parse", [command, JSON.stringify(result)])) as never;
	}

	#invoke(name: string, args: string[]): string {
		const vm = this.#vm;
		using fn = vm.global.getProp(name);
		const handles = args.map((a) => vm.newString(a));
		try {
			return vm.callFunction(fn, vm.undefined, ...handles).consume((h) => h.toString());
		} finally {
			for (const h of handles) h.dispose();
		}
	}

	/** False when no request of the body waits for `id`. */
	deliver(id: string, reply: Json): boolean {
		const taken = this.#invoke("__wallis_deliver", [id, JSON.stringify(reply)]) === "true";
		this.#vm.executePendingJobs();
		return taken;
	}

	#call(name: string, args: (string | number)[]): void {
		const vm = this.#vm;
		using fn = vm.global.getProp(name);
		const handles = args.map((a) => (typeof a === "string" ? vm.newString(a) : vm.newNumber(a)));
		try {
			vm.callFunction(fn, vm.undefined, ...handles).dispose();
		} finally {
			for (const h of handles) h.dispose();
		}
		vm.executePendingJobs();
	}

	dispose(): void {
		this.#vm.dispose();
	}
}

/** A workflow's declarations, read by evaluating its bundle in the sandbox without starting it. */
export async function declarationsOf(workflow: string): Promise<Declarations> {
	const { bundleWorkflow } = await import("./bundle.ts");
	const sandbox = await Sandbox.create((await bundleWorkflow(workflow)).code, { send: () => {}, done: () => {}, fail: () => {} });
	try {
		return sandbox.declare();
	} finally {
		sandbox.dispose();
	}
}
