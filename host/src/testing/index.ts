// `wallis/testing`: scripted executors and commands and pi-ai's faux
// provider, by package name, for a workflow's own tests and fake runs (no
// model calls, no keys).
//
//   import { createModels, fauxAssistantMessage, fauxProvider, fauxText, PiExecutor } from "wallis/testing";
//   const provider = fauxProvider({ models: [{ id: "faux-1" }] });
//   const models = createModels();
//   models.setProvider(provider.provider);
//   provider.setResponses([fauxAssistantMessage([fauxText("...")])]);
//   export default () => ({ executor: new PiExecutor({ models }) });

export { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
export { type AgentCall, type Conversation, conversation, FakeCommands, FakeExecutor, type FakeRun, type Turn } from "../host/executor.ts";
export { PiExecutor } from "../host/pi.ts";
export type { ExecutorKit } from "../host/runs.ts";
