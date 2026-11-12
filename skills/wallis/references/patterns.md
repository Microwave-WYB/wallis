# wallis patterns

## Staging: once, then many times

Split a workflow where its cost changes. The expensive stage returns
everything later stages need, as Artifacts (files) and plain data; later
stages take it as input.

```ts
export const negatives = workflow({ input: Type.Object({ raw: Tree(), meta: RollMeta }), output: Type.Object({ negs: Negs }), run: … });
export const develop = workflow({ input: Type.Object({ negs: Negs, look: Look, only: Type.Optional(Type.Array(Type.String())) }), output: …, run: … });
```

```ts
const n = await run(negatives, { raw: Tree.from(rawDir), meta });        // once
const negs = (await attach(negatives, n.id).done()).output.negs;         // in a later step, by id
await run(develop, { negs, look, only: ["2835"] });                       // seconds
```

Pass small metadata as data (parsed by the caller), bulk files as Trees, and
collections as arrays of records. There is no cache: a second `run` of a
stage recomputes it.

## A compute actor driven by an agent

One actor owns a scarce resource and runs jobs one at a time; the agent sends
several jobs, keeps working, and reads the results as they arrive.

```ts
const Job = Type.Object({ frame: Type.String(), size: Type.Integer({ minimum: 100 }) });
const grader = agent({
	model: "default", prompt: "…",
	input: Type.Object({ frames: Type.Array(Type.String()), renderer: Address(Job) }),
	output: Type.Object({ look: Look }),
	mailbox: Type.Union([Type.Object({ jpg: Artifact("image/jpeg") }), Type.Object({ error: Type.String() })]),
});

export const grade = workflow({ …, run: async (ctx, { negs, frames }) => {
	const renderer = ctx.spawn(Job, async (ctx, mailbox) => {
		for await (const m of mailbox) {
			try {
				const { jpg } = await ctx.call(render, { neg: pick(negs, m.body.frame), size: m.body.size });
				ctx.send(m.from, { jpg }, { replyTo: m.id });
			} catch (e) {
				if (!(e instanceof NodeFailed)) throw e;
				ctx.send(m.from, { error: e.message }, { replyTo: m.id });   // the agent decides
			}
		}
	});
	return ctx.call(grader, { frames, renderer: renderer.address });   // the mailbox closes on return
}});
```

The try/catch around each job is the restart policy: a render that fails
becomes an `{ error }` reply and the actor goes on. Without it, the first
failing render would end the actor; since nobody awaits `renderer.result`,
its failure fails the `grade` body (and the run, naming `renderer`), which
also cancels the grader waiting for the reply. wallis has no supervisors:
an actor that should survive bad messages catches per message, and a run
that failed is recovered with `resume`.

An invalid job (size 50) fails the agent's `send` call with the validation
errors, and the agent sends it again. Renders that arrive by mail are
readable by the agent (`read` on their `/in` path). On resume, finished
renders are answered from the journal and deliveries replay in their
recorded order.

## Steering a running agent

```ts
const job = ctx.start(uploader, { album, files });   // the agent declares mailbox: Type.String()
ctx.register("guidance", job.address);
const report = await job.result;
```

The caller: `await attach(id).send("guidance", "rename the album")`, or
`{ interrupt: true }` to abort its current turn. The message enters the
agent's next turn; one sent after the agent returned is rejected (`closed`).

## Asking the human, approvals

The body (or an agent given the address) asks through an outbox and waits for
the answer in its own mailbox:

```ts
export default workflow({
	input: …, output: …,
	mailbox: Type.Object({ decision: Type.Union([Type.Literal("stop"), Type.Literal("continue")]), note: Type.String() }),
	run: async (ctx, input, mailbox) => {
		const ask = ctx.outbox("stop_check", Type.Object({ reason: Type.String() }));
		ctx.register("decision", ctx.self);
		ctx.send(ask, { reason: "the evidence repeats" });
		const answer = await mailbox.receive();
		if ("closed" in answer || answer.body.decision === "stop") return …;
		…
	},
});
```

The caller loops on `r.next()`; a `message` from `stop_check` is shown to the
human, and `r.send("decision", { decision: "stop", note })` answers. An answer
that does not match the schema rejects with `MessageRejected`.

For an agent that may lack information, give it an `Address` input (an
outbox) and a mailbox, or let it end with an output such as
`{ type: "need_info", question }` that the workflow returns.

## Recovery in place

```ts
const r = attach(wf, id);
const { failed } = await r.status();
for (const f of failed) console.log(`${[...f.path, f.label].join(" > ")}: ${f.reason.type} (${f.recovery})\n${f.tail}`);
```

1. Read the failure: the label and definition site, the reason, the stderr or
   transcript tail.
2. Fix the cause: free memory (an OOM-killed stitch), fix a script in a bound
   volume, raise the budget, or edit the workflow (a changed node re-runs).
3. `await r.resume({ detach: true })`: finished calls come from the journal;
   only failed and unfinished ones run again.
4. A decided failure (`recovery: "retry"`) needs naming:
   `r.resume({ retry: [f.id], turns: 20 })` continues the agent's own session.

Editing a helper a node closes over does not change the node's identity: the
journal still answers the calls made before the edit. Retry those calls, or
start a new run.
