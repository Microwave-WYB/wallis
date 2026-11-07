// A "devtools console" for a running program: a local Unix socket that
// evaluates JavaScript in a context you choose and returns the result.
// One request per connection: the client writes code and ends its side;
// the server replies with util.inspect of the awaited result.
//
//   startConsole("work/ctl.sock", { arms })
//   node ctl.ts eval 'arms.a.status'
//
// Only for programs you trust: whoever can open the socket can run code
// in the process. The socket is created mode 0600.

import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { inspect } from "node:util";
import { createContext, Script } from "node:vm";

export function startConsole(path: string, globals: Record<string, unknown>, onEval?: (code: string) => void): Server {
	if (existsSync(path)) unlinkSync(path);
	const context = createContext({ ...globals, console, setTimeout, Date, JSON });
	// allowHalfOpen: the client ends its side after sending code; we still write the reply.
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		// A broken client must never crash the host (and the agents it runs).
		socket.on("error", () => {});
		let code = "";
		socket.on("data", (d) => (code += d));
		socket.on("end", async () => {
			onEval?.(code);
			let out: string;
			try {
				// An expression returns its value; otherwise run statements (use `return` for a value).
				let script: Script;
				try {
					script = new Script(`(async () => (${code}\n))()`);
				} catch {
					script = new Script(`(async () => {\n${code}\n})()`);
				}
				// The timeout bounds the synchronous part only; awaited work may run longer.
				const value = await script.runInContext(context, { timeout: 5_000 });
				out = inspect(value, { depth: 4, maxArrayLength: 50, maxStringLength: 4_000, breakLength: 120 });
			} catch (e) {
				out = `error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`;
			}
			socket.end(out);
		});
	});
	server.listen(path, () => chmodSync(path, 0o600));
	return server;
}
