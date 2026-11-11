//// The pure core of wallis v2, compiled to JavaScript.
////
//// The core owns the run's journal: which calls completed, their attempts,
//// the session values agent calls answer with, and every mailbox's
//// delivery order. It performs no I/O. The host feeds it events and
//// executes the effects it returns. See docs/v2.md at the repository root.
////
//// The host holds `RunState` as an opaque handle; events, effects and state
//// snapshots cross the boundary as JSON text.

import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import wallis_core/run.{type RunState}

import wallis_core/ids
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

/// JSON of the run: workflow, status, mailboxes and every call.
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

/// A mailbox's messages in their journaled order, as a JSON array.
pub fn mailbox_json(state: RunState, address: String) -> String {
  run.mailbox(state, address)
  |> json.array(types.envelope_to_json)
  |> json.to_string
}

/// How many attempts the call at this request id has had (0: none).
pub fn attempt_count(state: RunState, id: String) -> Int {
  run.attempt_count(state, id)
}

/// The core's semantics version, recorded with every run.
pub fn semantics() -> String {
  run.semantics
}

/// The journal key of a call, as the core computes it (see `run.requested`):
/// a running agent's mailbox address and a call's id derive from it.
/// `within` is "" for none. Returns "" when the input is not JSON.
pub fn slot_text(
  node: String,
  kind: String,
  input: String,
  scope: String,
  within: String,
  occurrence: Int,
) -> String {
  case value.parse(input) {
    Error(_) -> ""
    Ok(v) -> {
      let within = case within {
        "" -> None
        w -> Some(ids.session_id(w))
      }
      ids.slot_text(ids.slot(
        ids.digest(node),
        kind,
        v,
        scope,
        within,
        int.to_string(occurrence),
      ))
    }
  }
}

pub fn slot_of(state: RunState, id: String) -> String {
  run.slot_of(state, id)
}

pub fn sent_id(state: RunState, key: String) -> String {
  run.sent_id(state, key)
}
