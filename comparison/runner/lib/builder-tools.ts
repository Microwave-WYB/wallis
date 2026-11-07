// Tools for a coding agent confined to a sandbox. Paths are sandbox paths:
// /work is the agent's writable dir; the read-only binds (e.g.
// /mnt/siderius) can be read but never written. bash runs inside bwrap
// with no network; file tools resolve the sandbox path to the host path
// and refuse anything outside those roots (symlinks included).

import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import Type from "typebox";
import { type Box, sandboxed } from "./sandbox.ts";
import { type Tool, tool } from "./tool.ts";

const CAP = 16_000;

function cap(text: string): string {
	if (text.length <= CAP) return text;
	const head = text.slice(0, CAP / 2);
	const tail = text.slice(-CAP / 2);
	return `${head}\n\n[... ${text.length - CAP} characters cut; redirect to a file under /work and read parts of it ...]\n\n${tail}`;
}

export interface BuilderBox extends Box {
	/** Extra PATH entries inside the sandbox, e.g. /opt/node/bin. */
	readonly path?: readonly string[];
}

export function builderTools(box: BuilderBox, log: (line: string) => void): Tool[] {
	const roots: [string, string, boolean][] = [["/work", box.work, true], ...Object.entries(box.ro).map(([host, inside]) => [inside, host, false] as [string, string, boolean])];

	/** Sandbox path -> host path, or an error. */
	function host(path: string, write: boolean): string {
		const abs = resolve("/work", path);
		for (const [inside, root, writable] of roots) {
			if (abs !== inside && !abs.startsWith(`${inside}/`)) continue;
			if (write && !writable) throw new Error(`${path} is read-only`);
			const target = resolve(root, relative(inside, abs));
			// Resolve symlinks of the nearest existing ancestor and require it to stay under the root.
			let probe = target;
			for (;;) {
				try {
					const real = realpathSync(probe);
					const realRoot = realpathSync(root);
					if (real !== realRoot && !real.startsWith(`${realRoot}/`)) throw new Error(`${path} escapes ${inside}`);
					break;
				} catch (e) {
					if (e instanceof Error && e.message.includes("escapes")) throw e;
					const up = dirname(probe);
					if (up === probe) break;
					probe = up;
				}
			}
			return target;
		}
		throw new Error(`${path} is outside /work and the read-only mounts (${roots.map((r) => r[0]).join(", ")})`);
	}

	const env = { PATH: [...(box.path ?? []), "/usr/bin", "/bin"].join(":"), HOME: "/work/.home", LANG: "C.UTF-8", ...box.env };

	return [
		tool({
			name: "bash",
			description:
				"Run a bash command in the sandbox (cwd /work, no network, 10-minute limit). Output is capped at 16k characters; redirect long output to a file.",
			parameters: Type.Object({ command: Type.String() }),
			execute: async ({ command }) => {
				log(`bash: ${command.slice(0, 200).replace(/\n/g, "⏎")}`);
				const r = await sandboxed(["bash", "-c", command], { ...box, env, timeoutMs: box.timeoutMs ?? 600_000 });
				return { text: cap(`exit ${r.code}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`), isError: r.code !== 0 };
			},
		}),
		tool({
			name: "read_file",
			description: "Read a text file (under /work or a read-only mount). Lines are numbered; use offset and limit for large files.",
			parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }),
			execute: async ({ path, offset, limit }) => {
				log(`read: ${path}`);
				try {
					const lines = readFileSync(host(path, false), "utf8").split("\n");
					const from = (offset ?? 1) - 1;
					const to = Math.min(lines.length, from + (limit ?? 400));
					const body = lines.slice(from, to).map((l, i) => `${String(from + i + 1).padStart(5)}  ${l}`).join("\n");
					return { text: cap(`${body}${to < lines.length ? `\n[... ${lines.length - to} more lines; use offset=${to + 1}]` : ""}`) };
				} catch (e) {
					return { text: String(e instanceof Error ? e.message : e), isError: true };
				}
			},
		}),
		tool({
			name: "write_file",
			description: "Create or overwrite a file under /work.",
			parameters: Type.Object({ path: Type.String(), content: Type.String() }),
			execute: async ({ path, content }) => {
				log(`write: ${path} (${content.length} chars)`);
				try {
					const target = host(path, true);
					mkdirSync(dirname(target), { recursive: true });
					writeFileSync(target, content);
					return { text: `wrote ${path}` };
				} catch (e) {
					return { text: String(e instanceof Error ? e.message : e), isError: true };
				}
			},
		}),
		tool({
			name: "edit_file",
			description: "Replace exact text in a file under /work. old must occur exactly once unless all is true.",
			parameters: Type.Object({ path: Type.String(), old: Type.String(), new: Type.String(), all: Type.Optional(Type.Boolean()) }),
			execute: async ({ path, old, new: replacement, all }) => {
				log(`edit: ${path}`);
				try {
					const target = host(path, true);
					if (!statSync(target).isFile()) throw new Error(`${path} is not a file`);
					const text = readFileSync(target, "utf8");
					const count = text.split(old).length - 1;
					if (count === 0) throw new Error("old text not found");
					if (count > 1 && !all) throw new Error(`old text occurs ${count} times; make it unique or set all`);
					writeFileSync(target, all ? text.split(old).join(replacement) : text.replace(old, replacement));
					return { text: `edited ${path} (${all ? count : 1} replacement${count > 1 && all ? "s" : ""})` };
				} catch (e) {
					return { text: String(e instanceof Error ? e.message : e), isError: true };
				}
			},
		}),
	];
}
