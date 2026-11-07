import gleam/dict
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import support.{
  agent, branch_call, call, commit, field, last, pin, replay, replay_from,
  returned, started, state_of, view, workflow,
}
import wallis_core/run
import wallis_core/types.{
  type Workflow, Append, Budget, CallAgent, Checkpoint, Deliver, Descending,
  Fail, Finish, LlmMerge, Pin, Refuse, Requested, Resumed, RunScript, Script,
  Sum, TopK, TopOnly, Union, Usage, ViewSpec, Workflow,
}
import wallis_core/value.{JArray, JInt, JNull, JString}

fn basic() -> Workflow {
  workflow(
    [field("runs", Append), field("errors", Union), field("score", Sum)],
    [
      agent("worker", view(["runs"]), [
        #("runs", Some("summary")),
        #("errors", Some("errors")),
        #("score", None),
      ]),
    ],
  )
}

fn summary(s) {
  value.object([#("summary", JString(s))])
}

// --- Start ---

pub fn start_checkpoints_and_rejects_unresolved_alias_test() {
  let #(_, effects, log) = replay([started(basic())])
  assert effects == [Checkpoint]
  assert list.length(log) == 1
  let wf = basic()
  let bad =
    Workflow(..wf, agents: [
      types.Agent(..support.agent("x", view([]), []), model: "judge"),
    ])
  let no_default = types.Started(bad, Pin(..pin(), models: dict.new()), JNull)
  let assert [Refuse(None, reason)] = last([no_default])
  assert string.contains(reason, "judge")
}

pub fn start_rejects_view_of_unknown_field_test() {
  let wf = workflow([], [agent("a", view(["ghost"]), [])])
  let assert [Refuse(None, reason)] = last([started(wf)])
  assert string.contains(reason, "ghost")
}

// --- Calls, writes, journal ---

pub fn call_emits_call_agent_with_view_test() {
  let assert [
    CallAgent(id: "#0", agent: "worker", model: "fake/model", view:, ..),
  ] = last([started(basic()), call("#0", "worker", JInt(1))])
  assert view == "<field name=\"runs\">\n</field>"
}

pub fn writes_apply_at_call_end_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JInt(1)),
    returned(
      "#0",
      value.object([
        #("summary", JString("s0")),
        #("errors", JArray([JString("E1")])),
      ]),
    ),
  ]
  assert last(events)
    == [
      Deliver(
        "#0",
        value.object([
          #("errors", JArray([JString("E1")])),
          #("summary", JString("s0")),
        ]),
      ),
    ]
  assert state_of(events, "runs") == JArray([JString("s0")])
  assert state_of(events, "errors") == JArray([JString("E1")])
}

pub fn emit_to_undeclared_field_is_refused_atomically_test() {
  let wf =
    workflow([field("runs", Append), field("other", Append)], [
      agent("worker", view([]), [#("runs", Some("summary"))]),
    ])
  let events = [
    started(wf),
    call("#0", "worker", JNull),
    types.AgentReturned(
      "#0",
      summary("s"),
      [types.Write("other", JInt(1))],
      support.usage(),
    ),
  ]
  let assert [Refuse(Some("#0"), reason)] = last(events)
  assert string.contains(reason, "other")
  assert state_of(events, "runs") == JArray([])
}

pub fn emit_tool_writes_declared_field_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JNull),
    types.AgentReturned(
      "#0",
      JNull,
      [types.Write("score", JInt(4))],
      support.usage(),
    ),
  ]
  assert state_of(events, "score") == JInt(4)
}

/// Snapshot isolation: a call sees the state as of its request, even when
/// another call's writes land before it returns.
pub fn calls_are_snapshot_isolated_test() {
  let wf =
    workflow([field("errors", Union)], [
      agent("w", view(["errors"]), [#("errors", Some("errors"))]),
    ])
  let errs = fn(e) { value.object([#("errors", JArray([JString(e)]))]) }
  let events = [
    started(wf),
    branch_call("#0.a#0", "a", "w", JNull),
    branch_call("#0.b#0", "b", "w", JNull),
    returned("#0.a#0", errs("A")),
  ]
  // The state has A, but b's call was rendered at request time.
  assert state_of(events, "errors") == JArray([JString("A")])
  let assert [CallAgent(view:, ..)] = last(list.take(events, 3))
  assert !string.contains(view, "\"A\"")
  // A call requested after a's return sees it.
  let assert [CallAgent(view:, ..)] =
    last(list.append(events, [call("#1", "w", JNull)]))
  assert string.contains(view, "\"A\"")
}

pub fn parallel_branch_refuses_non_commutative_write_test() {
  let events = [
    started(basic()),
    branch_call("#0.a#0", "a", "worker", JNull),
    returned("#0.a#0", summary("s")),
  ]
  let assert [Refuse(Some("#0.a#0"), reason)] = last(events)
  assert string.contains(reason, "not commutative")
  assert state_of(events, "runs") == JArray([])
}

pub fn parallel_branch_accepts_commutative_write_test() {
  let events = [
    started(basic()),
    branch_call("#0.a#0", "a", "worker", JNull),
    returned("#0.a#0", value.object([#("errors", JArray([JString("E")]))])),
  ]
  let assert [Deliver("#0.a#0", _)] = last(events)
  assert state_of(events, "errors") == JArray([JString("E")])
}

pub fn agent_failure_is_journaled_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JNull),
    types.AgentFailed("#0", "boom", support.usage()),
  ]
  assert last(events) == [Fail("#0", "boom")]
}

pub fn body_commit_and_read_test() {
  let events = [
    started(basic()),
    commit("#0", [#("runs", JString("r")), #("score", JInt(2))]),
    Requested(
      "#1",
      None,
      types.Read(ViewSpec(["runs", "score"], 1000, 10, 1, [])),
    ),
  ]
  let assert [Deliver("#1", result)] = last(events)
  assert value.get(result, "data.runs") == Some(JArray([JString("r")]))
  assert value.get(result, "data.score") == Some(JInt(2))
}

pub fn body_finish_test() {
  let assert [Finish(types.Done(JInt(1)))] =
    last([started(basic()), types.BodyFinished(JInt(1))])
}

// --- Budget ---

fn budgeted(budget) {
  Workflow(..basic(), budget:)
}

pub fn budget_refuses_call_when_usd_spent_test() {
  let wf =
    budgeted(Budget(
      usd: Some(0.5),
      tokens: None,
      turns: None,
      compute_minutes: None,
    ))
  let events = [
    started(wf),
    call("#0", "worker", JNull),
    returned("#0", summary("s")),
    call("#1", "worker", JNull),
  ]
  let assert [Refuse(Some("#1"), reason)] = last(events)
  assert string.contains(reason, "usd")
}

pub fn budget_caps_turns_of_call_test() {
  let wf =
    budgeted(Budget(
      usd: None,
      tokens: None,
      turns: Some(3),
      compute_minutes: None,
    ))
  let events = [
    started(wf),
    call("#0", "worker", JNull),
    types.AgentReturned("#0", summary("s"), [], Usage(0.0, 0, 2)),
    call("#1", "worker", JNull),
  ]
  let assert [CallAgent(max_turns: 1, ..)] = last(events)
}

pub fn budget_checks_tokens_test() {
  let wf =
    budgeted(Budget(
      usd: None,
      tokens: Some(100),
      turns: None,
      compute_minutes: None,
    ))
  let assert [Refuse(Some("#1"), _)] =
    last([
      started(wf),
      call("#0", "worker", JNull),
      returned("#0", summary("s")),
      call("#1", "worker", JNull),
    ])
}

pub fn compute_minutes_pass_to_scripts_test() {
  let wf =
    budgeted(Budget(
      usd: None,
      tokens: None,
      turns: None,
      compute_minutes: Some(10.0),
    ))
  let script = fn(id) { Requested(id, None, Script("train", JNull)) }
  let assert [RunScript(compute_minutes: Some(10.0), ..)] =
    last([started(wf), script("#0")])
  let events = [
    started(wf),
    script("#0"),
    types.ScriptReturned("#0", JInt(1), 10.0),
    script("#1"),
  ]
  let assert [Refuse(Some("#1"), reason)] = last(events)
  assert string.contains(reason, "compute")
}

// --- llmMerge ---

fn merging(max_calls) {
  workflow(
    [
      field(
        "findings",
        LlmMerge(agent: "merger", max: 2, max_calls:, archive: Some("archive")),
      ),
      field("archive", Append),
    ],
    [
      agent("worker", view(["findings"]), [#("findings", Some("findings"))]),
      agent("merger", view([]), []),
    ],
  )
}

fn findings(xs) {
  value.object([#("findings", JArray(list.map(xs, JString)))])
}

pub fn llm_merge_calls_merge_agent_and_applies_result_test() {
  let prefix = [
    started(merging(5)),
    call("#0", "worker", JNull),
    returned("#0", findings(["a", "b", "c"])),
  ]
  let assert [CallAgent(id: "#0/merge/findings", agent: "merger", input:, ..)] =
    last(prefix)
  assert value.get(input, "incoming")
    == Some(JArray([JString("a"), JString("b"), JString("c")]))
  // Writes wait for the merge.
  assert state_of(prefix, "findings") == JArray([])
  let merged =
    value.object([
      #("items", JArray([JString("ab"), JString("c"), JString("x")])),
      #("archived", JArray([JString("a")])),
    ])
  let events = list.append(prefix, [returned("#0/merge/findings", merged)])
  let assert [Deliver("#0", _)] = last(events)
  // At most `max` items survive; the rest are archived.
  assert state_of(events, "findings") == JArray([JString("ab"), JString("c")])
  assert state_of(events, "archive") == JArray([JString("a"), JString("x")])
}

pub fn llm_merge_call_cap_falls_back_test() {
  let events = [
    started(merging(1)),
    call("#0", "worker", JNull),
    returned("#0", findings(["a"])),
    returned(
      "#0/merge/findings",
      value.object([#("items", JArray([JString("a")]))]),
    ),
    call("#1", "worker", JNull),
    returned("#1", findings(["b", "c"])),
  ]
  // Cap reached: no merge call, deterministic fallback keeps the newest two.
  let assert [Deliver("#1", _)] = last(events)
  assert state_of(events, "findings") == JArray([JString("b"), JString("c")])
  assert state_of(events, "archive") == JArray([JString("a")])
  let #(s, _, _) = replay(events)
  assert value.get(run.snapshot(s), "merge_calls.findings") == Some(JInt(1))
}

pub fn llm_merge_failure_falls_back_test() {
  let events = [
    started(merging(5)),
    call("#0", "worker", JNull),
    returned("#0", findings(["a", "b", "c"])),
    types.AgentFailed("#0/merge/findings", "bad", support.usage()),
  ]
  let assert [Deliver("#0", _)] = last(events)
  assert state_of(events, "findings") == JArray([JString("b"), JString("c")])
}

pub fn llm_merge_refused_in_parallel_branch_test() {
  let events = [
    started(merging(5)),
    branch_call("#0.x#0", "x", "worker", JNull),
    returned("#0.x#0", findings(["a"])),
  ]
  let assert [Refuse(Some("#0.x#0"), _)] = last(events)
}

pub fn top_k_in_parallel_branch_test() {
  let wf =
    workflow(
      [
        field(
          "cache",
          TopK(
            k: 2,
            by: "metric",
            order: Descending,
            key: None,
            latest: TopOnly,
          ),
        ),
      ],
      [agent("w", view([]), [#("cache", Some("entry"))])],
    )
  let entry = fn(m) {
    value.object([#("entry", value.object([#("metric", JInt(m))]))])
  }
  let events = [
    started(wf),
    branch_call("#0.a#0", "a", "w", JNull),
    branch_call("#0.b#0", "b", "w", JNull),
    returned("#0.b#0", entry(2)),
    returned("#0.a#0", entry(1)),
  ]
  let swapped = [
    started(wf),
    branch_call("#0.a#0", "a", "w", JNull),
    branch_call("#0.b#0", "b", "w", JNull),
    returned("#0.a#0", entry(1)),
    returned("#0.b#0", entry(2)),
  ]
  assert state_of(events, "cache") == state_of(swapped, "cache")
}

// --- Resume: pin, journal, divergence ---

fn first_run() {
  [
    started(basic()),
    call("#0", "worker", JInt(0)),
    returned("#0", summary("s0")),
    call("#1", "worker", JInt(1)),
  ]
}

pub fn refold_of_log_reproduces_state_test() {
  let events =
    list.append(first_run(), [
      returned("#1", summary("s1")),
      types.BodyFinished(JNull),
    ])
  let #(live, _, log) = replay(events)
  let #(refolded, _, _) = replay(log)
  assert run.snapshot(live) == run.snapshot(refolded)
}

pub fn resume_with_same_pin_is_accepted_test() {
  let #(s, _, _) = replay(first_run())
  let #(_, effects) = run.step(s, Resumed(pin()))
  assert effects == []
}

pub fn resume_with_changed_input_file_is_refused_test() {
  let #(s, _, _) = replay(first_run())
  let changed = Pin(..pin(), inputs: dict.from_list([#("advice.md", "a2")]))
  let #(s, effects) = run.step(s, Resumed(changed))
  let assert [Refuse(None, reason)] = effects
  assert string.contains(reason, "pin mismatch: inputs.advice.md")
  // The halted run takes no further requests.
  let #(_, effects) = run.step(s, call("#2", "worker", JNull))
  let assert [Refuse(None, "run is not running")] = effects
}

pub fn resume_names_each_pin_field_test() {
  let #(s, _, _) = replay(first_run())
  let reason = fn(p) {
    let assert #(_, [Refuse(None, r)]) = run.step(s, Resumed(p))
    r
  }
  assert string.contains(reason(Pin(..pin(), seed: 8)), "seed")
  assert string.contains(
    reason(Pin(..pin(), workflow_digest: "wf2")),
    "workflow_digest",
  )
  assert string.contains(
    reason(Pin(..pin(), models: dict.from_list([#("default", "other/model")]))),
    "models.default",
  )
}

pub fn replayed_request_is_answered_from_journal_test() {
  let #(s, _, _) = replay(first_run())
  let #(s, _, _) = replay_from(s, [Resumed(pin())])
  // The completed call is a journal hit: delivered, not checkpointed, no CallAgent.
  let #(s, effects) = run.step(s, call("#0", "worker", JInt(0)))
  assert effects == [Deliver("#0", summary("s0"))]
  // The call that was in flight at the stop is issued again, same view.
  let #(_, effects) = run.step(s, call("#1", "worker", JInt(1)))
  let assert [CallAgent(id: "#1", view:, ..)] = effects
  assert string.contains(view, "s0")
}

pub fn replay_divergence_halts_test() {
  let #(s, _, _) = replay(first_run())
  let #(s, effects) = run.step(s, call("#0", "worker", JInt(99)))
  let assert [Refuse(None, reason)] = effects
  assert string.contains(reason, "path divergence at request #0")
  let assert Some(run.Halted(_)) = run.status(s)
}

pub fn resumed_finished_run_reports_outcome_test() {
  let #(s, _, _) = replay([started(basic()), types.BodyFinished(JInt(5))])
  let #(_, effects) = run.step(s, Resumed(pin()))
  assert effects == [Finish(types.Done(JInt(5)))]
}

pub fn interrupted_run_log_equals_uninterrupted_test() {
  let whole =
    list.append(first_run(), [
      returned("#1", summary("s1")),
      types.BodyFinished(JNull),
    ])
  let #(expected, _, expected_log) = replay(whole)
  // Stop after #1 was requested; resume; the body replays #0 and #1.
  let #(s, _, log) = replay(first_run())
  let #(s, _, log2) =
    replay_from(s, [
      Resumed(pin()),
      call("#0", "worker", JInt(0)),
      call("#1", "worker", JInt(1)),
      returned("#1", summary("s1")),
      types.BodyFinished(JNull),
    ])
  assert list.append(log, log2) == expected_log
  assert run.snapshot(s) == run.snapshot(expected)
}
