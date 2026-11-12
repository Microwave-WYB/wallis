import gleam/list
import gleam/option.{None, Some}
import gleam/string
import support.{
  agent, agent_returned, command, command_in, last, log, nested, replay,
  replay_from, resumed, returned, session_of, started,
}
import wallis_core/ids
import wallis_core/run
import wallis_core/types.{
  AgentError, AgentFailed, AgentProgressed, CallAgent, Checkpoint,
  CommandError, CommandFailed, Deliver, Delivered, Done, Envelope, ExitCode,
  Fail, Failed, Finish, MessagesTaken, NotRunning, NotStarted, Refuse,
  RunCommand, RunEnded, RunWorkflow, Sent, SessionOfAnotherAgent, Taken,
  TurnLimitReached, UnknownRequest, UnknownSession, WorkflowError,
  WorkflowFailed, WorkflowReturned,
}
import wallis_core/value.{JInt, JNull, JString}

fn out(n) {
  value.object([#("n", JInt(n))])
}

// --- Start ---

pub fn start_is_logged_and_nothing_runs_before_it_test() {
  let #(_, effects, log) = replay([started()])
  assert effects == [Checkpoint]
  assert list.length(log) == 1
  assert last([command("0", "c", JNull, 0)])
    == [Refuse(None, NotStarted)]
}

// --- Calls and the journal ---

pub fn a_command_runs_then_answers_test() {
  assert last([started(), command("0", "c", JInt(1), 0)])
    == [Checkpoint, RunCommand("0", 1)]
  assert last([started(), command("0", "c", JInt(1), 0), returned("0", out(1))])
    == [Checkpoint, Deliver("0", out(1))]
}

pub fn a_command_failure_is_typed_test() {
  let failure = ExitCode(2, "boom")
  assert last([
      started(),
      command("0", "c", JNull, 0),
      CommandFailed("0", failure),
    ])
    == [Checkpoint, Fail("0", CommandError("c", failure))]
}

pub fn a_result_for_an_unknown_or_settled_call_is_refused_test() {
  assert last([started(), returned("9", JNull)])
    == [Refuse(Some("9"), UnknownRequest("9"))]
  assert last([
      started(),
      command("0", "c", JNull, 0),
      returned("0", JNull),
      returned("0", JNull),
    ])
    == [Refuse(Some("0"), NotRunning("0"))]
  // A command's result never settles a workflow call.
  assert last([started(), nested("0", "w", JNull), returned("0", JNull)])
    == [Refuse(Some("0"), NotRunning("0"))]
}

pub fn the_body_finishing_ends_the_run_test() {
  let events = [started(), types.BodyFinished(out(3))]
  assert last(events) == [Checkpoint, Finish(Done(out(3)))]
  assert last(list.append(events, [command("0", "c", JNull, 0)]))
    == [Refuse(None, RunEnded)]
}

pub fn the_body_failing_ends_the_run_typed_test() {
  let reason = types.BodyError("x")
  assert last([started(), types.BodyFailed(reason)])
    == [Checkpoint, Finish(Failed(reason))]
}

// --- Resume ---

fn done_first() {
  [started(), command("0", "c", JInt(1), 0), returned("0", out(1))]
}

pub fn a_completed_call_is_answered_from_the_journal_on_resume_test() {
  let #(s, _, _) = replay(done_first())
  let #(_, effects, log) =
    replay_from(s, [resumed(), command("0", "c", JInt(1), 0)])
  assert effects == [Deliver("0", out(1))]
  // Only the resume is logged: a hit is not.
  assert log == [resumed()]
}

pub fn a_changed_input_or_node_misses_whatever_the_id_test() {
  let #(s, _, _) = replay(done_first())
  let #(_, effects, _) =
    replay_from(s, [resumed(), command("7", "c", JInt(2), 0)])
  assert effects == [Checkpoint, RunCommand("7", 1)]
  let #(_, effects, _) =
    replay_from(s, [resumed(), command("0", "c2", JInt(1), 0)])
  assert effects == [Checkpoint, RunCommand("0", 1)]
  // Same node and input under another id: a hit, and the move is logged.
  let #(_, effects, _) =
    replay_from(s, [resumed(), command("5", "c", JInt(1), 0)])
  assert effects == [Checkpoint, Deliver("5", out(1))]
}

pub fn identical_calls_get_their_own_results_by_occurrence_test() {
  let #(s, _, _) =
    replay([
      started(),
      command("0", "c", JNull, 0),
      command("1", "c", JNull, 1),
      returned("0", out(0)),
      returned("1", out(1)),
    ])
  let #(_, effects, _) = replay_from(s, [resumed(), command("1", "c", JNull, 1)])
  assert effects == [Deliver("1", out(1))]
  let #(_, effects, _) = replay_from(s, [command("2", "c", JNull, 2)])
  assert effects == [Checkpoint, RunCommand("2", 1)]
}

pub fn a_call_in_flight_at_a_crash_is_issued_again_once_test() {
  let #(s, _, _) = replay([started(), command("0", "c", JNull, 0)])
  // Requested again by the same process: already issued.
  let #(_, effects, _) = replay_from(s, [command("0", "c", JNull, 0)])
  assert effects == []
  // After a resume: issued again, as the same attempt, and not logged.
  let #(s2, effects, log) =
    replay_from(s, [resumed(), command("0", "c", JNull, 0)])
  assert effects == [RunCommand("0", 1)]
  assert log == [resumed()]
  let #(_, effects, _) = replay_from(s2, [command("0", "c", JNull, 0)])
  assert effects == []
}

pub fn a_failed_call_runs_again_on_resume_as_a_new_attempt_test() {
  let #(s, _, _) =
    replay([
      started(),
      command("0", "c", JNull, 0),
      CommandFailed("0", ExitCode(137, "")),
      types.BodyFailed(CommandError("c", ExitCode(137, ""))),
    ])
  let #(s, effects, _) = replay_from(s, [resumed()])
  assert effects == [Checkpoint]
  let #(s, effects, _) = replay_from(s, [command("0", "c", JNull, 0)])
  assert effects == [Checkpoint, RunCommand("0", 2)]
  assert run.attempt_count(s.state, "0") == 2
  // The journal keeps both attempts.
  let snap = string.inspect(run.snapshot(s.state))
  assert string.contains(snap, "exit_code")
}

pub fn a_completed_run_stays_completed_on_resume_test() {
  let #(s, _, _) = replay([started(), types.BodyFinished(out(1))])
  let #(_, effects, _) = replay_from(s, [resumed()])
  assert effects == [Checkpoint, Finish(Done(out(1)))]
}

pub fn an_interrupted_run_logs_what_an_uninterrupted_one_does_test() {
  let whole = [
    started(),
    command("0", "c", JInt(0), 0),
    returned("0", out(0)),
    command("1", "c", JInt(1), 0),
    returned("1", out(1)),
    types.BodyFinished(out(2)),
  ]
  let interrupted = [
    started(),
    command("0", "c", JInt(0), 0),
    returned("0", out(0)),
    command("1", "c", JInt(1), 0),
    // The process dies here; the next one runs the body again.
    resumed(),
    command("0", "c", JInt(0), 0),
    command("1", "c", JInt(1), 0),
    returned("1", out(1)),
    types.BodyFinished(out(2)),
  ]
  let without_resumes =
    list.filter(log(interrupted), fn(e) { e != resumed() })
  assert without_resumes == log(whole)
}

pub fn a_code_change_is_recorded_and_never_refused_test() {
  let #(s, _, _) = replay([started(), types.Resumed("wf2", run.semantics)])
  assert string.contains(string.inspect(run.snapshot(s.state)), "wf1")
}

pub fn host_facts_are_noted_even_after_the_end_test() {
  let #(s, effects, _) =
    replay([started(), types.BodyFinished(JNull), types.Noted("k", JInt(1))])
  assert effects == [Checkpoint]
  assert string.contains(string.inspect(run.host_facts(s.state)), "k")
}

// --- Nested workflows ---

pub fn a_nested_workflow_runs_its_body_in_its_own_scope_test() {
  let assert [Checkpoint, RunWorkflow("0", scope, 1)] =
    last([started(), nested("0", "w", JNull)])
  assert scope != ""
  // Its calls are keyed by that scope: the same call at the top is another call.
  let events = [
    started(),
    nested("0", "w", JNull),
    command_in("1", "c", JNull, scope),
    returned("1", out(1)),
    WorkflowReturned("0", out(9)),
  ]
  assert last(events) == [Checkpoint, Deliver("0", out(9))]
  let #(s, _, _) = replay(events)
  let #(_, effects, _) = replay_from(s, [command("2", "c", JNull, 0)])
  assert effects == [Checkpoint, RunCommand("2", 1)]
}

pub fn a_completed_nested_workflow_is_not_run_again_on_resume_test() {
  let #(s, _, _) =
    replay([started(), nested("0", "w", JNull), WorkflowReturned("0", out(9))])
  let #(_, effects, _) = replay_from(s, [resumed(), nested("0", "w", JNull)])
  assert effects == [Deliver("0", out(9))]
}

pub fn a_nested_workflow_in_flight_runs_again_and_its_calls_hit_test() {
  let assert [_, RunWorkflow(_, scope, _)] =
    last([started(), nested("0", "w", JNull)])
  let #(s, _, _) =
    replay([
      started(),
      nested("0", "w", JNull),
      command_in("1", "c", JNull, scope),
      returned("1", out(1)),
    ])
  let #(_, effects, _) = replay_from(s, [resumed(), nested("0", "w", JNull)])
  assert effects == [RunWorkflow("0", scope, 1)]
  let #(_, effects, _) =
    replay_from(s, [resumed(), nested("0", "w", JNull), command_in("1", "c", JNull, scope)])
  assert effects == [Deliver("1", out(1))]
}

pub fn a_nested_workflow_failure_carries_its_reason_test() {
  let inner = CommandError("c", ExitCode(1, ""))
  assert last([started(), nested("0", "w", JNull), WorkflowFailed("0", inner)])
    == [Checkpoint, Fail("0", WorkflowError("w", inner))]
}

// --- Sessions ---

fn first_session() {
  let events = [
    started(),
    agent("0", "a", None, JString("hi")),
    agent_returned("0", out(1), "d1"),
  ]
  let #(s, effects, _) = replay(events)
  let assert Some(session) = session_of(effects)
  #(s, session)
}

pub fn an_agent_call_answers_with_its_output_and_session_test() {
  let assert [Checkpoint, CallAgent(id: "0", attempt: 1, history: None, ..)] =
    last([started(), agent("0", "a", None, JNull)])
  let #(_, session) = first_session()
  assert string.starts_with(session, "s")
}

pub fn a_call_of_a_session_value_continues_its_dialogue_test() {
  let #(s, session) = first_session()
  let #(_, effects, _) =
    replay_from(s, [agent("1", "a", Some(session), JString("more"))])
  let assert [Checkpoint, CallAgent(id: "1", history: Some("d1"), ..)] = effects
}

pub fn calling_a_session_value_twice_is_a_branch_test() {
  let #(s, session) = first_session()
  let #(s, effects, _) =
    replay_from(s, [
      agent("1", "a", Some(session), JString("x")),
      agent_returned("1", out(2), "d2"),
    ])
  let assert Some(b1) = session_of(effects)
  let #(_, effects, _) =
    replay_from(s, [
      agent("2", "a", Some(session), JString("y")),
      agent_returned("2", out(3), "d3"),
    ])
  let assert Some(b2) = session_of(effects)
  assert b1 != b2
}

pub fn a_session_value_the_run_never_answered_with_is_refused_test() {
  assert last([started(), agent("0", "a", Some("sbogus"), JNull)])
    == [Refuse(Some("0"), UnknownSession("sbogus"))]
}

pub fn only_its_own_agent_continues_a_session_value_test() {
  let #(s, session) = first_session()
  let #(_, effects, _) = replay_from(s, [agent("1", "b", Some(session), JNull)])
  assert effects == [Refuse(Some("1"), SessionOfAnotherAgent(session))]
}

pub fn a_renamed_agent_continues_its_sessions_test() {
  let #(s, session) = first_session()
  let renamed =
    types.Requested(
      id: "1",
      request: types.AgentCall(name: "renamed", input: JNull, session: Some(session), from: []),
      node: "a",
      scope: "",
      occurrence: 0,
    )
  let assert [Checkpoint, CallAgent(..)] = replay_from(s, [renamed]).1
}

pub fn a_session_value_carries_its_workspace_layers_test() {
  let #(_, effects, _) =
    replay([
      started(),
      agent("0", "a", None, JNull),
      types.AgentReturned("0", JNull, "m", "d1", ["sha256:l1"]),
    ])
  let assert [_, Deliver(value: value.JObject(entries), ..)] = effects
  assert list.key_find(entries, "layers")
    == Ok(value.JArray([JString("sha256:l1")]))
  let assert Some(session) = session_of(effects)
  let #(s, _, _) =
    replay([
      started(),
      agent("0", "a", None, JNull),
      types.AgentReturned("0", JNull, "m", "d1", ["sha256:l1"]),
    ])
  let assert [_, CallAgent(layers: ["sha256:l1"], ..)] =
    replay_from(s, [agent("1", "a", Some(session), JNull)]).1
}

pub fn a_new_attempt_answers_with_a_new_session_value_test() {
  let events = [
    started(),
    agent("0", "a", None, JNull),
    AgentFailed("0", types.GaveUp("x"), "m", None, []),
    resumed(),
    agent("0", "a", None, JNull),
    agent_returned("0", out(1), "d1"),
  ]
  let assert Some(second) = session_of(last(events))
  let #(_, first) = first_session()
  assert first != second
}

pub fn a_turn_limit_fails_with_a_session_to_continue_from_test() {
  let effects =
    last([
      started(),
      agent("0", "a", None, JNull),
      AgentFailed("0", TurnLimitReached(30), "m", Some("d1"), []),
    ])
  let assert [Checkpoint, Fail("0", AgentError("a", TurnLimitReached(30), Some(_)))] =
    effects
  let assert Some(session) = session_of(effects)
  let #(s, _, _) =
    replay([
      started(),
      agent("0", "a", None, JNull),
      AgentFailed("0", TurnLimitReached(30), "m", Some("d1"), []),
    ])
  let assert [Checkpoint, CallAgent(history: Some("d1"), ..)] =
    replay_from(s, [agent("1", "a", Some(session), JNull)]).1
}

pub fn a_reissued_agent_call_resumes_from_its_newest_checkpoint_test() {
  let #(s, _, _) =
    replay([
      started(),
      agent("0", "a", None, JNull),
      AgentProgressed("0", "c1"),
      AgentProgressed("0", "c2"),
    ])
  let assert [CallAgent(attempt: 1, checkpoint: Some("c2"), ..)] =
    replay_from(s, [resumed(), agent("0", "a", None, JNull)]).1
}

pub fn the_session_hash_chain_depends_on_the_attempt_test() {
  let assert [_, CallAgent(..)] = last([started(), agent("0", "a", None, JNull)])
  let slot = ids.slot(ids.digest("a"), "agent", JNull, "", None, "0")
  assert ids.next_session(slot, 1) != ids.next_session(slot, 2)
  assert ids.next_session(slot, 1) == ids.next_session(slot, 1)
}

// --- Mailboxes ---

fn send(key, to, body) {
  Sent(key, to, "body:", None, body)
}

pub fn messages_get_ids_in_their_delivery_order_test() {
  let #(s, effects, _) =
    replay([started(), send("k1", "box", JInt(1)), send("k2", "box", JInt(2))])
  assert effects
    == [Checkpoint, Delivered("box", Envelope("box/1", "body:", None, JInt(2)))]
  assert run.mailbox(s.state, "box")
    == [
      Envelope("box/0", "body:", None, JInt(1)),
      Envelope("box/1", "body:", None, JInt(2)),
    ]
}

pub fn a_send_journaled_before_is_not_delivered_again_test() {
  let #(s, _, _) = replay([started(), send("k1", "box", JInt(1))])
  let #(s, effects, log) =
    replay_from(s, [resumed(), send("k1", "box", JInt(1))])
  assert effects == []
  assert log == [resumed()]
  assert list.length(run.mailbox(s.state, "box")) == 1
}

pub fn many_senders_share_one_order_and_replies_name_their_request_test() {
  let #(s, _, _) =
    replay([
      started(),
      Sent("w1", "coord", "w1:", None, JInt(1)),
      Sent("w2", "coord", "w2:", None, JInt(2)),
      Sent("r1", "w1:", "coord", Some("coord/0"), JString("ok")),
    ])
  let assert [Envelope("coord/0", "w1:", ..), Envelope("coord/1", "w2:", ..)] =
    run.mailbox(s.state, "coord")
  assert run.mailbox(s.state, "w1:")
    == [Envelope("w1:/0", "coord", Some("coord/0"), JString("ok"))]
}

pub fn messages_an_agent_took_are_replayed_at_their_turns_test() {
  let assert [_, CallAgent(mailbox:, ..)] =
    last([started(), agent("0", "a", None, JNull)])
  let #(s, _, _) =
    replay([
      started(),
      agent("0", "a", None, JNull),
      send("k1", mailbox, JInt(1)),
      MessagesTaken("0", [mailbox <> "/0"], 3),
    ])
  let assert [CallAgent(taken: [Taken(3, [m])], ..)] =
    replay_from(s, [resumed(), agent("0", "a", None, JNull)]).1
  assert m == mailbox <> "/0"
}

pub fn messages_taken_by_a_call_that_is_not_running_are_refused_test() {
  assert last([
      started(),
      command("0", "c", JNull, 0),
      MessagesTaken("0", [], 1),
    ])
    == [Refuse(Some("0"), NotRunning("0"))]
}

// --- Decided failures and retry ---

fn turn_limited() {
  [
    started(),
    agent("0", "a", None, JNull),
    AgentFailed("0", TurnLimitReached(30), "m", Some("d1"), []),
    types.BodyFailed(AgentError("a", TurnLimitReached(30), None)),
  ]
}

pub fn a_decided_failure_is_answered_from_the_journal_on_resume_test() {
  let #(s, _, _) = replay(turn_limited())
  let assert [Fail("0", AgentError("a", TurnLimitReached(30), Some(_)))] =
    replay_from(s, [resumed(), agent("0", "a", None, JNull)]).1
}

pub fn a_retried_turn_limit_continues_its_own_dialogue_with_more_turns_test() {
  let #(s, _, _) = replay(turn_limited())
  let #(s, effects, _) = replay_from(s, [resumed()])
  assert effects == [Checkpoint]
  let assert [Checkpoint, CallAgent(..)] = last([started(), agent("0", "a", None, JNull)])
  let slot = ids.slot_text(ids.slot(ids.digest("a"), "agent", JNull, "", None, "0"))
  let #(s, effects, _) = replay_from(s, [types.Retried(slot, 20)])
  assert effects == [Checkpoint]
  let assert [
    Checkpoint,
    CallAgent(attempt: 2, checkpoint: Some("d1"), continuation: types.MoreTurns(20), ..),
  ] = replay_from(s, [agent("0", "a", None, JNull)]).1
}

pub fn an_invalid_output_retried_continues_with_its_errors_test() {
  let #(s, _, _) =
    replay([
      started(),
      agent("0", "a", None, JNull),
      AgentFailed("0", types.InvalidOutput(["/n: expected integer"]), "m", Some("d1"), []),
    ])
  let slot = ids.slot_text(ids.slot(ids.digest("a"), "agent", JNull, "", None, "0"))
  let #(s, _, _) = replay_from(s, [types.Retried(slot, 30)])
  let assert [
    Checkpoint,
    CallAgent(continuation: types.FixOutput(["/n: expected integer"]), ..),
  ] = replay_from(s, [agent("0", "a", None, JNull)]).1
}

pub fn retrying_a_finished_call_is_refused_test() {
  let #(s, _, _) = replay(done_first())
  let slot = ids.slot_text(ids.slot(ids.digest("c"), "command", JInt(1), "", None, "0"))
  let #(_, effects, _) = replay_from(s, [types.Retried(slot, 30)])
  assert effects == [Refuse(None, types.NotRetriable(slot))]
  assert last([started(), types.Retried("nope", 1)])
    == [Refuse(None, types.NotRetriable("nope"))]
}

pub fn a_model_error_is_not_decided_and_runs_again_on_resume_test() {
  let #(s, _, _) =
    replay([
      started(),
      agent("0", "a", None, JNull),
      AgentFailed("0", types.GaveUp("529"), "m", None, []),
    ])
  let assert [Checkpoint, CallAgent(attempt: 2, continuation: types.Fresh, ..)] =
    replay_from(s, [resumed(), agent("0", "a", None, JNull)]).1
}

// --- Body tool calls ---

fn tool(id, safe) {
  types.Requested(
    id:,
    request: types.ToolCall(name: "list", input: JNull, replay_safe: safe),
    node: "t",
    scope: "",
    occurrence: 0,
  )
}

pub fn a_body_tool_call_is_journaled_and_hit_on_resume_test() {
  let #(s, effects, _) =
    replay([started(), tool("0", True)])
  assert effects == [Checkpoint, types.RunTool("0", 1)]
  let #(s, _, _) = replay_from(s, [types.ToolReturned("0", out(1))])
  assert replay_from(s, [resumed(), tool("0", True)]).1 == [Deliver("0", out(1))]
}

pub fn a_tool_call_in_flight_at_a_stop_runs_again_only_if_safe_test() {
  let #(s, _, _) = replay([started(), tool("0", True)])
  assert replay_from(s, [resumed(), tool("0", True)]).1 == [types.RunTool("0", 1)]
  let #(s, _, _) = replay([started(), tool("0", False)])
  let assert [Checkpoint, Fail("0", types.ToolError("list", _))] =
    replay_from(s, [resumed(), tool("0", False)]).1
}

pub fn a_tool_failure_is_typed_test() {
  assert last([started(), tool("0", True), types.ToolFailed("0", "boom")])
    == [Checkpoint, Fail("0", types.ToolError("list", "boom"))]
}

pub fn a_calls_state_says_whether_its_mailbox_is_open_test() {
  let assert [_, CallAgent(mailbox:, ..)] = last([started(), agent("0", "a", None, JNull)])
  let slot = string.drop_start(mailbox, 6)
  let #(s, _, _) = replay([started(), agent("0", "a", None, JNull)])
  assert run.call_state(s.state, slot) == "running"
  let #(s2, _, _) = replay_from(s, [agent_returned("0", JNull, "d")])
  assert run.call_state(s2.state, slot) == "answered"
  let #(s3, _, _) = replay_from(s, [AgentFailed("0", types.GaveUp("x"), "m", None, [])])
  assert run.call_state(s3.state, slot) == "errored"
  let #(s, _, _) = replay_from(s, [AgentFailed("0", TurnLimitReached(3), "m", Some("d"), [])])
  assert run.call_state(s.state, slot) == "decided"
  assert run.call_state(s.state, "nope") == "none"
}

pub fn a_retried_outcome_unknown_tool_runs_again_test() {
  // An unsafe tool in flight when the run stopped is decided: outcome unknown.
  let #(s, _, _) = replay([started(), tool("0", False)])
  let #(s, effects, _) = replay_from(s, [resumed(), tool("0", False)])
  let assert [Checkpoint, Fail("0", types.ToolError("list", _))] = effects
  // Named in resume({ retry }), it runs again: the retry was never in flight.
  let slot = ids.slot_text(ids.slot(ids.digest("t"), "tool", JNull, "", None, "0"))
  let #(s, effects, _) = replay_from(s, [resumed(), types.Retried(slot, 0)])
  assert effects == [Checkpoint]
  let #(s, effects, _) = replay_from(s, [tool("0", False)])
  assert effects == [Checkpoint, types.RunTool("0", 2)]
  // A crash after it was issued leaves it in flight again: decided again on resume.
  let #(_, effects, _) = replay_from(s, [resumed(), tool("0", False)])
  let assert [Checkpoint, Fail("0", types.ToolError("list", _))] = effects
}

pub fn a_retried_call_is_not_reissued_twice_and_survives_a_resume_before_it_runs_test() {
  let #(s, _, _) = replay(turn_limited())
  let slot = ids.slot_text(ids.slot(ids.digest("a"), "agent", JNull, "", None, "0"))
  // Retried, then the process stops before the body asks for it again.
  let #(s, _, _) = replay_from(s, [resumed(), types.Retried(slot, 5)])
  let #(s, _, _) = replay_from(s, [resumed()])
  let assert [Checkpoint, CallAgent(attempt: 2, continuation: types.MoreTurns(5), ..)] =
    replay_from(s, [agent("0", "a", None, JNull)]).1
}
