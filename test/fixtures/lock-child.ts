// One contender for a stale lock (test/runs.test.ts): waits for a common start time, then tries.
import { acquireLock, runPaths } from "../../src/host/runs.ts";
const p = runPaths(process.argv[2]!);
const start = Number(process.argv[3]);
while (Date.now() < start) {}
try {
	acquireLock(p);
	console.log("got");
} catch {
	console.log("no");
}
setTimeout(() => {}, 300);
