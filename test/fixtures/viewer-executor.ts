// A scripted viewer for detached runs (no model is called), deciding from the conversation alone:
// it asks the renderer for an image, waits, reads the file that arrives in its mailbox, and
// returns what the file says. A read cut off by a stop is made again.

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "../../src/testing.ts";

type Msg = { role: string; content: string | { type: string; text?: string }[]; isError?: boolean; toolName?: string };
const text = (m: Msg) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(""));
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

function respond(context: { messages: Msg[] }) {
	const messages = context.messages.filter((m) => m.role !== "system");
	const delivery = messages.map((m) => /arrived in your mailbox/.test(text(m)) && /"path":"([^"]+)"/.exec(text(m))).find(Boolean);
	const reads = messages.filter((m) => m.role === "toolResult" && m.toolName === "read");
	const last = reads.at(-1);
	if (last && !last.isError) return call("submit_result", { result: { seen: text(last).split("\n")[0]!.trim() } });
	if (last?.isError && !/stopped while/.test(text(last))) return call("submit_result", { result: { seen: `unreadable: ${text(last).slice(0, 120)}` } });
	if (delivery) return call("read", { path: delivery[1] });
	if (messages.some((m) => m.role === "toolResult" && m.toolName === "send")) return fauxAssistantMessage([fauxText("Waiting for the image.")]);
	return call("send", { to: "renderer", message: { frame: "2835" } });
}

export default function create() {
	const provider = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 200_000 }] });
	provider.setResponses(Array.from({ length: 200 }, () => respond as never));
	const models = createModels();
	models.setProvider(provider.provider);
	return { models };
}
