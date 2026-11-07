import gleam/dict
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import support.{
  basic, cached, call, command, human, idle, last, nodes_after, pin, replay,
  replay_from, returned, snapshot_get, started, status_after,
}
import wallis_core/run
import wallis_core/types.{
  AgentGaveUp, AliasRebound, Answer, Assistant, Budget, BudgetRaised,
  BudgetReached, CallAgent, CancelRequested, Cancelled, CancelledByOwner,
  Checkpoint, ComputeMinutes, ContextExhausted, Deliver, Done, ExecutorFailed,
  ExecutorUnavailable, Fail, Finish, Finished, GaveUp, Idle, InboxMessage,
  InputRejected, InputTooLarge, Interrupt, InvalidDeclaration, Message, NodeDone,
  NodeFailed, NodeIdle, NodeNotRunning, NodeRunning, NotIdle, NotLive, NotOwner,
  NotRunning, NotSteerable, Pin, PinMismatch, Refuse, Restart, Resumed,
  RetryUnavailable, RunCommand, Running, Sent, Steer, Turns, UnknownAlias, Usage,
  User, Workflow,
}
import wallis_core/value.{JArray, JInt, JNull, JString}

fn summary(s) {
  value.object([#("summary", JString(s))])
}

fn failed(id, error) {
  types.AgentFailed(id, GaveUp(error), support.usage(), "fake/model")
}

fn sent(node, text) {
  Sent(node, text, "m1", human, 0)
}

// --- Start ---

pub fn start_checkpoints_and_rejects_unresolved_alias_test() {
  let #(_, effects, log) = replay([started(basic())])
  assert effects == [Checkpoint]
  assert list.length(log) == 1
  let bad =
    support.workflow([types.Agent(..support.agent("x"), model: "judge")])
  let no_default = types.Started(bad, Pin(..pin(), models: dict.new()), JNull)
  let assert [Refuse(None, InvalidDeclaration(reason))] = last([no_default])
  assert string.contains(reason, "judge")
}

pub fn start_rejects_duplicate_agents_test() {
  let wf = support.workflow([support.agent("a"), support.agent("a")])
  let assert [Refuse(None, InvalidDeclaration(_))] = last([started(wf)])
}

// --- Calls and the journal ---

pub fn call_emits_call_agent_with_its_input_test() {
  let assert [
    CallAgent(
      id: "#0",
      agent: "worker",
      model: "fake/model",
      input: JInt(1),
      transcript: [],
      note: None,
      ..,
    ),
  ] = last([started(basic()), call("#0", "worker", JInt(1))])
  assert status_after([started(basic()), call("#0", "worker", JInt(1))])
    == Some(Running)
}

pub fn a_result_reaches_the_body_only_as_its_answer_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JInt(1)),
    returned("#0", summary("s0")),
  ]
  assert last(events) == [Deliver("#0", summary("s0"))]
  let #(s, _, _) = replay(events)
  assert snapshot_get(s, "state") == JNull
}

pub fn agent_failure_is_journaled_and_typed_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JNull),
    failed("#0", "maxTurns exceeded"),
  ]
  assert last(events)
    == [Fail("#0", AgentGaveUp("worker", GaveUp("maxTurns exceeded")))]
  assert nodes_after(events)
    == [
      NodeDone(
        "#0",
        "worker",
        "fake/model",
        True,
        [],
        NodeFailed(GaveUp("maxTurns exceeded")),
      ),
    ]
}

pub fn context_exhaustion_is_a_typed_agent_failure_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JNull),
    types.AgentFailed("#0", ContextExhausted, support.usage(), "fake/model"),
  ]
  assert last(events) == [Fail("#0", AgentGaveUp("worker", ContextExhausted))]
}

pub fn an_input_too_large_for_the_window_is_a_journaled_refusal_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JNull),
    InputRejected("#0", Some("papers"), 900_000, 384_000),
  ]
  let refusal = InputTooLarge("worker", Some("papers"), 900_000, 384_000)
  assert last(events) == [Refuse(Some("#0"), refusal)]
  // Not a node: it never started a dialogue. A replay answers from the journal.
  assert nodes_after(events) == []
  let #(s, _, _) = replay(events)
  let #(_, effects) = run.step(s, call("#0", "worker", JNull))
  assert effects == [Refuse(Some("#0"), refusal)]
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

// --- Observations: monitoring only ---

pub fn observations_are_logged_once_and_never_diverge_test() {
  let events = [
    started(basic()),
    types.Observed("#0~0", "incumbent", JInt(3)),
    call("#0", "worker", JNull),
  ]
  let #(s, _, log) = replay(events)
  assert list.length(log) == 3
  assert snapshot_get(s, "observations")
    == JArray([
      value.object([
        #("at", JString("#0~0")),
        #("label", JString("incumbent")),
        #("value", JInt(3)),
      ]),
    ])
  // Replayed, even with another value: not logged again, nothing refused.
  let #(s, _) = run.step(s, Resumed(pin()))
  let #(_, effects) = run.step(s, types.Observed("#0~0", "incumbent", JInt(4)))
  assert effects == []
}

// --- Cancel ---

pub fn cancel_finishes_and_later_events_are_refused_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JNull),
    CancelRequested(human),
  ]
  assert last(events) == [Finish(Cancelled)]
  assert status_after(events) == Some(Finished(Cancelled))
  assert last(list.append(events, [returned("#0", summary("late"))]))
    == [Refuse(None, NotRunning)]
}

// --- Answering: ending a turn without a result ---

fn asked() {
  [started(basic()), call("#0", "worker", JNull), idle("#0", "Which dataset?")]
}

pub fn agent_ending_turn_without_result_idles_its_node_test() {
  assert last(asked()) == []
  assert status_after(asked()) == Some(Idle(None))
  assert nodes_after(asked())
    == [
      NodeIdle(
        "#0",
        "worker",
        "fake/model",
        True,
        [],
        types.Question("Which dataset?"),
      ),
    ]
}

pub fn an_answer_continues_the_same_dialogue_and_is_in_the_inbox_test() {
  let events = list.append(asked(), [sent("#0", "the 2024 one")])
  let assert [CallAgent(id: "#0", transcript:, ..)] = last(events)
  assert transcript
    == [Message(Assistant, "Which dataset?"), Message(User, "the 2024 one")]
  assert status_after(events) == Some(Running)
  let done = list.append(events, [returned("#0", summary("s"))])
  let assert [Deliver("#0", _)] = last(done)
  // The journal entry records which messages arrived, at which step.
  let assert [NodeDone(inbox:, ..)] = nodes_after(done)
  assert inbox == [InboxMessage(Answer, "the 2024 one", 1)]
}

pub fn an_answer_to_a_node_that_is_not_idle_is_refused_test() {
  let events = [started(basic()), call("#0", "worker", JNull), sent("#0", "hi")]
  assert last(events) == [Refuse(None, NotIdle("#0"))]
  let #(_, _, log) = replay(events)
  assert list.length(log) == 2
}

/// Killed after the answer was logged: the replay reissues the continued
/// call with the whole transcript, and the log ends equal.
pub fn an_answer_survives_a_kill_test() {
  let whole =
    list.append(asked(), [
      sent("#0", "the 2024 one"),
      returned("#0", summary("s")),
      types.BodyFinished(JNull),
    ])
  let #(expected, _, expected_log) = replay(whole)
  let #(s, _, log) = replay(list.append(asked(), [sent("#0", "the 2024 one")]))
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

// --- Ownership: re-checked when an intervention is applied ---

pub fn interventions_need_the_owner_or_the_human_test() {
  let events = list.append(asked(), [types.Claimed("harness:a")])
  assert last(list.append(events, [Sent("#0", "x", "m1", "harness:b", 0)]))
    == [Refuse(None, NotOwner("harness:b", Some("harness:a")))]
  let assert [CallAgent(..)] =
    last(list.append(events, [Sent("#0", "x", "m1", "harness:a", 0)]))
  let assert [CallAgent(..)] =
    last(list.append(events, [Sent("#0", "x", "m1", human, 0)]))
  assert last(list.append(events, [types.PauseRequested("harness:b")]))
    == [Refuse(None, NotOwner("harness:b", Some("harness:a")))]
  // An unowned run is the human's only.
  assert last([started(basic()), CancelRequested("harness:a")])
    == [Refuse(None, NotOwner("harness:a", None))]
}

pub fn claim_is_logged_and_works_on_finished_runs_test() {
  let events = [started(basic()), types.Claimed("harness:a")]
  let #(s, effects, log) = replay(events)
  assert effects == [Checkpoint]
  assert list.length(log) == 2
  assert snapshot_get(s, "owner") == JString("harness:a")
  let #(s, _, _) =
    replay_from(s, [types.BodyFinished(JNull), types.Claimed("harness:b")])
  assert snapshot_get(s, "owner") == JString("harness:b")
}

// --- Steering, interrupt, restart, cancel ---

pub fn steering_a_running_node_is_logged_and_joins_its_dialogue_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JNull),
    types.Steered("#0", "focus on recall", "m1", human),
  ]
  let #(s, effects, log) = replay(events)
  assert effects == [Checkpoint]
  assert list.length(log) == 3
  // A reissue after a kill carries the steering message.
  let #(s2, _) = run.step(s, Resumed(pin()))
  let assert #(
    _,
    [CallAgent(transcript: [Message(User, "focus on recall")], ..)],
  ) = run.step(s2, call("#0", "worker", JNull))
  let done = list.append(events, [returned("#0", summary("recall first"))])
  let assert [Deliver("#0", _)] = last(done)
  let assert [NodeDone(inbox: [InboxMessage(Steer, "focus on recall", 0)], ..)] =
    nodes_after(done)
  // Steering a node that is not running is refused.
  assert last(list.append(done, [types.Steered("#0", "late", "m2", human)]))
    == [Refuse(None, NodeNotRunning("#0"))]
}

pub fn a_non_steerable_node_refuses_steer_interrupt_and_answers_test() {
  let running = [started(basic()), call("#0", "judge", JNull)]
  assert last(list.append(running, [types.Steered("#0", "x", "m", human)]))
    == [Refuse(None, NotSteerable("#0"))]
  assert last(list.append(running, [types.Interrupted("#0", human)]))
    == [Refuse(None, NotSteerable("#0"))]
  let asking = list.append(running, [idle("#0", "?")])
  assert last(list.append(asking, [sent("#0", "x")]))
    == [Refuse(None, NotSteerable("#0"))]
  assert nodes_after(running)
    == [NodeRunning("#0", "judge", "fake/model", False, [])]
  // It accepts cancel, and a restart without a note.
  let assert [CallAgent(id: "#0", note: None, ..)] =
    last(list.append(asking, [types.Restarted("#0", None, human, 0)]))
  assert last(
      list.append(asking, [types.Restarted("#0", Some("hint"), human, 0)]),
    )
    == [Refuse(None, NotSteerable("#0"))]
  let assert [Fail("#0", AgentGaveUp("judge", CancelledByOwner))] =
    last(list.append(asking, [types.NodeCancelled("#0", human)]))
}

pub fn interrupt_is_logged_for_a_running_steerable_node_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JNull),
    types.Interrupted("#0", human),
  ]
  let #(_, effects, log) = replay(events)
  assert effects == [Checkpoint]
  assert list.length(log) == 3
  let assert [NodeRunning(inbox: [InboxMessage(Interrupt, "", 0)], ..)] =
    nodes_after(events)
  assert last([started(basic()), types.Interrupted("#9", human)])
    == [Refuse(None, NodeNotRunning("#9"))]
}

pub fn restart_discards_progress_and_reissues_with_the_note_test() {
  let events =
    list.append(asked(), [
      types.Restarted("#0", Some("use the 2024 data"), human, 0),
    ])
  let assert [
    CallAgent(id: "#0", input: JNull, transcript: [], note: Some(note), ..),
  ] = last(events)
  assert note == "use the 2024 data"
  let #(s, _, log) = replay(events)
  assert list.length(log) == 4
  // Killed after the restart: the reissue carries the note, not the old dialogue.
  let #(s, _) = run.step(s, Resumed(pin()))
  let assert #(_, [CallAgent(transcript: [], note: Some(_), ..)]) =
    run.step(s, call("#0", "worker", JNull))
  let done = list.append(events, [returned("#0", summary("s"))])
  let assert [
    NodeDone(inbox: [InboxMessage(Restart, "use the 2024 data", 1)], ..),
  ] = nodes_after(done)
  // A done node has nothing to restart.
  assert last(list.append(done, [types.Restarted("#0", None, human, 0)]))
    == [Refuse(None, NotLive("#0"))]
}

pub fn pause_holds_new_calls_until_resume_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JNull),
    types.PauseRequested(human),
    returned("#0", summary("s0")),
    call("#1", "worker", JNull),
  ]
  // The in-flight call finished; the new one is held.
  assert last(events) == []
  assert status_after(events) == Some(Idle(Some(types.PausedByUser)))
  let resumed = list.append(events, [types.ResumeRequested(human)])
  let assert [CallAgent(id: "#1", ..)] = last(resumed)
  assert status_after(resumed) == Some(Running)
}

pub fn cancelling_a_node_fails_it_for_the_body_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JNull),
    types.NodeCancelled("#0", human),
  ]
  assert last(events) == [Fail("#0", AgentGaveUp("worker", CancelledByOwner))]
  // A late result is ignored.
  assert last(list.append(events, [returned("#0", summary("late"))])) == []
  assert last([started(basic()), types.NodeCancelled("#0", human)])
    == [Refuse(None, NotLive("#0"))]
}

// --- Budget: exhaustion pauses ---

fn budgeted(budget) {
  Workflow(..basic(), budget:)
}

pub fn a_reached_turn_budget_admits_no_new_call_and_lets_in_flight_ones_finish_test() {
  let wf = budgeted(Budget(turns: Some(1), compute_minutes: None))
  let events = [
    started(wf),
    call("#0.a#0", "worker", JNull),
    call("#0.b#0", "worker", JNull),
    returned("#0.a#0", summary("a")),
    call("#0.a#1", "worker", JNull),
  ]
  // The budget is reached: the new call is held, the run stays running for the one in flight.
  assert last(events) == []
  assert status_after(events) == Some(Running)
  // The call in flight finishes normally, overshooting the budget by its turn.
  let done = list.append(events, [returned("#0.b#0", summary("b"))])
  let assert [Deliver("#0.b#0", _)] = last(done)
  assert status_after(done) == Some(Idle(Some(BudgetReached(Turns, 2.0, 1.0))))
  let #(s, _, log) = replay(done)
  assert snapshot_get(s, "spent.turns") == JInt(2)
  assert list.length(log) == 6
  // The owner raises it: the held call is issued.
  let raised = list.append(done, [BudgetRaised(Turns, 10.0)])
  let assert [CallAgent(id: "#0.a#1", ..)] = last(raised)
  // A raise that is not enough leaves it held.
  let assert [] = last(list.append(done, [BudgetRaised(Turns, 2.0)]))
}

pub fn usd_and_tokens_are_recorded_and_never_hold_a_call_test() {
  let events = [
    started(basic()),
    call("#0", "worker", JNull),
    types.AgentReturned(
      "#0",
      summary("s"),
      Usage(999.5, 10_000_000, 1),
      "fake/model",
    ),
    call("#1", "worker", JNull),
  ]
  let assert [CallAgent(id: "#1", ..)] = last(events)
  let #(s, _, _) = replay(events)
  assert snapshot_get(s, "spent.usd") == value.JFloat(999.5)
  assert snapshot_get(s, "budget")
    == value.object([#("compute_minutes", JNull), #("turns", JNull)])
}

pub fn a_call_carries_its_turns_so_far_and_its_allowance_test() {
  let assert [CallAgent(turn: 0, turn_limit: 8, ..)] =
    last([started(basic()), call("#0", "worker", JNull)])
  // Continued after a question: the turns used so far come along.
  let assert [CallAgent(turn: 1, turn_limit: 8, ..)] =
    last(list.append(asked(), [sent("#0", "yes")]))
}

fn at_limit() {
  [
    started(basic()),
    call("#0", "worker", JNull),
    types.TurnLimitReached("#0", 8, 8, Usage(0.0, 0, 8), "fake/model"),
  ]
}

pub fn reaching_the_turn_limit_idles_the_node_with_its_progress_test() {
  assert last(at_limit()) == []
  assert status_after(at_limit()) == Some(Idle(None))
  assert nodes_after(at_limit())
    == [
      NodeIdle("#0", "worker", "fake/model", True, [], types.TurnLimit(8, 8)),
    ]
}

pub fn more_turns_with_an_answer_continue_the_node_test() {
  // An answer without turns is refused: the node would stop again at once.
  assert last(list.append(at_limit(), [sent("#0", "go on")]))
    == [Refuse(None, types.NoTurnsLeft("#0"))]
  let events = list.append(at_limit(), [Sent("#0", "go on", "m1", human, 5)])
  let assert [CallAgent(id: "#0", turn: 8, turn_limit: 13, transcript:, ..)] =
    last(events)
  assert transcript == [Message(User, "go on")]
  let done = list.append(events, [returned("#0", summary("s"))])
  let assert [Deliver("#0", _)] = last(done)
  // Replay of the log reaches the same run.
  let #(live, _, log) = replay(done)
  let #(refolded, _, _) = replay(log)
  assert run.snapshot(live) == run.snapshot(refolded)
  // A restart resets the allowance to the agent's maxTurns.
  let restarted =
    list.append(at_limit(), [types.Restarted("#0", None, human, 0)])
  let assert [CallAgent(turn: 0, turn_limit: 8, ..)] = last(restarted)
}

pub fn compute_minutes_pass_to_commands_and_pause_test() {
  let wf = budgeted(Budget(turns: None, compute_minutes: Some(10.0)))
  let assert [RunCommand(compute_minutes: Some(10.0), ..)] =
    last([started(wf), command("#0", JNull)])
  let events = [
    started(wf),
    command("#0", JNull),
    types.CommandReturned("#0", JInt(1), 10.0),
    command("#1", JNull),
  ]
  assert status_after(events)
    == Some(Idle(Some(BudgetReached(ComputeMinutes, 10.0, 10.0))))
  let assert [RunCommand(id: "#1", compute_minutes: Some(5.0), ..)] =
    last(list.append(events, [BudgetRaised(ComputeMinutes, 15.0)]))
}

// --- Commands: nodes without a dialogue ---

pub fn a_command_is_a_node_running_then_done_test() {
  let events = [started(basic()), command("#0", JInt(3))]
  let assert [RunCommand(id: "#0", command: "train", input: JInt(3), ..)] =
    last(events)
  assert nodes_after(events) == [types.CommandRunning("#0", "train", [])]
  let done = list.append(events, [types.CommandReturned("#0", JInt(9), 1.0)])
  assert last(done) == [Deliver("#0", JInt(9))]
  assert nodes_after(done)
    == [types.CommandDone("#0", "train", [], types.Succeeded)]
}

pub fn a_command_failure_is_typed_test() {
  let failure = types.ExitCode(2, "Traceback: boom")
  let events = [
    started(basic()),
    command("#0", JNull),
    types.CommandFailed("#0", failure, 0.5),
  ]
  assert last(events) == [Fail("#0", types.CommandCrashed("train", failure))]
  assert nodes_after(events)
    == [types.CommandDone("#0", "train", [], types.FailedWith(failure))]
}

pub fn a_command_takes_restart_and_cancel_but_no_dialogue_test() {
  let running = [started(basic()), command("#0", JInt(3))]
  assert last(list.append(running, [sent("#0", "hi")]))
    == [Refuse(None, types.NotAnAgent("#0"))]
  assert last(list.append(running, [types.Steered("#0", "x", "m", human)]))
    == [Refuse(None, types.NotAnAgent("#0"))]
  assert last(
      list.append(running, [types.Restarted("#0", Some("n"), human, 0)]),
    )
    == [Refuse(None, types.NotAnAgent("#0"))]
  // A restart reruns it with the same input.
  let restarted = list.append(running, [types.Restarted("#0", None, human, 0)])
  let assert [RunCommand(id: "#0", input: JInt(3), ..)] = last(restarted)
  let assert [types.CommandRunning(inbox: [InboxMessage(Restart, "", 0)], ..)] =
    nodes_after(restarted)
  assert last(list.append(running, [types.NodeCancelled("#0", human)]))
    == [Fail("#0", types.CommandCrashed("train", types.CommandCancelled))]
}

pub fn a_nested_workflow_failure_round_trips_test() {
  let reason =
    types.WorkflowFailed(
      "tune",
      types.CommandCrashed("train", types.TimedOut(5.0)),
    )
  assert last([started(basic()), types.BodyFailed(reason)])
    == [Finish(types.Failed(reason))]
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
      sent("#0", "yes"),
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
      types.AgentReturned("#0", summary("s"), support.usage(), "other/model"),
    )
  let assert [Checkpoint, Deliver("#0", _)] = effects
}

pub fn retry_without_unavailable_calls_logs_nothing_test() {
  let #(s, _, _) = replay([started(basic())])
  let #(_, effects) = run.step(s, RetryUnavailable)
  assert effects == []
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
  assert refusal(Pin(..pin(), semantics: "wallis-core/1"))
    == PinMismatch("semantics", run.semantics, "wallis-core/1")
  assert refusal(
      Pin(
        ..pin(),
        inputs: dict.from_list([#("advice.md", "a1"), #("mount.kb", "d")]),
      ),
    )
    == PinMismatch("inputs.mount.kb", "<absent>", "d")
}

pub fn replayed_request_is_answered_from_journal_test() {
  let #(s, _, _) = replay(first_run())
  let #(s, _, _) = replay_from(s, [Resumed(pin())])
  let #(s, effects) = run.step(s, call("#0", "worker", JInt(0)))
  assert effects == [Deliver("#0", summary("s0"))]
  let #(_, effects) = run.step(s, call("#1", "worker", JInt(1)))
  let assert [CallAgent(id: "#1", input: JInt(1), ..)] = effects
}

// --- The journal is a cache: (node digest, input, occurrence) ---

fn ok(id, result) {
  types.AgentReturned(id, JString(result), support.usage(), "fake/model")
}

pub fn a_changed_input_misses_an_unchanged_one_hits_whatever_the_id_test() {
  let first = [
    started(basic()),
    cached("#0", "plan", JInt(1), 0),
    ok("#0", "p"),
    cached("#1", "write", JString("p"), 0),
    ok("#1", "w"),
  ]
  let #(s, _, _) = replay(first)
  let #(s, _) = run.step(s, Resumed(pin()))
  // An inserted node runs; its neighbours still hit under their new ids.
  let #(s, effects) = run.step(s, cached("#0", "check", JNull, 0))
  let assert [CallAgent(id: "#0", ..)] =
    list.filter(effects, fn(e) { e != Checkpoint })
  let #(s, _) = run.step(s, ok("#0", "c"))
  let #(s, effects) = run.step(s, cached("#1", "plan", JInt(1), 0))
  assert effects == [Deliver("#1", JString("p"))]
  // A changed upstream result changes the downstream input: a miss.
  let #(_, effects) = run.step(s, cached("#2", "write", JString("other"), 0))
  let assert [Checkpoint, CallAgent(..)] = effects
  // An unchanged result keeps the downstream hit.
  let #(_, effects) = run.step(s, cached("#2", "write", JString("p"), 0))
  assert effects == [Deliver("#2", JString("w"))]
}

pub fn a_changed_node_definition_misses_test() {
  let #(s, _, _) =
    replay([
      started(basic()),
      cached("#0", "plan-v1", JInt(1), 0),
      ok("#0", "p"),
    ])
  let #(_, effects) = run.step(s, cached("#0", "plan-v2", JInt(1), 0))
  let assert [Checkpoint, CallAgent(..)] = effects
}

pub fn identical_calls_get_their_own_recorded_results_by_occurrence_test() {
  let events = [
    started(basic()),
    cached("#0.0#0", "n", JNull, 0),
    cached("#0.1#0", "n", JNull, 1),
    cached("#0.2#0", "n", JNull, 2),
    ok("#0.1#0", "b"),
    ok("#0.0#0", "a"),
    ok("#0.2#0", "c"),
  ]
  let #(_, _, log) = replay(events)
  let #(refolded, _, _) = replay(log)
  let #(s, _) = run.step(refolded, Resumed(pin()))
  // Issue order may differ (ids too): occurrence n gets the nth result.
  let #(s, e0) = run.step(s, cached("x", "n", JNull, 0))
  let #(s, e1) = run.step(s, cached("y", "n", JNull, 1))
  let #(_, e2) = run.step(s, cached("z", "n", JNull, 2))
  assert [e0, e1, e2]
    == [
      [Deliver("x", JString("a"))],
      [Deliver("y", JString("b"))],
      [Deliver("z", JString("c"))],
    ]
}

pub fn a_crash_resume_reissues_only_what_was_in_flight_and_logs_a_moved_id_test() {
  let #(s, _, _) = replay([started(basic()), cached("#0.a#0", "n", JInt(1), 0)])
  let #(s, _) = run.step(s, Resumed(pin()))
  // The same call under another id (a reordered parallel): the record moves, logged, and is reissued once.
  let #(s, effects) = run.step(s, cached("#0.b#0", "n", JInt(1), 0))
  let assert [Checkpoint, CallAgent(id: "#0.b#0", ..)] = effects
  let #(_, effects) = run.step(s, cached("#0.b#0", "n", JInt(1), 0))
  assert effects == []
}

pub fn a_code_change_is_logged_and_never_refused_test() {
  let #(s, _, _) = replay(first_run())
  let #(s, effects) = run.step(s, types.CodeChanged("wf1", "wf2"))
  assert effects == [Checkpoint]
  let #(s, effects) = run.step(s, Resumed(Pin(..pin(), workflow_digest: "wf2")))
  assert effects == []
  assert snapshot_get(s, "status.type") == JString("running")
}

// --- An uncaught node failure holds the run ---

fn held_events() {
  [
    started(basic()),
    call("#0.a#0", "worker", JNull),
    call("#0.b#0", "worker", JInt(1)),
    failed("#0.a#0", "bad output"),
    types.BodyFailed(AgentGaveUp("worker", GaveUp("bad output"))),
  ]
}

pub fn an_uncaught_failure_holds_its_node_and_siblings_continue_test() {
  assert last(held_events()) == []
  // The sibling is still running.
  assert status_after(held_events()) == Some(Running)
  let done = list.append(held_events(), [returned("#0.b#0", summary("b"))])
  assert status_after(done)
    == Some(
      Idle(
        Some(types.NodeFailure(
          "#0.a#0",
          AgentGaveUp("worker", GaveUp("bad output")),
        )),
      ),
    )
}

pub fn restarting_a_held_node_reissues_it_and_the_body_runs_again_test() {
  let done = list.append(held_events(), [returned("#0.b#0", summary("b"))])
  let restarted =
    list.append(done, [types.Restarted("#0.a#0", Some("fix it"), human, 0)])
  let assert [CallAgent(id: "#0.a#0", note: Some("fix it"), ..)] =
    last(restarted)
  let fixed = list.append(restarted, [returned("#0.a#0", summary("a"))])
  // The body runs again against the journal: both calls hit.
  let #(s, _, _) = replay(fixed)
  let #(s, e) = run.step(s, call("#0.a#0", "worker", JNull))
  assert e == [Deliver("#0.a#0", summary("a"))]
  let #(_, e) = run.step(s, call("#0.b#0", "worker", JInt(1)))
  assert e == [Deliver("#0.b#0", summary("b"))]
}

pub fn cancelling_a_held_node_lets_the_failure_propagate_test() {
  let reason = AgentGaveUp("worker", GaveUp("bad output"))
  let events =
    list.append(held_events(), [types.NodeCancelled("#0.a#0", human)])
  assert last(events) == [Finish(types.Failed(reason))]
}

pub fn a_failure_the_owner_cancelled_ends_the_run_test() {
  let reason = AgentGaveUp("worker", CancelledByOwner)
  assert last([started(basic()), types.BodyFailed(reason)])
    == [Finish(types.Failed(reason))]
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
