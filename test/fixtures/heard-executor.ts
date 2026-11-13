// A scripted agent for detached runs (no model is called): it submits { heard: "nothing" } at once.

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "../../src/testing.ts";

export default function create() {
	const provider = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 200_000 }] });
	provider.setResponses(Array.from({ length: 50 }, () => () => fauxAssistantMessage([fauxToolCall("submit_result", { result: { heard: "nothing" } } as never)], { stopReason: "toolUse" })));
	const models = createModels();
	models.setProvider(provider.provider);
	return { models };
}
