//// Helpers for event-replay tests.

import gleam/dict
import gleam/list
import gleam/option.{type Option, None, Some}
import wallis_core/reducer
import wallis_core/run.{type RunState}
import wallis_core/types.{
  type Agent, type Effect, type Event, type Field, type Reducer, type ViewSpec,
  type Workflow, Agent, Budget, Call, Checkpoint, Commit, Field, Pin, Requested,
  Started, Usage, ViewSpec, Workflow, Write, WriteMap,
}
import wallis_core/value.{type Value, JNull}

pub fn field(name: String, r: Reducer) -> Field {
  Field(name, r, reducer.default_initial(r))
}

pub fn view(fields: List(String)) -> ViewSpec {
  ViewSpec(fields:, max_chars: 100_000, max_items: 100, chunk: 1, omit: [])
}

pub fn agent(
  name: String,
  view: ViewSpec,
  writes: List(#(String, Option(String))),
) -> Agent {
  Agent(
    name:,
    model: "default",
    view:,
    writes: list.map(writes, fn(w) { WriteMap(w.0, w.1) }),
    max_turns: 8,
  )
}

pub fn workflow(fields: List(Field), agents: List(Agent)) -> Workflow {
  Workflow(
    name: "test",
    fields:,
    agents:,
    scripts: ["train"],
    budget: Budget(usd: None, tokens: None, turns: None, compute_minutes: None),
  )
}

pub fn pin() -> types.Pin {
  Pin(
    workflow_digest: "wf1",
    models: dict.from_list([#("default", "fake/model")]),
    seed: 7,
    inputs: dict.from_list([#("advice.md", "a1")]),
  )
}

pub fn started(wf: Workflow) -> Event {
  Started(workflow: wf, pin: pin(), input: JNull)
}

pub fn call(id: String, agent: String, input: Value) -> Event {
  Requested(id:, branch: None, request: Call(agent:, input:))
}

pub fn branch_call(
  id: String,
  branch: String,
  agent: String,
  input: Value,
) -> Event {
  Requested(id:, branch: Some(branch), request: Call(agent:, input:))
}

pub fn commit(id: String, writes: List(#(String, Value))) -> Event {
  Requested(
    id:,
    branch: None,
    request: Commit(list.map(writes, fn(w) { Write(w.0, w.1) })),
  )
}

pub fn returned(id: String, output: Value) -> Event {
  types.AgentReturned(id:, output:, emits: [], usage: usage())
}

pub fn usage() -> types.Usage {
  Usage(usd: 0.5, tokens: 100, turns: 1)
}

/// Replays events from a fresh run; returns the final state, the effects of
/// the last event, and the events that were checkpointed (the log).
pub fn replay(events: List(Event)) -> #(RunState, List(Effect), List(Event)) {
  replay_from(run.new(), events)
}

pub fn replay_from(
  state: RunState,
  events: List(Event),
) -> #(RunState, List(Effect), List(Event)) {
  list.fold(events, #(state, [], []), fn(acc, event) {
    let #(state, _, log) = acc
    let #(state, effects) = run.step(state, event)
    let log = case list.contains(effects, Checkpoint) {
      True -> list.append(log, [event])
      False -> log
    }
    #(state, effects, log)
  })
}

/// Effects of the last event, without the checkpoint marker.
pub fn last(events: List(Event)) -> List(Effect) {
  let #(_, effects, _) = replay(events)
  list.filter(effects, fn(e) { e != Checkpoint })
}

pub fn state_of(events: List(Event), name: String) -> Value {
  let #(state, _, _) = replay(events)
  case run.snapshot(state) |> value.get("state." <> name) {
    Some(v) -> v
    None -> JNull
  }
}
