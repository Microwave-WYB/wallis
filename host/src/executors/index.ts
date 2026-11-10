// `wallis/executors`: what an executor module (the `--executor` module the
// CLI and `wallis serve` load) needs, by package name, so a workflow and
// its executor module can live anywhere: the pi executor, pi-ai's model
// registries, and the types of an executor module.
//
//   import { builtinModels, PiExecutor, type ExecutorKit } from "wallis/executors";
//   export default function create(): ExecutorKit {
//     return { executor: new PiExecutor({ models: builtinModels() }) };
//   }

export { createModels } from "@earendil-works/pi-ai";
export { builtinModels } from "@earendil-works/pi-ai/providers/all";
export type { CommandRunner } from "../host/commands.ts";
export type { AgentCall, Executor, NodeSession, NodeSpec, TranscriptEntry, TurnResult } from "../host/executor.ts";
export { parseModel, PiExecutor } from "../host/pi.ts";
export type { ExecutorKit } from "../host/runs.ts";
