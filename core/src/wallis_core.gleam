//// The pure core of wallis.
////
//// The core owns every decision about a run (views, reducers, pin, budget,
//// journal hits) and performs no I/O. The host feeds it events and executes
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

/// JSON of the run: status, nodes, state, spend, budget and models.
pub fn snapshot_json(state: RunState) -> String {
  json.to_string(run.snapshot(state))
}

/// The core's semantics version, pinned with every run.
pub fn semantics() -> String {
  run.semantics
}
