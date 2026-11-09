//// The run state machine: `step(RunState, Event) -> #(RunState, List(Effect))`.
////
//// A run is a fold of the workflow body over its journal. The body is a
//// deterministic program whose only interface to the world is typed
//// requests (agent and command calls); each request affects the body only
//// through its answer. Run memory is the body's local variables, rebuilt
//// on replay, so the core holds no workflow state: it keeps the journal,
//// replay matching, budget, pin, status, ownership and the interventions.
////
//// Request ids are assigned by the host from the body's branch path and a
//// per-branch counter, so they are stable across replays. A request whose
//// id is already recorded is a replay: it must carry the same digest (else
//// the event is refused as a path divergence) and is answered from the
//// journal, or, if it was still in flight when the host stopped, its effect
//// is emitted again. Replays emit no `Checkpoint`, so a resumed run's log
//// equals an uninterrupted one.
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
import wallis_core/digest
import wallis_core/types.{
  type Agent, type Effect, type Event, type FailReason, type IdleReason,
  type InboxKind, type InboxMessage, type Message, type Node, type Observation,
  type Outcome, type Pin, type Refusal, type Request, type RunStatus, type Usage,
  type Workflow,
}
import wallis_core/value.{type Value}

/// Bumped when a change to the core changes what a log means.
pub const semantics = "wallis-core/5"

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
    /// By request id (display and interventions only).
    requests: Dict(String, Record),
    /// The journal: a cache from slot (node, input, occurrence) to result.
    journal: Dict(String, Entry),
    /// Which request id holds each slot that has a record.
    slots: Dict(String, String),
    /// The slot of each session call (`<session>:<index>`) in this
    /// execution of the body: call k's slot includes call k-1's, so a
    /// session's later calls are keyed by everything before them.
    chain: Dict(String, String),
    /// Slots whose call was issued in this session (not logged).
    issued: Dict(String, Nil),
    /// A failed node the body did not handle: its id and the body's reason.
    hold: Option(#(String, FailReason)),
    spent: Spent,
    /// Newest first.
    observations: List(Observation),
  )
}

type Spent {
  Spent(usd: Float, tokens: Int, turns: Int, compute_minutes: Float)
}

type Record {
  Record(digest: String, kind: Kind, progress: Progress)
}

type Kind {
  /// `inbox` (newest first) and `steps` (model turns so far) outlive the
  /// call: they are what its journal entry records about its dialogue.
  /// `allowed`: the turns this node may use (its agent's maxTurns plus the
  /// turns granted with answers).
  /// `session` and `index` place the call in its session; `tools` are the
  /// MCP results journaled during the call.
  AgentKind(
    agent: String,
    input: Value,
    inbox: List(InboxMessage),
    steps: Int,
    allowed: Int,
    session: String,
    index: Int,
    tools: List(types.ToolResult),
  )
  CommandKind(command: String, input: Value, inbox: List(InboxMessage))
  ToolKind(tool: String, input: Value)
  OrchestratorKind(name: String, input: Value)
  RefusedKind
}

/// An agent call's dialogue after its input: the messages so far, and the
/// operator note of a restart.
type Dialogue {
  Dialogue(transcript: List(Message), note: Option(String))
}

type Progress {
  /// Held back by a pause or the budget before it is issued.
  Blocked(reason: IdleReason, note: Option(String))
  AwaitingAgent(dialogue: Dialogue)
  /// The agent asked something: waiting for an answer.
  AgentWaiting(dialogue: Dialogue, model: String, cause: types.IdleCause)
  /// The executor could not serve the call; reissued after a fix.
  Unavailable(dialogue: Dialogue, alias: String, error: String)
  AwaitingCommand
  AwaitingTool
  /// An orchestrator node: waiting for `ResultSubmitted`.
  AwaitingOrchestrator
  Completed(model: Option(String))
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
    NotYetStarted, _ -> #(run, [types.Refuse(None, types.NotStarted)])
    Active(_), types.Started(..) -> #(run, [
      types.Refuse(None, types.AlreadyStarted),
    ])
    Active(r), types.Resumed(pin:) ->
      case capability.check_pin(r.pin, pin) {
        Error(refusal) -> #(run, [types.Refuse(None, refusal)])
        Ok(resumable) -> #(
          Active(Run(..r, issued: dict.new())),
          resume(r, resumable),
        )
      }
    // Ownership changes even on a finished run.
    Active(r), types.Claimed(owner:) -> #(Active(Run(..r, owner: Some(owner))), [
      types.Checkpoint,
    ])
    Active(Run(lifecycle: Live, ..) as r), _ -> {
      let #(r, effects) = live_event(r, event)
      #(Active(issued(r, effects)), effects)
    }
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
      Active(
        Run(
          lifecycle: Live,
          workflow:,
          pin:,
          input:,
          models: pin.models,
          budget: workflow.budget,
          executor: None,
          owner: None,
          admission: Admitting,
          requests: dict.new(),
          journal: dict.new(),
          slots: dict.new(),
          chain: dict.new(),
          issued: dict.new(),
          hold: None,
          spent: Spent(0.0, 0, 0, 0.0),
          observations: [],
        ),
      ),
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

// --- Events on a live run ------------------------------------------------------

fn live_event(run: Run, event: Event) -> #(Run, List(Effect)) {
  case event {
    types.Requested(id:, request:, node_digest:, occurrence:) ->
      requested(run, id, request, node_digest, occurrence)
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
    types.AgentReturned(id:, output:, usage:, model:) ->
      agent_settled(run, id, usage, model, fn(_) { Answered(output) })
    types.AgentFailed(id:, failure:, usage:, model:) ->
      agent_settled(run, id, usage, model, fn(name) {
        Errored(types.AgentGaveUp(name, failure))
      })
    types.AgentAsked(id:, message:, usage:, model:) ->
      agent_idle(run, id, fn(_) { types.Asked(message) }, usage, model)
    types.ApprovalRequested(id:, server:, tool:, args:, usage:, model:) ->
      agent_idle(
        run,
        id,
        fn(_) { types.Approval(server, tool, args) },
        usage,
        model,
      )
    types.TurnInterrupted(id:, usage:, model:) ->
      agent_idle(run, id, fn(_) { types.Interrupted }, usage, model)
    types.ToolRecorded(id:, call:, result:) ->
      tool_recorded(run, id, call, result)
    types.ToolReturned(id:, output:) ->
      tool_settled(run, id, fn(_) { Answered(output) })
    types.ToolFailed(id:, failure:) ->
      tool_settled(run, id, fn(name) {
        Errored(types.ToolCrashed(name, failure))
      })
    types.ResultSubmitted(node:, value:, by:) ->
      intervene(run, by, fn(owned) {
        use node <- result.try(capability.check_submittable(
          owned,
          node,
          facts(run, node),
        ))
        submit(run, node, value)
      })
    types.InputRejected(id:, field:, chars:, limit:) ->
      agent_settled(run, id, types.Usage(0.0, 0, 0), "", fn(name) {
        Refused(types.InputTooLarge(name, field, chars, limit))
      })
    types.AgentIdle(id:, message:, usage:, model:) ->
      agent_idle(run, id, fn(_) { types.Question(message) }, usage, model)
    types.TurnLimitReached(id:, usage:, model:, ..) ->
      agent_idle(
        run,
        id,
        fn(kind) {
          case kind {
            AgentKind(steps:, allowed:, ..) -> types.TurnLimit(steps, allowed)
            _ -> types.TurnLimit(0, 0)
          }
        },
        usage,
        model,
      )
    types.ExecutorFailed(id:, error:) -> executor_failed(run, id, error)
    types.CommandReturned(id:, output:, minutes:) ->
      command_settled(run, id, fn(_) { Answered(output) }, minutes)
    types.CommandFailed(id:, failure:, minutes:) ->
      command_settled(
        run,
        id,
        fn(name) { Errored(types.CommandCrashed(name, failure)) },
        minutes,
      )
    types.Observed(at:, label:, value:) -> observe(run, at, label, value)
    types.Sent(node:, text:, by:, turns:, ..) ->
      intervene(run, by, fn(owned) {
        use idle <- result.map(capability.check_idle(
          owned,
          node,
          facts(run, node),
        ))
        answer(run, idle, text, turns)
      })
    types.Steered(node:, text:, by:, ..) ->
      intervene(run, by, fn(owned) {
        use node <- result.map(capability.check_steerable(
          owned,
          node,
          facts(run, node),
        ))
        steer(run, node, text)
      })
    types.InterruptRequested(node:, by:) ->
      intervene(run, by, fn(owned) {
        use node <- result.map(capability.check_steerable(
          owned,
          node,
          facts(run, node),
        ))
        let id = capability.steerable_id(node)
        #(add_inbox(run, id, types.Interrupt, ""), [types.Checkpoint])
      })
    types.Restarted(node:, note:, by:, turns:) ->
      intervene(run, by, fn(owned) {
        use node <- result.try(capability.check_live(
          owned,
          node,
          facts(run, node),
        ))
        restart(run, node, note, turns)
      })
    types.NodeCancelled(node:, by:) ->
      intervene(run, by, fn(owned) {
        use node <- result.map(capability.check_live(
          owned,
          node,
          facts(run, node),
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
    types.BodyFinished(output:) -> finish(run, types.Done(output))
    types.BodyFailed(reason:) -> body_failed(run, reason)
    types.Started(..) | types.Resumed(..) -> #(run, [])
  }
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
    None ->
      case leaf(reason) {
        types.AgentGaveUp(failure: types.CancelledByOwner, ..)
        | types.CommandCrashed(failure: types.CommandCancelled, ..)
        | types.ToolCrashed(failure: types.ToolCancelled, ..)
        | types.BodyError(..) -> finish(run, types.Failed(reason))
        failure ->
          case failed_node(run, failure) {
            Ok(id) -> #(Run(..run, hold: Some(#(id, reason))), [
              types.Checkpoint,
            ])
            Error(Nil) -> finish(run, types.Failed(reason))
          }
      }
  }
}

fn leaf(reason: FailReason) -> FailReason {
  case reason {
    types.WorkflowFailed(reason:, ..) -> leaf(reason)
    _ -> reason
  }
}

/// The first node, by id, that failed with this reason.
fn failed_node(run: Run, failure: FailReason) -> Result(String, Nil) {
  sorted_requests(run)
  |> list.find_map(fn(e) {
    case dict.get(run.journal, { e.1 }.digest) {
      Ok(Errored(f)) if f == failure -> Ok(e.0)
      _ -> Error(Nil)
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

// --- Requests ------------------------------------------------------------------

/// The journal slot of a call: the node's definition digest, the request
/// and its canonical input, and its occurrence in this execution of the
/// body. A session call's slot also includes its previous call's slot, so
/// it depends on the whole dialogue before it.
fn slot_of(
  node_digest: String,
  request: Request,
  previous: Option(String),
  occurrence: Int,
) -> String {
  let #(kind, name, body) = case request {
    types.Call(agent:, input:, ..) -> #("call", agent, input)
    types.Command(command:, input:) -> #("command", command, input)
    types.Tool(tool:, input:) -> #("tool", tool, input)
    types.Orchestrator(name:, input:) -> #("orchestrator", name, input)
  }
  digest.hex(string.join(
    [
      node_digest,
      kind,
      name,
      value.canonical(body),
      option.unwrap(previous, ""),
    ],
    "\n",
  ))
  <> "#"
  <> int.to_string(occurrence)
}

fn chain_key(session: String, index: Int) -> String {
  session <> ":" <> int.to_string(index)
}

/// The slot of the previous call in a session call's session.
fn previous_of(run: Run, request: Request) -> Option(String) {
  case request {
    types.Call(session:, index:, ..) if index > 0 ->
      dict.get(run.chain, chain_key(session, index - 1)) |> option.from_result
    _ -> None
  }
}

/// The journal is a cache. A slot with a result is a hit: answered, not
/// logged. A slot with a call in flight or waiting is the same call (its
/// record moves to this request id, and that move is logged). Anything
/// else is a new call.
fn requested(
  run: Run,
  id: String,
  request: Request,
  node_digest: String,
  occurrence: Int,
) -> #(Run, List(Effect)) {
  let slot =
    slot_of(node_digest, request, previous_of(run, request), occurrence)
  let run = case request {
    types.Call(session:, index:, ..) ->
      Run(..run, chain: dict.insert(run.chain, chain_key(session, index), slot))
    _ -> run
  }
  case dict.get(run.journal, slot), dict.get(run.slots, slot) {
    Ok(entry), _ -> #(run, [answer_effect(id, entry)])
    Error(Nil), Ok(old) ->
      case dict.get(run.requests, old) {
        Ok(record) -> {
          let moved = old != id
          let run = case moved {
            False -> run
            True ->
              Run(
                ..run,
                requests: run.requests
                  |> dict.delete(old)
                  |> dict.insert(id, record),
                slots: dict.insert(run.slots, slot, id),
              )
          }
          let #(run, effects) = reissue(run, id, slot, record)
          case moved {
            True -> #(run, [types.Checkpoint, ..effects])
            False -> #(run, effects)
          }
        }
        Error(Nil) -> new_request(run, id, slot, request)
      }
    Error(Nil), Error(Nil) -> new_request(run, id, slot, request)
  }
}

fn new_request(
  run: Run,
  id: String,
  slot: String,
  request: Request,
) -> #(Run, List(Effect)) {
  let run = Run(..run, slots: dict.insert(run.slots, slot, id))
  let #(run, effects) = live_request(run, id, slot, request)
  #(mark_issued(run, slot, effects), [types.Checkpoint, ..effects])
}

/// Every call issued by these effects, so a replay in the same session does
/// not issue it again.
fn issued(run: Run, effects: List(Effect)) -> Run {
  list.fold(effects, run, fn(run, e) {
    case e {
      types.CallAgent(digest:, ..) | types.RunCommand(digest:, ..) ->
        Run(..run, issued: dict.insert(run.issued, digest, Nil))
      _ -> run
    }
  })
}

fn mark_issued(run: Run, slot: String, effects: List(Effect)) -> Run {
  case
    list.any(effects, fn(e) {
      case e {
        types.CallAgent(..) | types.RunCommand(..) -> True
        _ -> False
      }
    })
  {
    True -> Run(..run, issued: dict.insert(run.issued, slot, Nil))
    False -> run
  }
}

/// A call already recorded and requested again: re-emitted only if it was in
/// flight and not yet issued in this session (after a crash); waiting calls
/// wait for the events that unblock them (`Sent`, `BudgetRaised`,
/// `RetryUnavailable`).
fn reissue(
  run: Run,
  id: String,
  slot: String,
  record: Record,
) -> #(Run, List(Effect)) {
  case dict.has_key(run.issued, slot) {
    True -> #(run, [])
    False -> {
      let effects = case record.progress, record.kind {
        AwaitingAgent(dialogue:), AgentKind(agent:, input:, ..) ->
          case call_effect(run, id, agent, input, slot, dialogue) {
            Ok(call) -> [call]
            Error(_) -> []
          }
        AwaitingCommand, CommandKind(command:, input:, ..) -> [
          command_effect(run, id, command, input, slot),
        ]
        AwaitingTool, ToolKind(tool:, input:) -> [
          types.CallTool(id:, tool:, input:, digest: slot),
        ]
        _, _ -> []
      }
      #(mark_issued(run, slot, effects), effects)
    }
  }
}

fn answer_effect(id: String, entry: Entry) -> Effect {
  case entry {
    Answered(v) -> types.Deliver(id, v)
    Errored(reason) -> types.Fail(id, reason)
    Refused(refusal) -> types.Refuse(Some(id), refusal)
  }
}

fn live_request(
  run: Run,
  id: String,
  d: String,
  request: Request,
) -> #(Run, List(Effect)) {
  case request {
    types.Call(agent: name, input:, session:, index:) ->
      case find_agent(run.workflow, name) {
        Error(Nil) ->
          settle(
            run,
            id,
            Record(d, RefusedKind, Completed(None)),
            Refused(types.UnknownAgent(name)),
          )
        Ok(agent) -> {
          let kind =
            AgentKind(name, input, [], 0, agent.max_turns, session, index, [])
          case admit(run) {
            Error(reason) -> #(
              record(run, id, Record(d, kind, Blocked(reason, None))),
              [],
            )
            Ok(Nil) -> {
              let dialogue = Dialogue([], None)
              // Recorded first: the effect reads the call's place in its session.
              let run =
                record(run, id, Record(d, kind, AwaitingAgent(dialogue)))
              case call_effect(run, id, name, input, d, dialogue) {
                Error(refusal) ->
                  settle(
                    run,
                    id,
                    Record(d, kind, Completed(None)),
                    Refused(refusal),
                  )
                Ok(call) -> #(run, [call])
              }
            }
          }
        }
      }
    types.Command(command:, input:) -> {
      let kind = CommandKind(command, input, [])
      case
        list.contains(run.workflow.commands, command),
        result.try(admission(run), fn(_) { compute_check(run) })
      {
        False, _ ->
          settle(
            run,
            id,
            Record(d, RefusedKind, Completed(None)),
            Refused(types.UnknownCommand(command)),
          )
        True, Error(reason) -> #(
          record(run, id, Record(d, kind, Blocked(reason, None))),
          [],
        )
        True, Ok(Nil) -> #(record(run, id, Record(d, kind, AwaitingCommand)), [
          command_effect(run, id, command, input, d),
        ])
      }
    }
    types.Tool(tool:, input:) -> {
      let kind = ToolKind(tool, input)
      case list.contains(run.workflow.tools, tool), admission(run) {
        False, _ ->
          settle(
            run,
            id,
            Record(d, RefusedKind, Completed(None)),
            Refused(types.UnknownTool(tool)),
          )
        True, Error(reason) -> #(
          record(run, id, Record(d, kind, Blocked(reason, None))),
          [],
        )
        True, Ok(Nil) -> #(record(run, id, Record(d, kind, AwaitingTool)), [
          types.CallTool(id:, tool:, input:, digest: d),
        ])
      }
    }
    // Orchestrator nodes cost nothing and are never held back.
    types.Orchestrator(name:, input:) ->
      case list.contains(run.workflow.orchestrators, name) {
        False ->
          settle(
            run,
            id,
            Record(d, RefusedKind, Completed(None)),
            Refused(types.UnknownOrchestrator(name)),
          )
        True -> #(
          record(
            run,
            id,
            Record(d, OrchestratorKind(name, input), AwaitingOrchestrator),
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
  id: String,
  name: String,
  input: Value,
  d: String,
  dialogue: Dialogue,
) -> Result(Effect, Refusal) {
  use agent <- result.try(
    find_agent(run.workflow, name)
    |> result.replace_error(types.UnknownAgent(name)),
  )
  use model <- result.try(
    resolve_model(run.models, agent.model)
    |> result.replace_error(types.UnknownAlias(agent.model)),
  )
  // The node's turns so far and its allowance (a new call has neither
  // yet), the previous call of its session and its journaled tool results.
  let #(turn, turn_limit, previous, recorded) = case
    dict.get(run.requests, id)
  {
    Ok(Record(
      kind: AgentKind(steps:, allowed:, session:, index:, tools:, ..),
      ..,
    )) -> #(
      steps,
      allowed,
      case index > 0 {
        True ->
          dict.get(run.chain, chain_key(session, index - 1))
          |> option.from_result
        False -> None
      },
      list.reverse(tools),
    )
    _ -> #(0, agent.max_turns, None, [])
  }
  Ok(types.CallAgent(
    id:,
    agent: agent.name,
    model:,
    input:,
    turn:,
    turn_limit:,
    digest: d,
    transcript: dialogue.transcript,
    note: dialogue.note,
    previous:,
    recorded:,
  ))
}

fn command_effect(
  run: Run,
  id: String,
  command: String,
  input: Value,
  d: String,
) -> Effect {
  types.RunCommand(
    id:,
    command:,
    input:,
    compute_minutes: option.map(run.budget.compute_minutes, fn(limit) {
      limit -. run.spent.compute_minutes
    }),
    digest: d,
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
    _ -> Ok(Nil)
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
    _ -> Ok(Nil)
  }
}

fn record(run: Run, id: String, rec: Record) -> Run {
  Run(..run, requests: dict.insert(run.requests, id, rec))
}

/// Completes a request with a journal entry and answers it.
fn settle(
  run: Run,
  id: String,
  rec: Record,
  entry: Entry,
) -> #(Run, List(Effect)) {
  let run =
    Run(
      ..record(run, id, rec),
      journal: dict.insert(run.journal, rec.digest, entry),
    )
  #(run, [answer_effect(id, entry)])
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

/// An agent call that is running or was cut off by an executor fault.
fn in_flight(record: Record) -> Option(#(String, Dialogue)) {
  case record.kind, record.progress {
    AgentKind(agent:, ..), AwaitingAgent(dialogue:)
    | AgentKind(agent:, ..), Unavailable(dialogue:, ..)
    -> Some(#(agent, dialogue))
    _, _ -> None
  }
}

fn add_steps(kind: Kind, usage: Usage) -> Kind {
  case kind {
    AgentKind(..) -> AgentKind(..kind, steps: kind.steps + usage.turns)
    _ -> kind
  }
}

/// A result, a failure or a rejected input completes the call. Results for
/// a call that is not in flight (cancelled, already settled) are ignored.
fn agent_settled(
  run: Run,
  id: String,
  usage: Usage,
  model: String,
  entry: fn(String) -> Entry,
) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(rec) ->
      case in_flight(rec) {
        None -> #(run, [])
        Some(#(name, _)) -> {
          let model = case model {
            "" -> None
            m -> Some(m)
          }
          let rec =
            Record(
              ..rec,
              kind: add_steps(rec.kind, usage),
              progress: Completed(model),
            )
          let #(run, effects) = settle(spend(run, usage), id, rec, entry(name))
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
  id: String,
  cause: fn(Kind) -> types.IdleCause,
  usage: Usage,
  model: String,
) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(rec) ->
      case in_flight(rec) {
        Some(#(_, d)) -> {
          let kind = add_steps(rec.kind, usage)
          let cause = cause(kind)
          let d = case cause {
            types.Question(message:) ->
              Dialogue(
                ..d,
                transcript: list.append(d.transcript, [
                  types.Message(types.Assistant, message),
                ]),
              )
            types.Asked(message:) ->
              Dialogue(
                ..d,
                transcript: list.append(d.transcript, [
                  types.Message(types.Assistant, message),
                ]),
              )
            types.TurnLimit(..) | types.Interrupted | types.Approval(..) -> d
          }
          let rec =
            Record(..rec, kind:, progress: AgentWaiting(d, model, cause))
          #(record(spend(run, usage), id, rec), [types.Checkpoint])
        }
        None -> #(run, [])
      }
    Error(Nil) -> #(run, [])
  }
}

/// An executor error is not an agent failure: the call stays incomplete and
/// the run goes idle until a fix and a `RetryUnavailable`.
fn executor_failed(
  run: Run,
  id: String,
  error: String,
) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(rec) ->
      case in_flight(rec) {
        Some(#(name, d)) -> {
          let alias = case find_agent(run.workflow, name) {
            Ok(a) -> a.model
            Error(Nil) -> name
          }
          #(
            record(
              run,
              id,
              Record(..rec, progress: Unavailable(d, alias, error)),
            ),
            [types.Checkpoint],
          )
        }
        None -> #(run, [])
      }
    Error(Nil) -> #(run, [])
  }
}

fn retry_unavailable(run: Run) -> #(Run, List(Effect)) {
  let #(run, effects) =
    sorted_requests(run)
    |> list.fold(#(run, []), fn(acc, entry) {
      let #(run, effects) = acc
      case entry.1 {
        Record(
          kind: AgentKind(agent:, input:, ..),
          progress: Unavailable(dialogue:, ..),
          ..,
        ) as rec ->
          case call_effect(run, entry.0, agent, input, rec.digest, dialogue) {
            Ok(call) -> #(
              record(
                run,
                entry.0,
                Record(..rec, progress: AwaitingAgent(dialogue)),
              ),
              list.append(effects, [call]),
            )
            Error(_) -> acc
          }
        _ -> acc
      }
    })
  case effects {
    [] -> #(run, [])
    _ -> #(run, [types.Checkpoint, ..effects])
  }
}

// --- Interventions -------------------------------------------------------------

fn held(run: Run, node: String) -> Bool {
  case run.hold {
    Some(#(id, _)) -> id == node
    None -> False
  }
}

fn facts(run: Run, node: String) -> NodeFacts {
  case dict.get(run.requests, node) {
    // A held failure is live again for restart and cancel.
    Ok(Record(kind: AgentKind(agent:, ..), ..)) if run.hold != None ->
      case held(run, node) {
        True ->
          capability.Faulted(case find_agent(run.workflow, agent) {
            Ok(a) -> a.steerable
            Error(Nil) -> False
          })
        False -> agent_facts(run, node)
      }
    Ok(Record(kind: CommandKind(..), progress: Completed(..), ..)) ->
      case held(run, node) {
        True -> capability.CommandWorking
        False -> capability.Settled
      }
    Ok(Record(kind: ToolKind(..), progress: Completed(..), ..)) ->
      case held(run, node) {
        True -> capability.ToolWorking
        False -> capability.Settled
      }
    _ -> agent_facts(run, node)
  }
}

fn agent_facts(run: Run, node: String) -> NodeFacts {
  case dict.get(run.requests, node) {
    Ok(Record(kind: AgentKind(agent:, ..), progress:, ..)) -> {
      let steerable = case find_agent(run.workflow, agent) {
        Ok(a) -> a.steerable
        Error(Nil) -> False
      }
      case progress {
        AwaitingAgent(..) -> capability.Working(steerable)
        AgentWaiting(cause: types.Approval(..), ..) ->
          capability.Approving(steerable)
        AgentWaiting(..) -> capability.Waiting(steerable)
        Unavailable(..) -> capability.Faulted(steerable)
        Blocked(..) -> capability.Held(steerable)
        AwaitingCommand | AwaitingTool | AwaitingOrchestrator | Completed(..) ->
          capability.Settled
      }
    }
    Ok(Record(kind: CommandKind(..), progress: AwaitingCommand, ..)) ->
      capability.CommandWorking
    Ok(Record(kind: ToolKind(..), progress: AwaitingTool, ..)) ->
      capability.ToolWorking
    Ok(Record(progress: AwaitingOrchestrator, ..)) -> capability.Pending
    Ok(_) -> capability.Settled
    Error(Nil) -> capability.Absent
  }
}

fn add_inbox(run: Run, id: String, kind: InboxKind, text: String) -> Run {
  case dict.get(run.requests, id) {
    Ok(Record(kind: AgentKind(..) as k, ..) as rec) -> {
      let message = types.InboxMessage(kind:, text:, step: k.steps)
      record(
        run,
        id,
        Record(..rec, kind: AgentKind(..k, inbox: [message, ..k.inbox])),
      )
    }
    Ok(Record(kind: CommandKind(..) as k, ..) as rec) -> {
      let message = types.InboxMessage(kind:, text:, step: 0)
      record(
        run,
        id,
        Record(..rec, kind: CommandKind(..k, inbox: [message, ..k.inbox])),
      )
    }
    _ -> run
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
  case dict.get(run.requests, id) {
    // At its turn limit a node continues only with more turns.
    Ok(Record(progress: AgentWaiting(cause: types.TurnLimit(..), ..), ..))
      if turns <= 0
    -> #(run, [types.Refuse(None, types.NoTurnsLeft(id))])
    Ok(Record(kind: AgentKind(..) as k, ..) as rec) ->
      continue_with(
        add_inbox(
          record(
            run,
            id,
            Record(
              ..rec,
              kind: AgentKind(..k, allowed: k.allowed + int.max(0, turns)),
            ),
          ),
          id,
          types.Answer,
          text,
        ),
        id,
        text,
      )
    _ -> #(run, [types.Refuse(None, types.NotIdle(id))])
  }
}

fn continue_with(run: Run, id: String, text: String) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(
      Record(
        kind: AgentKind(agent:, input:, ..),
        progress: AgentWaiting(dialogue: d, ..),
        ..,
      ) as rec,
    ) -> {
      let d =
        Dialogue(
          ..d,
          transcript: list.append(d.transcript, [
            types.Message(types.User, text),
          ]),
        )
      case call_effect(run, id, agent, input, rec.digest, d) {
        Ok(call) -> #(
          record(run, id, Record(..rec, progress: AwaitingAgent(d))),
          [
            types.Checkpoint,
            call,
          ],
        )
        Error(refusal) -> #(run, [types.Refuse(None, refusal)])
      }
    }
    _ -> #(run, [types.Refuse(None, types.NotIdle(id))])
  }
}

/// A steer joins the running node's dialogue; the executor delivers it at
/// the next step boundary. A node reissued after a crash carries it.
fn steer(run: Run, node: SteerableNode, text: String) -> #(Run, List(Effect)) {
  let id = capability.steerable_id(node)
  let run = add_inbox(run, id, types.Steer, text)
  case dict.get(run.requests, id) {
    Ok(Record(progress: AwaitingAgent(dialogue: d), ..) as rec) -> {
      let d =
        Dialogue(
          ..d,
          transcript: list.append(d.transcript, [
            types.Message(types.User, text),
          ]),
        )
      #(record(run, id, Record(..rec, progress: AwaitingAgent(d))), [
        types.Checkpoint,
      ])
    }
    _ -> #(run, [types.Refuse(None, types.NodeNotRunning(id))])
  }
}

/// Discards the dialogue and reissues the call with its original input and
/// the note. A note to a non-steerable node is refused; a call still held
/// back by a pause or the budget has nothing to restart.
fn restart(
  run: Run,
  node: LiveNode,
  note: Option(String),
  turns: Int,
) -> Result(#(Run, List(Effect)), Refusal) {
  let id = capability.live_id(node)
  // A held failure: its journal entry is invalidated and the hold lifted;
  // the call is then reissued like one in flight.
  let run = case held(run, id), dict.get(run.requests, id) {
    True, Ok(rec) -> {
      let progress = case rec.kind {
        CommandKind(..) -> AwaitingCommand
        ToolKind(..) -> AwaitingTool
        _ -> AwaitingAgent(Dialogue([], None))
      }
      Run(
        ..record(run, id, Record(..rec, progress:)),
        journal: dict.delete(run.journal, rec.digest),
        hold: None,
      )
    }
    _, _ -> run
  }
  use _ <- result.try(case note, capability.live_kind(node) {
    Some(_), capability.LiveAgent(steerable: False) ->
      Error(types.NotSteerable(id))
    Some(_), capability.LiveCommand | Some(_), capability.LiveTool ->
      Error(types.NotAnAgent(id))
    _, _ -> Ok(Nil)
  })
  case dict.get(run.requests, id) {
    // A body MCP tool call is made again: the outside world is asked anew.
    Ok(Record(kind: ToolKind(tool:, input:), progress: AwaitingTool, ..) as rec) ->
      Ok(
        #(run, [
          types.Checkpoint,
          types.CallTool(id:, tool:, input:, digest: rec.digest),
        ]),
      )
    // A command reruns with the same input.
    Ok(Record(
      kind: CommandKind(command:, input:, ..),
      progress: AwaitingCommand,
      ..,
    )) -> {
      let run = add_inbox(run, id, types.Restart, "")
      Ok(
        #(run, [
          types.Checkpoint,
          command_effect(run, id, command, input, run_digest(run, id)),
        ]),
      )
    }
    Ok(Record(kind: AgentKind(agent:, input:, ..), progress:, ..) as rec) ->
      case progress {
        AwaitingAgent(..) | AgentWaiting(..) | Unavailable(..) -> {
          let run = add_inbox(run, id, types.Restart, option.unwrap(note, ""))
          let rec = dict.get(run.requests, id) |> result.unwrap(rec)
          // Progress is discarded: the turn count and allowance start over,
          // and its journaled tool results go (the outside is asked anew).
          let rec = case rec.kind, find_agent(run.workflow, agent) {
            AgentKind(..) as k, Ok(a) ->
              Record(
                ..rec,
                kind: AgentKind(
                  ..k,
                  steps: 0,
                  allowed: case turns > 0 {
                    True -> turns
                    False -> a.max_turns
                  },
                  tools: [],
                ),
              )
            _, _ -> rec
          }
          let run = rewind(record(run, id, rec), rec.kind)
          let d = Dialogue([], note)
          case admit(run) {
            Error(reason) ->
              Ok(
                #(
                  record(
                    run,
                    id,
                    Record(..rec, progress: Blocked(reason, note)),
                  ),
                  [
                    types.Checkpoint,
                  ],
                ),
              )
            Ok(Nil) -> {
              use call <- result.map(call_effect(
                run,
                id,
                agent,
                input,
                rec.digest,
                d,
              ))
              #(record(run, id, Record(..rec, progress: AwaitingAgent(d))), [
                types.Checkpoint,
                call,
              ])
            }
          }
        }
        _ -> Error(types.NodeNotRunning(id))
      }
    _ -> Error(types.NotLive(id))
  }
}

/// Fails one node as an agent failure; the body gets a typed error.
fn cancel_node(run: Run, node: LiveNode) -> #(Run, List(Effect)) {
  let id = capability.live_id(node)
  case run.hold, dict.get(run.requests, id) {
    // Accepting a held failure: it propagates, and the run ends Failed.
    Some(#(held_id, reason)), _ if held_id == id ->
      finish(Run(..run, hold: None), types.Failed(reason))
    _, _ -> cancel_live(run, id)
  }
}

fn cancel_live(run: Run, id: String) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(Record(kind: ToolKind(tool:, ..), ..) as rec) -> {
      let #(run, effects) =
        settle(
          run,
          id,
          Record(..rec, progress: Completed(None)),
          Errored(types.ToolCrashed(tool, types.ToolCancelled)),
        )
      #(run, [types.Checkpoint, ..effects])
    }
    Ok(Record(kind: CommandKind(command:, ..), ..) as rec) -> {
      let #(run, effects) =
        settle(
          run,
          id,
          Record(..rec, progress: Completed(None)),
          Errored(types.CommandCrashed(command, types.CommandCancelled)),
        )
      #(run, [types.Checkpoint, ..effects])
    }
    Ok(Record(kind: AgentKind(agent:, ..), ..) as rec) -> {
      let #(run, effects) =
        settle(
          run,
          id,
          Record(..rec, progress: Completed(None)),
          Errored(types.AgentGaveUp(agent, types.CancelledByOwner)),
        )
      #(run, [types.Checkpoint, ..effects])
    }
    _ -> #(run, [types.Refuse(None, types.NotLive(id))])
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

fn sorted_requests(run: Run) -> List(#(String, Record)) {
  run.requests
  |> dict.to_list
  |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
}

/// Issues every blocked request that the pause and the budget now admit.
fn unblock(run: Run) -> #(Run, List(Effect)) {
  sorted_requests(run)
  |> list.fold(#(run, []), fn(acc, entry) {
    let #(run, effects) = acc
    let id = entry.0
    case entry.1 {
      Record(
        kind: AgentKind(agent:, input:, ..),
        progress: Blocked(note:, ..),
        ..,
      ) as rec ->
        case admit(run) {
          Ok(Nil) -> {
            let d = Dialogue([], note)
            case call_effect(run, id, agent, input, rec.digest, d) {
              Ok(call) -> #(
                record(run, id, Record(..rec, progress: AwaitingAgent(d))),
                list.append(effects, [call]),
              )
              Error(_) -> acc
            }
          }
          Error(_) -> acc
        }
      Record(kind: ToolKind(tool:, input:), progress: Blocked(..), ..) as rec ->
        case admission(run) {
          Ok(Nil) -> #(
            record(run, id, Record(..rec, progress: AwaitingTool)),
            list.append(effects, [
              types.CallTool(id:, tool:, input:, digest: rec.digest),
            ]),
          )
          Error(_) -> acc
        }
      Record(kind: CommandKind(command:, input:, ..), progress: Blocked(..), ..) as rec ->
        case result.try(admission(run), fn(_) { compute_check(run) }) {
          Ok(Nil) -> #(
            record(run, id, Record(..rec, progress: AwaitingCommand)),
            list.append(effects, [
              command_effect(run, id, command, input, rec.digest),
            ]),
          )
          Error(_) -> acc
        }
      _ -> acc
    }
  })
}

fn command_settled(
  run: Run,
  id: String,
  entry: fn(String) -> Entry,
  minutes: Float,
) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(
      Record(kind: CommandKind(command:, ..), progress: AwaitingCommand, ..) as rec,
    ) -> {
      let run =
        Run(
          ..run,
          spent: Spent(
            ..run.spent,
            compute_minutes: run.spent.compute_minutes +. minutes,
          ),
        )
      let #(run, effects) =
        settle(
          run,
          id,
          Record(..rec, progress: Completed(None)),
          entry(command),
        )
      #(run, [types.Checkpoint, ..effects])
    }
    _ -> #(run, [])
  }
}

/// A session call restarts from the session's state before it: every
/// later call of the session is invalidated, so it runs again.
fn rewind(run: Run, kind: Kind) -> Run {
  case kind {
    AgentKind(session:, index:, ..) -> {
      let prefix = session <> ":"
      let later =
        dict.to_list(run.chain)
        |> list.filter_map(fn(e) {
          case string.starts_with(e.0, prefix) {
            True ->
              case int.parse(string.drop_start(e.0, string.length(prefix))) {
                Ok(i) if i > index -> Ok(e.1)
                _ -> Error(Nil)
              }
            False -> Error(Nil)
          }
        })
      Run(..run, journal: dict.drop(run.journal, later))
    }
    _ -> run
  }
}

/// An MCP result inside a live agent call joins its journal entry.
fn tool_recorded(
  run: Run,
  id: String,
  call: String,
  result: Value,
) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(Record(kind: AgentKind(tools:, ..) as k, ..) as rec) ->
      case in_flight(rec), list.any(tools, fn(t) { t.call == call }) {
        Some(_), False -> #(
          record(
            run,
            id,
            Record(
              ..rec,
              kind: AgentKind(..k, tools: [
                types.ToolResult(call, result),
                ..tools
              ]),
            ),
          ),
          [types.Checkpoint],
        )
        // Already journaled (a replayed tool call), or not in flight.
        _, _ -> #(run, [])
      }
    _ -> #(run, [])
  }
}

fn tool_settled(
  run: Run,
  id: String,
  entry: fn(String) -> Entry,
) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(Record(kind: ToolKind(tool:, ..), progress: AwaitingTool, ..) as rec) -> {
      let #(run, effects) =
        settle(run, id, Record(..rec, progress: Completed(None)), entry(tool))
      #(run, [types.Checkpoint, ..effects])
    }
    _ -> #(run, [])
  }
}

/// The orchestrator's result for an orchestrator node, or its decision on
/// an approval. The host checked an orchestrator node's value against its
/// schema; a decision's fixed shape is checked again here.
fn submit(
  run: Run,
  node: capability.SubmittableNode,
  answer: Value,
) -> Result(#(Run, List(Effect)), Refusal) {
  let id = capability.submittable_id(node)
  case capability.submittable_kind(node), dict.get(run.requests, id) {
    capability.SubmitAnswer, Ok(rec) -> {
      let #(run, effects) =
        settle(
          run,
          id,
          Record(..rec, progress: Completed(None)),
          Answered(answer),
        )
      Ok(#(run, [types.Checkpoint, ..effects]))
    }
    capability.SubmitDecision, Ok(_) -> {
      use _ <- result.try(decision_errors(id, answer))
      let text = value.canonical(answer)
      Ok(continue_with(add_inbox(run, id, types.Answer, text), id, text))
    }
    _, Error(Nil) -> Error(types.NotPending(id))
  }
}

/// `{"type":"approve"}` or `{"type":"reject","reason":"<non-empty>"}`.
fn decision_errors(id: String, decision: Value) -> Result(Nil, Refusal) {
  case decision {
    value.JObject([#("type", value.JString("approve"))]) -> Ok(Nil)
    value.JObject([
      #("reason", value.JString(reason)),
      #("type", value.JString("reject")),
    ]) ->
      case string.trim(reason) {
        "" -> Error(types.InvalidAnswer(id, ["/reason must not be empty"]))
        _ -> Ok(Nil)
      }
    _ ->
      Error(
        types.InvalidAnswer(id, [
          "expected {\"type\":\"approve\"} or {\"type\":\"reject\",\"reason\":\"...\"}",
        ]),
      )
  }
}

fn run_digest(run: Run, id: String) -> String {
  case dict.get(run.requests, id) {
    Ok(rec) -> rec.digest
    Error(Nil) -> ""
  }
}

fn find_agent(workflow: Workflow, name: String) -> Result(Agent, Nil) {
  list.find(workflow.agents, fn(a) { a.name == name })
}

// --- Status --------------------------------------------------------------------

/// Running while any call or script is in flight. Otherwise idle: paused,
/// for budget or an executor fault (the first blocked request by id), or
/// because a node waits for an answer. A run with nothing in flight and
/// nothing waiting is running: its body is computing.
pub fn status(run: RunState) -> Option(RunStatus) {
  case run {
    NotYetStarted -> None
    Active(Run(lifecycle: Ended(outcome), ..)) -> Some(types.Finished(outcome))
    Active(r) -> {
      let records = list.map(sorted_requests(r), fn(e) { { e.1 }.progress })
      let running =
        list.any(records, fn(p) {
          case p {
            AwaitingAgent(..) | AwaitingCommand | AwaitingTool -> True
            _ -> False
          }
        })
      let reason =
        list.find_map(records, fn(p) {
          case p {
            Blocked(reason:, ..) -> Ok(current(r, reason))
            Unavailable(alias:, error:, ..) ->
              Ok(types.ExecutorUnavailable(alias, error))
            _ -> Error(Nil)
          }
        })
      let waiting =
        list.any(records, fn(p) {
          case p {
            AgentWaiting(..) | AwaitingOrchestrator -> True
            _ -> False
          }
        })
      case running, r.admission, reason, waiting {
        True, _, _, _ -> Some(types.Running)
        False, _, _, _ if r.hold != None ->
          case r.hold {
            Some(#(id, reason)) ->
              Some(types.Idle(Some(types.NodeFailure(id, reason))))
            None -> Some(types.Running)
          }
        False, Holding, _, _ -> Some(types.Idle(Some(types.PausedByUser)))
        False, Admitting, Ok(reason), _ -> Some(types.Idle(Some(reason)))
        False, Admitting, Error(Nil), True -> Some(types.Idle(None))
        False, Admitting, Error(Nil), False -> Some(types.Running)
      }
    }
  }
}

/// A held request's reason with the spend as it is now: calls in flight
/// when the budget was reached may have added to it.
fn current(run: Run, reason: IdleReason) -> IdleReason {
  case reason {
    types.BudgetReached(kind: types.Turns, ..) ->
      budget_check(run) |> result.unwrap_error(reason)
    types.BudgetReached(kind: types.ComputeMinutes, ..) ->
      compute_check(run) |> result.unwrap_error(reason)
    _ -> reason
  }
}

/// Agent calls that started a dialogue, and command calls that started.
/// Calls held back by a pause, the
/// budget or an executor fault, and calls refused before they started, are
/// not nodes; the run's idle reason names the held ones.
pub fn nodes(run: RunState) -> List(Node) {
  case run {
    NotYetStarted -> []
    Active(r) ->
      sorted_requests(r)
      |> list.filter_map(fn(e) {
        let #(id, rec) = e
        case rec.kind {
          AgentKind(agent:, inbox:, ..) -> {
            let declared = find_agent(r.workflow, agent)
            let steerable = case declared {
              Ok(a) -> a.steerable
              Error(Nil) -> False
            }
            let inbox = list.reverse(inbox)
            let current = fn() {
              case declared {
                Ok(a) -> resolve_model(r.models, a.model) |> result.unwrap("")
                Error(Nil) -> ""
              }
            }
            case rec.progress {
              AwaitingAgent(..) ->
                Ok(types.NodeRunning(id, agent, current(), steerable, inbox))
              AgentWaiting(model:, cause:, ..) ->
                Ok(types.NodeIdle(id, agent, model, steerable, inbox, cause))
              Completed(model:) ->
                case dict.get(r.journal, rec.digest) {
                  Ok(Answered(_)) ->
                    Ok(types.NodeDone(
                      id,
                      agent,
                      option.unwrap(model, ""),
                      steerable,
                      inbox,
                      types.Submitted,
                    ))
                  Ok(Errored(types.AgentGaveUp(failure:, ..))) ->
                    Ok(types.NodeDone(
                      id,
                      agent,
                      option.unwrap(model, ""),
                      steerable,
                      inbox,
                      types.NodeFailed(failure),
                    ))
                  _ -> Error(Nil)
                }
              _ -> Error(Nil)
            }
          }
          CommandKind(command:, inbox:, ..) -> {
            let inbox = list.reverse(inbox)
            case rec.progress {
              AwaitingCommand -> Ok(types.CommandRunning(id, command, inbox))
              Completed(..) ->
                case dict.get(r.journal, rec.digest) {
                  Ok(Answered(_)) ->
                    Ok(types.CommandDone(id, command, inbox, types.Succeeded))
                  Ok(Errored(types.CommandCrashed(failure:, ..))) ->
                    Ok(types.CommandDone(
                      id,
                      command,
                      inbox,
                      types.FailedWith(failure),
                    ))
                  _ -> Error(Nil)
                }
              _ -> Error(Nil)
            }
          }
          ToolKind(tool:, ..) ->
            case rec.progress {
              AwaitingTool -> Ok(types.ToolRunning(id, tool))
              Completed(..) ->
                case dict.get(r.journal, rec.digest) {
                  Ok(Answered(_)) ->
                    Ok(types.ToolDone(id, tool, types.ToolSucceeded))
                  Ok(Errored(types.ToolCrashed(failure:, ..))) ->
                    Ok(types.ToolDone(id, tool, types.ToolFailedWith(failure)))
                  _ -> Error(Nil)
                }
              _ -> Error(Nil)
            }
          OrchestratorKind(name:, input:) ->
            case rec.progress {
              AwaitingOrchestrator ->
                Ok(types.OrchestratorPending(id, name, input))
              _ -> Ok(types.OrchestratorDone(id, name))
            }
          RefusedKind -> Error(Nil)
        }
      })
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
        #("held", json.nullable(option.map(r.hold, fn(h) { h.0 }), json.string)),
        #(
          "code",
          json.array(
            [r.pin.workflow_digest, ..list.reverse(r.pin.prior_digests)],
            json.string,
          ),
        ),
        #("owner", json.nullable(r.owner, json.string)),
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
