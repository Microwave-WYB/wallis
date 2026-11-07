//// Capabilities: proofs that a check passed. Each type is opaque and its
//// only constructor is its check, so an operation that takes one cannot be
//// reached without the check. The node checks take an `OwnedRun`, so the
//// ownership check cannot be skipped either.
////
//// The host makes the same checks before it sends an event (in TS, with the
//// same names); the core makes them again when it applies the event,
//// because time passes in between.

import gleam/dict
import gleam/int
import gleam/list
import gleam/option.{type Option, Some}
import gleam/result
import gleam/string
import wallis_core/types.{
  type Pin, type Refusal, NodeNotRunning, NotAnAgent, NotIdle, NotLive, NotOwner,
  NotSteerable, PinMismatch,
}

/// The identity that controls every run.
pub const human = "human"

pub opaque type OwnedRun {
  OwnedRun(by: String)
}

/// The human controls every run; anyone else only the runs it owns.
pub fn check_owner(
  owner: Option(String),
  by: String,
) -> Result(OwnedRun, Refusal) {
  case by == human || owner == Some(by) {
    True -> Ok(OwnedRun(by))
    False -> Error(NotOwner(by, owner))
  }
}

/// What the run knows about a node when a check is made.
pub type NodeFacts {
  /// In flight with the executor.
  Working(steerable: Bool)
  /// Ended its turn with a question.
  Waiting(steerable: Bool)
  /// The executor could not serve it; reissued after a fix.
  Faulted(steerable: Bool)
  /// Held back by a pause or the budget before it was issued.
  Held(steerable: Bool)
  /// A command in flight: no dialogue.
  CommandWorking
  Settled
  Absent
}

pub opaque type IdleNode {
  IdleNode(node: String)
}

/// An answer goes only to a steerable node that waits for one.
pub fn check_idle(
  _owned: OwnedRun,
  node: String,
  facts: NodeFacts,
) -> Result(IdleNode, Refusal) {
  case facts {
    Waiting(steerable: True) -> Ok(IdleNode(node))
    Waiting(steerable: False) -> Error(NotSteerable(node))
    CommandWorking -> Error(NotAnAgent(node))
    _ -> Error(NotIdle(node))
  }
}

pub fn idle_id(node: IdleNode) -> String {
  node.node
}

pub opaque type SteerableNode {
  SteerableNode(node: String)
}

/// Steer and interrupt reach only a running node of a steerable agent.
pub fn check_steerable(
  _owned: OwnedRun,
  node: String,
  facts: NodeFacts,
) -> Result(SteerableNode, Refusal) {
  case facts {
    Working(steerable: True) -> Ok(SteerableNode(node))
    Working(steerable: False) -> Error(NotSteerable(node))
    CommandWorking -> Error(NotAnAgent(node))
    _ -> Error(NodeNotRunning(node))
  }
}

pub fn steerable_id(node: SteerableNode) -> String {
  node.node
}

/// What a live node is: an agent (steerable or not) or a command.
pub type LiveKind {
  LiveAgent(steerable: Bool)
  LiveCommand
}

pub opaque type LiveNode {
  LiveNode(node: String, kind: LiveKind)
}

/// Cancel and restart reach any node that is not done.
pub fn check_live(
  _owned: OwnedRun,
  node: String,
  facts: NodeFacts,
) -> Result(LiveNode, Refusal) {
  case facts {
    Working(steerable:)
    | Waiting(steerable:)
    | Faulted(steerable:)
    | Held(steerable:) -> Ok(LiveNode(node, LiveAgent(steerable)))
    CommandWorking -> Ok(LiveNode(node, LiveCommand))
    Settled | Absent -> Error(NotLive(node))
  }
}

pub fn live_id(node: LiveNode) -> String {
  node.node
}

pub fn live_kind(node: LiveNode) -> LiveKind {
  node.kind
}

pub opaque type ResumableRun {
  ResumableRun
}

/// Only result-defining fields are compared, in this order: seed,
/// semantics, then each pinned input (files and mounts). The alias table is
/// operational, and a code change is allowed and logged (`CodeChanged`).
pub fn check_pin(recorded: Pin, now: Pin) -> Result(ResumableRun, Refusal) {
  let differs = fn(field, a, b) {
    case a == b {
      True -> Ok(Nil)
      False -> Error(PinMismatch(field:, recorded: a, current: b))
    }
  }
  use _ <- result.try(differs(
    "seed",
    int.to_string(recorded.seed),
    int.to_string(now.seed),
  ))
  use _ <- result.try(differs("semantics", recorded.semantics, now.semantics))
  use _ <- result.try(
    list.append(dict.keys(recorded.inputs), dict.keys(now.inputs))
    |> list.unique
    |> list.sort(string.compare)
    |> list.try_each(fn(k) {
      differs(
        "inputs." <> k,
        dict.get(recorded.inputs, k) |> result.unwrap("<absent>"),
        dict.get(now.inputs, k) |> result.unwrap("<absent>"),
      )
    }),
  )
  Ok(ResumableRun)
}
