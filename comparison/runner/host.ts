// A long-lived host for REPL-driven orchestration. It loads the helpers,
// then serves a console on work/ctl.sock: send JavaScript with
// `node ctl.ts eval '<js>'`. `$` persists between evaluations (each one is
// wrapped in an async function, so plain const/let do not). Every
// evaluated snippet is appended to work/repl.log, so the session can be
// replayed or turned into a script later.
//
//   systemd-run --user --scope -p MemoryMax=8G node host.ts

import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { builderArm } from "./arms.ts";
import { startConsole } from "./lib/console.ts";

const work = fileURLToPath(new URL("work/", import.meta.url));
mkdirSync(work, { recursive: true });

const $: Record<string, unknown> = {};
const arms: Record<string, ReturnType<typeof builderArm>> = {};

startConsole(`${work}ctl.sock`, { $, arms, builderArm }, (code) =>
	appendFileSync(`${work}repl.log`, `// ${new Date().toISOString()}\n${code}\n\n`),
);
console.log(`host ready: node ctl.ts eval '<js>'  (socket ${work}ctl.sock)`);
