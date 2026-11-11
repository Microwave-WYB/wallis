// Colour-negative rolls, scanned as two halves per 6x6 frame (the owner's film workflow, v2).
//
// Three workflows and one interactive one, all plain values:
//   negatives  stage 1, run once per roll: measurements and the stitched linear negatives;
//   develop    stage 2, run many times: previews (plus a contact sheet) or finals for a look;
//   deliver    develop's finals, then an uploader agent; naming the album is the approval;
//   grade      an agent that drives a render actor until a frame matches a reference.
//
// Reuse is explicit: `negatives` returns its negatives as artifacts, and every later run takes
// them as input. Nothing is cached across runs; within one run, resume skips finished calls.

import { readFileSync } from "node:fs";
import {
	Address, agent, Artifact, command, NodeFailed, sandbox, toolset, Tree, Type, workflow,
	type ArtifactRef, type Mailbox, type Static,
} from "wallis";

const text = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// --- Sandboxes ----------------------------------------------------------------------------------

const film = (stage: "stage1" | "stage2") =>
	sandbox({
		requires: stage === "stage1" ? ["python3", "darktable-cli", "exiv2", "nona"] : ["python3", "darktable-cli", "exiv2"],
		volumes: ["./scripts/lib:/film/lib:ro", `./scripts/${stage}:/film/${stage}:ro`, "./pylib:/pylib:ro", "dt-cache:/root/.cache/darktable"],
		environment: { OMP_NUM_THREADS: "4", PYTHONPATH: "/pylib" },
	});
const stage1 = film("stage1");
const stage2 = film("stage2");
const py = (script: string, ...args: string[]) => ["python3", "-s", "-E", `/film/${script}`, ...args];

// --- Values ---------------------------------------------------------------------------------------

const Rgb = Type.Array(Type.Number(), { minItems: 3, maxItems: 3 });
/** A look in the owner's terms: the env names his scripts read, as strings. */
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
const Tiff = Artifact("image/tiff");
const Jpeg = Artifact("image/jpeg");
const Crop = Type.Object({ angle: Type.Number(), box: Type.Array(Type.Number(), { minItems: 4, maxItems: 4 }) });

/** One stitched frame and what stage 2 needs from stage 1 for it. */
const Neg = Type.Object({ neg: Tiff, lo: Rgb, dto: Type.String() });
/** Stage 1's product: every frame's negative plus the roll-wide measurements. */
export const Negs = Type.Object({ frames: Type.Record(Type.String(), Neg), dmin: Rgb, ratio: Rgb, exif: Type.Record(Type.String(), Type.String()) });

// --- Stage 1 commands -----------------------------------------------------------------------------

/** The roll's metadata: halves per frame, crops, the base scan's stem, EXIF. stdout is JSON (default parse). */
const rollMeta = command({
	sandbox: stage1,
	input: Type.Object({ roll: Tree() }),
	output: Type.Object({
		pairs: Type.Array(Type.Array(Type.String(), { minItems: 2, maxItems: 2 })),
		crops: Type.Record(Type.String(), Crop),
		base: Type.String(),
		exif: Type.Record(Type.String(), Type.String()),
	}),
	run: ({ roll }) => py("stage1/roll.py", roll.path),
});

/** A 1500 px linear render of one NEF: inner-region percentiles, the centre median, its EXIF date. */
const linear = command({
	sandbox: stage1,
	input: Type.Object({ nef: Tree(), stem: Type.String() }),
	output: Type.Object({ lo: Rgb, hi: Rgb, centre: Rgb, dto: Type.String() }),
	run: ({ nef, stem }) => py("stage1/linear.py", `${nef.path}/${stem}.NEF`),
});

/** Pair density ranges and the roll's channel ratios, from the base Dmin and every half's lo. */
const measureRoll = command({
	sandbox: stage1,
	input: Type.Object({ dmin: Rgb, pairs: Type.Array(Type.Array(Type.String())), lo: Type.Record(Type.String(), Rgb) }),
	output: Type.Object({ ratio: Rgb, pairs: Type.Record(Type.String(), Rgb) }),
	run: () => py("stage1/measure_roll.py"),
});

/** darktable pass 1 on both halves, remap with the saved alignment, cross-fade, straighten, crop. Peaks near 4 GB. */
const stitch = command({
	sandbox: stage1,
	input: Type.Object({ raw: Tree(), roll: Tree(), frame: Type.String(), a: Type.String(), b: Type.String(), crop: Crop }),
	output: Type.Object({ neg: Tiff }),
	run: (i) => py("stage1/stitch.py", `${i.raw.path}/${i.a}.NEF`, `${i.raw.path}/${i.b}.NEF`, `${i.roll.path}/pto/f${i.frame}.pto`, JSON.stringify(i.crop), "neg.tif"),
	parse: (r) => ({ neg: r.file("neg.tif") }),
});

// --- Stage 2 commands -----------------------------------------------------------------------------

const RenderIn = Type.Object({
	neg: Neg,
	look: Look,
	dmin: Rgb,
	ratio: Rgb,
	/** A preview size in px, or a full-resolution final with EXIF. */
	mode: Type.Union([Type.Object({ preview: Type.Integer() }), Type.Object({ final: Type.Record(Type.String(), Type.String()) })]),
});
const render = command({
	sandbox: stage2,
	input: RenderIn,
	output: Type.Object({ jpg: Jpeg }),
	run: (i) => py("stage2/render.py", JSON.stringify({ ...i, neg: i.neg.neg.path }), "out.jpg"),
	parse: (r) => ({ jpg: r.file("out.jpg") }),
});

const sheet = command({
	sandbox: stage2,
	input: Type.Object({ items: Type.Record(Type.String(), Jpeg) }),
	output: Type.Object({ sheet: Jpeg }),
	run: ({ items }) => py("stage2/sheet.py", "sheet.jpg", ...Object.entries(items).map(([f, img]) => `${f}=${img.path}`)),
	parse: (r) => ({ sheet: r.file("sheet.jpg") }),
});

// --- Stage 1 --------------------------------------------------------------------------------------

export const negatives = workflow({
	/** `raw`: the roll's NEFs. `roll`: pairs, crops, roll.json, the saved Hugin projects (pto/) and the base scan (base/). */
	input: Type.Object({ raw: Tree(), roll: Tree() }),
	output: Type.Object({ negs: Negs }),
	run: async (ctx, { raw, roll }) => {
		const meta = await ctx.call(rollMeta, { roll });
		const base = await ctx.call(linear, { nef: roll, stem: `base/${meta.base}` });

		// Small linear renders, four at a time: plain code, no framework queue.
		const stems = meta.pairs.flat();
		const small: Record<string, Static<typeof Rgb>> = {};
		const dto: Record<string, string> = {};
		for (let i = 0; i < stems.length; i += 4) {
			const batch = stems.slice(i, i + 4);
			const done = await Promise.all(batch.map((stem) => ctx.call(linear, { nef: raw, stem })));
			batch.forEach((stem, k) => { small[stem] = done[k]!.lo; dto[stem] = done[k]!.dto; });
		}
		const measured = await ctx.call(measureRoll, { dmin: base.centre, pairs: meta.pairs, lo: small });

		// Stitching peaks near 4 GB: one frame at a time.
		const frames: Static<typeof Negs>["frames"] = {};
		for (const [a, b] of meta.pairs as [string, string][]) {
			const frame = a.replace(/^DSC_/, "");
			const { neg } = await ctx.call(stitch, { raw, roll, frame, a, b, crop: meta.crops[frame]! });
			frames[frame] = { neg, lo: measured.pairs[a]!, dto: dto[a]! };
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
	output: Type.Object({ images: Type.Record(Type.String(), Jpeg), sheet: Type.Optional(Jpeg) }),
	run: async (ctx, { negs, look, overrides = {}, only, size }) => {
		const ids = only ?? Object.keys(negs.frames);
		const unknown = [...ids, ...Object.keys(overrides)].filter((f) => !(f in negs.frames));
		if (unknown.length > 0) throw new Error(`not on this roll: ${unknown.join(", ")} (frames: ${Object.keys(negs.frames).join(", ")})`);

		const images: Record<string, ArtifactRef<"image/jpeg">> = {};
		for (let i = 0; i < ids.length; i += 3) {
			const batch = ids.slice(i, i + 3);
			const done = await Promise.all(
				batch.map((f) =>
					ctx.call(render, {
						neg: negs.frames[f]!,
						look: { ...look, ...overrides[f] },
						dmin: negs.dmin,
						ratio: negs.ratio,
						mode: size === "final" ? { final: { ...negs.exif, "Exif.Photo.DateTimeOriginal": negs.frames[f]!.dto } } : { preview: size },
					}),
				),
			);
			batch.forEach((f, k) => (images[f] = done[k]!.jpg));
		}
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
	input: Type.Object({ album: Type.String(), files: Type.Array(Jpeg) }),
	output: Type.Object({ uploaded: Type.Integer(), notes: Type.String() }),
	mailbox: Type.String(), // guidance from the human, through the caller
	tools: [ente.upload, ente.list],
	turns: 40,
});

export const deliver = workflow({
	/** Naming the album is the approval: set it only after the human said yes to this album. */
	input: Type.Object({ negs: Negs, look: Look, overrides: Type.Optional(Type.Record(Type.String(), Patch)), album: Type.String({ minLength: 1 }) }),
	output: Type.Object({ images: Type.Record(Type.String(), Jpeg), album: Type.String(), verified: Type.Integer(), notes: Type.String() }),
	run: async (ctx, { negs, look, overrides, album }) => {
		const { images } = await ctx.call(develop, { negs, look, overrides, size: "final" });
		const files = Object.values(images);

		const job = ctx.start(ctx.session(uploader), { album, files });
		ctx.register("guidance", job.address); // the caller steers it: run.send("guidance", "…")
		const [report] = await job.result;

		// The body checks the album itself; the agent's word is not the record.
		const listed = await ctx.call(ente.list, { album });
		const missing = files.filter((f) => !listed.files.some((l) => l.name === f.name && l.digest === f.digest));
		if (missing.length > 0) throw new Error(`upload incomplete: ${missing.map((f) => f.name).join(", ")} not in ${album}`);
		return { images, album, verified: files.length, notes: report.notes };
	},
});

// --- Grading: an agent driving a compute actor ----------------------------------------------------

const Job = Type.Object({ frame: Type.String(), look: Look, size: Type.Integer() });
type Job = Static<typeof Job>;

const grader = agent({
	model: "default",
	prompt: text("./prompts/grader.md"),
	input: Type.Object({ frames: Type.Array(Type.String()), start: Look, reference: Jpeg, renderer: Address(Job) }),
	output: Type.Object({ look: Look, notes: Type.String() }),
	mailbox: Type.Union([Type.Object({ jpg: Jpeg }), Type.Object({ error: Type.String() })]), // finished renders arrive here
	turns: 80,
});

export const grade = workflow({
	input: Type.Object({ negs: Negs, frames: Type.Array(Type.String()), start: Look, reference: Jpeg }),
	output: Type.Object({ look: Look, notes: Type.String() }),
	run: async (ctx, { negs, frames, start, reference }) => {
		// Rendering is memory-heavy, so one actor owns it and runs jobs one at a time.
		const renderer = ctx.spawn(async (ctx, mailbox: Mailbox<Job>) => {
			for await (const m of mailbox) {
				try {
					const { jpg } = await ctx.call(render, { neg: negs.frames[m.body.frame]!, look: m.body.look, dmin: negs.dmin, ratio: negs.ratio, mode: { preview: m.body.size } });
					ctx.send(m.from, { jpg }, { replyTo: m.id });
				} catch (e) {
					if (!(e instanceof NodeFailed)) throw e;
					ctx.send(m.from, { error: e.message }, { replyTo: m.id }); // the agent decides what to do
				}
			}
		});
		const [out] = await ctx.call(ctx.session(grader), { frames, start, reference, renderer: renderer.address });
		return out; // the renderer's mailbox closes when this body returns
	},
});
