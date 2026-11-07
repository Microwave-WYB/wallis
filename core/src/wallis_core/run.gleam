//// The run state machine: `step(RunState, Event) -> #(RunState, List(Effect))`.
////
//// Request ids are assigned by the host from the body's branch path and a
//// per-branch counter, so they are stable across replays. A request whose
//// id is already recorded is a replay: it must carry the same digest (else
//// the event is refused as a path divergence) and is answered from the
//// journal, or, if it was still in flight when the host stopped, its effect
//// is emitted again. Replays emit no `Checkpoint`, so a resumed run's log
//// equals an uninterrupted one.
////
//// The run's status is derived from its requests: see `status`. Refusals
//// never change it.

import gleam/dict.{type Dict}
import gleam/float
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import wallis_core/digest
import wallis_core/reducer.{NonCommutative}
import wallis_core/types.{
  type Agent, type Effect, type Event, type FailReason, type Field,
  type IdleReason, type Message, type Node, type Outcome, type Pin, type Refusal,
  type Request, type RunStatus, type Usage, type Workflow, type Write,
  AgentFailed, AgentGaveUp, AgentIdle, AgentReturned, AliasRebound,
  AlreadyStarted, Assistant, BodyFailed, BodyFinished, BudgetExhausted,
  BudgetRaised, Call, CallAgent, CancelRequested, Cancelled, Checkpoint, Commit,
  ComputeMinutes, Deliver, Done, ExecutorChanged, ExecutorFailed,
  ExecutorUnavailable, Fail, Failed, Finish, Finished, GaveUp, Idle,
  InvalidDeclaration, JournalMissing, Message, Node, NodeDone, NodeIdle,
  NodeRunning, NonCommutativeWriteInBranch, NotIdle, NotRunning, NotStarted,
  PathDiverged, PinMismatch, Read, ReducerRejected, Refuse, Requested, Resumed,
  RetryUnavailable, RunScript, Running, Script, ScriptCrashed, ScriptFailed,
  ScriptReturned, Sent, Started, Submitted, Tokens, Turns, UnknownAgent,
  UnknownAlias, UnknownField, UnknownScript, Usd, User, Write, WriteNotAllowed,
}
import wallis_core/value.{type Value, JArray, JInt, JNull, JString}
import wallis_core/view

/// Bumped when a change to the core changes what a log means.
pub const semantics = "wallis-core/2"

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
    pin: Pin,
    input: Value,
    models: Dict(String, String),
    budget: types.Budget,
    executor: Option(String),
    state: Dict(String, Value),
    requests: Dict(String, Record),
    journal: Dict(String, Entry),
    spent: Spent,
  )
}

type Spent {
  Spent(usd: Float, tokens: Int, turns: Int, compute_minutes: Float)
}

type Record {
  Record(digest: String, branch: Option(String), kind: Kind, progress: Progress)
}

type Kind {
  AgentKind(agent: String, input: Value)
  ScriptKind(script: String, args: Value)
  OtherKind
}

/// An agent call's conversation: the snapshot view and the messages so far.
type Conversation {
  Conversation(
    view: String,
    omitted: Dict(String, Int),
    transcript: List(Message),
  )
}

type Progress {
  /// Waiting for budget before it is issued.
  Blocked(reason: IdleReason)
  AwaitingAgent(conversation: Conversation)
  /// The agent asked something: waiting for a `Sent`.
  AgentWaiting(conversation: Conversation, model: String)
  /// The executor could not serve the call; reissued after a fix.
  Unavailable(conversation: Conversation, alias: String, error: String)
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
    NotYetStarted, Started(workflow:, pin:, input:) ->
      start(workflow, pin, input)
    NotYetStarted, _ -> #(run, [Refuse(None, NotStarted)])
    Active(_), Started(..) -> #(run, [Refuse(None, AlreadyStarted)])
    Active(r), Resumed(pin:) -> #(run, resume(r, pin))
    Active(Run(lifecycle: Live, ..) as r), _ -> {
      let #(r, effects) = live_event(r, event)
      #(Active(r), effects)
    }
    Active(_), _ -> #(run, [Refuse(None, NotRunning)])
  }
}

// --- Start and resume ----------------------------------------------------------

fn start(
  workflow: Workflow,
  pin: Pin,
  input: Value,
) -> #(RunState, List(Effect)) {
  case validate(workflow, pin) {
    Error(reason) -> #(NotYetStarted, [Refuse(None, InvalidDeclaration(reason))])
    Ok(Nil) -> {
      let state =
        workflow.fields
        |> list.map(fn(f) { #(f.name, f.initial) })
        |> dict.from_list
      let run =
        Run(
          lifecycle: Live,
          workflow:,
          pin:,
          input:,
          models: pin.models,
          budget: workflow.budget,
          executor: None,
          state:,
          requests: dict.new(),
          journal: dict.new(),
          spent: Spent(0.0, 0, 0, 0.0),
        )
      #(Active(run), [Checkpoint])
    }
  }
}

fn validate(workflow: Workflow, pin: Pin) -> Result(Nil, String) {
  let names = list.map(workflow.fields, fn(f) { f.name })
  let known = fn(field, context) {
    case list.contains(names, field) {
      True -> Ok(Nil)
      False -> Error(context <> " refers to unknown field " <> field)
    }
  }
  use _ <- result.try(
    case list.length(list.unique(names)) == list.length(names) {
      True -> Ok(Nil)
      False -> Error("duplicate state field")
    },
  )
  use _ <- result.try(
    list.try_each(workflow.agents, fn(a) {
      use _ <- result.try(
        resolve_model(pin.models, a.model) |> result.map(fn(_) { Nil }),
      )
      use _ <- result.try(
        list.try_each(a.view.fields, known(_, "view of agent " <> a.name)),
      )
      list.try_each(a.writes, fn(w) {
        known(w.field, "writes of agent " <> a.name)
      })
    }),
  )
  Ok(Nil)
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

/// Only result-defining fields are compared; the alias table is operational.
fn resume(run: Run, pin: Pin) -> List(Effect) {
  case pin_mismatch(run.pin, pin) {
    Some(refusal) -> [Refuse(None, refusal)]
    None ->
      case run.lifecycle {
        Ended(outcome) -> [Finish(outcome)]
        Live -> []
      }
  }
}

fn pin_mismatch(recorded: Pin, now: Pin) -> Option(Refusal) {
  let differs = fn(field, a, b) {
    case a == b {
      True -> None
      False -> Some(PinMismatch(field:, recorded: a, current: b))
    }
  }
  differs("workflow_digest", recorded.workflow_digest, now.workflow_digest)
  |> option.lazy_or(fn() {
    differs("seed", int.to_string(recorded.seed), int.to_string(now.seed))
  })
  |> option.lazy_or(fn() {
    differs("semantics", recorded.semantics, now.semantics)
  })
  |> option.lazy_or(fn() {
    dict_mismatch("inputs", recorded.inputs, now.inputs)
  })
}

fn dict_mismatch(
  name: String,
  a: Dict(String, String),
  b: Dict(String, String),
) -> Option(Refusal) {
  list.append(dict.keys(a), dict.keys(b))
  |> list.unique
  |> list.sort(string.compare)
  |> list.find_map(fn(k) {
    let x = dict.get(a, k) |> result.unwrap("<absent>")
    let y = dict.get(b, k) |> result.unwrap("<absent>")
    case x == y {
      True -> Error(Nil)
      False -> Ok(PinMismatch(field: name <> "." <> k, recorded: x, current: y))
    }
  })
  |> option.from_result
}

// --- Events on a live run ------------------------------------------------------

fn live_event(run: Run, event: Event) -> #(Run, List(Effect)) {
  case event {
    Requested(id:, branch:, request:) -> requested(run, id, branch, request)
    AgentReturned(id:, output:, emits:, usage:, model:) ->
      agent_returned(run, id, output, emits, usage, model)
    AgentIdle(id:, message:, usage:, model:) ->
      agent_idle(run, id, message, usage, model)
    AgentFailed(id:, error:, usage:, model:) ->
      agent_failed(run, id, error, usage, model)
    ExecutorFailed(id:, error:) -> executor_failed(run, id, error)
    ScriptReturned(id:, output:, minutes:) ->
      script_settled(run, id, Answered(output), minutes)
    ScriptFailed(id:, error:, minutes:) ->
      script_failed(run, id, error, minutes)
    Sent(node:, text:, ..) -> sent(run, node, text)
    AliasRebound(alias:, to:, ..) -> rebind(run, alias, to)
    BudgetRaised(kind:, limit:) -> raise_budget(run, kind, limit)
    ExecutorChanged(name:) -> #(Run(..run, executor: Some(name)), [Checkpoint])
    RetryUnavailable -> retry_unavailable(run)
    CancelRequested -> finish(run, Cancelled)
    BodyFinished(output:) -> finish(run, Done(output))
    BodyFailed(reason:) -> finish(run, Failed(reason))
    Started(..) | Resumed(..) -> #(run, [])
  }
}

fn finish(run: Run, outcome: Outcome) -> #(Run, List(Effect)) {
  #(Run(..run, lifecycle: Ended(outcome)), [Checkpoint, Finish(outcome)])
}

fn request_digest(id: String, request: Request) -> String {
  let #(kind, name, body) = case request {
    Call(agent:, input:) -> #("call", agent, input)
    Script(script:, args:) -> #("script", script, args)
    Read(view:) -> #(
      "read",
      "",
      types.view_spec_to_json(view) |> json.to_string |> JString,
    )
    Commit(writes:) -> #(
      "commit",
      "",
      JArray(
        list.map(writes, fn(w) {
          value.object([#("field", JString(w.field)), #("value", w.value)])
        }),
      ),
    )
  }
  digest.hex(string.join([id, kind, name, value.canonical(body)], "\n"))
}

fn requested(
  run: Run,
  id: String,
  branch: Option(String),
  request: Request,
) -> #(Run, List(Effect)) {
  let d = request_digest(id, request)
  case dict.get(run.requests, id) {
    Ok(record) -> replay(run, id, d, record)
    Error(Nil) -> {
      let #(run, effects) = live_request(run, id, d, branch, request)
      #(run, [Checkpoint, ..effects])
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
    False -> #(run, [Refuse(None, PathDiverged(id))])
    True ->
      case record.progress, record.kind {
        Completed(..), _ ->
          case dict.get(run.journal, d) {
            Ok(entry) -> #(run, [answer(id, entry)])
            Error(Nil) -> #(run, [Refuse(None, JournalMissing(id))])
          }
        AwaitingAgent(conversation:), AgentKind(agent:, input:) ->
          case call_effect(run, id, agent, input, d, conversation) {
            Ok(call) -> #(run, [call])
            Error(_) -> #(run, [])
          }
        AwaitingScript, ScriptKind(script:, args:) -> #(run, [
          script_effect(run, id, script, args, d),
        ])
        // Waiting for a message, for budget, or for an executor fix: the
        // events that unblock them (`Sent`, `BudgetRaised`,
        // `RetryUnavailable`) are logged and reissue the call.
        _, _ -> #(run, [])
      }
  }
}

fn answer(id: String, entry: Entry) -> Effect {
  case entry {
    Answered(v) -> Deliver(id, v)
    Errored(reason) -> Fail(id, reason)
    Refused(refusal) -> Refuse(Some(id), refusal)
  }
}

fn live_request(
  run: Run,
  id: String,
  d: String,
  branch: Option(String),
  request: Request,
) -> #(Run, List(Effect)) {
  case request {
    Call(agent: name, input:) ->
      case find_agent(run.workflow, name) {
        Error(Nil) ->
          settle(
            run,
            id,
            Record(d, branch, OtherKind, Completed(None)),
            Refused(UnknownAgent(name)),
          )
        Ok(agent) -> {
          let kind = AgentKind(name, input)
          case budget_check(run) {
            Error(reason) -> #(
              record(run, id, Record(d, branch, kind, Blocked(reason))),
              [],
            )
            Ok(Nil) -> {
              let conversation = snapshot_view(run, agent)
              case call_effect(run, id, name, input, d, conversation) {
                Error(refusal) ->
                  settle(
                    run,
                    id,
                    Record(d, branch, kind, Completed(None)),
                    Refused(refusal),
                  )
                Ok(call) -> #(
                  record(
                    run,
                    id,
                    Record(d, branch, kind, AwaitingAgent(conversation)),
                  ),
                  [call],
                )
              }
            }
          }
        }
      }
    Script(script:, args:) -> {
      let kind = ScriptKind(script, args)
      case list.contains(run.workflow.scripts, script), compute_check(run) {
        False, _ ->
          settle(
            run,
            id,
            Record(d, branch, OtherKind, Completed(None)),
            Refused(UnknownScript(script)),
          )
        True, Error(reason) -> #(
          record(run, id, Record(d, branch, kind, Blocked(reason))),
          [],
        )
        True, Ok(Nil) -> #(
          record(run, id, Record(d, branch, kind, AwaitingScript)),
          [script_effect(run, id, script, args, d)],
        )
      }
    }
    Read(view: spec) -> {
      let rendered = view.render(spec, run.workflow.fields, run.state)
      let result =
        value.object([
          #("text", JString(rendered.text)),
          #(
            "omitted",
            rendered.omitted
              |> dict.to_list
              |> list.map(fn(e) { #(e.0, JInt(e.1)) })
              |> value.object,
          ),
          #("data", rendered.data),
        ])
      settle(
        run,
        id,
        Record(d, branch, OtherKind, Completed(None)),
        Answered(result),
      )
    }
    Commit(writes:) -> {
      let run = record(run, id, Record(d, branch, OtherKind, Completed(None)))
      complete(run, id, JNull, writes)
    }
  }
}

/// The call's view, rendered now: this is its snapshot. Later writes do not
/// reach it.
fn snapshot_view(run: Run, agent: Agent) -> Conversation {
  let rendered = view.render(agent.view, run.workflow.fields, run.state)
  Conversation(view: rendered.text, omitted: rendered.omitted, transcript: [])
}

/// The model is resolved at issue time from the current alias table, so a
/// rebinding reaches every call issued or continued after it.
fn call_effect(
  run: Run,
  id: String,
  name: String,
  input: Value,
  d: String,
  conversation: Conversation,
) -> Result(Effect, Refusal) {
  use agent <- result.try(
    find_agent(run.workflow, name) |> result.replace_error(UnknownAgent(name)),
  )
  use model <- result.try(
    resolve_model(run.models, agent.model)
    |> result.replace_error(UnknownAlias(agent.model)),
  )
  Ok(CallAgent(
    id:,
    agent: agent.name,
    model:,
    view: conversation.view,
    omitted: conversation.omitted,
    input:,
    max_turns: turn_cap(run, agent),
    digest: d,
    transcript: conversation.transcript,
  ))
}

fn script_effect(
  run: Run,
  id: String,
  script: String,
  args: Value,
  d: String,
) -> Effect {
  RunScript(
    id:,
    script:,
    args:,
    compute_minutes: option.map(run.budget.compute_minutes, fn(limit) {
      limit -. run.spent.compute_minutes
    }),
    digest: d,
  )
}

/// Checked before every agent call. An exhausted budget pauses the call.
fn budget_check(run: Run) -> Result(Nil, IdleReason) {
  let b = run.budget
  let s = run.spent
  use _ <- result.try(case b.usd {
    Some(limit) if s.usd >=. limit -> Error(BudgetExhausted(Usd, s.usd, limit))
    _ -> Ok(Nil)
  })
  use _ <- result.try(case b.tokens {
    Some(limit) if s.tokens >= limit ->
      Error(BudgetExhausted(Tokens, int.to_float(s.tokens), int.to_float(limit)))
    _ -> Ok(Nil)
  })
  case b.turns {
    Some(limit) if s.turns >= limit ->
      Error(BudgetExhausted(Turns, int.to_float(s.turns), int.to_float(limit)))
    _ -> Ok(Nil)
  }
}

fn compute_check(run: Run) -> Result(Nil, IdleReason) {
  case run.budget.compute_minutes {
    Some(limit) if run.spent.compute_minutes >=. limit ->
      Error(BudgetExhausted(ComputeMinutes, run.spent.compute_minutes, limit))
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
  let model = case rec.progress {
    Completed(model:) -> model
    _ -> None
  }
  let run =
    Run(
      ..record(run, id, Record(..rec, progress: Completed(model))),
      journal: dict.insert(run.journal, rec.digest, entry),
    )
  #(run, [answer(id, entry)])
}

fn settle_recorded(
  run: Run,
  id: String,
  model: Option(String),
  entry: Entry,
) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(rec) -> settle(run, id, Record(..rec, progress: Completed(model)), entry)
    Error(Nil) -> #(run, [Refuse(None, JournalMissing(id))])
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

/// The conversation of an agent call that is running or was cut off.
fn in_flight(record: Record) -> Option(#(String, Value, Conversation)) {
  case record.kind, record.progress {
    AgentKind(agent:, input:), AwaitingAgent(conversation:)
    | AgentKind(agent:, input:), Unavailable(conversation:, ..)
    -> Some(#(agent, input, conversation))
    _, _ -> None
  }
}

fn agent_returned(
  run: Run,
  id: String,
  output: Value,
  emits: List(Write),
  usage: Usage,
  model: String,
) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(rec) ->
      case in_flight(rec) {
        None -> #(run, [])
        Some(#(name, _, _)) -> {
          let run =
            spend(run, usage)
            |> record(id, Record(..rec, progress: Completed(Some(model))))
          let #(run, effects) = case find_agent(run.workflow, name) {
            Error(Nil) ->
              settle_recorded(run, id, Some(model), Refused(UnknownAgent(name)))
            Ok(agent) ->
              case agent_writes(agent, output, emits) {
                Error(refusal) ->
                  settle_recorded(run, id, Some(model), Refused(refusal))
                Ok(writes) -> complete(run, id, output, writes)
              }
          }
          #(run, [Checkpoint, ..effects])
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
        Some(#(_, _, c)) -> {
          let c =
            Conversation(
              ..c,
              transcript: list.append(c.transcript, [
                Message(Assistant, message),
              ]),
            )
          let run =
            spend(run, usage)
            |> record(id, Record(..rec, progress: AgentWaiting(c, model)))
          #(run, [Checkpoint])
        }
        None -> #(run, [])
      }
    Error(Nil) -> #(run, [])
  }
}

fn agent_failed(
  run: Run,
  id: String,
  error: String,
  usage: Usage,
  model: String,
) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(rec) ->
      case in_flight(rec) {
        Some(#(name, _, _)) -> {
          let #(run, effects) =
            settle_recorded(
              spend(run, usage),
              id,
              Some(model),
              Errored(AgentGaveUp(name, error)),
            )
          #(run, [Checkpoint, ..effects])
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
        Some(#(name, _, c)) -> {
          let alias = case find_agent(run.workflow, name) {
            Ok(a) -> a.model
            Error(Nil) -> name
          }
          #(
            record(
              run,
              id,
              Record(..rec, progress: Unavailable(c, alias, error)),
            ),
            [
              Checkpoint,
            ],
          )
        }
        None -> #(run, [])
      }
    Error(Nil) -> #(run, [])
  }
}

fn retry_unavailable(run: Run) -> #(Run, List(Effect)) {
  let #(run, effects) =
    run.requests
    |> dict.to_list
    |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
    |> list.fold(#(run, []), fn(acc, entry) {
      let #(run, effects) = acc
      case entry.1 {
        Record(
          kind: AgentKind(agent:, input:),
          progress: Unavailable(conversation:, ..),
          ..,
        ) as rec ->
          case
            call_effect(run, entry.0, agent, input, rec.digest, conversation)
          {
            Ok(call) -> #(
              record(
                run,
                entry.0,
                Record(..rec, progress: AwaitingAgent(conversation)),
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
    _ -> #(run, [Checkpoint, ..effects])
  }
}

/// A message to an idle node continues its conversation, with the model
/// the alias resolves to now.
fn sent(run: Run, node: String, text: String) -> #(Run, List(Effect)) {
  case dict.get(run.requests, node) {
    Ok(
      Record(
        kind: AgentKind(agent:, input:),
        progress: AgentWaiting(conversation: c, ..),
        ..,
      ) as rec,
    ) -> {
      let c =
        Conversation(
          ..c,
          transcript: list.append(c.transcript, [Message(User, text)]),
        )
      case call_effect(run, node, agent, input, rec.digest, c) {
        Ok(call) -> #(
          record(run, node, Record(..rec, progress: AwaitingAgent(c))),
          [
            Checkpoint,
            call,
          ],
        )
        Error(refusal) -> #(run, [Refuse(None, refusal)])
      }
    }
    _ -> #(run, [Refuse(None, NotIdle(node))])
  }
}

fn rebind(run: Run, alias: String, to: String) -> #(Run, List(Effect)) {
  case dict.has_key(run.models, alias) {
    False -> #(run, [Refuse(None, UnknownAlias(alias))])
    True -> #(Run(..run, models: dict.insert(run.models, alias, to)), [
      Checkpoint,
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
    Usd -> types.Budget(..b, usd: Some(limit))
    Tokens -> types.Budget(..b, tokens: Some(float.round(limit)))
    Turns -> types.Budget(..b, turns: Some(float.round(limit)))
    ComputeMinutes -> types.Budget(..b, compute_minutes: Some(limit))
  }
  let run = Run(..run, budget:)
  let #(run, effects) =
    run.requests
    |> dict.to_list
    |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
    |> list.fold(#(run, []), fn(acc, entry) {
      let #(run, effects) = acc
      let id = entry.0
      case entry.1 {
        Record(kind: AgentKind(agent:, input:), progress: Blocked(_), ..) as rec ->
          case budget_check(run), find_agent(run.workflow, agent) {
            Ok(Nil), Ok(a) -> {
              let c = snapshot_view(run, a)
              case call_effect(run, id, agent, input, rec.digest, c) {
                Ok(call) -> #(
                  record(run, id, Record(..rec, progress: AwaitingAgent(c))),
                  list.append(effects, [call]),
                )
                Error(_) -> acc
              }
            }
            _, _ -> acc
          }
        Record(kind: ScriptKind(script:, args:), progress: Blocked(_), ..) as rec ->
          case compute_check(run) {
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
  #(run, [Checkpoint, ..effects])
}

fn script_settled(
  run: Run,
  id: String,
  entry: Entry,
  minutes: Float,
) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(Record(progress: AwaitingScript, ..)) -> {
      let run =
        Run(
          ..run,
          spent: Spent(
            ..run.spent,
            compute_minutes: run.spent.compute_minutes +. minutes,
          ),
        )
      let #(run, effects) = settle_recorded(run, id, None, entry)
      #(run, [Checkpoint, ..effects])
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
  script_settled(run, id, Errored(ScriptCrashed(script, error)), minutes)
}

/// Writes come from the agent's declared output mappings plus its `emit`
/// calls, which must target a declared field.
fn agent_writes(
  agent: Agent,
  output: Value,
  emits: List(Write),
) -> Result(List(Write), Refusal) {
  let mapped =
    list.filter_map(agent.writes, fn(w) {
      case option.then(w.from, value.get(output, _)) {
        Some(JNull) | None -> Error(Nil)
        Some(v) -> Ok(Write(w.field, v))
      }
    })
  let allowed = list.map(agent.writes, fn(w) { w.field })
  use _ <- result.try(
    list.try_each(emits, fn(e) {
      case list.contains(allowed, e.field) {
        True -> Ok(Nil)
        False -> Error(WriteNotAllowed(agent.name, e.field))
      }
    }),
  )
  Ok(list.append(mapped, emits))
}

// --- Writes and reducers -------------------------------------------------------

/// Applies a finished call's buffered writes atomically: one bad write
/// refuses them all.
fn complete(
  run: Run,
  id: String,
  output: Value,
  writes: List(Write),
) -> #(Run, List(Effect)) {
  let #(branch, model) = case dict.get(run.requests, id) {
    Ok(Record(branch:, progress: Completed(model:), ..)) -> #(branch, model)
    Ok(rec) -> #(rec.branch, None)
    Error(Nil) -> #(None, None)
  }
  let applied = {
    use Nil <- result.try(check_writes(run, branch, writes))
    apply_writes(run.workflow, run.state, writes)
  }
  case applied {
    Error(refusal) -> settle_recorded(run, id, model, Refused(refusal))
    Ok(state) ->
      settle_recorded(Run(..run, state:), id, model, Answered(output))
  }
}

fn check_writes(
  run: Run,
  branch: Option(String),
  writes: List(Write),
) -> Result(Nil, Refusal) {
  list.try_each(writes, fn(w) {
    case find_field(run.workflow, w.field), branch {
      Error(Nil), _ -> Error(UnknownField(w.field))
      Ok(f), Some(b) ->
        case reducer.commutativity(f.reducer) {
          NonCommutative -> Error(NonCommutativeWriteInBranch(w.field, b))
          reducer.Commutative -> Ok(Nil)
        }
      Ok(_), None -> Ok(Nil)
    }
  })
}

fn apply_writes(
  workflow: Workflow,
  state: Dict(String, Value),
  writes: List(Write),
) -> Result(Dict(String, Value), Refusal) {
  list.try_fold(writes, state, fn(state, w) {
    use f <- result.try(
      find_field(workflow, w.field)
      |> result.replace_error(UnknownField(w.field)),
    )
    let current = dict.get(state, w.field) |> result.unwrap(f.initial)
    reducer.apply(f.reducer, current, w.value)
    |> result.map(dict.insert(state, w.field, _))
    |> result.map_error(ReducerRejected(w.field, _))
  })
}

fn find_agent(workflow: Workflow, name: String) -> Result(Agent, Nil) {
  list.find(workflow.agents, fn(a) { a.name == name })
}

fn find_field(workflow: Workflow, name: String) -> Result(Field, Nil) {
  list.find(workflow.fields, fn(f) { f.name == name })
}

// --- Status --------------------------------------------------------------------

/// Running while any call or script is in flight. Otherwise idle: for
/// budget or an executor fault (the first blocked request by id), or because
/// a node waits for a message. A run with nothing in flight and nothing
/// waiting is running: its body is computing.
pub fn status(run: RunState) -> Option(RunStatus) {
  case run {
    NotYetStarted -> None
    Active(Run(lifecycle: Ended(outcome), ..)) -> Some(Finished(outcome))
    Active(r) -> {
      let records =
        r.requests
        |> dict.to_list
        |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
        |> list.map(fn(e) { e.1.progress })
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
            Blocked(reason:) -> Ok(reason)
            Unavailable(alias:, error:, ..) ->
              Ok(ExecutorUnavailable(alias, error))
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
      case running, reason, waiting {
        True, _, _ -> Some(Running)
        False, Ok(reason), _ -> Some(Idle(Some(reason)))
        False, Error(Nil), True -> Some(Idle(None))
        False, Error(Nil), False -> Some(Running)
      }
    }
  }
}

/// Agent calls that started a conversation. Calls blocked on budget or an
/// executor fault are not nodes yet; the run's idle reason names them.
pub fn nodes(run: RunState) -> List(Node) {
  case run {
    NotYetStarted -> []
    Active(r) ->
      r.requests
      |> dict.to_list
      |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
      |> list.filter_map(fn(e) {
        let #(id, rec) = e
        case rec.kind {
          AgentKind(agent:, ..) -> {
            let model = fn() {
              case find_agent(r.workflow, agent) {
                Ok(a) -> resolve_model(r.models, a.model) |> result.unwrap("")
                Error(Nil) -> ""
              }
            }
            case rec.progress {
              AwaitingAgent(..) -> Ok(Node(id, agent, model(), NodeRunning))
              AgentWaiting(conversation:, model:) ->
                Ok(Node(id, agent, model, NodeIdle(last_text(conversation))))
              Completed(model:) -> {
                let outcome = case dict.get(r.journal, rec.digest) {
                  Ok(Errored(AgentGaveUp(error:, ..))) -> GaveUp(error)
                  _ -> Submitted
                }
                Ok(Node(id, agent, option.unwrap(model, ""), NodeDone(outcome)))
              }
              _ -> Error(Nil)
            }
          }
          _ -> Error(Nil)
        }
      })
  }
}

fn last_text(c: Conversation) -> String {
  case list.last(c.transcript) {
    Ok(m) -> m.text
    Error(Nil) -> ""
  }
}

/// Canonical JSON of the run: status, nodes, state, spend, budget, models.
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
        #("state", value.to_json(value.object(dict.to_list(r.state)))),
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
