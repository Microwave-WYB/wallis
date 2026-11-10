//// The pure core of wallis.
////
//// The core owns every decision about a run (journal, replay matching,
//// budget, pin, status, ownership and interventions) and performs no I/O. The host feeds it events and executes
//// the effects it returns. See docs/design.md at the repository root.
////
//// The host holds `RunState` as an opaque handle; events, effects and state
//// snapshots cross the boundary as JSON text.

import gleam/json
import gleam/list
import gleam/option.{None}
import gleam/string
import wallis_core/run.{type RunState}
import wallis_core/types.{type Effect, type Event, InvalidEvent, Refuse}
import wallis_core/value

pub fn init() -> RunState {
  run.new()
}

pub fn step(state: RunState, event: Event) -> #(RunState, List(Effect)) {
  run.step(state, event)
}

/// Steps one JSON event and returns the effects as a JSON array. An event
/// that does not decode leaves the state unchanged and yields a `refuse`.
pub fn step_json(state: RunState, event: String) -> #(RunState, String) {
  let #(state, effects) = case json.parse(event, types.event_decoder()) {
    Ok(event) -> run.step(state, event)
    Error(error) -> #(state, [
      Refuse(None, InvalidEvent(string.inspect(error))),
    ])
  }
  #(
    state,
    effects
      |> list.map(types.effect_to_json)
      |> json.preprocessed_array
      |> json.to_string,
  )
}

/// JSON of the run: status, nodes, observations, spend, budget and models.
pub fn snapshot_json(state: RunState) -> String {
  json.to_string(run.snapshot(state))
}

/// The whole state as text, for the differential check.
pub fn full_state(state: RunState) -> String {
  run.full_state(state)
}

/// JSON of the host facts the log noted.
pub fn facts_json(state: RunState) -> String {
  json.to_string(run.host_facts(state))
}

/// The core's semantics version, pinned with every run.
pub fn semantics() -> String {
  run.semantics
}

/// How many attempts (tried or forgotten) the call at this request id has
/// had: 0 for an id the run does not know. The host chains a write's count
/// into the write epoch of its tool source, so a read after a write that
/// re-executed misses.
pub fn attempt_count(state: RunState, id: String) -> Int {
  list.length(run.attempts(state, id))
}

/// The newest answer of a command or tool call's attempts, as JSON (`null`
/// when none answered): a re-execution's output is compared with it.
pub fn previous_answer_json(state: RunState, id: String) -> String {
  case run.previous_answer(state, id) {
    option.Some(v) -> json.to_string(value.to_json(v))
    option.None -> "null"
  }
}
