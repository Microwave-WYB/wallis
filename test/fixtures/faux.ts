// The executor module of the agent tests: pi on pi-ai's faux provider, so no
// model is ever called. Tests script it with `faux.setResponses`; the run
// loads this same module (by its path in .wallis/config.json), so the
// script and the run share it.

import { createModels, fauxProvider } from "../../src/testing.ts";

export const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 200_000 }] });

export default function create() {
	const models = createModels();
	models.setProvider(faux.provider);
	return { models };
}

type Part = { type: string; text?: string };
/** A message's text, whatever its shape. */
export function text(m: unknown): string {
	const c = (m as { content?: unknown })?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return (c as Part[]).map((p) => p.text ?? "").join("");
	return "";
}

/** The messages a faux response factory sees (system messages left out). */
export function messages(context: unknown): { role: string; isError?: boolean; content?: unknown }[] {
	return ((context as { messages?: { role: string }[] }).messages ?? []).filter((m) => m.role !== "system");
}
