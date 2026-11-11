// A FAKE Ente: it never talks to Ente or any network (its sandbox has network "none") and never
// sees image bytes. Its "server" is a JSON file per album in the ente-fake named volume
// (/ente), so the uploader agent's uploads and the body's later `list` see the same album.
// It records what would be uploaded, nothing more.
//
// Simulated failure: the first upload of FAIL_ONCE to an album fails with an expired session
// (deterministic: the album file remembers it was seen); every later attempt succeeds.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Type, type WallisTool } from "wallis";

const FAIL_ONCE = "DSC_2835.jpg"; // any one file name of the roll
type Album = { files: { name: string; digest: string; at: number }[]; seen: string[] };
const path = (album: string) => `/ente/${album.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
const load = (album: string): Album => (existsSync(path(album)) ? JSON.parse(readFileSync(path(album), "utf8")) : { files: [], seen: [] });
const save = (album: string, a: Album) => {
	mkdirSync("/ente", { recursive: true });
	writeFileSync(`${path(album)}.tmp`, JSON.stringify(a, null, 1));
	renameSync(`${path(album)}.tmp`, path(album));
};

const Upload = Type.Object({ album: Type.String(), name: Type.String(), digest: Type.String() });
export const upload = {
	name: "upload",
	label: "upload (fake Ente)",
	description: "Upload one file (by name and content digest) to an Ente album. Fails with an error message on a server or session problem.",
	parameters: Upload,
	outputSchema: Type.Object({ fake: Type.Literal(true), album: Type.String(), name: Type.String(), digest: Type.String(), files: Type.Integer() }),
	annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	execute: async (_id, p) => {
		const a = load(p.album);
		if (p.name === FAIL_ONCE && !a.seen.includes(p.name)) {
			a.seen.push(p.name);
			save(p.album, a);
			throw new Error(`401 Unauthorized: session expired while uploading ${p.name}; the session was refreshed, retry the upload`);
		}
		if (!a.seen.includes(p.name)) a.seen.push(p.name);
		a.files = [...a.files.filter((f) => !(f.name === p.name && f.digest === p.digest)), { name: p.name, digest: p.digest, at: a.files.length }];
		save(p.album, a);
		return {
			content: [{ type: "text", text: `uploaded ${p.name} (fake: recorded only) to ${p.album}` }],
			details: undefined,
			structuredContent: { fake: true as const, album: p.album, name: p.name, digest: p.digest, files: a.files.length },
		};
	},
} satisfies WallisTool<typeof Upload>;

const List = Type.Object({ album: Type.String() });
export const list = {
	name: "list",
	label: "list (fake Ente)",
	description: "List the files in an Ente album (name and content digest).",
	parameters: List,
	outputSchema: Type.Object({ album: Type.String(), files: Type.Array(Type.Object({ name: Type.String(), digest: Type.String() })) }),
	annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
	replay: "safe",
	execute: async (_id, p) => {
		const files = load(p.album).files.map((f) => ({ name: f.name, digest: f.digest }));
		return {
			content: [{ type: "text", text: JSON.stringify({ album: p.album, files }) }],
			details: undefined,
			structuredContent: { album: p.album, files },
		};
	},
} satisfies WallisTool<typeof List>;
