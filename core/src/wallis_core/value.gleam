//// JSON values as the core sees them. Objects keep their keys sorted, so
//// `canonical` is a stable rendering and equal values render equally.

import gleam/dict
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string

pub type Value {
  JNull
  JBool(Bool)
  JInt(Int)
  JFloat(Float)
  JString(String)
  JArray(List(Value))
  JObject(List(#(String, Value)))
}

/// Builds an object with sorted keys; later duplicates win.
pub fn object(entries: List(#(String, Value))) -> Value {
  entries
  |> dict.from_list
  |> dict.to_list
  |> list.sort(fn(a, b) { string.compare(a.0, b.0) })
  |> JObject
}

// Hand-written: the LSP decoder action cannot generate a decoder for a
// recursive, untagged JSON tree.
pub fn decoder() -> decode.Decoder(Value) {
  use <- decode.recursive
  decode.one_of(
    decode.optional(decode.int)
      |> decode.map(fn(i) {
        case i {
          None -> JNull
          Some(i) -> JInt(i)
        }
      }),
    [
      decode.map(decode.float, JFloat),
      decode.map(decode.string, JString),
      decode.map(decode.bool, JBool),
      decode.map(decode.list(decoder()), JArray),
      decode.map(decode.dict(decode.string, decoder()), fn(d) {
        object(dict.to_list(d))
      }),
    ],
  )
}

pub fn to_json(value: Value) -> json.Json {
  case value {
    JNull -> json.null()
    JBool(b) -> json.bool(b)
    JInt(i) -> json.int(i)
    JFloat(f) -> json.float(f)
    JString(s) -> json.string(s)
    JArray(items) -> json.array(items, to_json)
    JObject(entries) ->
      json.object(list.map(entries, fn(e) { #(e.0, to_json(e.1)) }))
  }
}

/// Canonical text: sorted keys, no whitespace.
pub fn canonical(value: Value) -> String {
  json.to_string(to_json(value))
}

pub fn parse(text: String) -> Result(Value, json.DecodeError) {
  json.parse(text, decoder())
}

/// Looks up a dotted path such as `_stats.best_score`. The empty path is
/// the value itself.
pub fn get(value: Value, path: String) -> Option(Value) {
  case path {
    "" -> Some(value)
    _ -> get_segments(value, string.split(path, "."))
  }
}

fn get_segments(value: Value, segments: List(String)) -> Option(Value) {
  case segments, value {
    [], _ -> Some(value)
    [key, ..rest], JObject(entries) ->
      case list.key_find(entries, key) {
        Ok(inner) -> get_segments(inner, rest)
        Error(Nil) -> None
      }
    _, _ -> None
  }
}
