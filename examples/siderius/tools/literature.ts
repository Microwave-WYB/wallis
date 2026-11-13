// Literature search for the literature_review agent: custom tools, served by
// wallis from their own sandbox (with the network), read-only and safe to
// repeat after a crash (`replay: "safe"`). A sketch: not run against the live
// APIs in tests.

import { Type, type WallisTool } from "wallis";

const Paper = Type.Object({ id: Type.String(), title: Type.String(), summary: Type.String(), year: Type.Union([Type.Integer(), Type.Null()]) });
const Papers = Type.Object({ papers: Type.Array(Paper) });

const SearchArxiv = Type.Object({ query: Type.String({ minLength: 1 }), max: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })) });

export const searchArxiv = {
	name: "search_arxiv",
	label: "arXiv search",
	description: "Search arXiv: id, title, abstract and year of the best matches.",
	parameters: SearchArxiv,
	outputSchema: Papers,
	annotations: { readOnlyHint: true, openWorldHint: true },
	replay: "safe",
	execute: async (_id, params, signal) => {
		const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:${params.query}`)}&max_results=${params.max ?? 10}`;
		const xml = await (await fetch(url, { signal })).text();
		const field = (entry: string, tag: string) => (new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry)?.[1] ?? "").replace(/\s+/g, " ").trim();
		const papers = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
			id: field(e!, "id"),
			title: field(e!, "title"),
			summary: field(e!, "summary"),
			year: Number(field(e!, "published").slice(0, 4)) || null,
		}));
		return { content: [{ type: "text", text: JSON.stringify(papers) }], details: undefined, structuredContent: { papers } };
	},
} satisfies WallisTool<typeof SearchArxiv>;

const SearchScholar = Type.Object({ query: Type.String({ minLength: 1 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })) });

export const searchScholar = {
	name: "search_scholar",
	label: "Semantic Scholar search",
	description: "Search Semantic Scholar: paper id, title, abstract and year.",
	parameters: SearchScholar,
	outputSchema: Papers,
	annotations: { readOnlyHint: true, openWorldHint: true },
	replay: "safe",
	execute: async (_id, params, signal) => {
		const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(params.query)}&limit=${params.limit ?? 10}&fields=title,abstract,year`;
		const key = process.env.S2_API_KEY;
		const body = (await (await fetch(url, { signal, headers: key ? { "x-api-key": key } : {} })).json()) as { data?: { paperId: string; title: string; abstract: string | null; year: number | null }[] };
		const papers = (body.data ?? []).map((p) => ({ id: p.paperId, title: p.title, summary: p.abstract ?? "", year: p.year }));
		return { content: [{ type: "text", text: JSON.stringify(papers) }], details: undefined, structuredContent: { papers } };
	},
} satisfies WallisTool<typeof SearchScholar>;
