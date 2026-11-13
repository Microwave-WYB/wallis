// A chat harness as a workflow: the pressure test for the actor API.
//
// The assistant is an agent with a mailbox. The caller (a terminal, a pi extension, a Telegram
// bridge) sends the human's messages to the registered address "user" and reads the replies from
// the outbox "reply". The assistant works in a copy-on-write copy of the repo; its changes come
// back as a Tree, which the human reviews and applies. Nothing writes the real checkout.

import { Address, agent, sandbox, Tree, Type, workflow } from "wallis";

const dev = sandbox({
	requires: ["git", "node", "npm", "rg"],
	volumes: ["npm-cache:/root/.npm:ro"], // an agent only reads named volumes
});

const assistant = agent({
	model: "default",
	prompt: [
		"You are a coding assistant working in /w, a copy of the user's repository.",
		"The user's messages arrive in your mailbox. Answer with `send` to `user`; you may send progress",
		"notes while you work. When the user says the session is over, return a summary of your changes.",
	].join("\n"),
	input: Type.Object({ user: Address(Type.String()) }),
	output: Type.Object({ summary: Type.String() }),
	mailbox: Type.String(),
	workspace: { access: "exec", sandbox: dev },
	turns: 500,
});

export default workflow({
	input: Type.Object({ repo: Tree() }),
	output: Type.Object({ summary: Type.String(), changes: Tree() }),
	run: async (ctx, { repo }) => {
		const reply = ctx.outbox("reply", Type.String());
		const chat = ctx.start(ctx.session(assistant, { from: repo }), { user: reply });
		ctx.register("user", chat.address);
		const [out, next] = await chat.result;
		return { summary: out.summary, changes: ctx.files(next) };
	},
});
