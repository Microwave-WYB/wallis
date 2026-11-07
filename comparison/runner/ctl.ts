// Talk to a running run.ts.
//
//   node ctl.ts status                 both arms' status.json (no connection needed)
//   node ctl.ts tail <arm> [n]         the last n lines of an arm's log
//   node ctl.ts eval '<js>'            evaluate in the live process: arms.a.status,
//                                      arms.a.handle.steer("..."), arms.b.agent ...

import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";

const work = new URL("work/", import.meta.url).pathname;
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "status") {
	for (const arm of ["a", "b"]) {
		const f = `${work}${arm}/status.json`;
		console.log(arm, existsSync(f) ? readFileSync(f, "utf8") : "(no status yet)");
	}
} else if (cmd === "tail") {
	const lines = readFileSync(`${work}${args[0]}/log.txt`, "utf8").trimEnd().split("\n");
	console.log(lines.slice(-Number(args[1] ?? 30)).join("\n"));
} else if (cmd === "eval") {
	const socket = connect(`${work}ctl.sock`);
	let out = "";
	socket.on("data", (d) => (out += d));
	socket.on("end", () => console.log(out));
	socket.on("error", (e) => (console.error(`not running? ${e.message}`), process.exit(1)));
	socket.end(args.join(" "));
} else {
	console.error("usage: node ctl.ts status | tail <arm> [n] | eval '<js>'");
	process.exit(2);
}
