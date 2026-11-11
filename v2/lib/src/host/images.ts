// What an image costs in a model's context, from its dimensions (read from
// its header), never from its bytes: the base64 of a 1.2 MB contact sheet
// is not 400k tokens of text.
//
// The formula (Anthropic's, documented for vision models): an image is
// scaled down to fit 1568 px on its long edge (and 1.15 megapixels), then
// costs width × height / 750 tokens, at most about 1600. An image whose
// header cannot be read counts as that maximum.

/** At most what one image costs (a 1568-px-edge image). */
export const MAX_IMAGE_TOKENS = 1600;

const LONG_EDGE = 1568;
const MAX_PIXELS = 1_150_000;

/** Width and height from a PNG, GIF, JPEG or WebP header; null when it is none of them. */
export function imageSize(bytes: Buffer): { width: number; height: number } | null {
	if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("ascii", 12, 16) === "IHDR") return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	if (bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "GIF") return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
	if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
		const chunk = bytes.toString("ascii", 12, 16);
		if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
		if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
		if (chunk === "VP8L") {
			const b = bytes.readUInt32LE(21);
			return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
		}
		return null;
	}
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		// JPEG: walk the markers to a start-of-frame.
		let at = 2;
		while (at + 9 < bytes.length) {
			if (bytes[at] !== 0xff) return null;
			const marker = bytes[at + 1]!;
			const length = bytes.readUInt16BE(at + 2);
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
			at += 2 + length;
		}
	}
	return null;
}

/** Tokens one image costs, from its base64 data. */
export function imageTokens(base64: string): number {
	// The header is in the first few kilobytes; nothing else is decoded.
	const size = imageSize(Buffer.from(base64.slice(0, 65_536), "base64"));
	if (size === null || size.width <= 0 || size.height <= 0) return MAX_IMAGE_TOKENS;
	let { width, height } = size;
	const edge = Math.max(width, height);
	if (edge > LONG_EDGE) {
		width = (width * LONG_EDGE) / edge;
		height = (height * LONG_EDGE) / edge;
	}
	if (width * height > MAX_PIXELS) {
		const k = Math.sqrt(MAX_PIXELS / (width * height));
		width *= k;
		height *= k;
	}
	return Math.min(MAX_IMAGE_TOKENS, Math.ceil((width * height) / 750));
}

/**
 * A message's images, counted, and the message without them (to count the
 * rest as text): an image block is removed, not emptied, so a text
 * estimate that prices every image block at a fixed size never counts it
 * a second time.
 */
export function splitImages(value: unknown): { tokens: number; rest: unknown } {
	let tokens = 0;
	const isImage = (v: unknown): v is { type: "image"; data: string } => v !== null && typeof v === "object" && (v as { type?: unknown }).type === "image" && typeof (v as { data?: unknown }).data === "string";
	const walk = (v: unknown): unknown => {
		if (Array.isArray(v))
			return v.flatMap((x) => {
				if (!isImage(x)) return [walk(x)];
				tokens += imageTokens(x.data);
				return [];
			});
		if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
		return v;
	};
	// The walk counts as it goes: the tokens are read after it.
	const rest = walk(value);
	return { tokens, rest };
}
