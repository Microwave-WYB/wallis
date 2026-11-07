// Context control: codemode for large inputs (the model writes a small
// script against the data instead of reading it), and capped tool results
// with a pointer to the full text in work/. pi-codemode runs the script in
// QuickJS; the tool itself is SDK-neutral.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodemodeSandbox, type CodemodeTool, renderDeclarations } from "@earendil-works/pi-codemode";
import Type from "typebox";
import { type Tool, tool } from "../template/lib/tool.ts";

/** Cuts text at `cap`, saving the whole of it in work/ and saying where. */
export function capped(text: string, cap: number, file: string): string {
	if (text.length <= cap) return text;
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, text);
	return `${text.slice(0, cap)}\n[truncated: ${text.length} chars; the full text is ${file}]`;
}

/**
 * A `codemode` tool: the model sends JavaScript that runs in QuickJS (no fs,
 * no network) with the full data as `input` and the given tools as
 * `tools.<name>(args)`. Only what the script returns enters the context.
 */
export function codemodeTool(data: unknown, tools: CodemodeTool[], cap = 8_000, spill = "work/spill.txt"): Tool {
	return tool({
		name: "codemode",
		description: [
			"Run a JavaScript async function body. The full input is the variable `input`; return a small value.",
			renderDeclarations({ tools }),
		].join("\n\n"),
		parameters: Type.Object({ code: Type.String() }),
		execute: async ({ code }, signal) => {
			const sandbox = new CodemodeSandbox({ tools });
			try {
				const r = await sandbox.execute(`const input = load("input");\n${code}`, { signal, store: { input: data } });
				const text = r.ok ? JSON.stringify(r.value ?? null) : (r.error.stack ?? r.error.message);
				return { text: capped(text, cap, spill), isError: !r.ok };
			} finally {
				await sandbox.close();
			}
		},
	});
}
