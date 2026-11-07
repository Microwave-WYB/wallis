// The one SDK seam. To use another agent SDK, write lib/agent.<sdk>.ts with
// the same `runAgent` and point this file at it.

export { runAgent, transient } from "./agent.pi.ts";
export { type AgentResult, type AgentSpec, submitted, type Tool, type ToolResult, tool } from "./tool.ts";
