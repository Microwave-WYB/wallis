// `wallis/testing`: what an executor module needs for scripted or faux
// models (never a real model call): pi-ai's model registry and its faux
// provider.

export { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
export type { ExecutorKit } from "./config.ts";
