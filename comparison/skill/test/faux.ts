// pi-ai's faux provider: scripted model replies, no network, no cost.

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { type Models, setModels } from "../template/lib/agent.pi.ts";

export type Reply = ReturnType<typeof fauxAssistantMessage>;
/** What a scripted reply sees: the system prompt and the messages so far. */
export type Seen = { systemPrompt?: string; messages: { role: string; content: unknown }[] };

/** A faux model registry whose every request is answered by `route`. */
export function faux(route: (seen: Seen) => Reply, use: (models: Models) => void = setModels) {
	const provider = fauxProvider({ models: [{ id: "a" }, { id: "b" }, { id: "c" }] });
	const models = createModels();
	models.setProvider(provider.provider);
	const seen: Seen[] = [];
	provider.setResponses(
		Array.from({ length: 200 }, () => (ctx: unknown) => {
			const s = JSON.parse(JSON.stringify(ctx)) as Seen;
			// The system prompt arrives as a leading `system` message.
			const first = s.messages[0];
			if (s.systemPrompt === undefined && first?.role === "system") s.systemPrompt = String(first.content);
			seen.push(s);
			return route(s);
		}),
	);
	// The pi variant's registry (of this copy of lib/): its runAgent calls now go to the faux provider.
	use(models as unknown as Models);
	return { models: models as unknown as Models, provider, seen };
}

export const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
export const text = (t: string) => fauxAssistantMessage([fauxText(t)], { stopReason: "stop" });
export const error = (message: string) => fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: message });
/** The text of the newest message a request ended with. */
export const newest = (s: Seen) => JSON.stringify(s.messages.at(-1)?.content ?? "");
