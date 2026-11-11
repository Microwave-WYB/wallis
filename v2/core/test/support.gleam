//// Helpers for event-replay tests. Every replay also checks that the state
//// rebuilt from the logged events alone equals the live state (the
//// differential check).

import gleam/list
import gleam/option.{type Option, None, Some}
import wallis_core/run.{type RunState}
import wallis_core/types.{type Effect, type Event}
import wallis_core/value.{type Value, JNull}

pub fn started() -> Event {
  types.Started(types.Workflow("test", "wf1"), JNull, run.semantics)
}

pub fn resumed() -> Event {
  types.Resumed("wf1", run.semantics)
}

pub fn command(id: String, node: String, input: Value, occurrence: Int) -> Event {
  types.Requested(
    id:,
    request: types.CommandCall(name: node, input:),
    node: node,
    scope: "",
    occurrence:,
  )
}

pub fn command_in(id: String, node: String, input: Value, scope: String) -> Event {
  types.Requested(
    id:,
    request: types.CommandCall(name: node, input:),
    node: node,
    scope:,
    occurrence: 0,
  )
}

pub fn nested(id: String, node: String, input: Value) -> Event {
  types.Requested(
    id:,
    request: types.WorkflowCall(name: node, input:),
    node: node,
    scope: "",
    occurrence: 0,
  )
}

/// A call of agent `node`'s session value (`None`: a new session).
pub fn agent(id: String, node: String, session: Option(String), input: Value) -> Event {
  types.Requested(
    id:,
    request: types.AgentCall(name: node, input:, session:, from: []),
    node: node,
    scope: "",
    occurrence: 0,
  )
}

pub fn returned(id: String, output: Value) -> Event {
  types.CommandReturned(id, output)
}

pub fn agent_returned(id: String, output: Value, dialogue: String) -> Event {
  types.AgentReturned(id, output, "faux/m", dialogue, [])
}

/// Steps every event; returns the final state, the last event's effects and
/// the events that were logged (those whose effects include a checkpoint).
/// Fails when the state refolded from the log differs from the live one.
/// A replayed run: its state and every event it logged so far.
pub type Played {
  Played(state: RunState, logged: List(Event))
}

pub fn replay(events: List(Event)) -> #(Played, List(Effect), List(Event)) {
  replay_from(Played(run.new(), []), events)
}

/// Continues a replay; the log returned is what these events logged.
pub fn replay_from(
  played: Played,
  events: List(Event),
) -> #(Played, List(Effect), List(Event)) {
  let #(state, last, log) =
    list.fold(events, #(played.state, [], []), fn(acc, event) {
      let #(s, _, log) = acc
      let #(s, effects) = run.step(s, event)
      let log = case list.contains(effects, types.Checkpoint) {
        True -> [event, ..log]
        False -> log
      }
      #(s, effects, log)
    })
  let log = list.reverse(log)
  let all = list.append(played.logged, log)
  assert run.full_state(refold(all)) == run.full_state(state)
  #(Played(state, all), last, log)
}

pub fn refold(events: List(Event)) -> RunState {
  list.fold(events, run.new(), fn(s, e) { run.step(s, e).0 })
}

pub fn last(events: List(Event)) -> List(Effect) {
  replay(events).1
}

pub fn log(events: List(Event)) -> List(Event) {
  replay(events).2
}

/// The session value an agent call answered (or failed) with, in these effects.
pub fn session_of(effects: List(Effect)) -> Option(String) {
  list.find_map(effects, fn(e) {
    case e {
      types.Deliver(value: value.JObject(entries), ..) ->
        case list.key_find(entries, "session") {
          Ok(value.JString(id)) -> Ok(id)
          _ -> Error(Nil)
        }
      types.Fail(reason: types.AgentError(session: Some(s), ..), ..) -> Ok(s)
      _ -> Error(Nil)
    }
  })
  |> option.from_result
}

pub fn none() -> Option(String) {
  None
}
