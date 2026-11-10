// A hostile racer for the TOCTOU escape tests: given an upper dir, it swaps an
// intermediate path component `<upper>/a` between a real directory (holding a
// decoy file) and a symlink to an out-of-sandbox directory, as fast as it can.
// It stands in for an agent's own `bash`, which shares the `/w` upper dir with
// the host file tools and can create/rename symlinks there concurrently.
//
// Usage: node swap-racer.mjs <upperDir> <outsideDir> <decoyName>
// The real dir and the symlink are pre-staged as hidden siblings so each flip
// is a single rename(2), keeping the swap window maximally wide.

import { mkdirSync, writeFileSync, symlinkSync, renameSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const [, , up, outside, decoy] = process.argv;
const a = join(up, "a");
const realDir = join(up, ".a-real");
const linkDir = join(up, ".a-link");

rmSync(realDir, { recursive: true, force: true });
rmSync(linkDir, { force: true });
mkdirSync(realDir, { recursive: true });
writeFileSync(join(realDir, decoy), "INSIDE-THE-SANDBOX\n");
symlinkSync(outside, linkDir);
// Begin with the real directory in place at `a`.
try {
	renameSync(realDir, a);
	renameSync(a, realDir);
} catch {
	// ignore
}

for (;;) {
	try {
		renameSync(realDir, a); // a := real dir (decoy file visible)
		renameSync(a, realDir);
		renameSync(linkDir, a); // a := symlink -> outside
		renameSync(a, linkDir);
	} catch {
		// a races with the reader; keep flipping
	}
}
