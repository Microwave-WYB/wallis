// The chat example (v2/examples/chat/workflow.ts, unchanged) driven by a scripted caller, on a
// scripted assistant: a detached run awaited with `next`; the human's messages to the registered
// address `user`, two of them batched into one turn; replies through the outbox; the changes come
// back as a Tree, and the repository itself is never written.

import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { bwrapAvailable } from "../src/host/sandbox.ts";
import { run, Tree } from "../src/index.ts";
import { here, project } from "./util.ts";

const skip = !(await bwrapAvailable()) && "bwrap cannot create a sandbox here";

test("the chat example: messages in, replies out, the changes as a Tree", { skip, timeout: 120_000 }, async () => {
	const root = project({ "chat/workflow.ts": readFileSync(join(here, "../../examples/chat/workflow.ts"), "utf8") }, { models: { default: "faux/chat" }, executor: join(here, "fixtures/chat-executor.ts") });
	const repo = join(root, "repo");
	mkdirSync(repo);
	writeFileSync(join(repo, "README.md"), "# repo\n");
	const chat = ((await import(pathToFileURL(join(root, "chat/workflow.ts")).href)) as { default: typeof import("../../examples/chat/workflow.ts").default }).default;
	const r = await run(chat, { repo: Tree.from(repo) }, { detach: true });
	assert.match(r.id, /^chat-/);
	// The assistant registers `user` and waits for a message.
	for (let i = 0; i < 400; i++) {
		try {
			await r.send("user", "append hello");
			break;
		} catch (e) {
			if (!/registered no address/.test(String(e))) throw e;
			await new Promise((d) => setTimeout(d, 50));
		}
	}
	const replies: string[] = [];
	for (; replies.length < 2; ) {
		const n = await r.next({ timeout: "30s" });
		assert.equal(n.type, "message", JSON.stringify(n));
		if (n.type === "message") replies.push(String(n.body));
	}
	assert.deepEqual(replies, ["working on: append hello", "done: appended"]);
	// Two messages sent together enter one turn together.
	await Promise.all([r.send("user", "one"), r.send("user", "two")]);
	const both = await r.next({ timeout: "30s" });
	assert.equal(both.type === "message" && both.body, "2 messages arrived together: one + two");
	await r.send("user", "bye");
	const end = await r.next({ timeout: "30s" });
	assert.equal(end.type, "finished", JSON.stringify(end));
	if (end.type !== "finished") return;
	assert.equal(end.output.summary, "Appended to README.md as asked.");
	// The changes are a Tree; the repository itself is untouched.
	const finished = await r.done();
	await finished.exportOutput(join(root, "changes"));
	const [dir] = readdirSync(join(root, "changes"));
	assert.equal(readFileSync(join(root, "changes", dir!, "README.md"), "utf8"), "# repo\nhello\n");
	assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# repo\n");
});
