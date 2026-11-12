// The film example's scripted agents (pi on pi-ai's faux provider; no model is ever called).
// One scripted "model", faux/scripted, plays the uploader or the grader, deciding from the
// conversation alone (never from call order), so it answers the same in every process, also after
// a resume.
//
// FAUX_UPLOADER_WAIT_GUIDANCE=1 makes the uploader wait for a guidance message before it reports.
// FAUX_UPLOADER_TURNS_PER_FILE=n makes the uploader check the album n-1 times before each upload
// (it then spends more turns).

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "../../src/testing.ts";

type Part = { type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Msg = { role: string; content: string | Part[]; toolCallId?: string; isError?: boolean };
const text = (m: Msg | undefined) => (m === undefined ? "" : typeof m.content === "string" ? m.content : m.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""));
const tools = (calls: [string, Record<string, unknown>][], say?: string) =>
	fauxAssistantMessage([...(say ? [fauxText(say)] : []), ...calls.map(([n, a]) => fauxToolCall(n, a as never))], { stopReason: "toolUse" });
const call = (name: string, args: Record<string, unknown>, say?: string) => tools([[name, args]], say);

/** Each tool call of the conversation with its result (if it has one yet). */
function history(messages: Msg[]) {
	const results = new Map(messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
	return messages
		.filter((m) => m.role === "assistant" && Array.isArray(m.content))
		.flatMap((m) => (m.content as Part[]).filter((p) => p.type === "toolCall"))
		.map((c) => ({ call: c, result: results.get(c.id) }));
}

/** The JSON object right after `Your input:`. */
function input(messages: Msg[]): Record<string, unknown> {
	const first = messages.find((m) => m.role === "user" && /Your input:/.test(text(m)));
	const t = text(first);
	const start = t.indexOf("{", t.indexOf("Your input:"));
	let depth = 0;
	for (let i = start; i < t.length; i++) {
		if (t[i] === "{") depth++;
		if (t[i] === "}" && --depth === 0) return JSON.parse(t.slice(start, i + 1));
	}
	throw new Error("no input");
}

/** Mailbox deliveries: each `[message <id> …]` header and the JSON body after it. */
function deliveries(messages: Msg[]): { id: string; body: unknown }[] {
	return messages
		.filter((m) => m.role === "user")
		.flatMap((m) => [...text(m).matchAll(/\[message (\S+) from [^\]]*\]\n(.*)/g)].map((x) => ({ id: x[1]!, body: JSON.parse(x[2]!) })));
}

type File = { name: string; digest: string };

function uploader(messages: Msg[]) {
	const { album, files } = input(messages) as { album: string; files: File[] };
	const done = history(messages).filter((d) => d.result !== undefined);
	const ok = new Set(done.filter((d) => d.call.name === "upload" && !d.result!.isError).map((d) => d.call.arguments!.name as string));
	const failures = done.filter((d) => d.call.name === "upload" && d.result!.isError);
	const guidance = deliveries(messages).map((d) => String(d.body));
	const last = done.at(-1);
	if (last?.call.name === "upload" && last.result!.isError) {
		const name = last.call.arguments!.name as string;
		if (/retry/i.test(text(last.result))) return call("upload", { album, name, digest: last.call.arguments!.digest }, `Upload of ${name} failed; the error says a retry can work, retrying.`);
	}
	const todo = files.find((f) => !ok.has(f.name));
	if (todo) {
		// Slow mode: check the album before each upload (costs turns).
		const per = Number(process.env.FAUX_UPLOADER_TURNS_PER_FILE ?? "1");
		const sinceUpload = done.length - 1 - done.map((d) => d.call.name).lastIndexOf("upload");
		if (per > 1 && sinceUpload < per - 1) return call("list", { album }, `Checking the album before uploading ${todo.name}.`);
		return call("upload", { album, name: todo.name, digest: todo.digest });
	}
	const listed = done.filter((d) => d.call.name === "list").at(-1);
	const lastUpload = done.map((d) => d.call.name).lastIndexOf("upload");
	if (!listed || done.indexOf(listed) < lastUpload) return call("list", { album }, "All files uploaded; listing the album to confirm.");
	// FAUX_UPLOADER_WAIT_GUIDANCE=1: with everything uploaded and listed, end the turn and wait for the
	// human's guidance (it arrives in the mailbox; the call waits for it) before returning.
	if (process.env.FAUX_UPLOADER_WAIT_GUIDANCE === "1" && guidance.length === 0) return fauxAssistantMessage([fauxText("All uploaded and listed; waiting for guidance before I report.")]);
	const body = text(listed.result);
	const inAlbum: File[] = JSON.parse(body.slice(0, body.lastIndexOf("}") + 1)).files;
	const confirmed = files.filter((f) => inAlbum.some((l) => l.name === f.name && l.digest === f.digest));
	const retried = failures.map((d) => d.call.arguments!.name as string);
	return call("submit_result", {
		result: {
			uploaded: confirmed.length,
			notes: `${confirmed.length}/${files.length} confirmed in ${album} by list. ${retried.length} failed attempt(s) retried: ${retried.join(", ") || "none"}.${guidance.length > 0 ? ` Guidance followed: ${guidance.join(" / ")}.` : ""}`,
		},
	});
}

/**
 * The grader: two jobs at once (the first send deliberately invalid: size 50 is under the minimum),
 * corrects it from the tool error, waits, looks at every render as it arrives, then returns.
 */
function grader(messages: Msg[]) {
	const { frames, start } = input(messages) as { frames: string[]; start: Record<string, string> };
	const all = history(messages);
	const sends = all.filter((d) => d.call.name === "send");
	const sent = sends.filter((d) => d.result && !d.result.isError);
	const got = deliveries(messages).filter((d) => typeof (d.body as { jpg?: unknown }).jpg === "object" || typeof (d.body as { error?: unknown }).error === "string");
	const read = new Set(all.filter((d) => d.call.name === "read").map((d) => d.call.arguments!.path as string));
	const warmer = { ...start, WB_SCALE: "[1.04,0.965,0.98]" };
	if (sends.length === 0) {
		// Several jobs before waiting; the first is invalid (size 50 < 100).
		return tools(
			[
				["send", { to: "renderer", message: { frame: frames[0], look: start, size: 50 } }],
				["send", { to: "renderer", message: { frame: frames[1] ?? frames[0], look: warmer, size: 400 } }],
			],
			"Rendering two frames to compare.",
		);
	}
	const rejected = sends.find((d) => d.result?.isError);
	if (rejected && sent.length < 2) return call("send", { to: "renderer", message: { ...(rejected.call.arguments!.message as object), size: 400 } }, "Size 50 is under the minimum; sending it again at 400.");
	for (const d of got) {
		const jpg = (d.body as { jpg?: { path: string } }).jpg;
		if (jpg && !read.has(jpg.path)) return call("read", { path: jpg.path }, `Looking at the render (${d.id}).`);
	}
	if (got.length < sent.length) return fauxAssistantMessage([fauxText(`Waiting for ${sent.length - got.length} more render(s).`)]);
	return call("submit_result", { result: { look: warmer, notes: `Looked at ${got.length} renders (${got.map((d) => d.id.split("/").at(-1)).join(", ")}); a slightly warmer balance matches the reference.` } });
}

function respond(context: { messages: Msg[] }) {
	const messages = context.messages.filter((m) => m.role !== "system");
	const system = JSON.stringify((context as { systemPrompt?: string; messages: unknown[] }).systemPrompt ?? context.messages.find((m) => m.role === "system") ?? "");
	return /reference image|grade a roll/i.test(system) ? grader(messages) : uploader(messages);
}

export default function create() {
	const provider = fauxProvider({ provider: "faux", models: [{ id: "scripted", contextWindow: 200_000 }] });
	provider.setResponses(Array.from({ length: 5000 }, () => respond as never));
	const models = createModels();
	models.setProvider(provider.provider);
	return { models };
}
