//// The run state machine: `step(RunState, Event) -> #(RunState, List(Effect))`.
////
//// A run is a fold of the workflow body over its journal. The body is a
//// deterministic program whose only interface to the world is typed
//// requests (agent, command, tool and orchestrator calls); each request
//// affects the body only through its answer. Run memory is the body's local
//// variables, rebuilt on replay, so the core holds no workflow state: it
//// keeps the calls (the journal), budget, pin, status, ownership and the
//// interventions.
////
//// Every call the body made is kept by its slot (node, input, occurrence),
//// with its attempts, newest first. The journal only grows: a restart opens
//// a new attempt, a forget adds a `Forgotten` mark, and the newest attempt
//// is the live one. A request for a slot whose live attempt settled is a
//// hit, answered from the journal; one whose live attempt is open is the
//// same call (reissued after a crash if it is not issued in this host
//// session); anything else is a new attempt. Hits emit no `Checkpoint`, so
//// a resumed run's log equals an uninterrupted one.
////
//// Each kind of call has its own state union, so a state is only ever
//// paired with its kind. Ids are typed (`ids.gleam`): strings on the wire,
//// opaque inside the core.
////
//// Interventions (answer, steer, interrupt, restart, cancel, pause) are
//// re-checked here when they are applied, through the capabilities in
//// `capability.gleam`; a failed check is a typed refusal, never a no-op.

import gleam/dict.{type Dict}
import gleam/float
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import wallis_core/capability.{
  type IdleNode, type LiveNode, type NodeFacts, type OwnedRun, type ResumableRun,
  type SteerableNode,
}
import wallis_core/ids.{type Digest, type RequestId, type SessionId, type Slot}
import wallis_core/types.{
  type Agent, type Effect, type Event, type FailReason, type IdleReason,
  type InboxKind, type InboxMessage, type Message, type Node, type Observation,
  type Outcome, type Pin, type Refusal, type Request, type RunStatus, type Usage,
  type Workflow,
}
import wallis_core/value.{type Value}

/// Bumped when a change to the core changes what a log means.
pub const semantics = "wallis-core/7"

pub opaque type RunState {
  NotYetStarted
  Active(Run)
}

type Lifecycle {
  Live
  Ended(Outcome)
}

/// Whether new calls are issued: `Holding` after a pause.
type Admission {
  Admitting
  Holding
}

type Run {
  Run(
    lifecycle: Lifecycle,
    workflow: Workflow,
    pin: Pin,
    input: Value,
    models: Dict(String, String),
    budget: types.Budget,
    executor: Option(String),
    owner: Option(String),
    admission: Admission,
    /// Every call the body made, by slot: the journal and the live state.
    calls: Dict(Slot, Call),
    /// The slot each request id named. A call that moved to a new id keeps
    /// the old one here; `lookup` answers only for the call's current id.
    ids: Dict(RequestId, Slot),
    /// Every session value an agent call answered with: the call and
    /// attempt it comes after, so a call of it continues that dialogue.
    sessions: Dict(SessionId, Origin),
    /// A failed call the body did not handle: its slot and the body's reason.
    hold: Option(#(Slot, FailReason)),
    spent: Spent,
    /// Newest first.
    observations: List(Observation),
    /// Host facts (`Noted`): what `meta.json` is derived from.
    facts: Dict(String, Value),
  )
}

/// Where a session value comes from: the call (slot) and attempt that
/// answered with it, and its workspace: layers, bottom first.
type Origin {
  Origin(after: Slot, attempt: Int, layers: List(Digest))
}

type Spent {
  Spent(usd: Float, tokens: Int, turns: Int, compute_minutes: Float)
}

/// A call of the body, by kind. `inbox` (newest first) lists the
/// interventions it received. `attempts` are newest first and never empty.
type Call {
  /// A call of a session value (`None`: a new session, whose workspace
  /// starts from the layers `from`).
  AgentCall(
    id: RequestId,
    agent: String,
    input: Value,
    session: Option(SessionId),
    from: List(Digest),
    inbox: List(InboxMessage),
    attempts: List(Attempt(AgentAttempt)),
  )
  CommandCall(
    id: RequestId,
    command: String,
    input: Value,
    inbox: List(InboxMessage),
    attempts: List(Attempt(CommandState)),
  )
  /// A tool called by the body; `replay` says whether a call in flight at a
  /// crash may be made again.
  ToolCall(
    id: RequestId,
    tool: String,
    input: Value,
    replay: types.Replay,
    attempts: List(Attempt(ToolState)),
  )
  OrchestratorCall(
    id: RequestId,
    name: String,
    input: Value,
    attempts: List(Attempt(OrchestratorState)),
  )
  /// Refused before it started (an unknown node): settled with its refusal.
  RefusedCall(id: RequestId, refusal: Refusal)
}

/// One attempt at a call. `Forgotten`: a forget left the slot without a
/// live attempt, so its next request is a new attempt.
type Attempt(state) {
  Forgotten
  Tried(state)
}

/// An agent attempt: the model turns it used, the turns it may use (its
/// agent's maxTurns plus the turns granted with answers), the MCP results
/// journaled during it, and where it is.
type AgentAttempt {
  AgentAttempt(
    steps: Int,
    allowed: Int,
    tools: List(types.ToolResult),
    state: AgentState,
  )
}

type AgentState {
  /// Held back by a pause or the budget before it is issued; `note` is the
  /// operator note of the restart that opened it.
  AgentHeld(reason: IdleReason, note: Option(String))
  /// In flight. `retry`: a restart of an unknown outcome, so the tool call
  /// that was in doubt is made again when the attempt resumes.
  AgentRunning(dialogue: Dialogue, issued: Issued, retry: Retry)
  /// The agent asked, ended its turn, hit its turn limit, was interrupted,
  /// or a tool call's outcome is unknown: waiting for its owner.
  AgentWaiting(dialogue: Dialogue, model: String, cause: types.IdleCause)
  /// The executor could not serve the call; reissued after a fix.
  AgentUnavailable(dialogue: Dialogue, alias: String, error: String)
  /// Its result, the model that served it, and the session's dialogue
  /// after it (a blob digest).
  AgentSettled(entry: Entry, served: Option(String), dialogue: Option(Digest))
}

type CommandState {
  CommandHeld(reason: IdleReason)
  CommandRunning(issued: Issued)
  CommandSettled(entry: Entry)
}

type ToolState {
  ToolHeld(reason: IdleReason)
  ToolRunning(issued: Issued)
  /// In flight at a crash and not safe to make again: its outcome is
  /// unknown until its owner restarts (calls it again) or cancels it.
  ToolInDoubt
  ToolSettled(entry: Entry)
}

type OrchestratorState {
  OrchestratorWaiting
  OrchestratorSettled(entry: Entry)
}

/// Whether a resumed attempt makes its call in doubt again (the owner
/// restarted an unknown outcome) or decides calls in flight as usual.
type Retry {
  Fresh
  RetryUnknown
}

/// Whether a running call's effect was emitted in this host session: a
/// call in flight when the host stopped is issued again, once.
type Issued {
  NotIssued
  IssuedNow
}

/// An agent call's dialogue after its input: the messages so far, the
/// operator note of a restart, and the digest of this attempt's newest
/// checkpoint (a blob; `None` before its first step).
type Dialogue {
  Dialogue(
    transcript: List(Message),
    note: Option(String),
    checkpoint: Option(Digest),
  )
}

type Entry {
  Answered(Value)
  Errored(FailReason)
  Refused(Refusal)
}

pub fn new() -> RunState {
  NotYetStarted
}

pub fn step(run: RunState, event: Event) -> #(RunState, List(Effect)) {
  case run, event {
    NotYetStarted, types.Started(workflow:, pin:, input:) ->
      start(workflow, pin, input)
    // Before `Started` every event is refused: there is no run to apply it to.
    NotYetStarted, _ -> #(run, [types.Refuse(None, types.NotStarted)])
    Active(_), types.Started(..) -> #(run, [
      types.Refuse(None, types.AlreadyStarted),
    ])
    Active(r), types.Resumed(pin:) ->
      case capability.check_pin(r.pin, pin) {
        Error(refusal) -> #(run, [types.Refuse(None, refusal)])
        Ok(resumable) -> #(Active(unissued(r)), resume(r, resumable))
      }
    // Ownership and host facts change even on a finished run.
    Active(r), types.Claimed(owner:) -> #(Active(Run(..r, owner: Some(owner))), [
      types.Checkpoint,
    ])
    Active(r), types.Noted(key:, value:) -> #(Active(note(r, key, value)), [
      types.Checkpoint,
    ])
    // Every other event of a live run: `live_event` matches each one.
    Active(Run(lifecycle: Live, ..) as r), _ -> {
      let #(r, effects) = live_event(r, event)
      #(Active(r), effects)
    }
    // A finished run takes only ownership and host facts (above).
    Active(_), _ -> #(run, [types.Refuse(None, types.NotRunning)])
  }
}

// --- Start and resume ----------------------------------------------------------

fn start(
  workflow: Workflow,
  pin: Pin,
  input: Value,
) -> #(RunState, List(Effect)) {
  let names = list.map(workflow.agents, fn(a) { a.name })
  let checked = {
    use _ <- result.try(
      case list.length(list.unique(names)) == list.length(names) {
        True -> Ok(Nil)
        False -> Error("duplicate agent name")
      },
    )
    list.try_each(workflow.agents, fn(a) {
      resolve_model(pin.models, a.model) |> result.replace(Nil)
    })
  }
  case checked {
    Error(reason) -> #(NotYetStarted, [
      types.Refuse(None, types.InvalidDeclaration(reason)),
    ])
    Ok(Nil) -> #(
      Active(Run(
        lifecycle: Live,
        workflow:,
        pin:,
        input:,
        models: pin.models,
        budget: workflow.budget,
        executor: None,
        owner: None,
        admission: Admitting,
        calls: dict.new(),
        ids: dict.new(),
        sessions: dict.new(),
        hold: None,
        spent: Spent(0.0, 0, 0, 0.0),
        observations: [],
        facts: dict.new(),
      )),
      [types.Checkpoint],
    )
  }
}

/// Resolution: the current alias table, then `default`.
fn resolve_model(
  models: Dict(String, String),
  alias: String,
) -> Result(String, String) {
  case dict.get(models, alias), dict.get(models, "default") {
    Ok(m), _ if m != "" -> Ok(m)
    _, Ok(m) if m != "" -> Ok(m)
    _, _ ->
      Error("model alias " <> alias <> " is unresolved and default is empty")
  }
}

fn resume(run: Run, _resumable: ResumableRun) -> List(Effect) {
  case run.lifecycle {
    Ended(outcome) -> [types.Finish(outcome)]
    Live -> []
  }
}

/// A new host session: nothing in flight has been issued by it yet.
fn unissued(run: Run) -> Run {
  let calls =
    dict.map_values(run.calls, fn(_, call) {
      case call {
        AgentCall(attempts: [Tried(a), ..older], ..) ->
          case a.state {
            AgentRunning(dialogue:, retry:, ..) ->
              AgentCall(..call, attempts: [
                Tried(
                  AgentAttempt(
                    ..a,
                    state: AgentRunning(dialogue, NotIssued, retry),
                  ),
                ),
                ..older
              ])
            AgentHeld(..)
            | AgentWaiting(..)
            | AgentUnavailable(..)
            | AgentSettled(..) -> call
          }
        CommandCall(attempts: [Tried(CommandRunning(_)), ..older], ..) ->
          CommandCall(..call, attempts: [
            Tried(CommandRunning(NotIssued)),
            ..older
          ])
        ToolCall(attempts: [Tried(ToolRunning(_)), ..older], ..) ->
          ToolCall(..call, attempts: [Tried(ToolRunning(NotIssued)), ..older])
        // Nothing in flight: nothing to issue again.
        AgentCall(..)
        | CommandCall(..)
        | ToolCall(..)
        | OrchestratorCall(..)
        | RefusedCall(..) -> call
      }
    })
  Run(..run, calls:)
}

// --- Events on a live run ------------------------------------------------------

fn live_event(run: Run, event: Event) -> #(Run, List(Effect)) {
  let rid = ids.request_id
  case event {
    types.Requested(id:, request:, node_digest:, occurrence:) ->
      requested(run, rid(id), request, ids.digest(node_digest), occurrence)
    types.CodeChanged(from:, to:) -> #(
      Run(
        ..run,
        pin: types.Pin(
          ..run.pin,
          workflow_digest: to,
          prior_digests: list.append(run.pin.prior_digests, [from]),
        ),
      ),
      [types.Checkpoint],
    )
    types.AgentReturned(id:, output:, usage:, model:, dialogue:, layers:) ->
      agent_returned(
        run,
        rid(id),
        output,
        usage,
        model,
        option.map(dialogue, ids.digest),
        option.map(layers, list.map(_, ids.digest)),
      )
    types.AgentFailed(id:, failure:, usage:, model:) ->
      agent_settled(run, rid(id), usage, model, fn(name) {
        Errored(types.AgentGaveUp(name, failure))
      })
    types.AgentAsked(id:, message:, usage:, model:) ->
      agent_idle(
        run,
        rid(id),
        fn(_, _) { types.Question(message) },
        usage,
        model,
      )
    types.CallOutcomeUnknown(id:, tool:, args:, usage:, model:) ->
      agent_idle(
        run,
        rid(id),
        fn(_, _) { types.OutcomeUnknown(tool, args) },
        usage,
        model,
      )
    types.PreviousDialogueMissing(id:) ->
      agent_settled(run, rid(id), no_usage(), "", fn(_) {
        Refused(types.DialogueMissing(id))
      })
    types.AgentProgressed(id:, dialogue:) ->
      progressed(run, rid(id), ids.digest(dialogue))
    types.ToolCallsInFlight(id:, calls:) -> in_flight_calls(run, rid(id), calls)
    types.TurnInterrupted(id:, usage:, model:) ->
      agent_idle(run, rid(id), fn(_, _) { types.Interrupted }, usage, model)
    types.ToolRecorded(id:, call:, result:) ->
      tool_recorded(run, rid(id), call, result)
    types.ToolReturned(id:, output:) ->
      tool_settled(run, rid(id), fn(_) { Answered(output) })
    types.ToolCallUnknown(id:) -> tool_unknown(run, rid(id))
    types.ToolFailed(id:, failure:) ->
      tool_settled(run, rid(id), fn(name) {
        Errored(types.ToolCrashed(name, failure))
      })
    types.ResultSubmitted(node:, value:, by:) ->
      intervene(run, by, fn(owned) {
        use node <- result.try(capability.check_submittable(
          owned,
          rid(node),
          node_facts(run, rid(node)),
        ))
        submit(run, node, value)
      })
    types.InputRejected(id:, field:, chars:, limit:) ->
      agent_settled(run, rid(id), no_usage(), "", fn(name) {
        Refused(types.InputTooLarge(name, field, chars, limit))
      })
    types.AgentIdle(id:, message:, usage:, model:) ->
      agent_idle(
        run,
        rid(id),
        fn(_, _) { types.EndedWithoutResult(message) },
        usage,
        model,
      )
    types.TurnLimitReached(id:, usage:, model:, ..) ->
      agent_idle(
        run,
        rid(id),
        fn(steps, allowed) { types.TurnLimit(steps, allowed) },
        usage,
        model,
      )
    types.ExecutorFailed(id:, error:) -> executor_failed(run, rid(id), error)
    types.CommandReturned(id:, output:, minutes:) ->
      command_settled(run, rid(id), fn(_) { Answered(output) }, minutes)
    types.CommandFailed(id:, failure:, minutes:) ->
      command_settled(
        run,
        rid(id),
        fn(name) { Errored(types.CommandCrashed(name, failure)) },
        minutes,
      )
    types.Observed(at:, label:, value:) -> observe(run, at, label, value)
    types.Sent(node:, text:, by:, turns:, ..) ->
      intervene(run, by, fn(owned) {
        use idle <- result.map(capability.check_idle(
          owned,
          rid(node),
          node_facts(run, rid(node)),
        ))
        answer(run, idle, text, turns)
      })
    types.Steered(node:, text:, by:, ..) ->
      intervene(run, by, fn(owned) {
        use node <- result.map(capability.check_steerable(
          owned,
          rid(node),
          node_facts(run, rid(node)),
        ))
        steer(run, node, text)
      })
    types.InterruptRequested(node:, by:) ->
      intervene(run, by, fn(owned) {
        use node <- result.map(capability.check_steerable(
          owned,
          rid(node),
          node_facts(run, rid(node)),
        ))
        let id = capability.steerable_id(node)
        let run = add_inbox(run, id, types.Interrupt, "")
        let attempt = case lookup(run, id) {
          Ok(#(_, call)) -> attempt_number(call)
          Error(Nil) -> 1
        }
        // For this attempt only: an earlier attempt opening late never takes it.
        #(run, [
          types.Checkpoint,
          types.InterruptTurn(ids.request_text(id), attempt),
        ])
      })
    types.Restarted(node:, note:, by:, turns:) ->
      intervene(run, by, fn(owned) {
        use node <- result.try(capability.check_live(
          owned,
          rid(node),
          node_facts(run, rid(node)),
        ))
        restart(run, node, note, turns)
      })
    types.NodeCancelled(node:, by:) ->
      intervene(run, by, fn(owned) {
        use node <- result.map(capability.check_live(
          owned,
          rid(node),
          node_facts(run, rid(node)),
        ))
        cancel_node(run, node)
      })
    types.CancelRequested(by:) ->
      intervene(run, by, fn(_) { Ok(finish(run, types.Cancelled)) })
    // A pause or resume that changes nothing is not logged.
    types.PauseRequested(by:) ->
      intervene(run, by, fn(_) {
        Ok(case run.admission {
          Holding -> #(run, [])
          Admitting -> #(Run(..run, admission: Holding), [types.Checkpoint])
        })
      })
    types.ResumeRequested(by:) ->
      intervene(run, by, fn(_) {
        Ok(case run.admission {
          Admitting -> #(run, [])
          Holding -> {
            let #(run, effects) = unblock(Run(..run, admission: Admitting))
            #(run, [types.Checkpoint, ..effects])
          }
        })
      })
    types.AliasRebound(alias:, to:, ..) -> rebind(run, alias, to)
    types.BudgetRaised(kind:, limit:) -> raise_budget(run, kind, limit)
    types.ExecutorChanged(name:) -> #(Run(..run, executor: Some(name)), [
      types.Checkpoint,
    ])
    types.RetryUnavailable -> retry_unavailable(run)
    types.Claimed(owner:) -> #(Run(..run, owner: Some(owner)), [
      types.Checkpoint,
    ])
    types.Noted(key:, value:) -> #(note(run, key, value), [types.Checkpoint])
    types.BodyFinished(output:) -> finish(run, types.Done(output))
    types.BodyFailed(reason:) -> body_failed(run, reason)
    // Handled by `step` before a live run sees them.
    types.Started(..) | types.Resumed(..) -> #(run, [])
  }
}

fn no_usage() -> Usage {
  types.Usage(0.0, 0, 0)
}

fn note(run: Run, key: String, value: Value) -> Run {
  Run(..run, facts: dict.insert(run.facts, key, value))
}

/// Applies an intervention only with an `OwnedRun`; any failed check is the
/// event's typed refusal.
fn intervene(
  run: Run,
  by: String,
  apply: fn(OwnedRun) -> Result(#(Run, List(Effect)), Refusal),
) -> #(Run, List(Effect)) {
  case result.try(capability.check_owner(run.owner, by), apply) {
    Ok(done) -> done
    Error(refusal) -> #(run, [types.Refuse(None, refusal)])
  }
}

/// An uncaught node failure holds the run on that node instead of ending
/// it: the owner restarts the node (the body then runs again against the
/// journal) or cancels it (the failure propagates). Other failures, and a
/// failure the owner already accepted, end the run.
fn body_failed(run: Run, reason: FailReason) -> #(Run, List(Effect)) {
  case run.hold {
    Some(_) -> #(run, [])
    None -> {
      let failure = leaf(reason)
      case failure {
        types.AgentGaveUp(failure: types.CancelledByOwner, ..)
        | types.CommandCrashed(failure: types.CommandCancelled, ..)
        | types.ToolCrashed(failure: types.ToolCancelled, ..)
        | types.AgentGaveUp(failure: types.UnknownOutcome(..), ..)
        | types.ToolCrashed(failure: types.ToolUnknownOutcome, ..)
        | types.OrchestratorCancelled(..)
        | types.BodyError(..) -> finish(run, types.Failed(reason))
        types.AgentGaveUp(..)
        | types.CommandCrashed(..)
        | types.ToolCrashed(..)
        | types.WorkflowFailed(..) ->
          case failed_call(run, failure) {
            Ok(slot) -> #(Run(..run, hold: Some(#(slot, reason))), [
              types.Checkpoint,
            ])
            Error(Nil) -> finish(run, types.Failed(reason))
          }
      }
    }
  }
}

fn leaf(reason: FailReason) -> FailReason {
  case reason {
    types.WorkflowFailed(reason:, ..) -> leaf(reason)
    types.BodyError(..)
    | types.AgentGaveUp(..)
    | types.CommandCrashed(..)
    | types.ToolCrashed(..)
    | types.OrchestratorCancelled(..) -> reason
  }
}

/// The first call, by request id, whose live attempt failed with this reason.
fn failed_call(run: Run, failure: FailReason) -> Result(Slot, Nil) {
  sorted_calls(run)
  |> list.find_map(fn(e) {
    case live_entry(e.1) {
      Ok(Errored(f)) if f == failure -> Ok(e.0)
      Ok(Errored(_)) | Ok(Answered(_)) | Ok(Refused(_)) | Error(Nil) ->
        Error(Nil)
    }
  })
}

fn finish(run: Run, outcome: Outcome) -> #(Run, List(Effect)) {
  #(Run(..run, lifecycle: Ended(outcome)), [
    types.Checkpoint,
    types.Finish(outcome),
  ])
}

/// Monitoring only. A replayed observation (same position) is not logged
/// again, and a changed value never diverges the replay.
fn observe(
  run: Run,
  at: String,
  label: String,
  value: Value,
) -> #(Run, List(Effect)) {
  case list.any(run.observations, fn(o) { o.at == at }) {
    True -> #(run, [])
    False -> #(
      Run(..run, observations: [
        types.Observation(at:, label:, value:),
        ..run.observations
      ]),
      [types.Checkpoint],
    )
  }
}

// --- Calls and the journal -----------------------------------------------------

fn call_id(call: Call) -> RequestId {
  case call {
    AgentCall(id:, ..)
    | CommandCall(id:, ..)
    | ToolCall(id:, ..)
    | OrchestratorCall(id:, ..)
    | RefusedCall(id:, ..) -> id
  }
}

fn with_id(call: Call, id: RequestId) -> Call {
  case call {
    AgentCall(..) -> AgentCall(..call, id:)
    CommandCall(..) -> CommandCall(..call, id:)
    ToolCall(..) -> ToolCall(..call, id:)
    OrchestratorCall(..) -> OrchestratorCall(..call, id:)
    RefusedCall(..) -> RefusedCall(..call, id:)
  }
}

/// Where a call's live attempt is, whatever its kind.
type Live {
  /// Settled: a request for its slot is answered from the journal.
  LiveSettled(Entry)
  /// Not settled: in flight, waiting or held back.
  LiveOpen
  /// Forgotten (or never tried): its next request is a new attempt.
  LiveForgotten
}

fn live_of(
  attempts: List(Attempt(state)),
  settled: fn(state) -> Option(Entry),
) -> Live {
  case attempts {
    [Tried(state), ..] ->
      case settled(state) {
        Some(entry) -> LiveSettled(entry)
        None -> LiveOpen
      }
    [Forgotten, ..] | [] -> LiveForgotten
  }
}

fn live(call: Call) -> Live {
  case call {
    AgentCall(attempts:, ..) ->
      live_of(attempts, fn(a) {
        case a.state {
          AgentSettled(entry:, ..) -> Some(entry)
          AgentHeld(..)
          | AgentRunning(..)
          | AgentWaiting(..)
          | AgentUnavailable(..) -> None
        }
      })
    CommandCall(attempts:, ..) ->
      live_of(attempts, fn(s) {
        case s {
          CommandSettled(entry) -> Some(entry)
          CommandHeld(..) | CommandRunning(..) -> None
        }
      })
    ToolCall(attempts:, ..) ->
      live_of(attempts, fn(s) {
        case s {
          ToolSettled(entry) -> Some(entry)
          ToolHeld(..) | ToolRunning(..) | ToolInDoubt -> None
        }
      })
    OrchestratorCall(attempts:, ..) ->
      live_of(attempts, fn(s) {
        case s {
          OrchestratorSettled(entry) -> Some(entry)
          OrchestratorWaiting -> None
        }
      })
    RefusedCall(refusal:, ..) -> LiveSettled(Refused(refusal))
  }
}

fn live_entry(call: Call) -> Result(Entry, Nil) {
  case live(call) {
    LiveSettled(entry) -> Ok(entry)
    LiveOpen | LiveForgotten -> Error(Nil)
  }
}

/// Records a call at its slot, under its current request id.
fn put(run: Run, slot: Slot, call: Call) -> Run {
  Run(
    ..run,
    calls: dict.insert(run.calls, slot, call),
    ids: dict.insert(run.ids, call_id(call), slot),
  )
}

/// The call a request id names now (an id a call moved away from names none).
fn lookup(run: Run, id: RequestId) -> Result(#(Slot, Call), Nil) {
  use slot <- result.try(dict.get(run.ids, id))
  use call <- result.try(dict.get(run.calls, slot))
  case call_id(call) == id {
    True -> Ok(#(slot, call))
    False -> Error(Nil)
  }
}

fn sorted_calls(run: Run) -> List(#(Slot, Call)) {
  run.calls
  |> dict.to_list
  |> list.sort(fn(a, b) { ids.compare_requests(call_id(a.1), call_id(b.1)) })
}

/// The live attempt of an agent call, changed.
fn update_agent(call: Call, f: fn(AgentAttempt) -> AgentAttempt) -> Call {
  case call {
    AgentCall(attempts: [Tried(a), ..older], ..) ->
      AgentCall(..call, attempts: [Tried(f(a)), ..older])
    // Nothing live to change.
    AgentCall(attempts: [Forgotten, ..], ..)
    | AgentCall(attempts: [], ..)
    | CommandCall(..)
    | ToolCall(..)
    | OrchestratorCall(..)
    | RefusedCall(..) -> call
  }
}

/// The live attempt of an agent call.
fn agent_attempt(call: Call) -> Result(AgentAttempt, Nil) {
  case call {
    AgentCall(attempts: [Tried(a), ..], ..) -> Ok(a)
    AgentCall(attempts: [Forgotten, ..], ..)
    | AgentCall(attempts: [], ..)
    | CommandCall(..)
    | ToolCall(..)
    | OrchestratorCall(..)
    | RefusedCall(..) -> Error(Nil)
  }
}

/// The live attempt settles (a forgotten head gets a settled attempt).
fn replace_head(attempts: List(Attempt(s)), state: s) -> List(Attempt(s)) {
  case attempts {
    [Tried(_), ..older] -> [Tried(state), ..older]
    [Forgotten, ..] | [] -> [Tried(state), ..attempts]
  }
}

// --- Requests ------------------------------------------------------------------

/// The journal slot of a request: see `ids.slot`. A session call's slot
/// includes its session's id, a hash chain over every call before it, so
/// it depends on the whole dialogue before it.
fn slot_of(node: Digest, request: Request, occurrence: String) -> Slot {
  let #(kind, name, body, within) = case request {
    // A new session is keyed by the layers it starts from.
    types.Call(agent:, input:, session: Some(s), ..) -> #(
      "call",
      agent,
      input,
      Some(ids.session_id(s)),
    )
    types.Call(agent:, input:, session: None, from: []) -> #(
      "call",
      agent,
      input,
      None,
    )
    types.Call(agent:, input:, session: None, from:) -> #(
      "call",
      agent,
      input,
      Some(ids.session_id("new:" <> string.join(from, ","))),
    )
    types.Command(command:, input:) -> #("command", command, input, None)
    types.Tool(tool:, input:, ..) -> #("tool", tool, input, None)
    types.Orchestrator(name:, input:) -> #("orchestrator", name, input, None)
  }
  ids.slot(node, kind, name, body, within, occurrence)
}

/// The journal is a cache. A slot whose live attempt settled is a hit:
/// answered, not logged. A slot whose live attempt is open is the same call
/// (it moves to this request id, and that move is logged). Anything else is
/// a new attempt.
fn requested(
  run: Run,
  id: RequestId,
  request: Request,
  node: Digest,
  occurrence: String,
) -> #(Run, List(Effect)) {
  let slot = slot_of(node, request, occurrence)
  case dict.get(run.calls, slot) {
    Error(Nil) -> new_attempt(run, id, slot, request, [])
    Ok(call) ->
      case live(call) {
        LiveSettled(entry) -> #(run, [deliver(run, id, slot, call, entry)])
        LiveOpen -> {
          let moved = call_id(call) != id
          let run = put(run, slot, with_id(call, id))
          let #(run, effects) = reissue(run, slot)
          case moved {
            True -> #(run, [types.Checkpoint, ..effects])
            False -> #(run, effects)
          }
        }
        LiveForgotten -> new_attempt(run, id, slot, request, [call])
      }
  }
}

fn new_attempt(
  run: Run,
  id: RequestId,
  slot: Slot,
  request: Request,
  prior: List(Call),
) -> #(Run, List(Effect)) {
  let #(run, effects) = begin(run, id, slot, request, prior)
  #(run, [types.Checkpoint, ..effects])
}

/// A call in flight and requested again: re-emitted only if it was not
/// issued in this host session (it was in flight at a crash). Waiting calls
/// wait for the events that unblock them (`Sent`, `BudgetRaised`,
/// `RetryUnavailable`).
fn reissue(run: Run, slot: Slot) -> #(Run, List(Effect)) {
  case dict.get(run.calls, slot) {
    Error(Nil) -> #(run, [])
    Ok(call) ->
      case call {
        AgentCall(
          attempts: [
            Tried(AgentAttempt(state: AgentRunning(d, NotIssued, _), ..)),
            ..
          ],
          ..,
        ) ->
          case call_effect(run, slot, call, d) {
            Ok(effect) -> #(put(run, slot, mark_issued(call)), [effect])
            Error(_) -> #(run, [])
          }
        CommandCall(attempts: [Tried(CommandRunning(NotIssued)), ..older], ..) -> #(
          put(
            run,
            slot,
            CommandCall(..call, attempts: [
              Tried(CommandRunning(IssuedNow)),
              ..older
            ]),
          ),
          [command_effect(run, slot, call)],
        )
        // A body tool call in flight at a crash: made again only if safe;
        // otherwise its outcome is unknown, and that is logged.
        ToolCall(
          attempts: [Tried(ToolRunning(NotIssued)), ..older],
          replay:,
          ..,
        ) -> {
          let run =
            put(
              run,
              slot,
              ToolCall(..call, attempts: [
                Tried(ToolRunning(IssuedNow)),
                ..older
              ]),
            )
          case replay {
            types.ReplaySafe -> #(run, [tool_effect(slot, call)])
            types.ReplayNever -> #(run, [
              types.LogUnknownTool(ids.request_text(call.id)),
            ])
          }
        }
        // Issued in this session, waiting, held back or settled: nothing to issue.
        AgentCall(..)
        | CommandCall(..)
        | ToolCall(..)
        | OrchestratorCall(..)
        | RefusedCall(..) -> #(run, [])
      }
  }
}

fn mark_issued(call: Call) -> Call {
  update_agent(call, fn(a) {
    case a.state {
      AgentRunning(dialogue:, retry:, ..) ->
        AgentAttempt(..a, state: AgentRunning(dialogue, IssuedNow, retry))
      AgentHeld(..)
      | AgentWaiting(..)
      | AgentUnavailable(..)
      | AgentSettled(..) -> a
    }
  })
}

fn answer_effect(id: RequestId, entry: Entry) -> Effect {
  let id = ids.request_text(id)
  case entry {
    Answered(v) -> types.Deliver(id, v)
    Errored(reason) -> types.Fail(id, reason)
    Refused(refusal) -> types.Refuse(Some(id), refusal)
  }
}

/// The answer of a settled call. An agent call answers with its output and
/// the session value after it (its id and its workspace's layers).
fn deliver(
  run: Run,
  id: RequestId,
  slot: Slot,
  call: Call,
  entry: Entry,
) -> Effect {
  case call, entry {
    AgentCall(attempts:, ..), Answered(output) -> {
      let next = ids.next_session(slot, list.length(attempts))
      case dict.get(run.sessions, next) {
        Ok(origin) ->
          types.Deliver(
            ids.request_text(id),
            value.object([
              #("output", output),
              #("session", value.JString(ids.session_text(next))),
              #(
                "layers",
                value.JArray(
                  list.map(origin.layers, fn(l) {
                    value.JString(ids.digest_text(l))
                  }),
                ),
              ),
            ]),
          )
        // Every answer registers its session first (`settle_agent_with`): a
        // missing one is a journal the core cannot trust, so it is refused,
        // never answered with an empty workspace.
        Error(Nil) ->
          types.Refuse(
            Some(ids.request_text(id)),
            types.UnknownSession(ids.session_text(next)),
          )
      }
    }
    AgentCall(..), Errored(_) | AgentCall(..), Refused(_) ->
      answer_effect(id, entry)
    CommandCall(..), _
    | ToolCall(..), _
    | OrchestratorCall(..), _
    | RefusedCall(..), _ -> answer_effect(id, entry)
  }
}

fn refuse_call(
  run: Run,
  id: RequestId,
  slot: Slot,
  refusal: Refusal,
) -> #(Run, List(Effect)) {
  #(put(run, slot, RefusedCall(id, refusal)), [
    answer_effect(id, Refused(refusal)),
  ])
}

/// The attempts of an earlier call at the slot, of this kind.
fn prior_agent(prior: List(Call)) -> List(Attempt(AgentAttempt)) {
  case prior {
    [AgentCall(attempts:, ..), ..] -> attempts
    [CommandCall(..), ..]
    | [ToolCall(..), ..]
    | [OrchestratorCall(..), ..]
    | [RefusedCall(..), ..]
    | [] -> []
  }
}

fn prior_command(prior: List(Call)) -> List(Attempt(CommandState)) {
  case prior {
    [CommandCall(attempts:, ..), ..] -> attempts
    [AgentCall(..), ..]
    | [ToolCall(..), ..]
    | [OrchestratorCall(..), ..]
    | [RefusedCall(..), ..]
    | [] -> []
  }
}

fn prior_tool(prior: List(Call)) -> List(Attempt(ToolState)) {
  case prior {
    [ToolCall(attempts:, ..), ..] -> attempts
    [AgentCall(..), ..]
    | [CommandCall(..), ..]
    | [OrchestratorCall(..), ..]
    | [RefusedCall(..), ..]
    | [] -> []
  }
}

fn prior_orchestrator(prior: List(Call)) -> List(Attempt(OrchestratorState)) {
  case prior {
    [OrchestratorCall(attempts:, ..), ..] -> attempts
    [AgentCall(..), ..]
    | [CommandCall(..), ..]
    | [ToolCall(..), ..]
    | [RefusedCall(..), ..]
    | [] -> []
  }
}

/// A new attempt at a slot (`prior`: the call there, if it was forgotten).
fn begin(
  run: Run,
  id: RequestId,
  slot: Slot,
  request: Request,
  prior: List(Call),
) -> #(Run, List(Effect)) {
  case request {
    types.Call(agent: name, input:, session:, from:) -> {
      // A session value is one this run answered with (or a new one).
      let known = case session {
        Some(s) -> dict.has_key(run.sessions, ids.session_id(s))
        None -> True
      }
      case find_agent(run.workflow, name), known {
        Error(Nil), _ -> refuse_call(run, id, slot, types.UnknownAgent(name))
        Ok(_), False ->
          refuse_call(
            run,
            id,
            slot,
            types.UnknownSession(option.unwrap(session, "")),
          )
        Ok(agent), True -> {
          let call = fn(state) {
            AgentCall(
              id:,
              agent: name,
              input:,
              session: option.map(session, ids.session_id),
              from: list.map(from, ids.digest),
              inbox: [],
              attempts: [
                Tried(AgentAttempt(0, agent.max_turns, [], state)),
                ..prior_agent(prior)
              ],
            )
          }
          case admit(run) {
            Error(reason) -> #(
              put(run, slot, call(AgentHeld(reason, None))),
              [],
            )
            Ok(Nil) -> {
              let d = Dialogue([], None, None)
              // Recorded first: the effect reads the call's place in its session.
              let call = call(AgentRunning(d, IssuedNow, Fresh))
              let run = put(run, slot, call)
              case call_effect(run, slot, call, d) {
                Error(refusal) ->
                  settle_agent(
                    run,
                    slot,
                    call,
                    Refused(refusal),
                    None,
                    no_usage(),
                  )
                Ok(effect) -> #(run, [effect])
              }
            }
          }
        }
      }
    }
    types.Command(command:, input:) ->
      case
        list.contains(run.workflow.commands, command),
        result.try(admission(run), fn(_) { compute_check(run) })
      {
        False, _ -> refuse_call(run, id, slot, types.UnknownCommand(command))
        True, admitted -> {
          let state = case admitted {
            Error(reason) -> CommandHeld(reason)
            Ok(Nil) -> CommandRunning(IssuedNow)
          }
          let call =
            CommandCall(id:, command:, input:, inbox: [], attempts: [
              Tried(state),
              ..prior_command(prior)
            ])
          let run = put(run, slot, call)
          case admitted {
            Error(_) -> #(run, [])
            Ok(Nil) -> #(run, [command_effect(run, slot, call)])
          }
        }
      }
    // The host checked that the tool exists (its sources are listed at preflight).
    types.Tool(tool:, input:, replay:) -> {
      let admitted = admission(run)
      let state = case admitted {
        Error(reason) -> ToolHeld(reason)
        Ok(Nil) -> ToolRunning(IssuedNow)
      }
      let call =
        ToolCall(id:, tool:, input:, replay:, attempts: [
          Tried(state),
          ..prior_tool(prior)
        ])
      let run = put(run, slot, call)
      case admitted {
        Error(_) -> #(run, [])
        Ok(Nil) -> #(run, [tool_effect(slot, call)])
      }
    }
    // Orchestrator nodes cost nothing and are never held back.
    types.Orchestrator(name:, input:) ->
      case list.contains(run.workflow.orchestrators, name) {
        False -> refuse_call(run, id, slot, types.UnknownOrchestrator(name))
        True -> #(
          put(
            run,
            slot,
            OrchestratorCall(id:, name:, input:, attempts: [
              Tried(OrchestratorWaiting),
              ..prior_orchestrator(prior)
            ]),
          ),
          [],
        )
      }
  }
}

/// The model is resolved at issue time from the current alias table, so a
/// rebinding reaches every call issued or continued after it.
fn call_effect(
  run: Run,
  slot: Slot,
  call: Call,
  dialogue: Dialogue,
) -> Result(Effect, Refusal) {
  case call, agent_attempt(call) {
    AgentCall(id:, agent: name, input:, session:, ..), Ok(a) -> {
      use agent <- result.try(
        find_agent(run.workflow, name)
        |> result.replace_error(types.UnknownAgent(name)),
      )
      use model <- result.try(
        resolve_model(run.models, agent.model)
        |> result.replace_error(types.UnknownAlias(agent.model)),
      )
      Ok(types.CallAgent(
        id: ids.request_text(id),
        agent: agent.name,
        model:,
        input:,
        turn: a.steps,
        turn_limit: a.allowed,
        slot: ids.slot_text(slot),
        transcript: dialogue.transcript,
        note: dialogue.note,
        session: option.map(session, ids.session_text),
        layers: list.map(layers_of(run, call), ids.digest_text),
        history: history_of(run, call) |> option.map(ids.digest_text),
        checkpoint: dialogue.checkpoint |> option.map(ids.digest_text),
        recorded: list.reverse(a.tools),
        attempt: attempt_number(call),
      ))
    }
    // Only an agent call with a live attempt is issued as one.
    AgentCall(agent:, ..), Error(Nil) -> Error(types.UnknownAgent(agent))
    CommandCall(command:, ..), _ -> Error(types.NotAnAgent(command))
    ToolCall(tool:, ..), _ -> Error(types.NotAnAgent(tool))
    OrchestratorCall(name:, ..), _ -> Error(types.NotAnAgent(name))
    RefusedCall(id:, ..), _ -> Error(types.NotAnAgent(ids.request_text(id)))
  }
}

/// The live attempt's number, from the first (1): what results, steers and
/// interrupts are matched against.
fn attempt_number(call: Call) -> Int {
  case call {
    AgentCall(attempts:, ..) -> list.length(attempts)
    CommandCall(attempts:, ..) -> list.length(attempts)
    ToolCall(attempts:, ..) -> list.length(attempts)
    OrchestratorCall(attempts:, ..) -> list.length(attempts)
    RefusedCall(..) -> 1
  }
}

fn command_effect(run: Run, slot: Slot, call: Call) -> Effect {
  let #(id, command, input) = case call {
    CommandCall(id:, command:, input:, ..) -> #(id, command, input)
    // Only command calls are run as commands.
    AgentCall(id:, input:, ..)
    | ToolCall(id:, input:, ..)
    | OrchestratorCall(id:, input:, ..) -> #(id, "", input)
    RefusedCall(id:, ..) -> #(id, "", value.JNull)
  }
  types.RunCommand(
    id: ids.request_text(id),
    command:,
    input:,
    compute_minutes: option.map(run.budget.compute_minutes, fn(limit) {
      limit -. run.spent.compute_minutes
    }),
    slot: ids.slot_text(slot),
  )
}

fn tool_effect(slot: Slot, call: Call) -> Effect {
  let #(id, tool, input) = case call {
    ToolCall(id:, tool:, input:, ..) -> #(id, tool, input)
    // Only tool calls are made as tool calls.
    AgentCall(id:, input:, ..)
    | CommandCall(id:, input:, ..)
    | OrchestratorCall(id:, input:, ..) -> #(id, "", input)
    RefusedCall(id:, ..) -> #(id, "", value.JNull)
  }
  types.CallTool(
    id: ids.request_text(id),
    tool:,
    input:,
    slot: ids.slot_text(slot),
  )
}

fn admission(run: Run) -> Result(Nil, IdleReason) {
  case run.admission {
    Admitting -> Ok(Nil)
    Holding -> Error(types.PausedByUser)
  }
}

/// A pause, then the budget: what holds a new agent call back.
fn admit(run: Run) -> Result(Nil, IdleReason) {
  result.try(admission(run), fn(_) { budget_check(run) })
}

/// Checked before every agent call. A reached budget is an attention
/// point: no new call is admitted, calls in flight finish.
fn budget_check(run: Run) -> Result(Nil, IdleReason) {
  case run.budget.turns {
    Some(limit) if run.spent.turns >= limit ->
      Error(types.BudgetReached(
        types.Turns,
        int.to_float(run.spent.turns),
        int.to_float(limit),
      ))
    Some(_) | None -> Ok(Nil)
  }
}

fn compute_check(run: Run) -> Result(Nil, IdleReason) {
  case run.budget.compute_minutes {
    Some(limit) if run.spent.compute_minutes >=. limit ->
      Error(types.BudgetReached(
        types.ComputeMinutes,
        run.spent.compute_minutes,
        limit,
      ))
    Some(_) | None -> Ok(Nil)
  }
}

// --- Agent results -------------------------------------------------------------

fn spend(run: Run, usage: Usage) -> Run {
  let s = run.spent
  Run(
    ..run,
    spent: Spent(
      ..s,
      usd: s.usd +. usage.usd,
      tokens: s.tokens + usage.tokens,
      turns: s.turns + usage.turns,
    ),
  )
}

/// An agent call that is running or was cut off by an executor fault: its
/// dialogue.
fn in_flight(call: Call) -> Result(Dialogue, Nil) {
  case agent_attempt(call) {
    Ok(AgentAttempt(state: AgentRunning(dialogue:, ..), ..))
    | Ok(AgentAttempt(state: AgentUnavailable(dialogue:, ..), ..)) ->
      Ok(dialogue)
    Ok(AgentAttempt(state: AgentHeld(..), ..))
    | Ok(AgentAttempt(state: AgentWaiting(..), ..))
    | Ok(AgentAttempt(state: AgentSettled(..), ..))
    | Error(Nil) -> Error(Nil)
  }
}

fn call_name(call: Call) -> String {
  case call {
    AgentCall(agent:, ..) -> agent
    CommandCall(command:, ..) -> command
    ToolCall(tool:, ..) -> tool
    OrchestratorCall(name:, ..) -> name
    RefusedCall(id:, ..) -> ids.request_text(id)
  }
}

/// Settles an agent call's live attempt with its result, the model that
/// served it and the dialogue it reached, and answers the body.
fn settle_agent(
  run: Run,
  slot: Slot,
  call: Call,
  entry: Entry,
  served: Option(String),
  usage: Usage,
) -> #(Run, List(Effect)) {
  settle_agent_with(
    run,
    slot,
    call,
    entry,
    served,
    usage,
    dialogue_after(run, call),
    None,
  )
}

fn settle_agent_with(
  run: Run,
  slot: Slot,
  call: Call,
  entry: Entry,
  served: Option(String),
  usage: Usage,
  dialogue: Option(Digest),
  layers: Option(List(Digest)),
) -> #(Run, List(Effect)) {
  // The workspace after the call: the layers the host reports, else unchanged.
  let layers = option.unwrap(layers, layers_of(run, call))
  let call =
    update_agent(call, fn(a) {
      AgentAttempt(
        ..a,
        steps: a.steps + usage.turns,
        state: AgentSettled(entry, served, dialogue),
      )
    })
  // An answer is a new session value: what a call of it continues.
  let run = case call, entry {
    AgentCall(attempts:, ..), Answered(_) -> {
      let n = list.length(attempts)
      Run(
        ..run,
        sessions: dict.insert(
          run.sessions,
          ids.next_session(slot, n),
          Origin(slot, n, layers),
        ),
      )
    }
    AgentCall(..), Errored(_)
    | AgentCall(..), Refused(_)
    | CommandCall(..), _
    | ToolCall(..), _
    | OrchestratorCall(..), _
    | RefusedCall(..), _ -> run
  }
  let run = put(spend(run, usage), slot, call)
  #(run, [deliver(run, call_id(call), slot, call, entry)])
}

/// A returned agent call: the dialogue it names is the session's after it.
fn agent_returned(
  run: Run,
  id: RequestId,
  output: Value,
  usage: Usage,
  model: String,
  dialogue: Option(Digest),
  layers: Option(List(Digest)),
) -> #(Run, List(Effect)) {
  case lookup(run, id) {
    Ok(#(slot, call)) ->
      case in_flight(call) {
        Error(Nil) -> #(run, [])
        Ok(_) -> {
          let served = case model {
            "" -> None
            m -> Some(m)
          }
          let dialogue = option.or(dialogue, dialogue_after(run, call))
          let #(run, effects) =
            settle_agent_with(
              run,
              slot,
              call,
              Answered(output),
              served,
              usage,
              dialogue,
              layers,
            )
          #(run, [types.Checkpoint, ..effects])
        }
      }
    Error(Nil) -> #(run, [])
  }
}

/// The workspace a call starts from: its session value's layers, or for a
/// new session the layers it was seeded `from`.
fn layers_of(run: Run, call: Call) -> List(Digest) {
  case call {
    AgentCall(session: Some(s), ..) ->
      case dict.get(run.sessions, s) {
        Ok(origin) -> origin.layers
        Error(Nil) -> []
      }
    AgentCall(session: None, from:, ..) -> from
    CommandCall(..) | ToolCall(..) | OrchestratorCall(..) | RefusedCall(..) ->
      []
  }
}

/// A result, a failure or a rejected input completes the call. Results for
/// a call that is not in flight (cancelled, already settled) are ignored.
fn agent_settled(
  run: Run,
  id: RequestId,
  usage: Usage,
  model: String,
  entry: fn(String) -> Entry,
) -> #(Run, List(Effect)) {
  case lookup(run, id) {
    Ok(#(slot, call)) ->
      case in_flight(call) {
        Error(Nil) -> #(run, [])
        Ok(_) -> {
          let served = case model {
            "" -> None
            m -> Some(m)
          }
          let #(run, effects) =
            settle_agent(run, slot, call, entry(call_name(call)), served, usage)
          #(run, [types.Checkpoint, ..effects])
        }
      }
    Error(Nil) -> #(run, [])
  }
}

/// The node waits for its owner: with a question (which joins its
/// dialogue), or at its turn limit (progress kept, nothing added).
fn agent_idle(
  run: Run,
  id: RequestId,
  cause: fn(Int, Int) -> types.IdleCause,
  usage: Usage,
  model: String,
) -> #(Run, List(Effect)) {
  case lookup(run, id) {
    Ok(#(slot, call)) ->
      case in_flight(call) {
        Ok(d) -> {
          let call =
            update_agent(call, fn(a) {
              let steps = a.steps + usage.turns
              let cause = cause(steps, a.allowed)
              let d = case cause {
                types.Question(message:) ->
                  Dialogue(
                    ..d,
                    transcript: list.append(d.transcript, [
                      types.Message(types.Assistant, message),
                    ]),
                  )
                types.EndedWithoutResult(text:) ->
                  Dialogue(
                    ..d,
                    transcript: list.append(d.transcript, [
                      types.Message(types.Assistant, text),
                    ]),
                  )
                types.TurnLimit(..)
                | types.Interrupted
                | types.OutcomeUnknown(..) -> d
              }
              AgentAttempt(..a, steps:, state: AgentWaiting(d, model, cause))
            })
          #(put(spend(run, usage), slot, call), [types.Checkpoint])
        }
        Error(Nil) -> #(run, [])
      }
    Error(Nil) -> #(run, [])
  }
}

/// An executor error is not an agent failure: the call stays incomplete and
/// the run goes idle until a fix and a `RetryUnavailable`.
fn executor_failed(
  run: Run,
  id: RequestId,
  error: String,
) -> #(Run, List(Effect)) {
  case lookup(run, id) {
    Ok(#(slot, call)) ->
      case in_flight(call) {
        Ok(d) -> {
          let alias = case find_agent(run.workflow, call_name(call)) {
            Ok(a) -> a.model
            Error(Nil) -> call_name(call)
          }
          let call =
            update_agent(call, fn(a) {
              AgentAttempt(..a, state: AgentUnavailable(d, alias, error))
            })
          #(put(run, slot, call), [types.Checkpoint])
        }
        Error(Nil) -> #(run, [])
      }
    Error(Nil) -> #(run, [])
  }
}

fn retry_unavailable(run: Run) -> #(Run, List(Effect)) {
  let #(run, effects) =
    sorted_calls(run)
    |> list.fold(#(run, []), fn(acc, entry) {
      let #(run, effects) = acc
      let #(slot, call) = entry
      case agent_attempt(call) {
        Ok(AgentAttempt(state: AgentUnavailable(dialogue:, ..), ..)) -> {
          let call =
            update_agent(call, fn(a) {
              AgentAttempt(..a, state: AgentRunning(dialogue, IssuedNow, Fresh))
            })
          case call_effect(run, slot, call, dialogue) {
            Ok(effect) -> #(
              put(run, slot, call),
              list.append(effects, [effect]),
            )
            Error(_) -> acc
          }
        }
        Ok(AgentAttempt(state: AgentHeld(..), ..))
        | Ok(AgentAttempt(state: AgentRunning(..), ..))
        | Ok(AgentAttempt(state: AgentWaiting(..), ..))
        | Ok(AgentAttempt(state: AgentSettled(..), ..))
        | Error(Nil) -> acc
      }
    })
  case effects {
    [] -> #(run, [])
    [_, ..] -> #(run, [types.Checkpoint, ..effects])
  }
}

/// A checkpoint of a running agent call: a reissued attempt resumes there.
fn progressed(
  run: Run,
  id: RequestId,
  dialogue: Digest,
) -> #(Run, List(Effect)) {
  let refused = #(run, [
    types.Refuse(None, types.NodeNotRunning(ids.request_text(id))),
  ])
  case lookup(run, id) {
    Ok(#(slot, call)) ->
      case agent_attempt(call) {
        Ok(AgentAttempt(state: AgentRunning(dialogue: d, issued:, retry:), ..)) -> {
          let call =
            update_agent(call, fn(a) {
              AgentAttempt(
                ..a,
                state: AgentRunning(
                  Dialogue(..d, checkpoint: Some(dialogue)),
                  issued,
                  retry,
                ),
              )
            })
          #(put(run, slot, call), [types.Checkpoint])
        }
        Ok(AgentAttempt(state: AgentHeld(..), ..))
        | Ok(AgentAttempt(state: AgentWaiting(..), ..))
        | Ok(AgentAttempt(state: AgentUnavailable(..), ..))
        | Ok(AgentAttempt(state: AgentSettled(..), ..))
        | Error(Nil) -> refused
      }
    Error(Nil) -> refused
  }
}

/// After a crash, the tool calls a resumed attempt found in flight: one that
/// only reads is made again; one on the sandbox only is an error the model
/// sees; one that reaches the outside is made again if it is safe to
/// replay, already journaled (same tool and arguments), or the owner
/// restarted its unknown outcome; otherwise its outcome is unknown and the
/// node waits. The decision is logged, so a replay decides the same.
fn in_flight_calls(
  run: Run,
  id: RequestId,
  calls: List(types.InFlightCall),
) -> #(Run, List(Effect)) {
  let refused = #(run, [
    types.Refuse(None, types.NodeNotRunning(ids.request_text(id))),
  ])
  case lookup(run, id) {
    Ok(#(slot, call)) ->
      case agent_attempt(call) {
        Ok(AgentAttempt(
          state: AgentRunning(dialogue:, issued:, retry:),
          tools:,
          ..,
        )) -> {
          let decisions =
            list.map(calls, fn(c) {
              case c.kind, retry {
                types.ReadsOnly, _ -> types.RunAgain(c.call)
                types.SandboxOnly, _ -> types.ErrorToModel(c.call)
                types.ExternalCall(..), RetryUnknown -> types.RunAgain(c.call)
                types.ExternalCall(replay: types.ReplaySafe), Fresh ->
                  types.RunAgain(c.call)
                types.ExternalCall(replay: types.ReplayNever), Fresh ->
                  case journaled(tools, c) {
                    True -> types.RunAgain(c.call)
                    False -> types.OutcomeIsUnknown(c.call)
                  }
              }
            })
          // The retry is spent on this decision.
          let call =
            update_agent(call, fn(a) {
              AgentAttempt(..a, state: AgentRunning(dialogue, issued, Fresh))
            })
          #(put(run, slot, call), [
            types.Checkpoint,
            types.InFlightDecided(ids.request_text(id), decisions),
          ])
        }
        Ok(AgentAttempt(state: AgentHeld(..), ..))
        | Ok(AgentAttempt(state: AgentWaiting(..), ..))
        | Ok(AgentAttempt(state: AgentUnavailable(..), ..))
        | Ok(AgentAttempt(state: AgentSettled(..), ..))
        | Error(Nil) -> refused
      }
    Error(Nil) -> refused
  }
}

/// A result journaled for this call key, of the same tool and arguments.
fn journaled(tools: List(types.ToolResult), c: types.InFlightCall) -> Bool {
  list.any(tools, fn(t) {
    t.call == c.call
    && value.get(t.result, "tool") == Some(value.JString(c.tool))
    && option.map(value.get(t.result, "args"), value.canonical)
    == Some(value.canonical(c.args))
  })
}

/// The session's dialogue after an agent call's live attempt ends: its
/// newest checkpoint, else the dialogue it started from (it never took a
/// step).
fn dialogue_after(run: Run, call: Call) -> Option(Digest) {
  case agent_attempt(call) {
    Ok(AgentAttempt(state: AgentRunning(dialogue: d, ..), ..))
    | Ok(AgentAttempt(state: AgentWaiting(dialogue: d, ..), ..))
    | Ok(AgentAttempt(state: AgentUnavailable(dialogue: d, ..), ..)) ->
      option.or(d.checkpoint, history_of(run, call))
    Ok(AgentAttempt(state: AgentHeld(..), ..))
    | Ok(AgentAttempt(state: AgentSettled(..), ..))
    | Error(Nil) -> history_of(run, call)
  }
}

/// The session's dialogue before an agent call: what the call its session
/// value comes after left (`None` for a new session).
fn history_of(run: Run, call: Call) -> Option(Digest) {
  case call {
    AgentCall(session: Some(s), ..) ->
      case dict.get(run.sessions, s) {
        Ok(Origin(after:, attempt:, ..)) -> dialogue_at(run, after, attempt)
        Error(Nil) -> None
      }
    AgentCall(session: None, ..)
    | CommandCall(..)
    | ToolCall(..)
    | OrchestratorCall(..)
    | RefusedCall(..) -> None
  }
}

/// The dialogue the `attempt`th attempt (from the first) at a slot left.
fn dialogue_at(run: Run, slot: Slot, attempt: Int) -> Option(Digest) {
  case dict.get(run.calls, slot) {
    Ok(AgentCall(attempts:, ..)) ->
      case list.drop(attempts, list.length(attempts) - attempt) {
        [Tried(AgentAttempt(state: AgentSettled(dialogue:, ..), ..)), ..] ->
          dialogue
        [Tried(AgentAttempt(state: AgentHeld(..), ..)), ..]
        | [Tried(AgentAttempt(state: AgentRunning(..), ..)), ..]
        | [Tried(AgentAttempt(state: AgentWaiting(..), ..)), ..]
        | [Tried(AgentAttempt(state: AgentUnavailable(..), ..)), ..]
        | [Forgotten, ..]
        | [] -> None
      }
    Ok(CommandCall(..))
    | Ok(ToolCall(..))
    | Ok(OrchestratorCall(..))
    | Ok(RefusedCall(..))
    | Error(Nil) -> None
  }
}

// --- Interventions -------------------------------------------------------------

fn held(run: Run, slot: Slot) -> Bool {
  case run.hold {
    Some(#(held, _)) -> held == slot
    None -> False
  }
}

fn steerable(run: Run, agent: String) -> Bool {
  case find_agent(run.workflow, agent) {
    Ok(a) -> a.steerable
    Error(Nil) -> False
  }
}

fn node_facts(run: Run, id: RequestId) -> NodeFacts {
  case lookup(run, id) {
    Error(Nil) -> capability.Absent
    Ok(#(slot, call)) ->
      case held(run, slot), call {
        // A held failure is live again for restart and cancel.
        True, AgentCall(agent:, ..) -> capability.Faulted(steerable(run, agent))
        True, CommandCall(..) -> capability.CommandWorking
        True, ToolCall(..) -> capability.ToolWorking
        True, OrchestratorCall(..) | True, RefusedCall(..) -> capability.Settled
        // Not held: what its live attempt says, for every kind.
        False, _ -> live_facts(run, call)
      }
  }
}

fn live_facts(run: Run, call: Call) -> NodeFacts {
  case call {
    AgentCall(agent:, attempts:, ..) -> {
      let steerable = steerable(run, agent)
      case attempts {
        [Tried(AgentAttempt(state:, ..)), ..] ->
          case state {
            AgentRunning(..) -> capability.Working(steerable)
            // Only a restart or a cancel resolves an unknown outcome.
            AgentWaiting(cause: types.OutcomeUnknown(..), ..) ->
              capability.Unsettled(steerable)
            AgentWaiting(..) -> capability.Waiting(steerable)
            AgentUnavailable(..) -> capability.Faulted(steerable)
            AgentHeld(..) -> capability.Held(steerable)
            AgentSettled(..) -> capability.Settled
          }
        [Forgotten, ..] | [] -> capability.Settled
      }
    }
    // A command or a body tool call is live while it runs, waits for an
    // unknown outcome, or is held back before it starts.
    CommandCall(attempts:, ..) ->
      case attempts {
        [Tried(CommandRunning(..)), ..] | [Tried(CommandHeld(..)), ..] ->
          capability.CommandWorking
        [Tried(CommandSettled(..)), ..] | [Forgotten, ..] | [] ->
          capability.Settled
      }
    ToolCall(attempts:, ..) ->
      case attempts {
        [Tried(ToolRunning(..)), ..]
        | [Tried(ToolInDoubt), ..]
        | [Tried(ToolHeld(..)), ..] -> capability.ToolWorking
        [Tried(ToolSettled(..)), ..] | [Forgotten, ..] | [] ->
          capability.Settled
      }
    OrchestratorCall(attempts:, ..) ->
      case attempts {
        [Tried(OrchestratorWaiting), ..] -> capability.Pending
        [Tried(OrchestratorSettled(..)), ..] | [Forgotten, ..] | [] ->
          capability.Settled
      }
    RefusedCall(..) -> capability.Settled
  }
}

fn add_inbox(run: Run, id: RequestId, kind: InboxKind, text: String) -> Run {
  case lookup(run, id) {
    Ok(#(slot, AgentCall(inbox:, ..) as call)) -> {
      let step = case agent_attempt(call) {
        Ok(a) -> a.steps
        Error(Nil) -> 0
      }
      let message = types.InboxMessage(kind:, text:, step:)
      put(run, slot, AgentCall(..call, inbox: [message, ..inbox]))
    }
    Ok(#(slot, CommandCall(inbox:, ..) as call)) -> {
      let message = types.InboxMessage(kind:, text:, step: 0)
      put(run, slot, CommandCall(..call, inbox: [message, ..inbox]))
    }
    // Tool and orchestrator calls keep no inbox.
    Ok(#(_, ToolCall(..)))
    | Ok(#(_, OrchestratorCall(..)))
    | Ok(#(_, RefusedCall(..)))
    | Error(Nil) -> run
  }
}

/// An answer continues the idle node's dialogue, with the model its alias
/// resolves to now.
fn answer(
  run: Run,
  node: IdleNode,
  text: String,
  turns: Int,
) -> #(Run, List(Effect)) {
  let id = capability.idle_id(node)
  let not_idle = #(run, [
    types.Refuse(None, types.NotIdle(ids.request_text(id))),
  ])
  case lookup(run, id) {
    Ok(#(slot, call)) ->
      case agent_attempt(call) {
        // At its turn limit a node continues only with more turns.
        Ok(AgentAttempt(state: AgentWaiting(cause: types.TurnLimit(..), ..), ..))
          if turns <= 0
        -> #(run, [types.Refuse(None, types.NoTurnsLeft(ids.request_text(id)))])
        Ok(AgentAttempt(state: AgentWaiting(..), ..)) -> {
          let call =
            update_agent(call, fn(a) {
              AgentAttempt(..a, allowed: a.allowed + int.max(0, turns))
            })
          let run = add_inbox(put(run, slot, call), id, types.Answer, text)
          continue_with(run, id, text)
        }
        Ok(AgentAttempt(state: AgentHeld(..), ..))
        | Ok(AgentAttempt(state: AgentRunning(..), ..))
        | Ok(AgentAttempt(state: AgentUnavailable(..), ..))
        | Ok(AgentAttempt(state: AgentSettled(..), ..))
        | Error(Nil) -> not_idle
      }
    Error(Nil) -> not_idle
  }
}

fn continue_with(
  run: Run,
  id: RequestId,
  text: String,
) -> #(Run, List(Effect)) {
  let not_idle = #(run, [
    types.Refuse(None, types.NotIdle(ids.request_text(id))),
  ])
  case lookup(run, id) {
    Ok(#(slot, call)) ->
      case agent_attempt(call) {
        Ok(AgentAttempt(state: AgentWaiting(dialogue: d, ..), ..)) -> {
          let d =
            Dialogue(
              ..d,
              transcript: list.append(d.transcript, [
                types.Message(types.User, text),
              ]),
            )
          let call =
            update_agent(call, fn(a) {
              AgentAttempt(..a, state: AgentRunning(d, IssuedNow, Fresh))
            })
          case call_effect(run, slot, call, d) {
            Ok(effect) -> #(put(run, slot, call), [types.Checkpoint, effect])
            Error(refusal) -> #(run, [types.Refuse(None, refusal)])
          }
        }
        Ok(AgentAttempt(state: AgentHeld(..), ..))
        | Ok(AgentAttempt(state: AgentRunning(..), ..))
        | Ok(AgentAttempt(state: AgentUnavailable(..), ..))
        | Ok(AgentAttempt(state: AgentSettled(..), ..))
        | Error(Nil) -> not_idle
      }
    Error(Nil) -> not_idle
  }
}

/// A steer joins the running node's dialogue; the executor delivers it at
/// the next step boundary. A node reissued after a crash carries it.
fn steer(run: Run, node: SteerableNode, text: String) -> #(Run, List(Effect)) {
  let id = capability.steerable_id(node)
  let run = add_inbox(run, id, types.Steer, text)
  let not_running = #(run, [
    types.Refuse(None, types.NodeNotRunning(ids.request_text(id))),
  ])
  case lookup(run, id) {
    Ok(#(slot, call)) ->
      case agent_attempt(call) {
        Ok(AgentAttempt(state: AgentRunning(dialogue: d, issued:, retry:), ..)) -> {
          let d =
            Dialogue(
              ..d,
              transcript: list.append(d.transcript, [
                types.Message(types.User, text),
              ]),
            )
          let call =
            update_agent(call, fn(a) {
              AgentAttempt(..a, state: AgentRunning(d, issued, retry))
            })
          #(put(run, slot, call), [types.Checkpoint])
        }
        Ok(AgentAttempt(state: AgentHeld(..), ..))
        | Ok(AgentAttempt(state: AgentWaiting(..), ..))
        | Ok(AgentAttempt(state: AgentUnavailable(..), ..))
        | Ok(AgentAttempt(state: AgentSettled(..), ..))
        | Error(Nil) -> not_running
      }
    Error(Nil) -> not_running
  }
}

/// A restart opens a new attempt with the call's original input (and the
/// operator note, for an agent), so it executes again; the attempts before
/// it, with their results, stay in the journal. A held failure is lifted
/// first. An unknown outcome is retried within its attempt instead. A note
/// to a non-steerable node is refused; a call still held back by a pause or
/// the budget has nothing to restart.
fn restart(
  run: Run,
  node: LiveNode,
  note: Option(String),
  turns: Int,
) -> Result(#(Run, List(Effect)), Refusal) {
  let id = capability.live_id(node)
  let text = ids.request_text(id)
  use _ <- result.try(case note, capability.live_kind(node) {
    Some(_), capability.LiveAgent(steerable: False) ->
      Error(types.NotSteerable(text))
    Some(_), capability.LiveCommand | Some(_), capability.LiveTool ->
      Error(types.NotAnAgent(text))
    Some(_), capability.LiveAgent(steerable: True)
    | Some(_), capability.LiveOrchestrator
    | None, _
    -> Ok(Nil)
  })
  use #(slot, call) <- result.try(
    lookup(run, id) |> result.replace_error(types.NotLive(text)),
  )
  let was_held = held(run, slot)
  let lifted = case was_held {
    True -> Run(..run, hold: None)
    False -> run
  }
  case call {
    // A body tool call is made again: the outside world is asked anew.
    ToolCall(attempts: [Tried(state), ..], ..) ->
      case state, was_held {
        ToolRunning(..), _ | ToolInDoubt, _ | ToolSettled(..), True -> {
          let call =
            ToolCall(..call, attempts: [
              Tried(ToolRunning(IssuedNow)),
              ..call.attempts
            ])
          Ok(
            #(put(lifted, slot, call), [
              types.Checkpoint,
              tool_effect(slot, call),
            ]),
          )
        }
        ToolHeld(..), _ | ToolSettled(..), False -> Error(types.NotLive(text))
      }
    // An orchestrator node is asked again.
    OrchestratorCall(attempts: [Tried(OrchestratorWaiting), ..], ..) -> {
      let call =
        OrchestratorCall(..call, attempts: [
          Tried(OrchestratorWaiting),
          ..call.attempts
        ])
      Ok(#(put(lifted, slot, call), [types.Checkpoint]))
    }
    // A command reruns with the same input.
    CommandCall(attempts: [Tried(state), ..], ..) ->
      case state, was_held {
        CommandRunning(..), _ | CommandSettled(..), True -> {
          let call =
            CommandCall(..call, attempts: [
              Tried(CommandRunning(IssuedNow)),
              ..call.attempts
            ])
          let run = add_inbox(put(lifted, slot, call), id, types.Restart, "")
          Ok(#(run, [types.Checkpoint, command_effect(run, slot, call)]))
        }
        CommandHeld(..), _ | CommandSettled(..), False ->
          Error(types.NotLive(text))
      }
    AgentCall(attempts: [Tried(a), ..], ..) ->
      case a.state, was_held {
        // An unknown outcome: the call continues where it stopped, its
        // dialogue, turns and journaled tool results kept; only the unknown
        // call is made again (the host retries it).
        AgentWaiting(dialogue: d, cause: types.OutcomeUnknown(..), ..), False ->
          case note {
            Some(_) -> Error(types.RetryTakesNoNote(text))
            None -> {
              let run = add_inbox(run, id, types.Restart, "")
              use #(_, call) <- result.try(
                lookup(run, id) |> result.replace_error(types.NotLive(text)),
              )
              // The core keeps the retry: a crash before it resumes does not lose it.
              let call =
                update_agent(call, fn(a) {
                  AgentAttempt(
                    ..a,
                    state: AgentRunning(d, IssuedNow, RetryUnknown),
                  )
                })
              use effect <- result.map(call_effect(run, slot, call, d))
              #(put(run, slot, call), [types.Checkpoint, effect])
            }
          }
        AgentRunning(..), _
        | AgentWaiting(..), _
        | AgentUnavailable(..), _
        | AgentSettled(..), True
        -> restart_agent(lifted, id, slot, note, turns)
        AgentHeld(..), _ -> Error(types.NodeNotRunning(text))
        AgentSettled(..), False -> Error(types.NotLive(text))
      }
    // Nothing live to restart: check_live refuses these before a restart.
    ToolCall(..)
    | OrchestratorCall(..)
    | CommandCall(..)
    | AgentCall(..)
    | RefusedCall(..) -> Error(types.NotLive(text))
  }
}

/// A new attempt of an agent call: its progress starts over (the turn count
/// and allowance, and without its journaled tool results: the outside is
/// asked anew). Its answer will be a new session value, so every call after
/// it misses.
fn restart_agent(
  run: Run,
  id: RequestId,
  slot: Slot,
  note: Option(String),
  turns: Int,
) -> Result(#(Run, List(Effect)), Refusal) {
  let run = add_inbox(run, id, types.Restart, option.unwrap(note, ""))
  use #(_, call) <- result.try(
    lookup(run, id) |> result.replace_error(types.NotLive(ids.request_text(id))),
  )
  case call {
    AgentCall(agent:, attempts:, ..) -> {
      let allowed = case turns > 0, find_agent(run.workflow, agent) {
        True, _ -> turns
        False, Ok(a) -> a.max_turns
        False, Error(Nil) -> 0
      }
      let attempt = fn(state) {
        AgentCall(..call, attempts: [
          Tried(AgentAttempt(0, allowed, [], state)),
          ..attempts
        ])
      }
      case admit(run) {
        Error(reason) ->
          Ok(
            #(put(run, slot, attempt(AgentHeld(reason, note))), [
              types.Checkpoint,
            ]),
          )
        Ok(Nil) -> {
          let d = Dialogue([], note, None)
          let call = attempt(AgentRunning(d, IssuedNow, Fresh))
          use effect <- result.map(call_effect(run, slot, call, d))
          #(put(run, slot, call), [types.Checkpoint, effect])
        }
      }
    }
    // `restart` calls this for agent calls only.
    CommandCall(..) | ToolCall(..) | OrchestratorCall(..) | RefusedCall(..) ->
      Error(types.NotAnAgent(ids.request_text(id)))
  }
}

/// Fails one node as a typed failure; the body handles it.
fn cancel_node(run: Run, node: LiveNode) -> #(Run, List(Effect)) {
  let id = capability.live_id(node)
  case lookup(run, id) {
    Ok(#(slot, call)) ->
      case run.hold {
        // Accepting a held failure: it propagates, and the run ends Failed.
        Some(#(held, reason)) if held == slot ->
          finish(Run(..run, hold: None), types.Failed(reason))
        Some(_) | None -> cancel_live(run, slot, call)
      }
    Error(Nil) -> #(run, [
      types.Refuse(None, types.NotLive(ids.request_text(id))),
    ])
  }
}

fn cancel_live(run: Run, slot: Slot, call: Call) -> #(Run, List(Effect)) {
  let settled = fn(run: Run, call: Call, entry: Entry) {
    #(put(run, slot, call), [
      types.Checkpoint,
      answer_effect(call_id(call), entry),
    ])
  }
  case call {
    OrchestratorCall(name:, attempts:, ..) -> {
      let entry = Errored(types.OrchestratorCancelled(name))
      settled(
        run,
        OrchestratorCall(
          ..call,
          attempts: replace_head(attempts, OrchestratorSettled(entry)),
        ),
        entry,
      )
    }
    ToolCall(tool:, attempts:, ..) -> {
      // Sent (running, or unknown after a crash): it may have taken effect.
      let failure = case attempts {
        [Tried(ToolRunning(..)), ..] | [Tried(ToolInDoubt), ..] ->
          types.ToolUnknownOutcome
        [Tried(ToolHeld(..)), ..]
        | [Tried(ToolSettled(..)), ..]
        | [Forgotten, ..]
        | [] -> types.ToolCancelled
      }
      let entry = Errored(types.ToolCrashed(tool, failure))
      settled(
        run,
        ToolCall(..call, attempts: replace_head(attempts, ToolSettled(entry))),
        entry,
      )
    }
    CommandCall(command:, attempts:, ..) -> {
      let entry = Errored(types.CommandCrashed(command, types.CommandCancelled))
      settled(
        run,
        CommandCall(
          ..call,
          attempts: replace_head(attempts, CommandSettled(entry)),
        ),
        entry,
      )
    }
    AgentCall(agent:, ..) -> {
      // Cancelled while a tool call's outcome was unknown: the body is told.
      let failure = case agent_attempt(call) {
        Ok(AgentAttempt(
          state: AgentWaiting(cause: types.OutcomeUnknown(tool:, args:), ..),
          ..,
        )) -> types.UnknownOutcome(tool, args)
        Ok(AgentAttempt(state: AgentWaiting(..), ..))
        | Ok(AgentAttempt(state: AgentRunning(..), ..))
        | Ok(AgentAttempt(state: AgentUnavailable(..), ..))
        | Ok(AgentAttempt(state: AgentHeld(..), ..))
        | Ok(AgentAttempt(state: AgentSettled(..), ..))
        | Error(Nil) -> types.CancelledByOwner
      }
      let #(run, effects) =
        settle_agent(
          run,
          slot,
          call,
          Errored(types.AgentGaveUp(agent, failure)),
          None,
          no_usage(),
        )
      #(run, [types.Checkpoint, ..effects])
    }
    RefusedCall(id:, ..) -> #(run, [
      types.Refuse(None, types.NotLive(ids.request_text(id))),
    ])
  }
}

fn rebind(run: Run, alias: String, to: String) -> #(Run, List(Effect)) {
  case dict.has_key(run.models, alias) {
    False -> #(run, [types.Refuse(None, types.UnknownAlias(alias))])
    True -> #(Run(..run, models: dict.insert(run.models, alias, to)), [
      types.Checkpoint,
    ])
  }
}

/// Raises one limit and issues every blocked request the budget now admits.
fn raise_budget(
  run: Run,
  kind: types.BudgetKind,
  limit: Float,
) -> #(Run, List(Effect)) {
  let b = run.budget
  let budget = case kind {
    types.Turns -> types.Budget(..b, turns: Some(float.round(limit)))
    types.ComputeMinutes -> types.Budget(..b, compute_minutes: Some(limit))
  }
  let #(run, effects) = unblock(Run(..run, budget:))
  #(run, [types.Checkpoint, ..effects])
}

/// Issues every held-back call that the pause and the budget now admit.
fn unblock(run: Run) -> #(Run, List(Effect)) {
  sorted_calls(run)
  |> list.fold(#(run, []), fn(acc, entry) {
    let #(run, effects) = acc
    let #(slot, call) = entry
    case call {
      AgentCall(
        attempts: [Tried(AgentAttempt(state: AgentHeld(note:, ..), ..)), ..],
        ..,
      ) ->
        case admit(run) {
          Ok(Nil) -> {
            let d = Dialogue([], note, None)
            let call =
              update_agent(call, fn(a) {
                AgentAttempt(..a, state: AgentRunning(d, IssuedNow, Fresh))
              })
            case call_effect(run, slot, call, d) {
              Ok(effect) -> #(
                put(run, slot, call),
                list.append(effects, [effect]),
              )
              Error(_) -> acc
            }
          }
          Error(_) -> acc
        }
      ToolCall(attempts: [Tried(ToolHeld(..)), ..older], ..) ->
        case admission(run) {
          Ok(Nil) -> {
            let call =
              ToolCall(..call, attempts: [
                Tried(ToolRunning(IssuedNow)),
                ..older
              ])
            #(
              put(run, slot, call),
              list.append(effects, [tool_effect(slot, call)]),
            )
          }
          Error(_) -> acc
        }
      CommandCall(attempts: [Tried(CommandHeld(..)), ..older], ..) ->
        case result.try(admission(run), fn(_) { compute_check(run) }) {
          Ok(Nil) -> {
            let call =
              CommandCall(..call, attempts: [
                Tried(CommandRunning(IssuedNow)),
                ..older
              ])
            #(
              put(run, slot, call),
              list.append(effects, [command_effect(run, slot, call)]),
            )
          }
          Error(_) -> acc
        }
      // Not held back: nothing to issue.
      AgentCall(..)
      | ToolCall(..)
      | CommandCall(..)
      | OrchestratorCall(..)
      | RefusedCall(..) -> acc
    }
  })
}

fn command_settled(
  run: Run,
  id: RequestId,
  entry: fn(String) -> Entry,
  minutes: Float,
) -> #(Run, List(Effect)) {
  case lookup(run, id) {
    Ok(#(
      slot,
      CommandCall(command:, attempts: [Tried(CommandRunning(..)), ..older], ..) as call,
    )) -> {
      let run =
        Run(
          ..run,
          spent: Spent(
            ..run.spent,
            compute_minutes: run.spent.compute_minutes +. minutes,
          ),
        )
      let entry = entry(command)
      let call =
        CommandCall(..call, attempts: [Tried(CommandSettled(entry)), ..older])
      #(put(run, slot, call), [types.Checkpoint, answer_effect(id, entry)])
    }
    // Not running (cancelled, settled, restarted): the result is not this call's.
    Ok(#(_, CommandCall(..)))
    | Ok(#(_, AgentCall(..)))
    | Ok(#(_, ToolCall(..)))
    | Ok(#(_, OrchestratorCall(..)))
    | Ok(#(_, RefusedCall(..)))
    | Error(Nil) -> #(run, [])
  }
}

/// An MCP result inside a live agent call joins its attempt.
fn tool_recorded(
  run: Run,
  id: RequestId,
  call_key: String,
  result: Value,
) -> #(Run, List(Effect)) {
  case lookup(run, id) {
    Ok(#(slot, call)) ->
      case in_flight(call) {
        // A result for a call already journaled replaces it (the host found
        // the record did not match the call: another tool or arguments).
        Ok(_) -> {
          let call =
            update_agent(call, fn(a) {
              AgentAttempt(..a, tools: [
                types.ToolResult(call_key, result),
                ..list.filter(a.tools, fn(t) { t.call != call_key })
              ])
            })
          #(put(run, slot, call), [types.Checkpoint])
        }
        Error(Nil) -> #(run, [])
      }
    Error(Nil) -> #(run, [])
  }
}

fn tool_settled(
  run: Run,
  id: RequestId,
  entry: fn(String) -> Entry,
) -> #(Run, List(Effect)) {
  case lookup(run, id) {
    Ok(#(
      slot,
      ToolCall(tool:, attempts: [Tried(ToolRunning(..)), ..older], ..) as call,
    )) -> {
      let entry = entry(tool)
      let call =
        ToolCall(..call, attempts: [Tried(ToolSettled(entry)), ..older])
      #(put(run, slot, call), [types.Checkpoint, answer_effect(id, entry)])
    }
    // Not running: the result is not this call's.
    Ok(#(_, ToolCall(..)))
    | Ok(#(_, AgentCall(..)))
    | Ok(#(_, CommandCall(..)))
    | Ok(#(_, OrchestratorCall(..)))
    | Ok(#(_, RefusedCall(..)))
    | Error(Nil) -> #(run, [])
  }
}

/// The orchestrator's result for an orchestrator node; the host checked it
/// against the node's answer schema.
fn submit(
  run: Run,
  node: capability.SubmittableNode,
  answer: Value,
) -> Result(#(Run, List(Effect)), Refusal) {
  let id = capability.submittable_id(node)
  case lookup(run, id) {
    Ok(#(slot, OrchestratorCall(attempts:, ..) as call)) -> {
      let entry = Answered(answer)
      let call =
        OrchestratorCall(
          ..call,
          attempts: replace_head(attempts, OrchestratorSettled(entry)),
        )
      Ok(#(put(run, slot, call), [types.Checkpoint, answer_effect(id, entry)]))
    }
    Ok(#(_, AgentCall(..)))
    | Ok(#(_, CommandCall(..)))
    | Ok(#(_, ToolCall(..)))
    | Ok(#(_, RefusedCall(..)))
    | Error(Nil) -> Error(types.NotPending(ids.request_text(id)))
  }
}

/// A body tool call in flight at a crash and not safe to make again: it
/// waits for its owner, its outcome unknown.
fn tool_unknown(run: Run, id: RequestId) -> #(Run, List(Effect)) {
  case lookup(run, id) {
    Ok(#(
      slot,
      ToolCall(attempts: [Tried(ToolRunning(..)), ..older], ..) as call,
    )) -> #(
      put(run, slot, ToolCall(..call, attempts: [Tried(ToolInDoubt), ..older])),
      [types.Checkpoint],
    )
    // Not a tool call in flight: nothing to record.
    Ok(#(_, ToolCall(..)))
    | Ok(#(_, AgentCall(..)))
    | Ok(#(_, CommandCall(..)))
    | Ok(#(_, OrchestratorCall(..)))
    | Ok(#(_, RefusedCall(..)))
    | Error(Nil) -> #(run, [])
  }
}

fn find_agent(workflow: Workflow, name: String) -> Result(Agent, Nil) {
  list.find(workflow.agents, fn(a) { a.name == name })
}

// --- Status --------------------------------------------------------------------

/// What a call's live attempt contributes to the run's status.
type Activity {
  /// In flight.
  Busy
  /// Held back (or faulted) for this reason.
  Blocked(IdleReason)
  /// Waiting for its owner.
  Awaiting
  /// Settled or forgotten.
  Quiet
}

fn activity(run: Run, call: Call) -> Activity {
  case call {
    AgentCall(attempts: [Tried(a), ..], ..) ->
      case a.state {
        AgentRunning(..) -> Busy
        AgentHeld(reason:, ..) -> Blocked(current_reason(run, reason))
        AgentUnavailable(alias:, error:, ..) ->
          Blocked(types.ExecutorUnavailable(alias, error))
        AgentWaiting(..) -> Awaiting
        AgentSettled(..) -> Quiet
      }
    CommandCall(attempts: [Tried(state), ..], ..) ->
      case state {
        CommandRunning(..) -> Busy
        CommandHeld(reason) -> Blocked(current_reason(run, reason))
        CommandSettled(..) -> Quiet
      }
    ToolCall(attempts: [Tried(state), ..], ..) ->
      case state {
        ToolRunning(..) -> Busy
        ToolHeld(reason) -> Blocked(current_reason(run, reason))
        ToolInDoubt -> Awaiting
        ToolSettled(..) -> Quiet
      }
    OrchestratorCall(attempts: [Tried(state), ..], ..) ->
      case state {
        OrchestratorWaiting -> Awaiting
        OrchestratorSettled(..) -> Quiet
      }
    AgentCall(..)
    | CommandCall(..)
    | ToolCall(..)
    | OrchestratorCall(..)
    | RefusedCall(..) -> Quiet
  }
}

/// Running while any call is in flight. Otherwise idle: on a held failure,
/// paused, for budget or an executor fault (the first blocked call by id),
/// or because a node waits for its owner. A run with nothing in flight and
/// nothing waiting is running: its body is computing.
pub fn status(run: RunState) -> Option(RunStatus) {
  case run {
    NotYetStarted -> None
    Active(Run(lifecycle: Ended(outcome), ..)) -> Some(types.Finished(outcome))
    Active(r) -> {
      let activities = list.map(sorted_calls(r), fn(e) { activity(r, e.1) })
      let running = list.contains(activities, Busy)
      let reason =
        list.find_map(activities, fn(a) {
          case a {
            Blocked(reason) -> Ok(reason)
            Busy | Awaiting | Quiet -> Error(Nil)
          }
        })
      let waiting = list.contains(activities, Awaiting)
      case running, r.hold, r.admission, reason, waiting {
        // In flight wins; then a held failure; then a pause; then a reason.
        True, _, _, _, _ -> Some(types.Running)
        False, Some(#(slot, reason)), _, _, _ ->
          Some(types.Idle(Some(types.NodeFailure(held_id(r, slot), reason))))
        False, None, Holding, _, _ -> Some(types.Idle(Some(types.PausedByUser)))
        False, None, Admitting, Ok(reason), _ -> Some(types.Idle(Some(reason)))
        False, None, Admitting, Error(Nil), True -> Some(types.Idle(None))
        False, None, Admitting, Error(Nil), False -> Some(types.Running)
      }
    }
  }
}

fn held_id(run: Run, slot: Slot) -> String {
  case dict.get(run.calls, slot) {
    Ok(call) -> ids.request_text(call_id(call))
    Error(Nil) -> ""
  }
}

/// A held request's reason with the spend as it is now: calls in flight
/// when the budget was reached may have added to it.
fn current_reason(run: Run, reason: IdleReason) -> IdleReason {
  case reason {
    types.BudgetReached(kind: types.Turns, ..) ->
      budget_check(run) |> result.unwrap_error(reason)
    types.BudgetReached(kind: types.ComputeMinutes, ..) ->
      compute_check(run) |> result.unwrap_error(reason)
    types.ExecutorUnavailable(..)
    | types.PausedByUser
    | types.NodeFailure(..) -> reason
  }
}

/// Every call on the live path, as a node: running, waiting, held back,
/// done, or refused. A forgotten call (a later call of a rewound session)
/// is not on the live path and is not shown.
pub fn nodes(run: RunState) -> List(Node) {
  case run {
    NotYetStarted -> []
    Active(r) ->
      sorted_calls(r)
      |> list.filter_map(fn(e) { node_of(r, e.1) })
  }
}

fn node_of(r: Run, call: Call) -> Result(Node, Nil) {
  case call {
    AgentCall(id:, agent:, inbox:, attempts:, ..) -> {
      let id = ids.request_text(id)
      let steerable = steerable(r, agent)
      let inbox = list.reverse(inbox)
      let current = fn() {
        case find_agent(r.workflow, agent) {
          Ok(a) -> resolve_model(r.models, a.model) |> result.unwrap("")
          Error(Nil) -> ""
        }
      }
      case attempts {
        [Tried(AgentAttempt(state:, ..)), ..] ->
          case state {
            AgentRunning(..) ->
              Ok(types.NodeRunning(id, agent, current(), steerable, inbox))
            AgentWaiting(model:, cause:, ..) ->
              Ok(types.NodeIdle(id, agent, model, steerable, inbox, cause))
            AgentHeld(reason:, ..) ->
              Ok(types.NodeHeld(
                id,
                agent,
                current(),
                steerable,
                inbox,
                current_reason(r, reason),
              ))
            AgentUnavailable(alias:, error:, ..) ->
              Ok(types.NodeHeld(
                id,
                agent,
                current(),
                steerable,
                inbox,
                types.ExecutorUnavailable(alias, error),
              ))
            AgentSettled(entry:, served:, ..) -> {
              let done = fn(outcome) {
                Ok(types.NodeDone(
                  id,
                  agent,
                  option.unwrap(served, ""),
                  steerable,
                  inbox,
                  outcome,
                ))
              }
              case entry {
                Answered(_) -> done(types.Submitted)
                Errored(types.AgentGaveUp(failure:, ..)) ->
                  done(types.NodeFailed(failure))
                Refused(refusal) -> Ok(types.NodeRefused(id, refusal))
                // An agent call fails only as AgentGaveUp.
                Errored(_) -> Error(Nil)
              }
            }
          }
        [Forgotten, ..] | [] -> Error(Nil)
      }
    }
    CommandCall(id:, command:, inbox:, attempts:, ..) -> {
      let id = ids.request_text(id)
      let inbox = list.reverse(inbox)
      case attempts {
        [Tried(CommandRunning(..)), ..] ->
          Ok(types.CommandRunning(id, command, inbox))
        [Tried(CommandHeld(reason)), ..] ->
          Ok(types.CommandHeld(id, command, inbox, current_reason(r, reason)))
        [Tried(CommandSettled(Answered(_))), ..] ->
          Ok(types.CommandDone(id, command, inbox, types.Succeeded))
        [Tried(CommandSettled(Errored(types.CommandCrashed(failure:, ..)))), ..] ->
          Ok(types.CommandDone(id, command, inbox, types.FailedWith(failure)))
        [Tried(CommandSettled(Refused(refusal))), ..] ->
          Ok(types.NodeRefused(id, refusal))
        // A command fails only as CommandCrashed.
        [Tried(CommandSettled(Errored(_))), ..] | [Forgotten, ..] | [] ->
          Error(Nil)
      }
    }
    ToolCall(id:, tool:, input:, attempts:, ..) -> {
      let id = ids.request_text(id)
      case attempts {
        [Tried(ToolRunning(..)), ..] -> Ok(types.ToolRunning(id, tool))
        [Tried(ToolInDoubt), ..] ->
          Ok(types.ToolOutcomeUnknown(id, tool, input))
        [Tried(ToolHeld(reason)), ..] ->
          Ok(types.ToolHeld(id, tool, current_reason(r, reason)))
        [Tried(ToolSettled(Answered(_))), ..] ->
          Ok(types.ToolDone(id, tool, types.ToolSucceeded))
        [Tried(ToolSettled(Errored(types.ToolCrashed(failure:, ..)))), ..] ->
          Ok(types.ToolDone(id, tool, types.ToolFailedWith(failure)))
        [Tried(ToolSettled(Refused(refusal))), ..] ->
          Ok(types.NodeRefused(id, refusal))
        // A tool call fails only as ToolCrashed.
        [Tried(ToolSettled(Errored(_))), ..] | [Forgotten, ..] | [] ->
          Error(Nil)
      }
    }
    OrchestratorCall(id:, name:, input:, attempts:) -> {
      let id = ids.request_text(id)
      case attempts {
        [Tried(OrchestratorWaiting), ..] ->
          Ok(types.OrchestratorPending(id, name, input))
        [Tried(OrchestratorSettled(Answered(_))), ..] ->
          Ok(types.OrchestratorDone(id, name))
        [
          Tried(OrchestratorSettled(Errored(types.OrchestratorCancelled(..)))),
          ..
        ] -> Ok(types.OrchestratorDropped(id, name))
        [Tried(OrchestratorSettled(Refused(refusal))), ..] ->
          Ok(types.NodeRefused(id, refusal))
        // An orchestrator node fails only as cancelled.
        [Tried(OrchestratorSettled(Errored(_))), ..] | [Forgotten, ..] | [] ->
          Error(Nil)
      }
    }
    RefusedCall(id:, refusal:) ->
      Ok(types.NodeRefused(ids.request_text(id), refusal))
  }
}

/// The whole state, as text: every field of the run (calls with all their
/// attempts, sessions, layers, dialogue and checkpoint digests, retries,
/// recorded tool results, hold, spend, facts), except whether a running call
/// was issued in this host session, which a fold of the log cannot know.
/// For the differential check: the live state must equal the log's fold.
pub fn full_state(run: RunState) -> String {
  case run {
    NotYetStarted -> "not yet started"
    Active(r) -> string.inspect(Active(unissued(r)))
  }
}

/// The host facts the log noted (`Noted`), for `meta.json`: not part of the
/// snapshot, since they are about the host, not the run.
pub fn host_facts(run: RunState) -> json.Json {
  case run {
    NotYetStarted -> json.object([])
    Active(r) -> sorted_object(r.facts, value.to_json)
  }
}

fn entry_text(entry: Entry) -> String {
  case entry {
    Answered(_) -> "answered"
    Errored(_) -> "errored"
    Refused(_) -> "refused"
  }
}

fn describe_attempts(
  attempts: List(Attempt(s)),
  settled: fn(s) -> Option(String),
) -> List(String) {
  list.map(attempts, fn(attempt) {
    case attempt {
      Forgotten -> "forgotten"
      Tried(state) -> option.unwrap(settled(state), "open")
    }
  })
}

/// The attempts at a request's slot, newest first, for tests and display:
/// `open`, `forgotten`, or how it settled and by which model.
pub fn attempts(run: RunState, id: String) -> List(String) {
  case run {
    NotYetStarted -> []
    Active(r) ->
      case lookup(r, ids.request_id(id)) {
        Error(Nil) -> []
        Ok(#(_, call)) ->
          case call {
            AgentCall(attempts:, ..) ->
              describe_attempts(attempts, fn(a) {
                case a.state {
                  AgentSettled(entry: e, served: Some(model), ..) ->
                    Some(entry_text(e) <> " by " <> model)
                  AgentSettled(entry: e, served: None, ..) ->
                    Some(entry_text(e))
                  AgentHeld(..)
                  | AgentRunning(..)
                  | AgentWaiting(..)
                  | AgentUnavailable(..) -> None
                }
              })
            CommandCall(attempts:, ..) ->
              describe_attempts(attempts, fn(s) {
                case s {
                  CommandSettled(e) -> Some(entry_text(e))
                  CommandHeld(..) | CommandRunning(..) -> None
                }
              })
            ToolCall(attempts:, ..) ->
              describe_attempts(attempts, fn(s) {
                case s {
                  ToolSettled(e) -> Some(entry_text(e))
                  ToolHeld(..) | ToolRunning(..) | ToolInDoubt -> None
                }
              })
            OrchestratorCall(attempts:, ..) ->
              describe_attempts(attempts, fn(s) {
                case s {
                  OrchestratorSettled(e) -> Some(entry_text(e))
                  OrchestratorWaiting -> None
                }
              })
            RefusedCall(..) -> ["refused"]
          }
      }
  }
}

/// Canonical JSON of the run: status, nodes, observations, spend, budget,
/// models, executor and owner.
pub fn snapshot(run: RunState) -> json.Json {
  case run {
    NotYetStarted -> json.object([#("status", json.null())])
    Active(r) ->
      json.object([
        #("status", case status(run) {
          Some(s) -> types.run_status_to_json(s)
          None -> json.null()
        }),
        #("nodes", json.array(nodes(run), types.node_to_json)),
        #(
          "observations",
          json.array(list.reverse(r.observations), types.observation_to_json),
        ),
        #(
          "spent",
          json.object([
            #("usd", json.float(r.spent.usd)),
            #("tokens", json.int(r.spent.tokens)),
            #("turns", json.int(r.spent.turns)),
            #("compute_minutes", json.float(r.spent.compute_minutes)),
          ]),
        ),
        #("budget", types.budget_to_json(r.budget)),
        #("models", sorted_object(r.models, json.string)),
        #("executor", json.nullable(r.executor, json.string)),
        #(
          "held",
          json.nullable(
            option.map(r.hold, fn(h) { held_id(r, h.0) }),
            json.string,
          ),
        ),
        #(
          "code",
          json.array(
            [r.pin.workflow_digest, ..list.reverse(r.pin.prior_digests)],
            json.string,
          ),
        ),
        #("owner", json.nullable(r.owner, json.string)),
        #("sessions", json.array(session_branches(r), fn(x) { x })),
      ])
  }
}

/// Every session value the run answered with, by the call that made it:
/// the session it continued (`from`, null for a new one), so the values
/// form a tree of branches.
fn session_branches(r: Run) -> List(json.Json) {
  r.sessions
  |> dict.to_list
  |> list.filter_map(fn(e) {
    let #(id, Origin(after:, ..)) = e
    case dict.get(r.calls, after) {
      Ok(AgentCall(id: call, agent:, session:, ..)) ->
        Ok(#(
          ids.request_text(call),
          json.object([
            #("id", json.string(ids.session_text(id))),
            #("agent", json.string(agent)),
            #("call", json.string(ids.request_text(call))),
            #(
              "from",
              json.nullable(option.map(session, ids.session_text), json.string),
            ),
          ]),
        ))
      Ok(CommandCall(..))
      | Ok(ToolCall(..))
      | Ok(OrchestratorCall(..))
      | Ok(RefusedCall(..))
      | Error(Nil) -> Error(Nil)
    }
  })
  |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
  |> list.map(fn(e) { e.1 })
}

fn sorted_object(d: Dict(String, a), encode: fn(a) -> json.Json) -> json.Json {
  d
  |> dict.to_list
  |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
  |> list.map(fn(e) { #(e.0, encode(e.1)) })
  |> json.object
}
