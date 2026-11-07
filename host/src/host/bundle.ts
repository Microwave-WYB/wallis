// Bundles a workflow.ts with its prompts, mcp.json and the SDK into one
// script for the sandbox. The workflow digest is the hash of that script,
// so it covers code, prompts and MCP config.

import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = resolve(here, "../sdk/index.ts");
const runtime = resolve(here, "../sdk/runtime.ts");
const nodeModules = resolve(here, "../../node_modules");

export interface Bundle {
	readonly code: string;
	readonly digest: string;
}

export async function bundleWorkflow(entry: string): Promise<Bundle> {
	const file = resolve(entry);
	const dir = dirname(file);
	const result = await build({
		stdin: {
			contents: `import wf from ${JSON.stringify(file)};\nimport { install } from ${JSON.stringify(runtime)};\ninstall(wf);\n`,
			resolveDir: dir,
			loader: "ts",
			sourcefile: "wallis-entry.ts",
		},
		absWorkingDir: dir,
		bundle: true,
		write: false,
		format: "iife",
		platform: "neutral",
		mainFields: ["module", "main"],
		conditions: ["import"],
		target: "es2022",
		alias: { wallis: sdk },
		nodePaths: [nodeModules],
		loader: { ".md": "text", ".json": "json" },
		legalComments: "none",
		logLevel: "silent",
	});
	const code = result.outputFiles[0]!.text;
	return { code, digest: `sha256:${createHash("sha256").update(code).digest("hex")}` };
}
