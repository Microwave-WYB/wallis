// Volumes in compose vocabulary: the parse, and the resolution's errors
// (each names the volume and what to fix).

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { namedVolumesDir, parseVolume, resolveVolumes, VolumeError } from "../src/host/volumes.ts";
import { tmp } from "./util.ts";

test("a volume string parses to a bind, a named volume, or an invalid one with its reason", () => {
	assert.deepEqual(parseVolume("./scripts:/scripts:ro"), { kind: "bind", host: "./scripts", target: "/scripts" });
	assert.deepEqual(parseVolume("~/data:/data:ro"), { kind: "bind", host: "~/data", target: "/data" });
	assert.deepEqual(parseVolume("dt-cache:/root/.cache/darktable"), { kind: "named", name: "dt-cache", target: "/root/.cache/darktable" });
	const reason = (text: string) => {
		const v = parseVolume(text);
		return v.kind === "invalid" ? v.reason : null;
	};
	assert.match(reason("./scripts:/scripts")!, /needs its mode/);
	assert.match(reason("./scripts:/scripts:rw")!, /only :ro exists/);
	assert.match(reason("/etc:/etc2:ro")!, /relative/);
	assert.match(reason("./scripts:scripts:ro")!, /absolute/);
	assert.match(reason("a:b:c:d")!, /<host path>:<target>:ro or <name>:<target>/);
});

const refusal = (texts: string[], dir: string, stores: string[] = []) => {
	try {
		resolveVolumes(texts, dir, { stores });
		return null;
	} catch (error) {
		if (error instanceof VolumeError) return error.message;
		throw error;
	}
};

test("targets that overlap a dir the sandbox owns, or each other, are refused with the volume named", () => {
	const dir = tmp();
	mkdirSync(join(dir, "scripts"));
	for (const target of ["/usr", "/usr/local/share", "/lib64", "/proc", "/dev/dri", "/in", "/w/x", "/tmp", "/run/wallis/env", "/run", "/"]) {
		assert.match(refusal([`./scripts:${target}:ro`], dir) ?? "", /owns/, target);
	}
	assert.equal(refusal(["./scripts:/scripts:ro", "c:/scripts/cache"], dir), "volume c:/scripts/cache: the target overlaps the volume at /scripts");
	assert.match(refusal(["./scripts:/a/../usr:ro"], dir) ?? "", /plain absolute path/);
	assert.match(refusal(["./scripts:/scripts/:ro"], dir) ?? "", /plain absolute path/);
	assert.match(refusal(["./scripts:/scripts:rw"], dir) ?? "", /only :ro exists/);
	assert.equal(refusal(["./scripts:/scripts:ro", "./scripts:/opt/x:ro"], dir), null);
});

test("a bind resolves against the workflow dir or ~/; its host dir must exist; a named volume is wallis's", () => {
	const dir = tmp();
	mkdirSync(join(dir, "scripts"));
	const [bind, named] = resolveVolumes(["./scripts:/s:ro", "cache:/c"], dir);
	assert.deepEqual(bind, { kind: "bind", target: "/s", dir: join(dir, "scripts") });
	assert.deepEqual(named, { kind: "named", target: "/c", dir: join(namedVolumesDir(dir), "cache"), name: "cache" });
	assert.match(refusal(["./missing:/m:ro"], dir) ?? "", /does not exist/);
	assert.equal(resolveVolumes(["~/:/home-ro:ro"], dir)[0]!.dir, homedir());
	assert.match(refusal(["./:/p:ro"], dir, [join(dir, ".wallis")]) ?? "", /wallis's own/);
});
