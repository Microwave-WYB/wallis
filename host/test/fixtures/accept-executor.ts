// The executor module of the acceptance test: pi on pi-ai's faux provider,
// with one scripted "model" that decides from the conversation (not from
// call order), so it behaves the same in every host process. It answers
// the steps of fixtures/accept/workflow.ts:
//   ask       calls `ask`, then submits the reply
//   implicit  ends its turn without a result, then submits the message it gets
//   limit     runs codemode until a message says "finish"
//   slow      waits until the turn is aborted (interrupt), then submits the message
//   upload    calls the custom tool upload, then submits its result
//   flaky     submits (on a model the executor can serve)
//   fragile   gives up (an empty reply) unless restarted with a note
//   last      submits
// The model faux/broken fails as an executor error (HTTP 412). Unconfined
// (confine "off"): the fixture's tool processes run as plain processes.

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { PiExecutor } from "../../src/host/pi.ts";

type Msg = { role: string; content: unknown };
const text = (m: Msg | undefined): string =>
	m === undefined ? "" : typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
const clean = (s: string) => s.replace(/\s*\[Turn \d+ of \d+\]\s*$/, "").trim();
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
const submit = (ok: string) => call("submit_result", { ok });

function respond(context: { messages: Msg[] }, options: { signal?: AbortSignal } | undefined, _state: unknown, model: { id: string }) {
	if (model.id === "broken") return fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "HTTP 412 account suspended" });
	const messages = context.messages;
	let start = -1;
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user" && /"step": "\w+"/.test(text(messages[i]))) (start = i), (i = -1);
	const step = /"step": "(\w+)"/.exec(text(messages[start]))?.[1];
	const after = messages.slice(start + 1);
	const results = after.filter((m) => m.role === "toolResult");
	const replies = after.filter((m) => m.role === "user");
	switch (step) {
		case "ask":
			return results.length === 0 ? call("ask", { message: "Which colour should the sheet use?" }) : submit(clean(text(results.at(-1))));
		case "implicit":
			return replies.length === 0 ? fauxAssistantMessage("I could not decide between the warm and the cool variant.") : submit(clean(text(replies.at(-1))));
		case "limit":
			return replies.some((m) => text(m).includes("finish")) ? submit("finished") : call("codemode", { code: "return 1" });
		case "slow": {
			// After an interrupt the reply may join the step's own message (which ends with its input's "}"): its last line.
			const said = clean(text(messages.filter((m) => m.role === "user").at(-1))).split("\n").at(-1)!.replace(/^The human: /, "");
			if (replies.length > 0 || said !== "}") return submit(said);
			return new Promise((resolve) => {
				const done = () => resolve(fauxAssistantMessage("(stopped)"));
				if (options?.signal?.aborted) return done();
				options?.signal?.addEventListener("abort", done, { once: true });
				setTimeout(done, 60_000);
			});
		}
		case "upload":
			return results.length === 0 ? call("upload", { name: "sheet.jpg" }) : submit(clean(text(results.at(-1))));
		case "flaky":
			return submit("served");
		case "fragile":
			return text(messages[start]).includes("Operator note") ? submit("recovered") : fauxAssistantMessage("");
		case "last":
			return submit("done");
		default:
			return submit(`unknown step ${step}`);
	}
}

export default function create() {
	const provider = fauxProvider({ models: [{ id: "faux-1" }, { id: "broken" }] });
	provider.setResponses(Array.from({ length: 2000 }, () => respond as never));
	const models = createModels();
	models.setProvider(provider.provider);
	return { executor: new PiExecutor({ models, retryDelaysMs: [] }), confine: "off" as const };
}
