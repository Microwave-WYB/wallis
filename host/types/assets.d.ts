// Prompts are imported as text: `import p from "./p.md" with { type: "text" }`.
declare module "*.md" {
	const text: string;
	export default text;
}
