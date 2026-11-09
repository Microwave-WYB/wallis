//// Helpers for event-replay tests.

import gleam/dict
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import wallis_core/run.{type RunState}
import wallis_core/types.{
  type Agent, type Effect, type Event, type Workflow, Agent, Budget, Call,
  Checkpoint, Pin, Requested, Started, Usage, Workflow,
}
import wallis_core/value.{type Value, JArray, JNull}

/// Interventions in tests come from the human, who controls every run.
pub const human = "human"

pub fn agent(name: String) -> Agent {
  Agent(name:, model: "default", max_turns: 8, steerable: True)
}

pub fn workflow(agents: List(Agent)) -> Workflow {
  Workflow(
    name: "test",
    agents:,
    commands: ["train"],
    orchestrators: ["pick"],
    budget: Budget(turns: None, compute_minutes: None),
  )
}

/// A steerable `worker` and a non-steerable `judge`.
pub fn basic() -> Workflow {
  workflow([agent("worker"), Agent(..agent("judge"), steerable: False)])
}

pub fn pin() -> types.Pin {
  Pin(
    workflow_digest: "wf1",
    prior_digests: [],
    models: dict.from_list([#("default", "fake/model")]),
    seed: 7,
    inputs: dict.from_list([#("advice.md", "a1")]),
    semantics: run.semantics,
  )
}

pub fn started(wf: Workflow) -> Event {
  Started(workflow: wf, pin: pin(), input: JNull)
}

/// A call whose journal slot is unique to its id, so tests that are not
/// about the cache keep one slot per request. Each is a one-call session.
pub fn call(id: String, agent: String, input: Value) -> Event {
  Requested(
    id:,
    request: Call(agent:, input:, session: id, index: 0),
    node_digest: agent <> "@" <> id,
    occurrence: 0,
  )
}

/// A call keyed as the host keys it: by node digest, input and occurrence.
pub fn cached(
  id: String,
  node: String,
  input: Value,
  occurrence: Int,
) -> Event {
  Requested(
    id:,
    request: Call(agent: "worker", input:, session: id, index: 0),
    node_digest: node,
    occurrence:,
  )
}

/// Call `index` of session `session`, keyed like the host keys it.
pub fn session_call(session: String, index: Int, input: Value) -> Event {
  Requested(
    id: session <> ":" <> int.to_string(index),
    request: Call(agent: "worker", input:, session:, index:),
    node_digest: "worker",
    occurrence: 0,
  )
}

pub fn tool(id: String, input: Value) -> Event {
  Requested(
    id:,
    request: types.Tool(tool: "search", input:, replay: types.ReplaySafe),
    node_digest: "search",
    occurrence: 0,
  )
}

pub fn orchestrator(id: String, input: Value) -> Event {
  Requested(
    id:,
    request: types.Orchestrator(name: "pick", input:),
    node_digest: "pick",
    occurrence: 0,
  )
}

pub fn command(id: String, input: Value) -> Event {
  Requested(
    id:,
    request: types.Command(command: "train", input:),
    node_digest: "train@" <> id,
    occurrence: 0,
  )
}

pub fn returned(id: String, output: Value) -> Event {
  types.AgentReturned(id:, output:, usage: usage(), model: "fake/model")
}

pub fn idle(id: String, message: String) -> Event {
  types.AgentIdle(id, message, usage(), "fake/model")
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

/// The state a log folds to.
pub fn refold(log: List(Event)) -> RunState {
  let #(state, _, _) = replay(log)
  state
}

/// Effects of the last event, without the checkpoint marker.
pub fn last(events: List(Event)) -> List(Effect) {
  let #(_, effects, _) = replay(events)
  list.filter(effects, fn(e) { e != Checkpoint })
}

/// A dotted path into the run's JSON snapshot.
pub fn snapshot_get(state: RunState, path: String) -> Value {
  let assert Ok(snap) = value.parse(json.to_string(run.snapshot(state)))
  case value.get(snap, path) {
    Some(v) -> v
    None -> JNull
  }
}

pub fn status_after(events: List(Event)) -> Option(types.RunStatus) {
  let #(state, _, _) = replay(events)
  run.status(state)
}

pub fn nodes_after(events: List(Event)) -> List(types.Node) {
  let #(state, _, _) = replay(events)
  run.nodes(state)
}

/// The i-th node of the run's snapshot.
pub fn node(state: RunState, i: Int) -> Value {
  case snapshot_get(state, "nodes") {
    JArray(nodes) ->
      case list.drop(nodes, i) {
        [n, ..] -> n
        [] -> JNull
      }
    _ -> JNull
  }
}
