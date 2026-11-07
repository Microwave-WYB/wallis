// The executor module the CLI and MCP tests load (`--executor`). Scripted
// for the two-node and ask examples. Environment switches:
//   WALLIS_FAKE_EXEC_LOG=path        record every call the executor starts
//   WALLIS_FAKE_KILL_ON=agent[:n]    SIGKILL this process while that agent's call
//                                    (after n replies, default any) is in flight
//   WALLIS_FAKE_UNAVAILABLE_MODEL=m  calls on model m fail as executor errors

import { appendFileSync } from "node:fs";
import { type AgentCall, conversation, ExecutorUnavailable, FakeExecutor } from "../../src/host/index.ts";

export const responses = {
	planner: { submit: { outline: ["why", "how", "so what"], note: "outline has three points" } },
	scout: conversation(
		{ idle: "Who is the audience: experts or newcomers?" },
		{ submit: { outline: ["what a product is", "why it folds"], note: "for newcomers" } },
	),
	writer: { submit: { text: "Why. How. So what.", words: 4 } },
};

export default function create() {
	const replies = (call: AgentCall) => call.transcript.filter((m) => m.role === "user").length;
	const fake = new FakeExecutor(responses, {
		name: "fake",
		onCall: (call) => {
			const log = process.env.WALLIS_FAKE_EXEC_LOG;
			if (log) appendFileSync(log, `${JSON.stringify({ id: call.id, agent: call.agent, model: call.model, replies: replies(call) })}\n`);
			const kill = process.env.WALLIS_FAKE_KILL_ON;
			if (kill) {
				const [agent, n] = kill.split(":");
				if (call.agent === agent && (n === undefined || Number(n) === replies(call))) process.kill(process.pid, "SIGKILL");
			}
		},
	});
	const executor = {
		name: fake.name,
		call: async (call: AgentCall) => {
			if (call.model === process.env.WALLIS_FAKE_UNAVAILABLE_MODEL) {
				appendFileSync(process.env.WALLIS_FAKE_EXEC_LOG ?? "/dev/null", `${JSON.stringify({ id: call.id, agent: call.agent, model: call.model, unavailable: true })}\n`);
				throw new ExecutorUnavailable("HTTP 412 account suspended");
			}
			return fake.call(call);
		},
	};
	return { executor };
}
