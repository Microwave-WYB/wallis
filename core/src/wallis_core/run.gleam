//// The run state machine: `step(RunState, Event) -> #(RunState, List(Effect))`.
////
//// A run is a fold of the workflow body over its journal. The body is a
//// deterministic program whose only interface to the world is typed
//// requests (agent calls and scripts); each request affects the body only
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
pub const semantics = "wallis-core/3"

pub opaque type RunState {
  NotYetStarted
  Active(Run)
}

type Lifecycle {
  Live
  Ended(Outcome)
}

/// Whether new calls and scripts are issued: `Holding` after a pause.
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
    requests: Dict(String, Record),
    journal: Dict(String, Entry),
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
  AgentKind(agent: String, input: Value, inbox: List(InboxMessage), steps: Int)
  ScriptKind(script: String, args: Value)
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
  AgentWaiting(dialogue: Dialogue, model: String)
  /// The executor could not serve the call; reissued after a fix.
  Unavailable(dialogue: Dialogue, alias: String, error: String)
  AwaitingScript
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
        Ok(resumable) -> #(run, resume(r, resumable))
      }
    // Ownership changes even on a finished run.
    Active(r), types.Claimed(owner:) -> #(Active(Run(..r, owner: Some(owner))), [
      types.Checkpoint,
    ])
    Active(Run(lifecycle: Live, ..) as r), _ -> {
      let #(r, effects) = live_event(r, event)
      #(Active(r), effects)
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
    types.Requested(id:, request:) -> requested(run, id, request)
    types.AgentReturned(id:, output:, usage:, model:) ->
      agent_settled(run, id, usage, model, fn(_) { Answered(output) })
    types.AgentFailed(id:, failure:, usage:, model:) ->
      agent_settled(run, id, usage, model, fn(name) {
        Errored(types.AgentGaveUp(name, failure))
      })
    types.InputRejected(id:, field:, chars:, limit:) ->
      agent_settled(run, id, types.Usage(0.0, 0, 0), "", fn(name) {
        Refused(types.InputTooLarge(name, field, chars, limit))
      })
    types.AgentIdle(id:, message:, usage:, model:) ->
      agent_idle(run, id, message, usage, model)
    types.ExecutorFailed(id:, error:) -> executor_failed(run, id, error)
    types.ScriptReturned(id:, output:, minutes:) ->
      script_settled(run, id, Answered(output), minutes)
    types.ScriptFailed(id:, error:, minutes:) ->
      script_failed(run, id, error, minutes)
    types.Observed(at:, label:, value:) -> observe(run, at, label, value)
    types.Sent(node:, text:, by:, ..) ->
      intervene(run, by, fn(owned) {
        use idle <- result.map(capability.check_idle(
          owned,
          node,
          facts(run, node),
        ))
        answer(run, idle, text)
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
    types.Interrupted(node:, by:) ->
      intervene(run, by, fn(owned) {
        use node <- result.map(capability.check_steerable(
          owned,
          node,
          facts(run, node),
        ))
        let id = capability.steerable_id(node)
        #(add_inbox(run, id, types.Interrupt, ""), [types.Checkpoint])
      })
    types.Restarted(node:, note:, by:) ->
      intervene(run, by, fn(owned) {
        use node <- result.try(capability.check_live(
          owned,
          node,
          facts(run, node),
        ))
        restart(run, node, note)
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
    types.BodyFailed(reason:) -> finish(run, types.Failed(reason))
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

fn request_digest(id: String, request: Request) -> String {
  let #(kind, name, body) = case request {
    types.Call(agent:, input:) -> #("call", agent, input)
    types.Script(script:, args:) -> #("script", script, args)
  }
  digest.hex(string.join([id, kind, name, value.canonical(body)], "\n"))
}

fn requested(run: Run, id: String, request: Request) -> #(Run, List(Effect)) {
  let d = request_digest(id, request)
  case dict.get(run.requests, id) {
    Ok(record) -> replay(run, id, d, record)
    Error(Nil) -> {
      let #(run, effects) = live_request(run, id, d, request)
      #(run, [types.Checkpoint, ..effects])
    }
  }
}

/// Replays answer from the journal or re-emit what was in flight. They do
/// not change the run, so a refold of the log reaches the same state.
fn replay(
  run: Run,
  id: String,
  d: String,
  record: Record,
) -> #(Run, List(Effect)) {
  case record.digest == d {
    False -> #(run, [types.Refuse(None, types.PathDiverged(id))])
    True ->
      case record.progress, record.kind {
        Completed(..), _ ->
          case dict.get(run.journal, d) {
            Ok(entry) -> #(run, [answer_effect(id, entry)])
            Error(Nil) -> #(run, [types.Refuse(None, types.JournalMissing(id))])
          }
        AwaitingAgent(dialogue:), AgentKind(agent:, input:, ..) ->
          case call_effect(run, id, agent, input, d, dialogue) {
            Ok(call) -> #(run, [call])
            Error(_) -> #(run, [])
          }
        AwaitingScript, ScriptKind(script:, args:) -> #(run, [
          script_effect(run, id, script, args, d),
        ])
        // Waiting for an answer, for budget, or for an executor fix: the
        // events that unblock them (`Sent`, `BudgetRaised`,
        // `RetryUnavailable`) are logged and reissue the call.
        _, _ -> #(run, [])
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
    types.Call(agent: name, input:) ->
      case find_agent(run.workflow, name) {
        Error(Nil) ->
          settle(
            run,
            id,
            Record(d, RefusedKind, Completed(None)),
            Refused(types.UnknownAgent(name)),
          )
        Ok(_) -> {
          let kind = AgentKind(name, input, [], 0)
          case admit(run) {
            Error(reason) -> #(
              record(run, id, Record(d, kind, Blocked(reason, None))),
              [],
            )
            Ok(Nil) -> {
              let dialogue = Dialogue([], None)
              case call_effect(run, id, name, input, d, dialogue) {
                Error(refusal) ->
                  settle(
                    run,
                    id,
                    Record(d, kind, Completed(None)),
                    Refused(refusal),
                  )
                Ok(call) -> #(
                  record(run, id, Record(d, kind, AwaitingAgent(dialogue))),
                  [call],
                )
              }
            }
          }
        }
      }
    types.Script(script:, args:) -> {
      let kind = ScriptKind(script, args)
      case
        list.contains(run.workflow.scripts, script),
        result.try(admission(run), fn(_) { compute_check(run) })
      {
        False, _ ->
          settle(
            run,
            id,
            Record(d, RefusedKind, Completed(None)),
            Refused(types.UnknownScript(script)),
          )
        True, Error(reason) -> #(
          record(run, id, Record(d, kind, Blocked(reason, None))),
          [],
        )
        True, Ok(Nil) -> #(record(run, id, Record(d, kind, AwaitingScript)), [
          script_effect(run, id, script, args, d),
        ])
      }
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
  Ok(types.CallAgent(
    id:,
    agent: agent.name,
    model:,
    input:,
    max_turns: turn_cap(run, agent),
    digest: d,
    transcript: dialogue.transcript,
    note: dialogue.note,
  ))
}

fn script_effect(
  run: Run,
  id: String,
  script: String,
  args: Value,
  d: String,
) -> Effect {
  types.RunScript(
    id:,
    script:,
    args:,
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

/// Checked before every agent call. An exhausted budget pauses the call.
fn budget_check(run: Run) -> Result(Nil, IdleReason) {
  let b = run.budget
  let s = run.spent
  use _ <- result.try(case b.usd {
    Some(limit) if s.usd >=. limit ->
      Error(types.BudgetExhausted(types.Usd, s.usd, limit))
    _ -> Ok(Nil)
  })
  use _ <- result.try(case b.tokens {
    Some(limit) if s.tokens >= limit ->
      Error(types.BudgetExhausted(
        types.Tokens,
        int.to_float(s.tokens),
        int.to_float(limit),
      ))
    _ -> Ok(Nil)
  })
  case b.turns {
    Some(limit) if s.turns >= limit ->
      Error(types.BudgetExhausted(
        types.Turns,
        int.to_float(s.turns),
        int.to_float(limit),
      ))
    _ -> Ok(Nil)
  }
}

fn compute_check(run: Run) -> Result(Nil, IdleReason) {
  case run.budget.compute_minutes {
    Some(limit) if run.spent.compute_minutes >=. limit ->
      Error(types.BudgetExhausted(
        types.ComputeMinutes,
        run.spent.compute_minutes,
        limit,
      ))
    _ -> Ok(Nil)
  }
}

fn turn_cap(run: Run, agent: Agent) -> Int {
  case run.budget.turns {
    Some(limit) -> int.max(1, int.min(agent.max_turns, limit - run.spent.turns))
    None -> agent.max_turns
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

fn agent_idle(
  run: Run,
  id: String,
  message: String,
  usage: Usage,
  model: String,
) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(rec) ->
      case in_flight(rec) {
        Some(#(_, d)) -> {
          let d =
            Dialogue(
              ..d,
              transcript: list.append(d.transcript, [
                types.Message(types.Assistant, message),
              ]),
            )
          let rec =
            Record(
              ..rec,
              kind: add_steps(rec.kind, usage),
              progress: AgentWaiting(d, model),
            )
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

fn facts(run: Run, node: String) -> NodeFacts {
  case dict.get(run.requests, node) {
    Ok(Record(kind: AgentKind(agent:, ..), progress:, ..)) -> {
      let steerable = case find_agent(run.workflow, agent) {
        Ok(a) -> a.steerable
        Error(Nil) -> False
      }
      case progress {
        AwaitingAgent(..) -> capability.Working(steerable)
        AgentWaiting(..) -> capability.Waiting(steerable)
        Unavailable(..) -> capability.Faulted(steerable)
        Blocked(..) -> capability.Held(steerable)
        AwaitingScript | Completed(..) -> capability.Settled
      }
    }
    _ -> capability.Absent
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
    _ -> run
  }
}

/// An answer continues the idle node's dialogue, with the model its alias
/// resolves to now.
fn answer(run: Run, node: IdleNode, text: String) -> #(Run, List(Effect)) {
  let id = capability.idle_id(node)
  let run = add_inbox(run, id, types.Answer, text)
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
) -> Result(#(Run, List(Effect)), Refusal) {
  let id = capability.live_id(node)
  use _ <- result.try(case note, capability.live_steerable(node) {
    Some(_), False -> Error(types.NotSteerable(id))
    _, _ -> Ok(Nil)
  })
  case dict.get(run.requests, id) {
    Ok(Record(kind: AgentKind(agent:, input:, ..), progress:, ..) as rec) ->
      case progress {
        AwaitingAgent(..) | AgentWaiting(..) | Unavailable(..) -> {
          let run = add_inbox(run, id, types.Restart, option.unwrap(note, ""))
          let rec = dict.get(run.requests, id) |> result.unwrap(rec)
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
  case dict.get(run.requests, id) {
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
    types.Usd -> types.Budget(..b, usd: Some(limit))
    types.Tokens -> types.Budget(..b, tokens: Some(float.round(limit)))
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
      Record(kind: ScriptKind(script:, args:), progress: Blocked(..), ..) as rec ->
        case result.try(admission(run), fn(_) { compute_check(run) }) {
          Ok(Nil) -> #(
            record(run, id, Record(..rec, progress: AwaitingScript)),
            list.append(effects, [
              script_effect(run, id, script, args, rec.digest),
            ]),
          )
          Error(_) -> acc
        }
      _ -> acc
    }
  })
}

fn script_settled(
  run: Run,
  id: String,
  entry: Entry,
  minutes: Float,
) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(Record(progress: AwaitingScript, ..) as rec) -> {
      let run =
        Run(
          ..run,
          spent: Spent(
            ..run.spent,
            compute_minutes: run.spent.compute_minutes +. minutes,
          ),
        )
      let #(run, effects) =
        settle(run, id, Record(..rec, progress: Completed(None)), entry)
      #(run, [types.Checkpoint, ..effects])
    }
    _ -> #(run, [])
  }
}

fn script_failed(
  run: Run,
  id: String,
  error: String,
  minutes: Float,
) -> #(Run, List(Effect)) {
  let script = case dict.get(run.requests, id) {
    Ok(Record(kind: ScriptKind(script:, ..), ..)) -> script
    _ -> ""
  }
  script_settled(run, id, Errored(types.ScriptCrashed(script, error)), minutes)
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
            AwaitingAgent(..) | AwaitingScript -> True
            _ -> False
          }
        })
      let reason =
        list.find_map(records, fn(p) {
          case p {
            Blocked(reason:, ..) -> Ok(reason)
            Unavailable(alias:, error:, ..) ->
              Ok(types.ExecutorUnavailable(alias, error))
            _ -> Error(Nil)
          }
        })
      let waiting =
        list.any(records, fn(p) {
          case p {
            AgentWaiting(..) -> True
            _ -> False
          }
        })
      case running, r.admission, reason, waiting {
        True, _, _, _ -> Some(types.Running)
        False, Holding, _, _ -> Some(types.Idle(Some(types.PausedByUser)))
        False, Admitting, Ok(reason), _ -> Some(types.Idle(Some(reason)))
        False, Admitting, Error(Nil), True -> Some(types.Idle(None))
        False, Admitting, Error(Nil), False -> Some(types.Running)
      }
    }
  }
}

/// Agent calls that started a dialogue. Calls held back by a pause, the
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
              AgentWaiting(dialogue:, model:) ->
                Ok(types.NodeIdle(
                  id,
                  agent,
                  model,
                  steerable,
                  inbox,
                  last_text(dialogue),
                ))
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
          _ -> Error(Nil)
        }
      })
  }
}

fn last_text(d: Dialogue) -> String {
  case list.last(d.transcript) {
    Ok(m) -> m.text
    Error(Nil) -> ""
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
