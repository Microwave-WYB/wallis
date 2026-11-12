// The chat acceptance's scripted assistant (pi's faux provider; no model is called). It decides from
// the conversation alone, so it answers the same in any process:
//   no message yet          -> ends its turn (it waits for the user);
//   "append <text>"         -> a progress note, then bash `echo <text> >> README.md`, then "done";
//   several messages at once -> says how many arrived together;
//   "bye"                   -> returns a summary.

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "../../src/testing.ts";

type Part = { type: string; text?: string; name?: string; arguments?: Record<string, unknown> };
type Msg = { role: string; content: string | Part[] };
const text = (m: Msg) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(""));
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
const send = (message: string) => call("send", { to: "user", message });

function respond(context: { messages: Msg[] }) {
	const messages = context.messages.filter((m) => m.role !== "system");
	const lastUser = messages.map((m, i) => [m, i] as const).filter(([m]) => m.role === "user" && /arrived in your mailbox/.test(text(m))).at(-1);
	if (!lastUser) return fauxAssistantMessage([fauxText("Ready when you are.")]);
	const [m, at] = lastUser;
	const bodies = [...text(m).matchAll(/\[message [^\]]+\]\n(.*)/g)].map((x) => JSON.parse(x[1]!) as string);
	const after = messages.slice(at + 1).flatMap((x) => (x.role === "assistant" && Array.isArray(x.content) ? (x.content as Part[]).filter((p) => p.type === "toolCall") : []));
	const did = (name: string) => after.some((c) => c.name === name);
	if (bodies.includes("bye")) return call("submit_result", { result: { summary: "Appended to README.md as asked." } });
	if (bodies.length > 1 && !did("send")) return send(`${bodies.length} messages arrived together: ${bodies.join(" + ")}`);
	const append = bodies.find((b) => b.startsWith("append "));
	if (append && !did("send")) return send(`working on: ${append}`);
	if (append && !did("bash")) return call("bash", { command: `echo ${JSON.stringify(append.slice(7))} >> README.md && git --version >/dev/null && cat README.md` });
	if (append && after.filter((c) => c.name === "send").length < 2) return send("done: appended");
	return fauxAssistantMessage([fauxText("Waiting for the next message.")]);
}

export default function create() {
	const provider = fauxProvider({ provider: "faux", models: [{ id: "chat", contextWindow: 200_000 }] });
	provider.setResponses(Array.from({ length: 500 }, () => respond as never));
	const models = createModels();
	models.setProvider(provider.provider);
	return { models };
}
