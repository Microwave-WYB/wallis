// A detached run's process: `node runner.ts <run dir>`. It reads what it was
// asked to do (`start.json`), imports the workflow from its module, drives
// the run to its end and, when it exits normally, runs `onExit`.

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { importWorkflow, launch, processLog, readStart } from "./launch.ts";
import { runPaths } from "./host/runs.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: runner.ts <run dir>");
const paths = runPaths(dir);
const request = readStart(paths);
const root = dirname(dirname(dirname(paths.dir)));
processLog(paths, `process ${process.pid}: ${request.resume ? "resume" : "start"}`);
const def = await importWorkflow(request.module, request.digest, request.name);
const { result } = await launch({ root, paths, def, input: request.input, ...(request.resume ? { resume: { retry: request.resume.retry, turns: request.resume.turns } } : {}) });
const outcome = await result;
processLog(paths, `process ${process.pid}: ${outcome.type}`);
if (request.onExit) spawnSync("sh", ["-c", request.onExit], { stdio: "inherit", env: { ...process.env, WALLIS_RUN_ID: paths.id, WALLIS_RUN_DIR: paths.dir } });
process.exit(0);
