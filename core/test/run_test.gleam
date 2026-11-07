import gleam/dict
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import support.{
  agent, branch_call, call, commit, field, last, pin, replay, replay_from,
  returned, snapshot_get, started, state_of, status_after, view, workflow,
}
import wallis_core/run
import wallis_core/types.{
  type Workflow, AgentGaveUp, AgentIdle, AliasRebound, Append, Assistant, Budget,
  BudgetExhausted, BudgetRaised, CallAgent, CancelRequested, Cancelled,
  Checkpoint, ComputeMinutes, Deliver, Descending, Done, ExecutorFailed,
  ExecutorUnavailable, Fail, Finish, Finished, Idle, InvalidDeclaration,
  LlmMerge, Message, NonCommutativeWriteInBranch, NotIdle, NotRunning,
  PathDiverged, Pin, PinMismatch, Refuse, Requested, Resumed, RetryUnavailable,
  RunScript, Running, Script, Sent, Sum, Tokens, TopK, TopOnly, Union,
  UnknownAlias, Usage, Usd, User, ViewSpec, Workflow, WriteNotAllowed,
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

fn failed(id, error) {
  types.AgentFailed(id, error, support.usage(), "fake/model")
}

fn idle(id, message) {
  AgentIdle(id, message, support.usage(), "fake/model")
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
  let assert [Refuse(None, InvalidDeclaration(reason))] = last([no_default])
  assert string.contains(reason, "judge")
}

pub fn start_rejects_view_of_unknown_field_test() {
  let wf = workflow([], [agent("a", view(["ghost"]), [])])
  let assert [Refuse(None, InvalidDeclaration(reason))] = last([started(wf)])
  assert string.contains(reason, "ghost")
}

// --- Calls, writes, journal ---

pub fn call_emits_call_agent_with_view_test() {
  let assert [
    CallAgent(
      id: "#0",
      agent: "worker",
      model: "fake/model",
      view:,
      transcript: [],
      ..,
    ),
  ] = last([started(basic()), call("#0", "worker", JInt(1))])
  assert view == "<field name=\"runs\">\n</field>"
  assert status_after([started(basic()), call("#0", "worker", JInt(1))])
    == Some(Running)
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
  let assert [Deliver("#0", _)] = last(events)
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
      "fake/model",
    ),
  ]
  assert last(events)
    == [Refuse(Some("#0"), WriteNotAllowed("worker", "other"))]
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
      "fake/model",
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
  assert state_of(events, "errors") == JArray([JString("A")])
  let assert [CallAgent(view:, ..)] = last(list.take(events, 3))
  assert !string.contains(view, "\"A\"")
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
  assert last(events)
    == [Refuse(Some("#0.a#0"), NonCommutativeWriteInBranch("runs", "a"))]
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

pub fn agent_failure_is_journaled_and_typed_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JNull),
    failed("#0", "maxTurns exceeded"),
  ]
  assert last(events)
    == [Fail("#0", AgentGaveUp("worker", "maxTurns exceeded"))]
  assert snapshot_get(replay(events).0, "nodes")
    == JArray([
      value.object([
        #("id", JString("#0")),
        #("agent", JString("worker")),
        #("model", JString("fake/model")),
        #(
          "status",
          value.object([
            #("type", JString("node_done")),
            #(
              "outcome",
              value.object([
                #("type", JString("gave_up")),
                #("error", JString("maxTurns exceeded")),
              ]),
            ),
          ]),
        ),
      ]),
    ])
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
  let assert [Finish(Done(JInt(1)))] =
    last([started(basic()), types.BodyFinished(JInt(1))])
}

pub fn body_failure_is_typed_test() {
  let reason = types.BodyError("TypeError: x is undefined")
  assert last([started(basic()), types.BodyFailed(reason)])
    == [Finish(types.Failed(reason))]
}

// --- Cancel ---

pub fn cancel_finishes_and_later_events_are_refused_test() {
  let events = [started(basic()), call("#0", "worker", JNull), CancelRequested]
  assert last(events) == [Finish(Cancelled)]
  assert status_after(events) == Some(Finished(Cancelled))
  assert last(list.append(events, [returned("#0", summary("late"))]))
    == [Refuse(None, NotRunning)]
}

// --- Questions: ending a turn without a result ---

fn asked() {
  [started(basic()), call("#0", "worker", JNull), idle("#0", "Which dataset?")]
}

pub fn agent_ending_turn_without_result_idles_its_node_test() {
  assert last(asked()) == []
  assert status_after(asked()) == Some(Idle(None))
  assert support.node(replay(asked()).0, 0) |> value.get("status")
    == Some(
      value.object([
        #("type", JString("node_idle")),
        #("last_message", JString("Which dataset?")),
      ]),
    )
}

pub fn send_continues_the_same_conversation_test() {
  let events = list.append(asked(), [Sent("#0", "the 2024 one", "m1")])
  let assert [CallAgent(id: "#0", transcript:, ..)] = last(events)
  assert transcript
    == [Message(Assistant, "Which dataset?"), Message(User, "the 2024 one")]
  assert status_after(events) == Some(Running)
  let done = list.append(events, [returned("#0", summary("s"))])
  let assert [Deliver("#0", _)] = last(done)
}

pub fn send_to_a_node_that_is_not_idle_is_refused_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JNull),
    Sent("#0", "hi", "m1"),
  ]
  assert last(events) == [Refuse(None, NotIdle("#0"))]
  let #(_, _, log) = replay(events)
  assert list.length(log) == 2
}

/// Killed after the send was logged: the replay reissues the continued
/// call with the whole transcript, and the log ends equal.
pub fn question_send_survives_a_kill_test() {
  let whole =
    list.append(asked(), [
      Sent("#0", "the 2024 one", "m1"),
      returned("#0", summary("s")),
      types.BodyFinished(JNull),
    ])
  let #(expected, _, expected_log) = replay(whole)
  let #(s, _, log) =
    replay(list.append(asked(), [Sent("#0", "the 2024 one", "m1")]))
  let #(s, effects) = run.step(s, Resumed(pin()))
  assert effects == []
  let #(s, effects) = run.step(s, call("#0", "worker", JNull))
  let assert [CallAgent(transcript: [_, Message(User, "the 2024 one")], ..)] =
    effects
  let #(s, _, log2) =
    replay_from(s, [returned("#0", summary("s")), types.BodyFinished(JNull)])
  assert list.append(log, log2) == expected_log
  assert run.snapshot(s) == run.snapshot(expected)
}

pub fn replaying_an_idle_node_does_nothing_test() {
  let #(s, _, _) = replay(asked())
  let #(_, effects) = run.step(s, call("#0", "worker", JNull))
  assert effects == []
}

// --- Budget: exhaustion pauses ---

fn budgeted(budget) {
  Workflow(..basic(), budget:)
}

pub fn exhausted_budget_pauses_then_raise_continues_test() {
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
  assert last(events) == []
  assert status_after(events)
    == Some(Idle(Some(BudgetExhausted(Usd, 0.5, 0.5))))
  // The paused call is logged; replay leaves it paused.
  let #(s, _, log) = replay(events)
  assert list.length(log) == 4
  let #(_, effects) = run.step(s, call("#1", "worker", JNull))
  assert effects == []
  let raised = list.append(events, [BudgetRaised(Usd, 1.0)])
  let assert [CallAgent(id: "#1", ..)] = last(raised)
  assert status_after(raised) == Some(Running)
  // A raise that is not enough leaves it paused.
  let assert [] = last(list.append(events, [BudgetRaised(Usd, 0.4)]))
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
    types.AgentReturned("#0", summary("s"), [], Usage(0.0, 0, 2), "fake/model"),
    call("#1", "worker", JNull),
  ]
  let assert [CallAgent(max_turns: 1, ..)] = last(events)
}

pub fn token_budget_pauses_test() {
  let wf =
    budgeted(Budget(
      usd: None,
      tokens: Some(100),
      turns: None,
      compute_minutes: None,
    ))
  let events = [
    started(wf),
    call("#0", "worker", JNull),
    returned("#0", summary("s")),
    call("#1", "worker", JNull),
  ]
  assert status_after(events)
    == Some(Idle(Some(BudgetExhausted(Tokens, 100.0, 100.0))))
}

pub fn compute_minutes_pass_to_scripts_and_pause_test() {
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
  assert status_after(events)
    == Some(Idle(Some(BudgetExhausted(ComputeMinutes, 10.0, 10.0))))
  let assert [RunScript(id: "#1", compute_minutes: Some(5.0), ..)] =
    last(list.append(events, [BudgetRaised(ComputeMinutes, 15.0)]))
}

// --- Models: rebinding mid-run ---

pub fn alias_rebind_reaches_later_calls_only_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JNull),
    returned("#0", summary("s0")),
    AliasRebound("default", "fake/model", "other/model"),
    call("#1", "worker", JNull),
  ]
  let assert [CallAgent(id: "#1", model: "other/model", ..)] = last(events)
  let #(s, _, log) = replay(events)
  assert list.length(log) == 5
  // Each node records the model it ran on.
  assert support.node(s, 0) |> value.get("model") == Some(JString("fake/model"))
  assert support.node(s, 1) |> value.get("model")
    == Some(JString("other/model"))
  // The completed call is answered from the journal, not re-executed.
  let #(s, _) = run.step(s, Resumed(pin()))
  let #(_, effects) = run.step(s, call("#0", "worker", JNull))
  assert effects == [Deliver("#0", summary("s0"))]
}

pub fn rebinding_an_unknown_alias_is_refused_test() {
  assert last([started(basic()), AliasRebound("nope", "", "x/y")])
    == [Refuse(None, UnknownAlias("nope"))]
}

pub fn idle_node_continues_with_the_new_model_test() {
  let events =
    list.append(asked(), [
      AliasRebound("default", "fake/model", "other/model"),
      Sent("#0", "yes", "m1"),
    ])
  let assert [CallAgent(id: "#0", model: "other/model", ..)] = last(events)
}

pub fn resume_accepts_a_changed_alias_table_test() {
  let #(s, _, _) = replay(asked())
  let other =
    Pin(..pin(), models: dict.from_list([#("default", "other/model")]))
  let #(s, effects) = run.step(s, Resumed(other))
  assert effects == []
  // Bindings change only through AliasRebound.
  assert snapshot_get(s, "models.default") == JString("fake/model")
}

// --- Executor errors are not agent failures ---

pub fn executor_error_pauses_and_retry_reissues_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JNull),
    ExecutorFailed("#0", "HTTP 412 account suspended"),
  ]
  assert last(events) == []
  assert status_after(events)
    == Some(
      Idle(Some(ExecutorUnavailable("default", "HTTP 412 account suspended"))),
    )
  // A replay alone does not reissue it.
  let #(s, _, _) = replay(events)
  let #(s, _) = run.step(s, Resumed(pin()))
  let #(s, effects) = run.step(s, call("#0", "worker", JNull))
  assert effects == []
  // After a rebind, the retry reissues it with the new model.
  let #(s, _) =
    run.step(s, AliasRebound("default", "fake/model", "other/model"))
  let #(s, effects) = run.step(s, RetryUnavailable)
  let assert [Checkpoint, CallAgent(id: "#0", model: "other/model", ..)] =
    effects
  let #(_, effects) =
    run.step(
      s,
      types.AgentReturned(
        "#0",
        summary("s"),
        [],
        support.usage(),
        "other/model",
      ),
    )
  let assert [Checkpoint, Deliver("#0", _)] = effects
}

pub fn retry_without_unavailable_calls_logs_nothing_test() {
  let #(s, _, _) = replay([started(basic())])
  let #(_, effects) = run.step(s, RetryUnavailable)
  assert effects == []
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
  assert state_of(prefix, "findings") == JArray([])
  let merged =
    value.object([
      #("items", JArray([JString("ab"), JString("c"), JString("x")])),
      #("archived", JArray([JString("a")])),
    ])
  let events = list.append(prefix, [returned("#0/merge/findings", merged)])
  let assert [Deliver("#0", _)] = last(events)
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
  let assert [Deliver("#1", _)] = last(events)
  assert state_of(events, "findings") == JArray([JString("b"), JString("c")])
  assert state_of(events, "archive") == JArray([JString("a")])
  assert snapshot_get(replay(events).0, "merge_calls.findings") == JInt(1)
}

pub fn llm_merge_failure_falls_back_test() {
  let events = [
    started(merging(5)),
    call("#0", "worker", JNull),
    returned("#0", findings(["a", "b", "c"])),
    failed("#0/merge/findings", "bad"),
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
  let assert [
    Refuse(Some("#0.x#0"), NonCommutativeWriteInBranch("findings", "x")),
  ] = last(events)
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

pub fn resume_with_changed_input_file_is_refused_typed_test() {
  let #(s, _, _) = replay(first_run())
  let changed = Pin(..pin(), inputs: dict.from_list([#("advice.md", "a2")]))
  let #(s2, effects) = run.step(s, Resumed(changed))
  assert effects
    == [
      Refuse(
        None,
        PinMismatch(field: "inputs.advice.md", recorded: "a1", current: "a2"),
      ),
    ]
  // A refusal does not change the run.
  assert run.snapshot(s2) == run.snapshot(s)
}

pub fn resume_names_each_result_defining_field_test() {
  let #(s, _, _) = replay(first_run())
  let refusal = fn(p) {
    let assert #(_, [Refuse(None, r)]) = run.step(s, Resumed(p))
    r
  }
  assert refusal(Pin(..pin(), seed: 8)) == PinMismatch("seed", "7", "8")
  assert refusal(Pin(..pin(), workflow_digest: "wf2"))
    == PinMismatch("workflow_digest", "wf1", "wf2")
  assert refusal(Pin(..pin(), semantics: "wallis-core/1"))
    == PinMismatch("semantics", run.semantics, "wallis-core/1")
}

pub fn replayed_request_is_answered_from_journal_test() {
  let #(s, _, _) = replay(first_run())
  let #(s, _, _) = replay_from(s, [Resumed(pin())])
  let #(s, effects) = run.step(s, call("#0", "worker", JInt(0)))
  assert effects == [Deliver("#0", summary("s0"))]
  let #(_, effects) = run.step(s, call("#1", "worker", JInt(1)))
  let assert [CallAgent(id: "#1", view:, ..)] = effects
  assert string.contains(view, "s0")
}

pub fn replay_divergence_is_refused_without_changing_the_run_test() {
  let #(s, _, _) = replay(first_run())
  let #(s2, effects) = run.step(s, call("#0", "worker", JInt(99)))
  assert effects == [Refuse(None, PathDiverged("#0"))]
  assert run.snapshot(s2) == run.snapshot(s)
}

pub fn resumed_finished_run_reports_outcome_test() {
  let #(s, _, _) = replay([started(basic()), types.BodyFinished(JInt(5))])
  let #(_, effects) = run.step(s, Resumed(pin()))
  assert effects == [Finish(Done(JInt(5)))]
}

pub fn interrupted_run_log_equals_uninterrupted_test() {
  let whole =
    list.append(first_run(), [
      returned("#1", summary("s1")),
      types.BodyFinished(JNull),
    ])
  let #(expected, _, expected_log) = replay(whole)
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
