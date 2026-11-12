//// The run state machine: `step(RunState, Event) -> #(RunState, List(Effect))`.
////
//// A run is a fold of the workflow body over its journal. The body is plain
//// code whose only interface to the world is typed calls; each call affects
//// the body only through its answer. The core keeps the calls (the journal)
//// and the run's lifecycle; nothing of the body's own state.
////
//// Every call the body made is kept by its slot (node, input, scope,
//// occurrence), with its attempts, newest first. The journal only grows. A
//// request for a slot whose live attempt answered is a hit, answered from
//// the journal and not logged, so a resumed run's log equals an
//// uninterrupted one. A slot whose live attempt is running is the same
//// call: issued again if this process has not issued it (it was in flight
//// when the last one stopped). A slot whose live attempt failed gets a new
//// attempt: a failure is not a completed call, so resuming runs it again.
//// Except a decided failure (an agent's turn limit or invalid output, an
//// unsafe tool call whose outcome is unknown): it is the call's result, and
//// runs again only when the caller names it (`Retried`).
////
//// Resume is the only reuse, and only within one run: nothing here is
//// shared across runs.
////
//// Agent calls are calls of session values. A session value is a hash
//// chain over the call it comes after and that call's attempt, so a new
//// attempt yields a new session and everything after it misses; only the
//// agent that answered with it (by definition digest) continues it.
////
//// Mailboxes: every message is journaled once, by its send's key, in the
//// order it was delivered to its mailbox; its id is `<mailbox>/<seq>`. A
//// send whose key is journaled is not delivered again, so a body that runs
//// again after a resume re-sends nothing, and its mailboxes replay their
//// recorded order before anything new.

import gleam/dict.{type Dict}
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import wallis_core/ids.{type Digest, type RequestId, type SessionId, type Slot}
import wallis_core/types.{
  type Effect, type Event, type FailReason, type Outcome, type Refusal,
  type Request, type Workflow,
}
import wallis_core/value.{type Value}

/// Bumped when a change to the core changes what a log means.
pub const semantics = "wallis-core/v2.1"

pub opaque type RunState {
  NotYetStarted
  Active(Run)
}

type Lifecycle {
  Live
  Ended(Outcome)
}

type Run {
  Run(
    lifecycle: Lifecycle,
    workflow: Workflow,
    /// Module digests of earlier processes that drove the run, oldest first.
    prior_digests: List(String),
    input: Value,
    /// Every call the body made, by slot: the journal and the live state.
    calls: Dict(Slot, Call),
    /// The slot each request id named. A call that moved to a new id keeps
    /// the old one here; `lookup` answers only for the call's current id.
    ids: Dict(RequestId, Slot),
    /// Every session value an agent call answered with: where it comes from.
    sessions: Dict(SessionId, Origin),
    /// Every mailbox's messages, newest first.
    mailboxes: Dict(String, List(types.Envelope)),
    /// The message id each journaled send's key was delivered as.
    sends: Dict(String, String),
    /// Host facts (`Noted`): what `meta.json` is derived from.
    facts: Dict(String, Value),
  )
}

/// Where a session value comes from: the agent (its definition digest), the
/// call (slot) and attempt that answered with it, the dialogue after it (a
/// blob) and its workspace layers, bottom first.
type Origin {
  Origin(
    node: Digest,
    after: Slot,
    attempt: Int,
    dialogue: Option(Digest),
    layers: List(Digest),
  )
}

/// What kind of node a call runs: each kind takes only its own results.
type Kind {
  CommandKind
  WorkflowKind
  /// A call of a session value (`None`: a new session, whose workspace
  /// starts from the layers `from`).
  AgentKind(session: Option(SessionId), from: List(Digest))
  ToolKind(replay_safe: Bool)
}

/// A call of the body. `attempts` are newest first and never empty.
type Call {
  Call(
    id: RequestId,
    kind: Kind,
    /// A label, for display.
    name: String,
    /// The node's definition digest: its identity.
    node: Digest,
    input: Value,
    /// The slot of the nested workflow call it was made in; "" at the top.
    scope: String,
    occurrence: Int,
    attempts: List(Attempt),
  )
}

/// One attempt at a call. A running agent attempt keeps its newest
/// checkpoint (a dialogue blob) and the messages it took, newest first.
type Attempt {
  Running(
    issued: Issued,
    checkpoint: Option(Digest),
    taken: List(types.Taken),
    continuation: types.Continuation,
  )
  Settled(entry: Entry)
}

fn running() -> Attempt {
  Running(IssuedNow, None, [], types.Fresh)
}

/// Whether a running call's effect was emitted by this process: a call in
/// flight when the last process stopped is issued again, once.
type Issued {
  NotIssued
  IssuedNow
}

type Entry {
  Answered(Value)
  Errored(FailReason)
  /// A failure that is the call's own outcome: answered from the journal
  /// like a result, and run again only when retried. `dialogue`: an agent's
  /// dialogue after it, which a retry continues.
  Decided(FailReason, dialogue: Option(Digest))
}

pub fn new() -> RunState {
  NotYetStarted
}

/// What an event is to `step`: every variant is named here once, so a new
/// event must say which it is.
type Phase {
  Starting(workflow: Workflow, input: Value, semantics: String)
  Resuming(digest: String, semantics: String)
  /// Host facts: applied even on a finished run.
  Noting(key: String, value: Value)
  /// Everything else: applied to a live run only (`live_event`).
  Applying
}

fn phase(event: Event) -> Phase {
  case event {
    types.Started(workflow:, input:, semantics:) ->
      Starting(workflow, input, semantics)
    types.Resumed(digest:, semantics:) -> Resuming(digest, semantics)
    types.Noted(key:, value:) -> Noting(key, value)
    types.Requested(..)
    | types.AgentProgressed(..)
    | types.MessagesTaken(..)
    | types.AgentReturned(..)
    | types.AgentFailed(..)
    | types.Sent(..)
    | types.ToolReturned(..)
    | types.ToolFailed(..)
    | types.Retried(..)
    | types.CommandReturned(..)
    | types.CommandFailed(..)
    | types.WorkflowReturned(..)
    | types.WorkflowFailed(..)
    | types.BodyFinished(..)
    | types.BodyFailed(..) -> Applying
  }
}

pub fn step(state: RunState, event: Event) -> #(RunState, List(Effect)) {
  case state, phase(event) {
    NotYetStarted, Starting(workflow:, input:, semantics: s) ->
      case s == semantics {
        True -> #(
          Active(Run(
            lifecycle: Live,
            workflow:,
            prior_digests: [],
            input:,
            calls: dict.new(),
            ids: dict.new(),
            sessions: dict.new(),
            mailboxes: dict.new(),
            sends: dict.new(),
            facts: dict.new(),
          )),
          [types.Checkpoint],
        )
        False -> #(state, [
          types.Refuse(None, types.SemanticsChanged(s, semantics)),
        ])
      }
    // Before `Started` every other event is refused: there is no run.
    NotYetStarted, Resuming(..)
    | NotYetStarted, Noting(..)
    | NotYetStarted, Applying
    -> #(state, [types.Refuse(None, types.NotStarted)])
    Active(_), Starting(..) -> #(state, [
      types.Refuse(None, types.AlreadyStarted),
    ])
    Active(r), Resuming(digest:, semantics: s) ->
      case s == semantics {
        False -> #(state, [
          types.Refuse(None, types.SemanticsChanged(semantics, s)),
        ])
        True -> {
          let #(r, effects) = resume(r, digest)
          #(Active(r), effects)
        }
      }
    Active(r), Noting(key:, value:) -> #(
      Active(Run(..r, facts: dict.insert(r.facts, key, value))),
      [types.Checkpoint],
    )
    Active(Run(lifecycle: Live, ..) as r), Applying -> {
      let #(r, effects) = live_event(r, event)
      #(Active(r), effects)
    }
    Active(Run(lifecycle: Ended(_), ..)), Applying -> #(state, [
      types.Refuse(None, types.RunEnded),
    ])
  }
}

// --- Resume --------------------------------------------------------------------

/// A new process drives the run. A completed run stays completed (its
/// outcome is the answer); a failed or stopped one is live again, with
/// nothing in flight issued by this process yet.
fn resume(run: Run, digest: String) -> #(Run, List(Effect)) {
  let prior_digests = case digest == run.workflow.digest {
    True -> run.prior_digests
    False -> list.append(run.prior_digests, [run.workflow.digest])
  }
  let run =
    Run(
      ..run,
      prior_digests:,
      workflow: types.Workflow(..run.workflow, digest:),
      calls: dict.map_values(run.calls, fn(_, call) { unissued(call) }),
    )
  case run.lifecycle {
    Ended(types.Done(_) as outcome) -> #(run, [
      types.Checkpoint,
      types.Finish(outcome),
    ])
    Ended(types.Failed(_)) | Live -> #(Run(..run, lifecycle: Live), [
      types.Checkpoint,
    ])
  }
}

fn unissued(call: Call) -> Call {
  case call.attempts {
    [Running(_, checkpoint, taken, continuation), ..older] ->
      Call(..call, attempts: [
        Running(NotIssued, checkpoint, taken, continuation),
        ..older
      ])
    // Nothing in flight: nothing to issue again.
    [Settled(_), ..] | [] -> call
  }
}

// --- Events on a live run ------------------------------------------------------

fn live_event(run: Run, event: Event) -> #(Run, List(Effect)) {
  let rid = ids.request_id
  case event {
    types.Requested(id:, request:, node:, scope:, occurrence:) ->
      requested(run, rid(id), request, ids.digest(node), scope, occurrence)
    types.CommandReturned(id:, output:) ->
      settle(run, rid(id), is_command, fn(_, _) { #(run, Answered(output)) })
    types.CommandFailed(id:, failure:) ->
      settle(run, rid(id), is_command, fn(_, call) {
        #(run, Errored(types.CommandError(call.name, failure)))
      })
    types.WorkflowReturned(id:, output:) ->
      settle(run, rid(id), is_workflow, fn(_, _) { #(run, Answered(output)) })
    types.WorkflowFailed(id:, reason:) ->
      settle(run, rid(id), is_workflow, fn(_, call) {
        #(run, Errored(types.WorkflowError(call.name, reason)))
      })
    types.AgentReturned(id:, output:, dialogue:, layers:, ..) ->
      settle(run, rid(id), is_agent, fn(slot, call) {
        let #(run, session) =
          register(run, slot, call, Some(ids.digest(dialogue)), layers)
        #(
          run,
          Answered(
            value.object([
              #("output", output),
              #("session", value.JString(ids.session_text(session))),
              #("layers", value.JArray(list.map(layers, value.JString))),
            ]),
          ),
        )
      })
    types.AgentFailed(id:, failure:, dialogue:, layers:, ..) ->
      settle(run, rid(id), is_agent, fn(slot, call) {
        let dialogue = option.map(dialogue, ids.digest)
        // A failure with a dialogue after it can be continued from.
        let #(run, session) = case dialogue {
          Some(_) -> {
            let #(run, session) = register(run, slot, call, dialogue, layers)
            #(run, Some(ids.session_text(session)))
          }
          None -> #(run, None)
        }
        let reason = types.AgentError(call.name, failure, session)
        #(run, case failure {
          types.TurnLimitReached(..) | types.InvalidOutput(..) ->
            Decided(reason, dialogue)
          types.GaveUp(..) | types.ContextExhausted -> Errored(reason)
        })
      })
    types.ToolReturned(id:, output:) ->
      settle(run, rid(id), is_tool, fn(_, _) { #(run, Answered(output)) })
    types.ToolFailed(id:, message:) ->
      settle(run, rid(id), is_tool, fn(_, call) {
        #(run, Errored(types.ToolError(call.name, message)))
      })
    types.Retried(call:, turns:) -> retried(run, call, turns)
    types.AgentProgressed(id:, checkpoint:) ->
      update_running(run, rid(id), fn(_, taken) {
        #(Some(ids.digest(checkpoint)), taken)
      })
    types.MessagesTaken(id:, messages:, turn:) ->
      update_running(run, rid(id), fn(c, taken) {
        #(c, [types.Taken(turn, messages), ..taken])
      })
    types.Sent(key:, to:, from:, reply_to:, body:) ->
      sent(run, key, to, from, reply_to, body)
    types.BodyFinished(output:) -> finish(run, types.Done(output))
    types.BodyFailed(reason:) -> finish(run, types.Failed(reason))
    // Handled by `step` (`phase`) before a live run sees them.
    types.Started(..) | types.Resumed(..) | types.Noted(..) -> #(run, [])
  }
}

fn finish(run: Run, outcome: Outcome) -> #(Run, List(Effect)) {
  #(Run(..run, lifecycle: Ended(outcome)), [
    types.Checkpoint,
    types.Finish(outcome),
  ])
}

fn kind_of(request: Request) -> #(Kind, String, Value) {
  case request {
    types.CommandCall(name:, input:) -> #(CommandKind, name, input)
    types.WorkflowCall(name:, input:) -> #(WorkflowKind, name, input)
    types.AgentCall(name:, input:, session:, from:) -> #(
      AgentKind(
        option.map(session, ids.session_id),
        list.map(from, ids.digest),
      ),
      name,
      input,
    )
    types.ToolCall(name:, input:, replay_safe:) -> #(
      ToolKind(replay_safe),
      name,
      input,
    )
  }
}

fn kind_text(kind: Kind) -> String {
  case kind {
    CommandKind -> "command"
    WorkflowKind -> "workflow"
    AgentKind(..) -> "agent"
    ToolKind(..) -> "tool"
  }
}

fn is_command(kind: Kind) -> Bool {
  case kind {
    CommandKind -> True
    WorkflowKind | AgentKind(..) | ToolKind(..) -> False
  }
}

fn is_workflow(kind: Kind) -> Bool {
  case kind {
    WorkflowKind -> True
    CommandKind | AgentKind(..) | ToolKind(..) -> False
  }
}

fn is_agent(kind: Kind) -> Bool {
  case kind {
    AgentKind(..) -> True
    CommandKind | WorkflowKind | ToolKind(..) -> False
  }
}

fn is_tool(kind: Kind) -> Bool {
  case kind {
    ToolKind(..) -> True
    CommandKind | WorkflowKind | AgentKind(..) -> False
  }
}

/// The caller names a failed call to run again: its next request opens a
/// new attempt. An agent's decided failure continues its own dialogue (with
/// more turns, or with its output's errors); anything else starts fresh.
fn retried(run: Run, text: String, turns: Int) -> #(Run, List(Effect)) {
  let found =
    dict.to_list(run.calls)
    |> list.find(fn(e) { ids.slot_text(e.0) == text })
  case found {
    Error(Nil) -> #(run, [types.Refuse(None, types.NotRetriable(text))])
    Ok(#(slot, call)) ->
      case call.attempts {
        [Settled(Decided(reason, dialogue)), ..] -> {
          let continuation = case reason {
            types.AgentError(failure: types.TurnLimitReached(..), ..) ->
              types.MoreTurns(turns)
            types.AgentError(failure: types.InvalidOutput(errors), ..) ->
              types.FixOutput(errors)
            types.AgentError(..)
            | types.BodyError(..)
            | types.CommandError(..)
            | types.WorkflowError(..)
            | types.ToolError(..)
            | types.SchemaMismatch(..) -> types.Fresh
          }
          let attempt = Running(NotIssued, dialogue, [], continuation)
          let call = Call(..call, attempts: [attempt, ..call.attempts])
          #(put(run, slot, call), [types.Checkpoint])
        }
        // A failure runs again on resume anyway; naming it changes nothing.
        [Settled(Errored(_)), ..] -> #(run, [])
        [Settled(Answered(_)), ..] | [Running(..), ..] | [] -> #(run, [
          types.Refuse(None, types.NotRetriable(text)),
        ])
      }
  }
}

/// What a session call continues, checked: a session value this run
/// answered with, of this agent (by identity: a renamed agent still does).
fn session_check(
  run: Run,
  kind: Kind,
  node: Digest,
) -> Result(Option(Origin), Refusal) {
  case kind {
    AgentKind(session: Some(s), ..) ->
      case dict.get(run.sessions, s) {
        Error(Nil) -> Error(types.UnknownSession(ids.session_text(s)))
        Ok(origin) if origin.node != node ->
          Error(types.SessionOfAnotherAgent(ids.session_text(s)))
        Ok(origin) -> Ok(Some(origin))
      }
    AgentKind(session: None, ..) | CommandKind | WorkflowKind | ToolKind(..) ->
      Ok(None)
  }
}

/// The session a settled agent call answers with: a hash chain over its
/// slot and attempt, so a new attempt yields a new session value.
fn register(
  run: Run,
  slot: Slot,
  call: Call,
  dialogue: Option(Digest),
  layers: List(String),
) -> #(Run, ids.SessionId) {
  let attempt = list.length(call.attempts)
  let session = ids.next_session(slot, attempt)
  let origin =
    Origin(
      node: call.node,
      after: slot,
      attempt:,
      dialogue:,
      layers: list.map(layers, ids.digest),
    )
  #(Run(..run, sessions: dict.insert(run.sessions, session, origin)), session)
}

fn requested(
  run: Run,
  id: RequestId,
  request: Request,
  node: Digest,
  scope: String,
  occurrence: Int,
) -> #(Run, List(Effect)) {
  let #(kind, name, input) = kind_of(request)
  case session_check(run, kind, node) {
    Error(refusal) -> #(run, [
      types.Refuse(Some(ids.request_text(id)), refusal),
    ])
    Ok(_) -> requested_checked(run, id, kind, name, node, input, scope, occurrence)
  }
}

fn requested_checked(
  run: Run,
  id: RequestId,
  kind: Kind,
  name: String,
  node: Digest,
  input: Value,
  scope: String,
  occurrence: Int,
) -> #(Run, List(Effect)) {
  // The node's name is not part of the slot: names are labels. A session
  // call's slot includes its session (a hash chain over every call before
  // it); a new session's, the layers it starts from.
  let within = case kind {
    AgentKind(session: Some(s), ..) -> Some(s)
    AgentKind(session: None, from: []) -> None
    AgentKind(session: None, from:) ->
      Some(
        ids.session_id(
          "new:" <> string.join(list.map(from, ids.digest_text), ","),
        ),
      )
    CommandKind | WorkflowKind | ToolKind(..) -> None
  }
  let slot =
    ids.slot(
      node,
      kind_text(kind),
      input,
      scope,
      within,
      int.to_string(occurrence),
    )
  case dict.get(run.calls, slot) {
    Error(Nil) -> {
      let call =
        Call(
          id:,
          kind:,
          name:,
          node:,
          input:,
          scope:,
          occurrence:,
          attempts: [running()],
        )
      #(put(run, slot, call), [types.Checkpoint, issue(run, slot, call)])
    }
    Ok(call) -> {
      // A call keeps its slot under the id the body uses now; a move is logged.
      let moved = call.id != id
      let call = Call(..call, id:)
      let #(call, effects) = case call.attempts {
        [Settled(Answered(v)), ..] -> #(call, [
          types.Deliver(ids.request_text(id), v),
        ])
        [Settled(Decided(reason, _)), ..] -> #(call, [
          types.Fail(ids.request_text(id), reason),
        ])
        // A body tool call in flight as a process stopped, not safe to make
        // again: its outcome is unknown, decided so until it is retried.
        [Running(NotIssued, ..), ..older] if call.kind == ToolKind(False) -> {
          let reason =
            types.ToolError(
              call.name,
              "outcome unknown: it was in flight when the run stopped; check, then retry it",
            )
          let call = Call(..call, attempts: [Settled(Decided(reason, None)), ..older])
          #(call, [types.Checkpoint, types.Fail(ids.request_text(id), reason)])
        }
        [Running(NotIssued, checkpoint, taken, continuation), ..older] -> {
          let call =
            Call(..call, attempts: [
              Running(IssuedNow, checkpoint, taken, continuation),
              ..older
            ])
          #(call, [issue(run, slot, call)])
        }
        [Running(IssuedNow, ..), ..] -> #(call, [])
        // A failure is not a completed call: it runs again, as a new attempt.
        [Settled(Errored(_)), ..] | [] -> {
          let call = Call(..call, attempts: [running(), ..call.attempts])
          #(call, [types.Checkpoint, issue(run, slot, call)])
        }
      }
      let logged = list.contains(effects, types.Checkpoint)
      let effects = case moved && !logged {
        True -> [types.Checkpoint, ..effects]
        False -> effects
      }
      #(put(run, slot, call), effects)
    }
  }
}

fn issue(run: Run, slot: Slot, call: Call) -> Effect {
  let id = ids.request_text(call.id)
  let attempt = list.length(call.attempts)
  case call.kind {
    CommandKind -> types.RunCommand(id, attempt)
    ToolKind(..) -> types.RunTool(id, attempt)
    WorkflowKind -> types.RunWorkflow(id, ids.slot_text(slot), attempt)
    AgentKind(session:, from:) -> {
      // Checked when it was requested: a session call's origin exists.
      let origin = case session {
        Some(s) -> option.from_result(dict.get(run.sessions, s))
        None -> None
      }
      let #(history, layers) = case origin {
        Some(o) -> #(o.dialogue, o.layers)
        None -> #(None, from)
      }
      let #(checkpoint, taken, continuation) = case call.attempts {
        [Running(_, checkpoint, taken, continuation), ..] -> #(
          checkpoint,
          taken,
          continuation,
        )
        [Settled(_), ..] | [] -> #(None, [], types.Fresh)
      }
      types.CallAgent(
        id:,
        attempt:,
        mailbox: mailbox_of(slot),
        history: option.map(history, ids.digest_text),
        layers: list.map(layers, ids.digest_text),
        checkpoint: option.map(checkpoint, ids.digest_text),
        taken: list.reverse(taken),
        continuation:,
      )
    }
  }
}

/// A running agent call's mailbox address: its slot, stable across resumes.
fn mailbox_of(slot: Slot) -> String {
  "agent:" <> ids.slot_text(slot)
}

/// Updates the running attempt of an agent call (a checkpoint, messages
/// taken); anything else is refused, typed.
fn update_running(
  run: Run,
  id: RequestId,
  f: fn(Option(Digest), List(types.Taken)) ->
    #(Option(Digest), List(types.Taken)),
) -> #(Run, List(Effect)) {
  let text = ids.request_text(id)
  case lookup(run, id) {
    Error(Nil) -> #(run, [types.Refuse(Some(text), types.UnknownRequest(text))])
    Ok(#(slot, call)) ->
      case call.attempts, is_agent(call.kind) {
        [Running(issued, checkpoint, taken, continuation), ..older], True -> {
          let #(checkpoint, taken) = f(checkpoint, taken)
          let call =
            Call(..call, attempts: [
              Running(issued, checkpoint, taken, continuation),
              ..older
            ])
          #(put(run, slot, call), [types.Checkpoint])
        }
        [Running(..), ..], False | [Settled(_), ..], _ | [], _ -> #(run, [
          types.Refuse(Some(text), types.NotRunning(text)),
        ])
      }
  }
}

/// A send: journaled once by its key, in its mailbox's order.
fn sent(
  run: Run,
  key: String,
  to: String,
  from: String,
  reply_to: Option(String),
  body: Value,
) -> #(Run, List(Effect)) {
  case dict.get(run.sends, key) {
    // Sent before (the body runs again after a resume): not delivered again.
    Ok(_) -> #(run, [])
    Error(Nil) -> {
      let messages = result_or(dict.get(run.mailboxes, to), [])
      let id = to <> "/" <> int.to_string(list.length(messages))
      let envelope = types.Envelope(id:, from:, reply_to:, body:)
      #(
        Run(
          ..run,
          mailboxes: dict.insert(run.mailboxes, to, [envelope, ..messages]),
          sends: dict.insert(run.sends, key, id),
        ),
        [types.Checkpoint, types.Delivered(to, envelope)],
      )
    }
  }
}

fn result_or(r: Result(a, Nil), default: a) -> a {
  case r {
    Ok(a) -> a
    Error(Nil) -> default
  }
}

fn put(run: Run, slot: Slot, call: Call) -> Run {
  Run(
    ..run,
    calls: dict.insert(run.calls, slot, call),
    ids: dict.insert(run.ids, call.id, slot),
  )
}

/// The call a request id names now (not one that moved away from it).
fn lookup(run: Run, id: RequestId) -> Result(#(Slot, Call), Nil) {
  case dict.get(run.ids, id) {
    Error(Nil) -> Error(Nil)
    Ok(slot) ->
      case dict.get(run.calls, slot) {
        Ok(call) if call.id == id -> Ok(#(slot, call))
        Ok(_) | Error(Nil) -> Error(Nil)
      }
  }
}

/// A result settles the running attempt of a call of its kind; any other
/// result is refused, typed.
fn settle(
  run: Run,
  id: RequestId,
  kind: fn(Kind) -> Bool,
  entry: fn(Slot, Call) -> #(Run, Entry),
) -> #(Run, List(Effect)) {
  let text = ids.request_text(id)
  case lookup(run, id) {
    Error(Nil) -> #(run, [types.Refuse(Some(text), types.UnknownRequest(text))])
    Ok(#(slot, call)) ->
      case call.attempts, kind(call.kind) {
        [Running(..), ..older], True -> {
          let #(run, entry) = entry(slot, call)
          let call = Call(..call, attempts: [Settled(entry), ..older])
          let answer = case entry {
            Answered(v) -> types.Deliver(text, v)
            Errored(reason) | Decided(reason, _) -> types.Fail(text, reason)
          }
          #(put(run, slot, call), [types.Checkpoint, answer])
        }
        [Running(..), ..], False | [Settled(_), ..], _ | [], _ -> #(run, [
          types.Refuse(Some(text), types.NotRunning(text)),
        ])
      }
  }
}

// --- Reading the state ---------------------------------------------------------

/// The whole state as text, for the differential check: everything but
/// what this process issued (which a log cannot know).
pub fn full_state(state: RunState) -> String {
  case state {
    NotYetStarted -> "not_started"
    Active(r) ->
      string.inspect(
        Run(..r, calls: dict.map_values(r.calls, fn(_, c) { unissued(c) })),
      )
  }
}

/// How many attempts the call at this request id has had (0: none).
pub fn attempt_count(state: RunState, id: String) -> Int {
  case state {
    NotYetStarted -> 0
    Active(r) ->
      case lookup(r, ids.request_id(id)) {
        Ok(#(_, call)) -> list.length(call.attempts)
        Error(Nil) -> 0
      }
  }
}

pub fn host_facts(state: RunState) -> json.Json {
  case state {
    NotYetStarted -> json.object([])
    Active(r) -> sorted_object(r.facts, value.to_json)
  }
}

/// The run as JSON: its workflow, status and every call with its attempts,
/// in slot order (the host orders them for display).
pub fn snapshot(state: RunState) -> json.Json {
  case state {
    NotYetStarted -> json.object([#("status", json.string("not_started"))])
    Active(r) ->
      json.object([
        #("workflow", types.workflow_to_json(r.workflow)),
        #("prior_digests", json.array(r.prior_digests, json.string)),
        #("input", value.to_json(r.input)),
        #("status", case r.lifecycle {
          Live -> json.object([#("type", json.string("live"))])
          Ended(outcome) ->
            json.object([
              #("type", json.string("ended")),
              #("outcome", types.outcome_to_json(outcome)),
            ])
        }),
        #(
          "mailboxes",
          sorted_object(r.mailboxes, fn(m) {
            json.array(list.reverse(m), types.envelope_to_json)
          }),
        ),
        #(
          "calls",
          r.calls
            |> dict.to_list
            |> list.sort(fn(a, b) {
              string.compare(ids.slot_text(a.0), ids.slot_text(b.0))
            })
            |> json.array(fn(e) { call_json(e.0, e.1) }),
        ),
      ])
  }
}

fn call_json(slot: Slot, call: Call) -> json.Json {
  json.object([
    #("id", json.string(ids.request_text(call.id))),
    #("slot", json.string(ids.slot_text(slot))),
    #("kind", json.string(kind_text(call.kind))),
    #("name", json.string(call.name)),
    #("node", json.string(ids.digest_text(call.node))),
    #("scope", json.string(call.scope)),
    #("occurrence", json.int(call.occurrence)),
    #("input", value.to_json(call.input)),
    // Oldest first, as they happened.
    #("attempts", json.array(list.reverse(call.attempts), attempt_json)),
  ])
}

fn attempt_json(attempt: Attempt) -> json.Json {
  case attempt {
    Running(..) -> json.object([#("type", json.string("running"))])
    Settled(Answered(v)) ->
      json.object([
        #("type", json.string("answered")),
        #("output", value.to_json(v)),
      ])
    Settled(Errored(reason)) ->
      json.object([
        #("type", json.string("failed")),
        #("reason", types.fail_reason_to_json(reason)),
        #("decided", json.bool(False)),
      ])
    Settled(Decided(reason, _)) ->
      json.object([
        #("type", json.string("failed")),
        #("reason", types.fail_reason_to_json(reason)),
        #("decided", json.bool(True)),
      ])
  }
}

fn sorted_object(d: Dict(String, a), encode: fn(a) -> json.Json) -> json.Json {
  d
  |> dict.to_list
  |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
  |> list.map(fn(e) { #(e.0, encode(e.1)) })
  |> json.object
}

/// A mailbox's messages in their journaled delivery order: what it
/// replays on resume before anything new.
pub fn mailbox(state: RunState, address: String) -> List(types.Envelope) {
  case state {
    NotYetStarted -> []
    Active(r) -> list.reverse(result_or(dict.get(r.mailboxes, address), []))
  }
}

/// The journal key (slot) the request id names, "" when none.
pub fn slot_of(state: RunState, id: String) -> String {
  case state {
    NotYetStarted -> ""
    Active(r) ->
      case dict.get(r.ids, ids.request_id(id)) {
        Ok(slot) -> ids.slot_text(slot)
        Error(Nil) -> ""
      }
  }
}

/// The id a journaled send's key was delivered as, "" when none.
pub fn sent_id(state: RunState, key: String) -> String {
  case state {
    NotYetStarted -> ""
    Active(r) -> result_or(dict.get(r.sends, key), "")
  }
}

/// Where the call at this slot is: "running" (its newest attempt is open),
/// "settled", or "none" (the run has no such call). A settled agent call's
/// mailbox is closed.
pub fn call_state(state: RunState, slot_text: String) -> String {
  case state {
    NotYetStarted -> "none"
    Active(r) ->
      case dict.to_list(r.calls) |> list.find(fn(e) { ids.slot_text(e.0) == slot_text }) {
        Error(Nil) -> "none"
        Ok(#(_, call)) ->
          case call.attempts {
            [Running(..), ..] -> "running"
            [Settled(_), ..] -> "settled"
            [] -> "none"
          }
      }
  }
}
