// A film-style workflow on tiny synthetic scans (stdlib python3 only): colour-negative rolls,
// scanned as two halves per frame, to previews or finals. The shape of the owner's real film
// workflow (darktable, Hugin, 33 MP frames), with the heavy work replaced by toy image scripts in
// ./scripts, so it runs anywhere bubblewrap does (test/film.test.ts runs it end to end).
//
// Four workflows, all plain values:
//   negatives  stage 1, run once per roll: measurements and the stitched negatives;
//   develop    stage 2, run many times: previews (plus a contact sheet) or finals for a look;
//   deliver    develop's finals, then an uploader agent; naming the album is the approval;
//   grade      an agent that drives a render actor until the frames match a reference.
//
// Reuse is explicit: `negatives` returns its negatives as artifacts, and every later run takes
// them as input. Nothing is cached across runs; within one run, resume skips finished calls.

import { readFileSync } from "node:fs";
import { Address, agent, Artifact, command, NodeFailed, sandbox, toolset, Tree, Type, workflow, type Static } from "wallis";

const text = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/** At most `n` calls at once, results in input order. Plain code: wallis has no queue. */
async function pool<T, R>(items: readonly T[], n: number, f: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await f(items[i]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
	return out;
}

// --- Sandboxes ----------------------------------------------------------------------------------

// The real workflow requires darktable-cli, exiv2 and nona here; this one needs python3 alone.
const film = (stage: "stage1" | "stage2") => sandbox({ requires: ["python3"], volumes: ["./scripts/lib:/film/lib:ro", `./scripts/${stage}:/film/${stage}:ro`] });
const stage1 = film("stage1");
const stage2 = film("stage2");
const py = (script: string, ...args: string[]) => ["python3", "-s", "-E", `/film/${script}`, ...args];

// --- Values ---------------------------------------------------------------------------------------

const Rgb = Type.Array(Type.Number(), { minItems: 3, maxItems: 3 });
/** A look, as the scripts read it (strings, as the real workflow's env names are). */
export const Look = Type.Object({
	BLACK_SHIFT_D: Type.String(),
	NEG_GAMMA: Type.String(),
	DMIN_SCALE: Type.String(),
	WB_SCALE: Type.String(),
	CBRGB: Type.String(),
	NEG_EXPOSURE: Type.Optional(Type.String()),
	NEG_BLACK: Type.Optional(Type.String()),
});
type Look = Static<typeof Look>;
const Patch = Type.Partial(Look);
const Image = Artifact("image/png");
const Crop = Type.Object({ angle: Type.Number(), box: Type.Array(Type.Number(), { minItems: 4, maxItems: 4 }) });

/** The roll's metadata, parsed by the caller from the roll directory's JSON files. Plain data. */
export const RollMeta = Type.Object({
	/** Frame number ("0001") and its two halves' scan file names. */
	frames: Type.Array(Type.Object({ frame: Type.String(), halves: Type.Tuple([Type.String(), Type.String()]), crop: Crop })),
	/** The unexposed-film scan, inside the roll Tree ("base/DSC_0000.pgm"). */
	base: Type.String(),
	exif: Type.Record(Type.String(), Type.String()),
});

/** One stitched frame and what stage 2 needs from stage 1 for it. */
const Neg = Type.Object({ frame: Type.String(), negative: Artifact("image/x-portable-graymap"), lo: Rgb, dto: Type.String() });
type Neg = Static<typeof Neg>;
/** Stage 1's product: every frame's negative plus the roll-wide measurements. */
export const Negs = Type.Object({ frames: Type.Array(Neg), dmin: Rgb, ratio: Rgb, exif: Type.Record(Type.String(), Type.String()) });
type Negs = Static<typeof Negs>;

// --- Stage 1 commands (stdout is JSON unless `parse` says otherwise) ------------------------------

/** A "linear render" of one scan: its range, its mean, its capture date. */
const linear = command({
	sandbox: stage1,
	input: Type.Object({ in: Tree(), file: Type.String() }),
	output: Type.Object({ lo: Rgb, hi: Rgb, centre: Rgb, dto: Type.String() }),
	run: (i) => py("stage1/linear.py", `${i.in.path}/${i.file}`),
});

/** Each pair's density range and the roll's channel ratios, from the base Dmin and every half's lo. */
const measureRoll = command({
	sandbox: stage1,
	input: Type.Object({ dmin: Rgb, pairs: Type.Array(Type.Object({ frame: Type.String(), a: Rgb, b: Rgb })) }),
	output: Type.Object({ ratio: Rgb, lo: Type.Record(Type.String(), Rgb) }),
	run: (i) => py("stage1/measure_roll.py", JSON.stringify(i)),
});

/** Both halves stitched with the saved alignment, then cropped (in the real workflow: darktable, nona; near 4 GB). */
const stitch = command({
	sandbox: stage1,
	input: Type.Object({ raw: Tree(), roll: Tree(), frame: RollMeta.properties.frames.items }),
	output: Type.Object({ negative: Artifact("image/x-portable-graymap") }),
	run: ({ raw, roll, frame: f }) =>
		py("stage1/stitch.py", `${raw.path}/${f.halves[0]}`, `${raw.path}/${f.halves[1]}`, `${roll.path}/pto/f${f.frame}.pto`, JSON.stringify(f.crop), "neg.pgm"),
	parse: (r) => ({ negative: r.file("neg.pgm") }),
});

// --- Stage 2 commands -----------------------------------------------------------------------------

const render = command({
	sandbox: stage2,
	input: Type.Object({
		neg: Neg,
		look: Look,
		dmin: Rgb,
		ratio: Rgb,
		/** A preview size in px, or a full-resolution final with these EXIF tags. */
		mode: Type.Union([Type.Object({ preview: Type.Integer() }), Type.Object({ final: Type.Record(Type.String(), Type.String()) })]),
	}),
	output: Type.Object({ jpg: Image }),
	// The pair's density range (`lo`) is a render parameter; each image is named by its frame.
	run: ({ neg, ...rest }) => py("stage2/render.py", neg.negative.path, JSON.stringify({ ...rest, lo: neg.lo }), `DSC_${neg.frame}.png`),
	parse: (r, i) => ({ jpg: r.file(`DSC_${i.neg.frame}.png`) }),
});

const sheet = command({
	sandbox: stage2,
	input: Type.Object({ items: Type.Array(Type.Object({ frame: Type.String(), jpg: Image })) }),
	output: Type.Object({ sheet: Image }),
	run: ({ items }) => py("stage2/sheet.py", "sheet.png", ...items.map((it) => `${it.frame}=${it.jpg.path}`)),
	parse: (r) => ({ sheet: r.file("sheet.png") }),
});

// --- Stage 1 --------------------------------------------------------------------------------------

export const negatives = workflow({
	/** `raw`: the roll's scans. `roll`: the saved alignments (pto/) and the base scan (base/). */
	input: Type.Object({ raw: Tree(), roll: Tree(), meta: RollMeta }),
	output: Type.Object({ negs: Negs }),
	run: async (ctx, { raw, roll, meta }) => {
		const base = await ctx.call(linear, { in: roll, file: meta.base });
		const small = await pool(meta.frames, 2, async (f) => {
			const [a, b] = await Promise.all(f.halves.map((file) => ctx.call(linear, { in: raw, file })));
			return { frame: f.frame, a: a!, b: b! };
		});
		const measured = await ctx.call(measureRoll, { dmin: base.centre, pairs: small.map((s) => ({ frame: s.frame, a: s.a.lo, b: s.b.lo })) });

		// Stitching is the memory-heavy step (near 4 GB in the real workflow): one frame at a time.
		const frames: Neg[] = [];
		for (const [i, frame] of meta.frames.entries()) {
			const { negative } = await ctx.call(stitch, { raw, roll, frame });
			frames.push({ frame: frame.frame, negative, lo: measured.lo[frame.frame]!, dto: small[i]!.a.dto });
		}
		return { negs: { frames, dmin: base.centre, ratio: measured.ratio, exif: meta.exif } };
	},
});

// --- Stage 2 --------------------------------------------------------------------------------------

export const develop = workflow({
	input: Type.Object({
		negs: Negs,
		look: Look,
		/** Per-frame patches over the look, by frame number ("2841"). */
		overrides: Type.Optional(Type.Record(Type.String(), Patch)),
		/** Only these frames (default: all). */
		only: Type.Optional(Type.Array(Type.String())),
		/** A preview size in px (with a contact sheet), or `"final"`. */
		size: Type.Union([Type.Integer({ minimum: 100 }), Type.Literal("final")]),
	}),
	output: Type.Object({ images: Type.Array(Type.Object({ frame: Type.String(), jpg: Image })), sheet: Type.Optional(Image) }),
	run: async (ctx, { negs, look, overrides = {}, only, size }) => {
		const known = negs.frames.map((n) => n.frame);
		const unknown = [...(only ?? []), ...Object.keys(overrides)].filter((f) => !known.includes(f));
		if (unknown.length > 0) throw new Error(`not on this roll: ${unknown.join(", ")} (frames: ${known.join(", ")})`);

		const chosen = only ? negs.frames.filter((n) => only.includes(n.frame)) : negs.frames;
		const images = await pool(chosen, 3, async (neg) => {
			const mode = size === "final" ? { final: { ...negs.exif, "Exif.Photo.DateTimeOriginal": neg.dto } } : { preview: size };
			const { jpg } = await ctx.call(render, { neg, look: { ...look, ...overrides[neg.frame] }, dmin: negs.dmin, ratio: negs.ratio, mode });
			return { frame: neg.frame, jpg };
		});
		if (size === "final") return { images };
		return { images, ...(await ctx.call(sheet, { items: images })) };
	},
});

// --- Delivery -------------------------------------------------------------------------------------

const ente = toolset<typeof import("./tools/ente.ts")>("./tools/ente.ts", {
	sandbox: sandbox({ requires: ["node"], volumes: ["ente-fake:/ente"] }),
});

const uploader = agent({
	model: "default",
	prompt: text("./prompts/uploader.md"),
	input: Type.Object({ album: Type.String(), files: Type.Array(Image) }),
	output: Type.Object({ uploaded: Type.Integer(), notes: Type.String() }),
	mailbox: Type.String(), // guidance from the human, through the caller
	tools: [ente.upload, ente.list],
	turns: 40,
});

export const deliver = workflow({
	/** Naming the album is the approval: set it only after the human said yes to this album. */
	input: Type.Object({ negs: Negs, look: Look, overrides: Type.Optional(Type.Record(Type.String(), Patch)), album: Type.String({ minLength: 1 }) }),
	output: Type.Object({ images: develop.output.properties.images, album: Type.String(), verified: Type.Integer(), notes: Type.String() }),
	run: async (ctx, { negs, look, overrides, album }) => {
		const { images } = await ctx.call(develop, { negs, look, overrides, size: "final" });
		const files = images.map((i) => i.jpg);

		const job = ctx.start(uploader, { album, files }); // one-shot: a fresh session, the output only
		ctx.register("guidance", job.address); // the caller steers it: run.send("guidance", "…")
		const report = await job.result;

		// The body checks the album itself; the agent's word is not the record.
		const listed = await ctx.call(ente.list, { album });
		const missing = files.filter((f) => !listed.files.some((l) => l.name === f.name && l.digest === f.digest));
		if (missing.length > 0) throw new Error(`upload incomplete: ${missing.map((f) => f.name).join(", ")} not in ${album}`);
		return { images, album, verified: files.length, notes: report.notes };
	},
});

// --- Grading: an agent driving a compute actor ----------------------------------------------------

const Job = Type.Object({ frame: Type.String(), look: Look, size: Type.Integer({ minimum: 100, maximum: 2000 }) });

const grader = agent({
	model: "default",
	prompt: text("./prompts/grader.md"),
	input: Type.Object({ frames: Type.Array(Type.String()), start: Look, reference: Image, renderer: Address(Job) }),
	output: Type.Object({ look: Look, notes: Type.String() }),
	mailbox: Type.Union([Type.Object({ jpg: Image }), Type.Object({ error: Type.String() })]), // finished renders arrive here
	turns: 80,
});

export const grade = workflow({
	input: Type.Object({ negs: Negs, frames: Type.Array(Type.String()), start: Look, reference: Image }),
	output: grader.output,
	run: async (ctx, { negs, frames, start, reference }) => {
		// Rendering is memory-heavy, so one actor owns it and runs jobs one at a time.
		const renderer = ctx.spawn(Job, async (ctx, mailbox) => {
			for await (const m of mailbox) {
				const neg = negs.frames.find((n) => n.frame === m.body.frame);
				if (!neg) {
					ctx.send(m.from, { error: `no frame ${m.body.frame}; frames: ${frames.join(", ")}` }, { replyTo: m.id });
					continue;
				}
				try {
					const { jpg } = await ctx.call(render, { neg, look: m.body.look, dmin: negs.dmin, ratio: negs.ratio, mode: { preview: m.body.size } });
					ctx.send(m.from, { jpg }, { replyTo: m.id });
				} catch (e) {
					if (!(e instanceof NodeFailed)) throw e;
					ctx.send(m.from, { error: e.message }, { replyTo: m.id }); // the agent decides what to do
				}
			}
		});
		// The renderer's mailbox closes when this body returns.
		return ctx.call(grader, { frames, start, reference, renderer: renderer.address });
	},
});
