// The public surface of the `wallis` package (v2): exactly what
// the examples' target api.d.ts declared (now in git history), implemented.
//
// Naming (docs/v2.md §3): nodes and resources are lowercase nouns, schema
// builders are Capitalized, operations are verbs.

export { Type, type Static, type TSchema } from "./values.ts";
export { Address, Artifact, type ArtifactRef, type MessageId, Tree, type TreeRef } from "./values.ts";
export { agent, type Agent, command, type Command, type CommandResult, mcp, type McpConfig, type McpServers, sandbox, type Sandbox, type SandboxSpec, type Session, type Tool, toolset, type Toolset, type WallisTool } from "./nodes.ts";
export { workflow } from "./workflow.ts";
export type { Ctx, Envelope, Mailbox, Running, Step, Workflow } from "./runtime.ts";
export { type CallId, type CallRef, type FailedCall, type FailureReason, MessageRejected, NodeFailed } from "./errors.ts";
export { attach, type Finished, list, type Next, prune, run, type Run } from "./caller.ts";
export type { Duration, Status } from "./status.ts";
