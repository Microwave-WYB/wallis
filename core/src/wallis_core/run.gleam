//// The run state machine: `step(RunState, Event) -> #(RunState, List(Effect))`.
////
//// Request ids are assigned by the host from the body's branch path and a
//// per-branch counter, so they are stable across replays. A request whose
//// id is already recorded is a replay: it must carry the same digest (or the
//// run halts on path divergence) and is answered from the journal, or, if it
//// was still in flight when the run stopped, its effect is emitted again.
//// Replays emit no `Checkpoint`, so a resumed run's log equals an
//// uninterrupted one.

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
  type Agent, type Effect, type Event, type Field, type Outcome, type Pin,
  type Request, type Usage, type Workflow, type Write, AgentFailed,
  AgentReturned, BodyFailed, BodyFinished, Call, CallAgent, Checkpoint, Commit,
  Deliver, Done, Fail, Failed, Finish, LlmMerge, Read, Refuse, Requested,
  Resumed, RunScript, Script, ScriptFailed, ScriptReturned, Started, Write,
}
import wallis_core/value.{type Value, JArray, JInt, JNull, JString}
import wallis_core/view

pub opaque type RunState {
  Idle
  Active(Run)
}

pub type Status {
  Running
  Finished(Outcome)
  /// Stopped by the core (pin mismatch, path divergence). Never logged.
  Halted(reason: String)
}

type Run {
  Run(
    status: Status,
    workflow: Workflow,
    pin: Pin,
    input: Value,
    state: Dict(String, Value),
    requests: Dict(String, Record),
    journal: Dict(String, Entry),
    merges: Dict(String, MergeRef),
    merge_calls: Dict(String, Int),
    spent: Spent,
  )
}

type Spent {
  Spent(usd: Float, tokens: Int, turns: Int, compute_minutes: Float)
}

type Record {
  Record(digest: String, branch: Option(String), progress: Progress)
}

type Progress {
  AwaitingAgent(call: Effect)
  AwaitingScript(run: Effect)
  /// The call returned; its writes wait for llmMerge calls. They are
  /// applied together when the last merge settles.
  AwaitingMerges(
    output: Value,
    writes: List(Write),
    pending: List(PendingMerge),
    settled: List(#(String, MergeOutcome)),
  )
  Completed
}

type PendingMerge {
  PendingMerge(field: String, call: Effect)
}

type MergeOutcome {
  Merged(items: List(Value), archived: List(Value))
  UseFallback
}

type MergeRef {
  MergeRef(parent: String, field: String)
}

type Entry {
  Answered(Value)
  Errored(String)
  Refused(String)
}

pub fn new() -> RunState {
  Idle
}

pub fn status(run: RunState) -> Option(Status) {
  case run {
    Idle -> None
    Active(r) -> Some(r.status)
  }
}

pub fn step(run: RunState, event: Event) -> #(RunState, List(Effect)) {
  case run, event {
    Idle, Started(workflow:, pin:, input:) -> start(workflow, pin, input)
    Idle, _ -> #(Idle, [Refuse(None, "run not started")])
    Active(_), Started(..) -> #(run, [Refuse(None, "run already started")])
    Active(r), Resumed(pin:) -> resume(r, pin)
    Active(Run(status: Running, ..) as r), _ -> {
      let #(r, effects) = running(r, event)
      #(Active(r), effects)
    }
    Active(_), _ -> #(run, [Refuse(None, "run is not running")])
  }
}

// --- Start and resume ----------------------------------------------------------

fn start(
  workflow: Workflow,
  pin: Pin,
  input: Value,
) -> #(RunState, List(Effect)) {
  case validate(workflow, pin) {
    Error(reason) -> #(Idle, [Refuse(None, reason)])
    Ok(Nil) -> {
      let state =
        workflow.fields
        |> list.map(fn(f) { #(f.name, f.initial) })
        |> dict.from_list
      let run =
        Run(
          status: Running,
          workflow:,
          pin:,
          input:,
          state:,
          requests: dict.new(),
          journal: dict.new(),
          merges: dict.new(),
          merge_calls: dict.new(),
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
        resolve_model(pin, a.model) |> result.map(fn(_) { Nil }),
      )
      use _ <- result.try(
        list.try_each(a.view.fields, known(_, "view of agent " <> a.name)),
      )
      list.try_each(a.writes, fn(w) {
        known(w.field, "writes of agent " <> a.name)
      })
    }),
  )
  list.try_each(workflow.fields, fn(f) {
    case f.reducer {
      LlmMerge(agent:, archive:, ..) -> {
        use _ <- result.try(case find_agent(workflow, agent) {
          Ok(_) -> Ok(Nil)
          Error(Nil) ->
            Error("llmMerge of " <> f.name <> " names unknown agent " <> agent)
        })
        case archive {
          Some(a) -> known(a, "archive of " <> f.name)
          None -> Ok(Nil)
        }
      }
      _ -> Ok(Nil)
    }
  })
}

/// Resolution: the pinned alias table, then `default`.
fn resolve_model(pin: Pin, alias: String) -> Result(String, String) {
  case dict.get(pin.models, alias), dict.get(pin.models, "default") {
    Ok(m), _ if m != "" -> Ok(m)
    _, Ok(m) if m != "" -> Ok(m)
    _, _ ->
      Error("model alias " <> alias <> " is unresolved and default is empty")
  }
}

fn resume(run: Run, pin: Pin) -> #(RunState, List(Effect)) {
  case pin_mismatch(run.pin, pin) {
    Some(reason) -> {
      let reason = "pin mismatch: " <> reason
      #(Active(Run(..run, status: Halted(reason))), [Refuse(None, reason)])
    }
    None ->
      case run.status {
        Finished(outcome) -> #(Active(run), [Finish(outcome)])
        Running | Halted(_) -> #(Active(Run(..run, status: Running)), [])
      }
  }
}

fn pin_mismatch(recorded: Pin, now: Pin) -> Option(String) {
  let differs = fn(field, a, b) {
    case a == b {
      True -> None
      False ->
        Some(field <> " (recorded " <> show(a) <> ", now " <> show(b) <> ")")
    }
  }
  differs("workflow_digest", recorded.workflow_digest, now.workflow_digest)
  |> option.lazy_or(fn() {
    differs("seed", int.to_string(recorded.seed), int.to_string(now.seed))
  })
  |> option.lazy_or(fn() {
    dict_mismatch("models", recorded.models, now.models)
  })
  |> option.lazy_or(fn() {
    dict_mismatch("inputs", recorded.inputs, now.inputs)
  })
}

fn dict_mismatch(
  name: String,
  a: Dict(String, String),
  b: Dict(String, String),
) -> Option(String) {
  list.append(dict.keys(a), dict.keys(b))
  |> list.unique
  |> list.sort(string.compare)
  |> list.find_map(fn(k) {
    let x = dict.get(a, k) |> result.unwrap("<absent>")
    let y = dict.get(b, k) |> result.unwrap("<absent>")
    case x == y {
      True -> Error(Nil)
      False ->
        Ok(
          name
          <> "."
          <> k
          <> " (recorded "
          <> show(x)
          <> ", now "
          <> show(y)
          <> ")",
        )
    }
  })
  |> option.from_result
}

fn show(s: String) -> String {
  json.to_string(json.string(s))
}

// --- Running -------------------------------------------------------------------

fn running(run: Run, event: Event) -> #(Run, List(Effect)) {
  case event {
    Requested(id:, branch:, request:) -> requested(run, id, branch, request)
    AgentReturned(id:, output:, emits:, usage:) ->
      agent_returned(run, id, output, emits, usage)
    AgentFailed(id:, error:, usage:) -> agent_failed(run, id, error, usage)
    ScriptReturned(id:, output:, minutes:) ->
      script_settled(run, id, Answered(output), minutes)
    ScriptFailed(id:, error:, minutes:) ->
      script_settled(run, id, Errored(error), minutes)
    BodyFinished(output:) -> finish(run, Done(output))
    BodyFailed(error:) -> finish(run, Failed(error))
    Started(..) | Resumed(..) -> #(run, [])
  }
}

fn finish(run: Run, outcome: Outcome) -> #(Run, List(Effect)) {
  #(Run(..run, status: Finished(outcome)), [Checkpoint, Finish(outcome)])
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
      let #(run, effects) = live(run, id, d, branch, request)
      #(run, [Checkpoint, ..effects])
    }
  }
}

fn replay(
  run: Run,
  id: String,
  d: String,
  record: Record,
) -> #(Run, List(Effect)) {
  case record.digest == d, record.progress {
    False, _ -> {
      let reason =
        "path divergence at request "
        <> id
        <> ": recorded digest "
        <> record.digest
        <> ", replay digest "
        <> d
      #(Run(..run, status: Halted(reason)), [Refuse(None, reason)])
    }
    True, Completed ->
      case dict.get(run.journal, d) {
        Ok(entry) -> #(run, [answer(id, entry)])
        Error(Nil) -> #(run, [Refuse(None, "journal has no entry for " <> id)])
      }
    True, AwaitingAgent(call:) -> #(run, [call])
    True, AwaitingScript(run: effect) -> #(run, [effect])
    True, AwaitingMerges(pending:, ..) -> #(
      run,
      list.map(pending, fn(p) { p.call }),
    )
  }
}

fn answer(id: String, entry: Entry) -> Effect {
  case entry {
    Answered(v) -> Deliver(id, v)
    Errored(e) -> Fail(id, e)
    Refused(r) -> Refuse(Some(id), r)
  }
}

fn live(
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
          settle(run, id, d, branch, Refused("unknown agent " <> name))
        Ok(agent) ->
          case call_effect(run, id, agent, input, d) {
            Error(reason) -> settle(run, id, d, branch, Refused(reason))
            Ok(call) -> #(
              record(run, id, Record(d, branch, AwaitingAgent(call))),
              [call],
            )
          }
      }
    Script(script:, args:) -> {
      let remaining =
        option.map(run.workflow.budget.compute_minutes, fn(limit) {
          limit -. run.spent.compute_minutes
        })
      case list.contains(run.workflow.scripts, script), remaining {
        False, _ ->
          settle(run, id, d, branch, Refused("unknown script " <> script))
        True, Some(r) if r <=. 0.0 ->
          settle(
            run,
            id,
            d,
            branch,
            Refused("budget exhausted: compute minutes"),
          )
        True, _ -> {
          let effect = RunScript(id, script, args, remaining, d)
          #(record(run, id, Record(d, branch, AwaitingScript(effect))), [effect])
        }
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
      settle(run, id, d, branch, Answered(result))
    }
    Commit(writes:) -> {
      let run = record(run, id, Record(d, branch, Completed))
      complete(run, id, JNull, writes)
    }
  }
}

/// Builds a `CallAgent` against the current state, which is the call's
/// snapshot: later writes do not reach it.
fn call_effect(
  run: Run,
  id: String,
  agent: Agent,
  input: Value,
  d: String,
) -> Result(Effect, String) {
  use max_turns <- result.try(budget_check(run, agent))
  use model <- result.try(resolve_model(run.pin, agent.model))
  let rendered = view.render(agent.view, run.workflow.fields, run.state)
  Ok(CallAgent(
    id:,
    agent: agent.name,
    model:,
    view: rendered.text,
    omitted: rendered.omitted,
    input:,
    max_turns:,
    digest: d,
  ))
}

/// Checked before every `CallAgent`. Returns the turn cap for the call.
fn budget_check(run: Run, agent: Agent) -> Result(Int, String) {
  let b = run.workflow.budget
  let s = run.spent
  use _ <- result.try(case b.usd {
    Some(limit) if s.usd >=. limit ->
      Error(
        "budget exhausted: usd "
        <> float.to_string(s.usd)
        <> " of "
        <> float.to_string(limit),
      )
    _ -> Ok(Nil)
  })
  use _ <- result.try(case b.tokens {
    Some(limit) if s.tokens >= limit ->
      Error(
        "budget exhausted: tokens "
        <> int.to_string(s.tokens)
        <> " of "
        <> int.to_string(limit),
      )
    _ -> Ok(Nil)
  })
  case b.turns {
    Some(limit) if s.turns >= limit ->
      Error(
        "budget exhausted: turns "
        <> int.to_string(s.turns)
        <> " of "
        <> int.to_string(limit),
      )
    Some(limit) -> Ok(int.min(agent.max_turns, limit - s.turns))
    None -> Ok(agent.max_turns)
  }
}

fn record(run: Run, id: String, rec: Record) -> Run {
  Run(..run, requests: dict.insert(run.requests, id, rec))
}

/// Completes a request with a journal entry and answers it.
fn settle(
  run: Run,
  id: String,
  d: String,
  branch: Option(String),
  entry: Entry,
) -> #(Run, List(Effect)) {
  let run =
    Run(
      ..record(run, id, Record(d, branch, Completed)),
      journal: dict.insert(run.journal, d, entry),
    )
  #(run, [answer(id, entry)])
}

fn settle_recorded(run: Run, id: String, entry: Entry) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(rec) -> settle(run, id, rec.digest, rec.branch, entry)
    Error(Nil) -> #(run, [Refuse(None, "unknown request " <> id)])
  }
}

// --- Returns -------------------------------------------------------------------

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

fn agent_returned(
  run: Run,
  id: String,
  output: Value,
  emits: List(Write),
  usage: Usage,
) -> #(Run, List(Effect)) {
  case dict.get(run.merges, id), dict.get(run.requests, id) {
    Ok(ref), _ -> {
      let #(run, effects) =
        merge_settled(spend(run, usage), id, ref, parse_merge(run, ref, output))
      #(run, [Checkpoint, ..effects])
    }
    _, Ok(Record(progress: AwaitingAgent(call: CallAgent(agent: name, ..)), ..))
    -> {
      let run = spend(run, usage)
      let #(run, effects) = case find_agent(run.workflow, name) {
        Error(Nil) ->
          settle_recorded(run, id, Refused("unknown agent " <> name))
        Ok(agent) ->
          case agent_writes(agent, output, emits) {
            Error(reason) -> settle_recorded(run, id, Refused(reason))
            Ok(writes) -> complete(run, id, output, writes)
          }
      }
      #(run, [Checkpoint, ..effects])
    }
    // A return for a request that is not in flight (stale or duplicate).
    _, _ -> #(run, [])
  }
}

fn agent_failed(
  run: Run,
  id: String,
  error: String,
  usage: Usage,
) -> #(Run, List(Effect)) {
  case dict.get(run.merges, id), dict.get(run.requests, id) {
    Ok(ref), _ -> {
      let #(run, effects) =
        merge_settled(spend(run, usage), id, ref, UseFallback)
      #(run, [Checkpoint, ..effects])
    }
    _, Ok(Record(progress: AwaitingAgent(..), ..)) -> {
      let #(run, effects) =
        settle_recorded(spend(run, usage), id, Errored(error))
      #(run, [Checkpoint, ..effects])
    }
    _, _ -> #(run, [])
  }
}

fn script_settled(
  run: Run,
  id: String,
  entry: Entry,
  minutes: Float,
) -> #(Run, List(Effect)) {
  case dict.get(run.requests, id) {
    Ok(Record(progress: AwaitingScript(..), ..)) -> {
      let run =
        Run(
          ..run,
          spent: Spent(
            ..run.spent,
            compute_minutes: run.spent.compute_minutes +. minutes,
          ),
        )
      let #(run, effects) = settle_recorded(run, id, entry)
      #(run, [Checkpoint, ..effects])
    }
    _ -> #(run, [])
  }
}

/// Writes come from the agent's declared output mappings plus its `emit`
/// calls, which must target a declared field.
fn agent_writes(
  agent: Agent,
  output: Value,
  emits: List(Write),
) -> Result(List(Write), String) {
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
        False ->
          Error("agent " <> agent.name <> " may not write field " <> e.field)
      }
    }),
  )
  Ok(list.append(mapped, emits))
}

// --- Writes and reducers -------------------------------------------------------

/// Applies a finished call's buffered writes atomically, or starts the
/// llmMerge calls they need first.
fn complete(
  run: Run,
  id: String,
  output: Value,
  writes: List(Write),
) -> #(Run, List(Effect)) {
  let branch = case dict.get(run.requests, id) {
    Ok(rec) -> rec.branch
    Error(Nil) -> None
  }
  case check_writes(run, branch, writes) {
    Error(reason) -> settle_recorded(run, id, Refused(reason))
    Ok(Nil) -> {
      let #(run, pending) = start_merges(run, id, writes)
      case pending {
        [] -> apply_and_answer(run, id, output, writes, [])
        _ -> {
          let rec = case dict.get(run.requests, id) {
            Ok(rec) -> rec
            Error(Nil) -> Record("", branch, Completed)
          }
          let run =
            record(
              run,
              id,
              Record(
                ..rec,
                progress: AwaitingMerges(output, writes, pending, []),
              ),
            )
          #(run, list.map(pending, fn(p) { p.call }))
        }
      }
    }
  }
}

fn check_writes(
  run: Run,
  branch: Option(String),
  writes: List(Write),
) -> Result(Nil, String) {
  list.try_each(writes, fn(w) {
    case find_field(run.workflow, w.field), branch {
      Error(Nil), _ -> Error("write to unknown field " <> w.field)
      Ok(f), Some(b) ->
        case reducer.commutativity(f.reducer) {
          NonCommutative ->
            Error(
              "parallel branch "
              <> b
              <> " writes field "
              <> w.field
              <> " whose reducer is not commutative",
            )
          reducer.Commutative -> Ok(Nil)
        }
      Ok(_), None -> Ok(Nil)
    }
  })
}

/// One merge call per llmMerge field written, while under its call cap and
/// the budget; otherwise that field uses the deterministic fallback.
fn start_merges(
  run: Run,
  id: String,
  writes: List(Write),
) -> #(Run, List(PendingMerge)) {
  writes
  |> list.map(fn(w) { w.field })
  |> list.unique
  |> list.fold(#(run, []), fn(acc, field) {
    let #(run, pending) = acc
    case find_field(run.workflow, field) {
      Ok(types.Field(reducer: LlmMerge(agent:, max:, max_calls:, ..), ..)) -> {
        let used = dict.get(run.merge_calls, field) |> result.unwrap(0)
        let incoming =
          writes
          |> list.filter(fn(w) { w.field == field })
          |> list.flat_map(fn(w) { as_items(w.value) })
        let current = dict.get(run.state, field) |> result.unwrap(JArray([]))
        let call_id = id <> "/merge/" <> field
        let input =
          value.object([
            #("current", current),
            #("incoming", JArray(incoming)),
            #("max", JInt(max)),
          ])
        let effect = case used < max_calls, find_agent(run.workflow, agent) {
          True, Ok(a) ->
            call_effect(
              run,
              call_id,
              a,
              input,
              digest.hex(call_id <> "\n" <> value.canonical(input)),
            )
            |> option.from_result
          _, _ -> None
        }
        case effect {
          None -> #(run, pending)
          Some(call) -> #(
            Run(
              ..run,
              merges: dict.insert(run.merges, call_id, MergeRef(id, field)),
              merge_calls: dict.insert(run.merge_calls, field, used + 1),
            ),
            list.append(pending, [PendingMerge(field, call)]),
          )
        }
      }
      _ -> #(run, pending)
    }
  })
}

fn as_items(v: Value) -> List(Value) {
  case v {
    JArray(items) -> items
    _ -> [v]
  }
}

/// A merge agent returns `{ items: [...], archived: [...] }`. Items past the
/// field's `max` are archived too. Anything else falls back.
fn parse_merge(run: Run, ref: MergeRef, output: Value) -> MergeOutcome {
  let max = case find_field(run.workflow, ref.field) {
    Ok(types.Field(reducer: LlmMerge(max:, ..), ..)) -> max
    _ -> 0
  }
  case value.get(output, "items"), value.get(output, "archived") {
    Some(JArray(items)), archived -> {
      let archived = case archived {
        Some(JArray(a)) -> a
        _ -> []
      }
      Merged(
        list.take(items, max),
        list.append(archived, list.drop(items, max)),
      )
    }
    _, _ -> UseFallback
  }
}

fn merge_settled(
  run: Run,
  call_id: String,
  ref: MergeRef,
  outcome: MergeOutcome,
) -> #(Run, List(Effect)) {
  let run = Run(..run, merges: dict.delete(run.merges, call_id))
  case dict.get(run.requests, ref.parent) {
    Ok(
      Record(progress: AwaitingMerges(output:, writes:, pending:, settled:), ..) as rec,
    ) -> {
      let pending = list.filter(pending, fn(p) { p.field != ref.field })
      let settled = list.append(settled, [#(ref.field, outcome)])
      case pending {
        [] -> apply_and_answer(run, ref.parent, output, writes, settled)
        _ -> #(
          record(
            run,
            ref.parent,
            Record(
              ..rec,
              progress: AwaitingMerges(output, writes, pending, settled),
            ),
          ),
          [],
        )
      }
    }
    _ -> #(run, [])
  }
}

fn apply_and_answer(
  run: Run,
  id: String,
  output: Value,
  writes: List(Write),
  merged: List(#(String, MergeOutcome)),
) -> #(Run, List(Effect)) {
  case apply_writes(run.workflow, run.state, writes, merged) {
    Error(reason) -> settle_recorded(run, id, Refused(reason))
    Ok(state) -> settle_recorded(Run(..run, state:), id, Answered(output))
  }
}

fn apply_writes(
  workflow: Workflow,
  state: Dict(String, Value),
  writes: List(Write),
  merged: List(#(String, MergeOutcome)),
) -> Result(Dict(String, Value), String) {
  writes
  |> list.try_fold(#(state, []), fn(acc, w) {
    let #(state, done) = acc
    use f <- result.try(
      find_field(workflow, w.field)
      |> result.replace_error("write to unknown field " <> w.field),
    )
    let current = dict.get(state, w.field) |> result.unwrap(f.initial)
    case f.reducer {
      LlmMerge(max:, archive:, ..) ->
        case list.contains(done, w.field) {
          True -> Ok(acc)
          False -> {
            let incoming =
              writes
              |> list.filter(fn(x) { x.field == w.field })
              |> list.flat_map(fn(x) { as_items(x.value) })
            use #(kept, archived) <- result.try(
              case list.key_find(merged, w.field) {
                Ok(Merged(items:, archived:)) -> Ok(#(JArray(items), archived))
                _ -> reducer.merge_fallback(max, current, JArray(incoming))
              },
            )
            let state = dict.insert(state, w.field, kept)
            use state <- result.try(archive_items(
              workflow,
              state,
              archive,
              archived,
            ))
            Ok(#(state, [w.field, ..done]))
          }
        }
      r -> {
        use next <- result.try(
          reducer.apply(r, current, w.value)
          |> result.map_error(fn(e) { w.field <> ": " <> e }),
        )
        Ok(#(dict.insert(state, w.field, next), done))
      }
    }
  })
  |> result.map(fn(acc) { acc.0 })
}

fn archive_items(
  workflow: Workflow,
  state: Dict(String, Value),
  archive: Option(String),
  items: List(Value),
) -> Result(Dict(String, Value), String) {
  case archive {
    None -> Ok(state)
    Some(name) -> {
      use f <- result.try(
        find_field(workflow, name)
        |> result.replace_error("unknown archive field " <> name),
      )
      list.try_fold(items, state, fn(state, item) {
        let current = dict.get(state, name) |> result.unwrap(f.initial)
        reducer.apply(f.reducer, current, item)
        |> result.map(dict.insert(state, name, _))
      })
    }
  }
}

fn find_agent(workflow: Workflow, name: String) -> Result(Agent, Nil) {
  list.find(workflow.agents, fn(a) { a.name == name })
}

fn find_field(workflow: Workflow, name: String) -> Result(Field, Nil) {
  list.find(workflow.fields, fn(f) { f.name == name })
}

// --- Snapshot ------------------------------------------------------------------

/// Status, state, spend and in-flight requests, as canonical JSON.
pub fn snapshot(run: RunState) -> Value {
  case run {
    Idle ->
      value.object([#("status", value.object([#("type", JString("idle"))]))])
    Active(r) ->
      value.object([
        #("status", status_value(r.status)),
        #("state", value.object(dict.to_list(r.state))),
        #(
          "spent",
          value.object([
            #("usd", value.JFloat(r.spent.usd)),
            #("tokens", JInt(r.spent.tokens)),
            #("turns", JInt(r.spent.turns)),
            #("compute_minutes", value.JFloat(r.spent.compute_minutes)),
          ]),
        ),
        #(
          "in_flight",
          r.requests
            |> dict.to_list
            |> list.filter(fn(e) { { e.1 }.progress != Completed })
            |> list.map(fn(e) { JString(e.0) })
            |> list.sort(value.compare)
            |> JArray,
        ),
        #(
          "merge_calls",
          r.merge_calls
            |> dict.to_list
            |> list.map(fn(e) { #(e.0, JInt(e.1)) })
            |> value.object,
        ),
      ])
  }
}

fn status_value(status: Status) -> Value {
  case status {
    Running -> value.object([#("type", JString("running"))])
    Finished(outcome) ->
      value.object([
        #("type", JString("finished")),
        #("outcome", case outcome {
          Done(v) -> value.object([#("done", v)])
          Failed(e) -> value.object([#("failed", JString(e))])
        }),
      ])
    Halted(reason) ->
      value.object([#("type", JString("halted")), #("reason", JString(reason))])
  }
}
