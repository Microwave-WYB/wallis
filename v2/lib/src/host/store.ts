// The project's content-addressed store, shared by every run of the project
// (docs/v2.md §5.4), so one run's output artifacts and Trees can be another
// run's input without copying:
//
//   <root>/.wallis/store/blobs/<hex>         one read-only file per distinct content:
//                                            artifacts, and values the logs name (dialogues)
//   <root>/.wallis/store/layers/<hex>/       a layer (see layers.ts); a Tree is a stack of them
//   <root>/.wallis/store/layers/<hex>.json   its manifest; <hex> is the manifest's sha256
//   <root>/.wallis/store/hashes.json         a cache: file sha256 by (path, size, mtime)
//
// Every object is written whole (a temp file or dir, then a rename) before
// the event that names it. Ingesting moves a file or dir when its source is
// discardable (a command's scratch dir: no copy at all); otherwise it is
// copied with `cp --reflink=auto`, a reflink where the filesystem has them.
// Nothing is evicted implicitly: `prune` deletes what no run's log names.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { crashPoint } from "./faults.ts";
import { commitLayer, digestOf, hashFile, layerDir, layersDir, manifestOf, removeWork, syncPath, writeDurably } from "./layers.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DIGESTS = /sha256:[0-9a-f]{64}/g;

export function isDigest(value: unknown): value is string {
	return typeof value === "string" && DIGEST.test(value);
}

const hex = (digest: string) => digest.slice("sha256:".length);

export class StoreError extends Error {
	override readonly name = "StoreError";
}

export class Store {
	/** `<root>/.wallis/store`. */
	readonly dir: string;
	#hashes: Record<string, string> | null = null;
	#dirty = false;

	constructor(root: string) {
		this.dir = join(resolve(root), ".wallis", "store");
	}

	get blobs(): string {
		return join(this.dir, "blobs");
	}

	blobPath(digest: string): string {
		if (!isDigest(digest)) throw new StoreError(`not a digest: ${digest}`);
		return join(this.blobs, hex(digest));
	}

	hasBlob(digest: string): boolean {
		return isDigest(digest) && existsSync(this.blobPath(digest));
	}

	layerDir(digest: string): string {
		if (!isDigest(digest)) throw new StoreError(`not a digest: ${digest}`);
		return layerDir(this.dir, digest);
	}

	hasLayer(digest: string): boolean {
		return isDigest(digest) && existsSync(this.layerDir(digest)) && existsSync(`${this.layerDir(digest)}.json`);
	}

	#temp(): string {
		mkdirSync(this.blobs, { recursive: true });
		return join(this.blobs, `.in-${process.pid}-${randomBytes(4).toString("hex")}`);
	}

	/** Puts `temp` (a whole file) at its digest's path, read-only; drops it if the store has that content. */
	#settle(temp: string, digest: string): string {
		const target = this.blobPath(digest);
		if (existsSync(target)) rmSync(temp, { force: true });
		else {
			// chmod also sets the ctime `prune` reads as the time it entered the store.
			chmodSync(temp, 0o444);
			syncPath(temp);
			renameSync(temp, target);
			syncPath(this.blobs);
			crashPoint("blob");
		}
		return digest;
	}

	/** A value a log will name (a dialogue, say), as a blob. Returns its digest. */
	putText(text: string): string {
		const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
		if (this.hasBlob(digest)) return digest;
		const temp = this.#temp();
		writeFileSync(temp, text);
		return this.#settle(temp, digest);
	}

	/** A blob's text, or null when the store does not have it. */
	readText(digest: string): string | null {
		return this.hasBlob(digest) ? readFileSync(this.blobPath(digest), "utf8") : null;
	}

	/**
	 * A regular file, as a blob. `move`: its source is discardable (a
	 * command's scratch dir, on the store's filesystem) and is renamed into
	 * the store; otherwise it is copied, by reflink where possible, and the
	 * source is left alone.
	 */
	ingestFile(path: string, options: { readonly move: boolean }): string {
		const st = lstatSync(path);
		if (!st.isFile()) throw new StoreError(`${path} is not a regular file`);
		if (options.move) {
			const digest = `sha256:${hashFile(path)}`;
			const temp = this.#temp();
			try {
				renameSync(path, temp);
			} catch (error) {
				// Another filesystem: copy instead.
				if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
				return this.ingestFile(path, { move: false });
			}
			return this.#settle(temp, digest);
		}
		const digest = `sha256:${this.hashOf(path)}`;
		if (this.hasBlob(digest)) return digest;
		const temp = this.#temp();
		copy(path, temp);
		return this.#settle(temp, digest);
	}

	/**
	 * A directory, as a one-layer Tree. `move`: the dir is discardable and is
	 * renamed into the store; otherwise it is copied (reflinks), and only
	 * files whose (path, size, mtime) changed since the last ingest are
	 * hashed again.
	 */
	ingestTree(dir: string, options: { readonly move: boolean }): string[] {
		if (!statSync(dir).isDirectory()) throw new StoreError(`${dir} is not a directory`);
		mkdirSync(layersDir(this.dir), { recursive: true });
		if (options.move) {
			const digest = commitLayer(this.dir, { upper: dir }, null, 1, { overlay: false });
			this.#flush();
			return digest === null ? [] : [digest];
		}
		const manifest = manifestOf(dir, (p) => this.hashOf(p), false);
		this.#flush();
		if (Object.keys(manifest).length === 0) return [];
		const { digest, text } = digestOf(manifest);
		const target = layerDir(this.dir, digest);
		if (existsSync(target) && existsSync(`${target}.json`)) return [digest];
		const temp = `${target}.${process.pid}.tmp`;
		rmSync(temp, { recursive: true, force: true });
		copy(dir, temp);
		// The copy is checked against the manifest it is named by: the source may have changed meanwhile.
		const copied = digestOf(manifestOf(temp, hashFile, false)).digest;
		if (copied !== digest) {
			removeWork(temp);
			throw new StoreError(`${dir} changed while it was being ingested`);
		}
		if (!existsSync(`${target}.json`)) writeDurably(`${target}.json`, text);
		if (existsSync(target)) removeWork(temp);
		else renameSync(temp, target);
		syncPath(layersDir(this.dir));
		return [digest];
	}

	// --- The hash cache ------------------------------------------------------------

	/** sha256 (hex) of a file, from the cache while its real path, size and mtime are unchanged. */
	hashOf(path: string): string {
		const st = statSync(path, { bigint: true });
		const key = `${realpathSync(path)}\0${st.size}\0${st.mtimeNs}`;
		const hashes = this.#cache();
		let h = hashes[key];
		if (h === undefined) {
			h = hashFile(path);
			hashes[key] = h;
			this.#dirty = true;
		}
		return h;
	}

	#cache(): Record<string, string> {
		if (this.#hashes === null) {
			try {
				const raw: unknown = JSON.parse(readFileSync(join(this.dir, "hashes.json"), "utf8"));
				this.#hashes = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
			} catch {
				this.#hashes = {};
			}
		}
		return this.#hashes;
	}

	#flush(): void {
		if (!this.#dirty || this.#hashes === null) return;
		try {
			mkdirSync(this.dir, { recursive: true });
			const temp = join(this.dir, `.hashes-${process.pid}-${randomBytes(4).toString("hex")}`);
			writeFileSync(temp, JSON.stringify(this.#hashes));
			renameSync(temp, join(this.dir, "hashes.json"));
			this.#dirty = false;
		} catch {
			// The cache only saves time; digests never depend on it.
		}
	}

	// --- Prune -----------------------------------------------------------------------

	/**
	 * Deletes every blob and layer that no run's log names, directly or
	 * through a blob that names it (a dialogue delta names its base). An
	 * object that entered the store after `since` is kept: a live run may
	 * have written it before the event that will name it.
	 */
	prune(logs: readonly string[], since: number | null): { blobs: number; layers: number; bytes: number } {
		const live = new Set<string>();
		const pending: string[] = [];
		const mark = (text: string) => {
			for (const d of text.match(DIGESTS) ?? []) if (!live.has(d)) (live.add(d), pending.push(d));
		};
		for (const log of logs) if (existsSync(log)) mark(readFileSync(log, "utf8"));
		while (pending.length > 0) {
			const d = pending.pop()!;
			const path = join(this.blobs, hex(d));
			// Only small blobs can be values that name others (dialogues); artifacts are data.
			if (existsSync(path) && statSync(path).size < 64 << 20) {
				const text = readFileSync(path).toString("latin1");
				if (text.includes("sha256:")) mark(text);
			}
		}
		const young = (path: string) => since !== null && lstatSync(path).ctimeMs >= since;
		let blobs = 0;
		let layers = 0;
		let bytes = 0;
		if (existsSync(this.blobs)) {
			for (const name of readdirSync(this.blobs)) {
				const path = join(this.blobs, name);
				if (name.startsWith(".") || live.has(`sha256:${name}`) || young(path)) continue;
				bytes += lstatSync(path).size;
				rmSync(path, { force: true });
				blobs++;
			}
		}
		const ldir = layersDir(this.dir);
		if (existsSync(ldir)) {
			for (const name of readdirSync(ldir)) {
				if (!/^[0-9a-f]{64}$/.test(name)) continue;
				const path = join(ldir, name);
				if (live.has(`sha256:${name}`) || young(`${path}.json`)) continue;
				bytes += duBytes(path);
				removeWork(path);
				rmSync(`${path}.json`, { force: true });
				layers++;
			}
		}
		return { blobs, layers, bytes };
	}
}

/** `cp -a --reflink=auto`: a reflink where the filesystem has them, else a plain copy. */
function copy(from: string, to: string): void {
	const r = spawnSync("cp", ["-a", "--reflink=auto", "--no-target-directory", from, to], { encoding: "utf8" });
	if (r.status !== 0) {
		rmSync(to, { recursive: true, force: true });
		throw new StoreError(`cannot copy ${from} into the store: ${r.stderr.trim()}`);
	}
}

function duBytes(path: string): number {
	let total = 0;
	const walk = (p: string) => {
		const st = lstatSync(p);
		if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
		else total += st.size;
	};
	walk(path);
	return total;
}
