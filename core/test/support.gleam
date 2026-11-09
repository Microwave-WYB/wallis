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
/// about the cache keep one slot per request. Each is a new session's call.
pub fn call(id: String, agent: String, input: Value) -> Event {
  Requested(
    id:,
    request: Call(agent:, input:, session: None),
    node_digest: agent <> "@" <> id,
    occurrence: "0",
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
    request: Call(agent: "worker", input:, session: None),
    node_digest: node,
    occurrence: int.to_string(occurrence),
  )
}

/// A call of a session value (`None`: a new session), keyed like the host
/// keys it.
pub fn session_call(id: String, session: Option(String), input: Value) -> Event {
  Requested(
    id:,
    request: Call(agent: "worker", input:, session:),
    node_digest: "worker",
    occurrence: "0",
  )
}

/// The session value an agent call answered with, in these effects.
pub fn session_of(effects: List(Effect)) -> Option(String) {
  list.find_map(effects, fn(e) {
    case e {
      types.Deliver(value: value.JObject(entries), ..) ->
        case list.key_find(entries, "session") {
          Ok(value.JString(id)) -> Ok(id)
          _ -> Error(Nil)
        }
      _ -> Error(Nil)
    }
  })
  |> option.from_result
}

/// The effects with an agent call's answer as its output alone (the session
/// value it carries is a hash), so tests compare outputs.
pub fn outputs(effects: List(Effect)) -> List(Effect) {
  list.map(effects, fn(e) {
    case e {
      types.Deliver(id:, value: value.JObject(entries)) ->
        case list.key_find(entries, "output"), list.key_find(entries, "session") {
          Ok(output), Ok(_) -> types.Deliver(id, output)
          _, _ -> e
        }
      _ -> e
    }
  })
}

pub fn tool(id: String, input: Value) -> Event {
  Requested(
    id:,
    request: types.Tool(tool: "search", input:, replay: types.ReplaySafe),
    node_digest: "search",
    occurrence: "0",
  )
}

pub fn orchestrator(id: String, input: Value) -> Event {
  Requested(
    id:,
    request: types.Orchestrator(name: "pick", input:),
    node_digest: "pick",
    occurrence: "0",
  )
}

pub fn command(id: String, input: Value) -> Event {
  Requested(
    id:,
    request: types.Command(command: "train", input:),
    node_digest: "train@" <> id,
    occurrence: "0",
  )
}

pub fn returned(id: String, output: Value) -> Event {
  types.AgentReturned(
    id:,
    output:,
    usage: usage(),
    model: "fake/model",
    dialogue: None,
  )
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
    #(state, outputs(effects), log)
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
