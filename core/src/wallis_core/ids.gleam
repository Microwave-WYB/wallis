//// The ids the core keeps apart by type. On the wire (events and effects)
//// they are strings; the core turns them into these opaque types where an
//// event is applied, and back where an effect is made, so a slot is never
//// used as a request id, nor a digest as either.
////
//// A request id and a session id come from the host (the body's branch
//// path and counter); a digest names content (a node's definition, a blob).
//// A slot has no constructor from a string: it is made only by hashing a
//// call (`slot`).

import gleam/int
import gleam/option.{type Option}
import gleam/order.{type Order}
import gleam/string
import wallis_core/digest as sha
import wallis_core/value.{type Value}

/// Names a request of the body: for display and interventions only.
pub opaque type RequestId {
  RequestId(String)
}

pub fn request_id(text: String) -> RequestId {
  RequestId(text)
}

pub fn request_text(id: RequestId) -> String {
  let RequestId(text) = id
  text
}

/// Request ids in display order (by their text).
pub fn compare_requests(a: RequestId, b: RequestId) -> Order {
  string.compare(request_text(a), request_text(b))
}

/// Names a session value of the body.
pub opaque type SessionId {
  SessionId(String)
}

pub fn session_id(text: String) -> SessionId {
  SessionId(text)
}

pub fn session_text(id: SessionId) -> String {
  let SessionId(text) = id
  text
}

/// Names content: a node's definition, or a blob in the run's store.
pub opaque type Digest {
  Digest(String)
}

pub fn digest(text: String) -> Digest {
  Digest(text)
}

pub fn digest_text(d: Digest) -> String {
  let Digest(text) = d
  text
}

/// A journal key.
pub opaque type Slot {
  Slot(String)
}

/// The journal slot of a call: the node's definition digest, the request's
/// kind, name and canonical input, the session it continues (`None` for a
/// new session, and for calls that are not session calls), and its
/// occurrence in its branch of the body.
pub fn slot(
  node: Digest,
  kind: String,
  name: String,
  input: Value,
  within: Option(SessionId),
  occurrence: String,
) -> Slot {
  let within = case within {
    option.Some(SessionId(text)) -> text
    option.None -> ""
  }
  Slot(
    sha.hex(string.join(
      [digest_text(node), kind, name, value.canonical(input), within],
      "\n",
    ))
    <> "#"
    <> occurrence,
  )
}

pub fn slot_text(slot: Slot) -> String {
  let Slot(text) = slot
  text
}

/// The session value after a call: a hash chain over the session it
/// continued, the call's slot and the attempt that answered, so a new
/// attempt (a restart) yields a new session and everything after it misses.
pub fn next_session(slot: Slot, attempt: Int) -> SessionId {
  let Slot(text) = slot
  SessionId("s" <> sha.hex(text <> "\n" <> int.to_string(attempt)))
}
