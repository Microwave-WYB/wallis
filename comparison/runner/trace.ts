// Read an arm's trajectory from its saved session files (written after
// every turn), so it works whether or not the host is running.
//
//   node trace.ts <arm> [last-n-messages=20] [phase=latest] [--full]

import { existsSync, readdirSync, readFileSync } from "node:fs";

const [arm = "a", nArg = "20", phaseArg, flag] = process.argv.slice(2);
const full = [phaseArg, flag].includes("--full");
const dir = new URL(`work/${arm}/sessions/`, import.meta.url).pathname;
if (!existsSync(dir)) {
	console.error(`no sessions for arm ${arm} yet`);
	process.exit(1);
}
const phases = readdirSync(dir).filter((f) => /^phase-\d+\.json$/.test(f)).map((f) => Number(f.match(/\d+/)![0])).sort((a, b) => a - b);
const phase = phaseArg && phaseArg !== "--full" ? Number(phaseArg) : phases.at(-1)!;
const { messages, turns } = JSON.parse(readFileSync(`${dir}phase-${phase}.json`, "utf8")) as { messages: Message[]; turns: number };

interface Message { role: string; content: Content[] | string; isError?: boolean; toolName?: string }
type Content = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown };

const clip = (s: string, n: number) => (full || s.length <= n ? s : `${s.slice(0, n)} …`);
console.log(`arm ${arm}, phase ${phase} of [${phases.join(", ")}], ${turns} turns, ${messages.length} messages\n`);
for (const m of messages.slice(-Number(nArg))) {
	const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
	for (const c of parts) {
		if (m.role === "assistant" && c.type === "thinking") console.log(`  think  ${clip(c.thinking ?? "", 400).replace(/\s+/g, " ")}`);
		else if (m.role === "assistant" && c.type === "text" && c.text?.trim()) console.log(`  say    ${clip(c.text, 400)}`);
		else if (m.role === "assistant" && c.type === "toolCall") {
			const args = c.arguments as Record<string, unknown>;
			const summary = c.name === "bash" ? String(args.command) : c.name === "write_file" ? `${args.path} (${String(args.content).length} chars)` : JSON.stringify(args);
			console.log(`  ${c.name?.padEnd(6)} ${clip(summary, 300).replace(/\n/g, "⏎ ")}`);
		} else if (m.role === "toolResult" && c.type === "text") console.log(`    ↳ ${m.isError ? "[error] " : ""}${clip(c.text ?? "", 240).replace(/\n/g, "⏎ ")}`);
		else if (m.role === "user" && c.type === "text") console.log(`  user   ${clip(c.text ?? "", 300).replace(/\n/g, "⏎ ")}`);
	}
}
