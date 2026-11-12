// Copies the Gleam core's JavaScript build (core/build/dev/javascript) into core/dist, which ships
// in the package, so installing wallis never needs Gleam. Tests and the build tool's own files are
// left out. Run after `gleam build` (mise run build does both).
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const core = join(dirname(fileURLToPath(import.meta.url)), "..", "core");
const from = join(core, "build", "dev", "javascript");
const to = join(core, "dist");
if (!existsSync(join(from, "wallis_core", "wallis_core.mjs"))) throw new Error("build the core first: cd core && gleam build");
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
const skip = (name) => /(^|_)test\.|^support\.|^_gleam_artefacts$|^gleam@@|\.cache/.test(name);
for (const pkg of ["wallis_core", "gleam_stdlib", "gleam_json"]) {
	cpSync(join(from, pkg), join(to, pkg), { recursive: true, filter: (src) => !skip(src.split("/").at(-1)) });
}
for (const f of readdirSync(from)) if (/^prelude\.(d\.)?m?ts$|^prelude\.mjs$/.test(f)) cpSync(join(from, f), join(to, f));
console.log(`core/dist: ${readdirSync(to).join(", ")}`);
