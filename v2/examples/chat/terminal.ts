// A terminal front end for the chat workflow: about the smallest harness.
//   node terminal.ts <repo dir>          start a session
//   node terminal.ts --attach <run id>   reattach (the run kept going while you were away)
// Ctrl-D ends the input; the run itself stops only when the assistant returns, or on `/stop`.

import { createInterface } from "node:readline/promises";
import { attach, run, Tree } from "wallis";
import chat from "./workflow.ts";

const [a, b] = process.argv.slice(2);
const r = a === "--attach" ? attach(chat, b!) : await run(chat, { repo: Tree.from(a!) }, { detach: true });
console.log(`run ${r.id}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });

// Replies: print each outbox message as it arrives; close the input when the run ends.
const printer = (async () => {
	for (;;) {
		const n = await r.next({ timeout: "1h" });
		if (n.type === "message") console.log(`\n${String(n.body)}\n`);
		if (n.type === "finished") { console.log(`\n${n.output.summary}\nchanges: ${n.output.changes.digest}`); return rl.close(); }
		if (n.type === "failed") { console.error(n.error); return rl.close(); }
		if (n.type === "stopped") return rl.close(); // resume later with attach(chat, id).resume()
	}
})();

// Input: every line goes to the assistant's mailbox; `!` interrupts its current turn.
for await (const line of rl) {
	if (line === "/stop") { await r.stop(); break; }
	const interrupt = line.startsWith("!");
	await r.send("user", interrupt ? line.slice(1) : line, { interrupt });
}
await printer;
