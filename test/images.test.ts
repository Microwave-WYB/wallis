// Image costs from header dimensions: every format's header, and the split
// that counts images once (by dimensions) and leaves the rest as text.

import assert from "node:assert/strict";
import { test } from "node:test";
import { imageSize, imageTokens, MAX_IMAGE_TOKENS, splitImages } from "../src/host/images.ts";

const png = (w: number, h: number) => {
	const b = Buffer.alloc(33);
	Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(b, 0);
	b.writeUInt32BE(w, 16);
	b.writeUInt32BE(h, 20);
	return b;
};
const gif = (w: number, h: number) => {
	const b = Buffer.alloc(13);
	b.write("GIF89a", 0, "ascii");
	b.writeUInt16LE(w, 6);
	b.writeUInt16LE(h, 8);
	return b;
};
const jpeg = (w: number, h: number, sof: number) => {
	// SOI, an APP0 (JFIF) segment to walk past, then the start of frame, then padding.
	const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
	const frame = Buffer.from([0xff, sof, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, ...Buffer.alloc(9)]);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame, Buffer.alloc(16)]);
};
const webp = (chunk: "VP8 " | "VP8L" | "VP8X", w: number, h: number) => {
	const b = Buffer.alloc(40);
	b.write("RIFF", 0, "ascii");
	b.write("WEBP", 8, "ascii");
	b.write(chunk, 12, "ascii");
	if (chunk === "VP8 ") {
		Buffer.from([0x9d, 0x01, 0x2a]).copy(b, 23);
		b.writeUInt16LE(w, 26);
		b.writeUInt16LE(h, 28);
	} else if (chunk === "VP8L") {
		b[20] = 0x2f;
		b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
	} else {
		b.writeUIntLE(w - 1, 24, 3);
		b.writeUIntLE(h - 1, 27, 3);
	}
	return b;
};

test("imageSize reads PNG, GIF, baseline and progressive JPEG, and WebP VP8, VP8L and VP8X headers", () => {
	assert.deepEqual(imageSize(png(2400, 1600)), { width: 2400, height: 1600 });
	assert.deepEqual(imageSize(gif(320, 200)), { width: 320, height: 200 });
	assert.deepEqual(imageSize(jpeg(1024, 768, 0xc0)), { width: 1024, height: 768 }, "baseline");
	assert.deepEqual(imageSize(jpeg(4000, 3000, 0xc2)), { width: 4000, height: 3000 }, "progressive");
	assert.deepEqual(imageSize(webp("VP8 ", 640, 480)), { width: 640, height: 480 });
	assert.deepEqual(imageSize(webp("VP8L", 300, 200)), { width: 300, height: 200 });
	assert.deepEqual(imageSize(webp("VP8X", 5000, 4000)), { width: 5000, height: 4000 });
	assert.equal(imageSize(Buffer.from("not an image")), null);
});

test("splitImages counts each image by its dimensions, once, and removes it from the rest", () => {
	const data = (b: Buffer) => b.toString("base64");
	const message = {
		role: "user",
		content: [
			{ type: "text", text: "look" },
			{ type: "image", data: data(png(1000, 1000)), mimeType: "image/png" },
			{ type: "image", data: data(jpeg(200, 150, 0xc0)), mimeType: "image/jpeg" },
		],
	};
	const { tokens, rest } = splitImages(message);
	// 1000×1000 fits (≤1568 px, ≤1.15 MP): 1e6/750; 200×150: 30000/750.
	assert.equal(tokens, Math.ceil(1_000_000 / 750) + 40);
	assert.deepEqual(rest, { role: "user", content: [{ type: "text", text: "look" }] }, "no image block is left to be counted again");
	// 4000×4000 is scaled to fit 1568 px, then to 1.15 megapixels.
	assert.equal(imageTokens(data(png(4000, 4000))), Math.ceil(1_150_000 / 750));
	assert.equal(imageTokens("bm90IGFuIGltYWdl"), MAX_IMAGE_TOKENS, "an unreadable header counts as the most an image costs");
});
