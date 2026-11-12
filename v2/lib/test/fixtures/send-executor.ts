// A scripted worker for detached runs (no model is called), deciding from the conversation alone:
// it sends one job to `renderer`, waits, and submits the reply it got (or, when the send was
// rejected because the renderer is closed, says so).

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "../../src/testing.ts";

type Part = { type: string; text?: string; name?: string };
type Msg = { role: string; content: string | Part[]; isError?: boolean; toolName?: string };
const text = (m: Msg) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(""));
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

function respond(context: { messages: Msg[] }) {
	const messages = context.messages.filter((m) => m.role !== "system");
	const reply = messages.map((m) => /arrived in your mailbox/.test(text(m)) && /"result":"([^"]+)"/.exec(text(m))).find(Boolean);
	if (reply) return call("submit_result", { result: { got: reply[1] } });
	const sendResult = messages.filter((m) => m.role === "toolResult" && m.toolName === "send").at(-1);
	if (sendResult?.isError && /closed/.test(text(sendResult))) return call("submit_result", { result: { got: "closed" } });
	if (sendResult) return fauxAssistantMessage([fauxText("Waiting for the render.")]);
	return call("send", { to: "renderer", message: { frame: "2835" } });
}

export default function create() {
	const provider = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 200_000 }] });
	provider.setResponses(Array.from({ length: 200 }, () => respond as never));
	const models = createModels();
	models.setProvider(provider.provider);
	return { models };
}
