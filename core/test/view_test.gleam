import gleam/dict
import gleam/int
import gleam/list
import gleam/string
import support.{field}
import wallis_core/types.{Append, Freeze, Replace, Sum, ViewSpec}
import wallis_core/value.{JArray, JFloat, JInt, JObject, JString}
import wallis_core/view

fn seq(from: Int, to: Int) -> List(Int) {
  case from > to {
    True -> []
    False -> [from, ..seq(from + 1, to)]
  }
}

fn items(n: Int) -> value.Value {
  JArray(list.map(seq(1, n), fn(i) { value.object([#("i", JInt(i))]) }))
}

fn spec(fields, max_chars, max_items, chunk, omit) {
  ViewSpec(fields:, max_chars:, max_items:, chunk:, omit:)
}

pub fn selects_only_named_fields_test() {
  let fields = [field("a", Replace), field("b", Replace)]
  let state = dict.from_list([#("a", JInt(1)), #("b", JInt(2))])
  let r = view.render(spec(["b"], 1000, 10, 1, []), fields, state)
  assert r.text == "<field name=\"b\">\n2\n</field>"
}

pub fn orders_stable_before_volatile_test() {
  // Declared volatile first; rendered frozen, then append-only, then volatile.
  let fields = [field("score", Sum), field("log", Append), field("v1", Freeze)]
  let state =
    dict.from_list([
      #("score", JInt(3)),
      #("log", items(1)),
      #("v1", JString("x")),
    ])
  let r =
    view.render(spec(["score", "log", "v1"], 1000, 10, 1, []), fields, state)
  let names =
    r.text
    |> string.split("\n")
    |> list.filter(string.starts_with(_, "<field"))
  assert names
    == ["<field name=\"v1\">", "<field name=\"log\">", "<field name=\"score\">"]
}

pub fn caps_items_and_records_omitted_test() {
  let fields = [field("log", Append)]
  let state = dict.from_list([#("log", items(10))])
  let r = view.render(spec(["log"], 10_000, 4, 1, []), fields, state)
  assert dict.get(r.omitted, "log") == Ok(6)
  // The newest four are shown.
  assert r.data
    == value.object([#("log", JArray(list.drop(as_list(items(10)), 6)))])
  assert string.contains(r.text, "omitted=\"6\"")
}

fn as_list(v) {
  case v {
    JArray(xs) -> xs
    _ -> []
  }
}

pub fn chunked_window_only_appends_between_moves_test() {
  let fields = [field("log", Append)]
  let render = fn(n) {
    view.render(
      spec(["log"], 10_000, 8, 4, []),
      fields,
      dict.from_list([#("log", items(n))]),
    )
  }
  // n = 9..12 share the window start (4), so each render extends the last.
  let starts =
    list.map([9, 10, 11, 12, 13], fn(n) { dict.get(render(n).omitted, "log") })
  assert starts == [Ok(4), Ok(4), Ok(4), Ok(4), Ok(8)]
  let body = fn(n) {
    render(n).text |> string.split("\n") |> list.drop(1) |> list.take(4)
  }
  assert body(9) == body(12)
}

pub fn max_chars_drops_items_then_truncates_test() {
  let fields = [field("log", Append)]
  let state = dict.from_list([#("log", items(50))])
  let r = view.render(spec(["log"], 120, 50, 1, []), fields, state)
  assert string.length(r.text) <= 120
  let assert Ok(omitted) = dict.get(r.omitted, "log")
  assert omitted > 0
  // A scalar too large for the cap is truncated with a marker.
  let big = dict.from_list([#("s", JString(string.repeat("x", 500)))])
  let r = view.render(spec(["s"], 100, 10, 1, []), [field("s", Replace)], big)
  assert string.length(r.text) == 100
  assert string.ends_with(r.text, "[truncated]")
}

pub fn omit_filters_keys_at_any_depth_test() {
  let finding =
    value.object([
      #("content", JString("c")),
      #("confidence", JFloat(0.9)),
      #(
        "source",
        value.object([#("confidence", JInt(1)), #("ref", JString("r"))]),
      ),
    ])
  let state = dict.from_list([#("findings", JArray([finding]))])
  let r =
    view.render(
      spec(["findings"], 1000, 10, 1, ["confidence"]),
      [field("findings", Append)],
      state,
    )
  assert !string.contains(r.text, "confidence")
  assert string.contains(r.text, "\"ref\":\"r\"")
}

pub fn rendering_is_canonical_test() {
  let a = JObject([#("b", JInt(1)), #("a", JInt(2))])
  let b = value.object([#("a", JInt(2)), #("b", JInt(1))])
  let render = fn(v) {
    view.render(
      spec(["x"], 1000, 10, 1, []),
      [field("x", Replace)],
      dict.from_list([#("x", v)]),
    ).text
  }
  // Values decoded from JSON are always key-sorted; `object` sorts too.
  // Objects render one key per line; nested values render canonically.
  assert render(b) == "<field name=\"x\">\na: 2\nb: 1\n</field>"
  assert render(JArray([b]))
    == "<field name=\"x\">\n{\"a\":2,\"b\":1}\n</field>"
  let assert Ok(parsed) = value.parse("{\"b\":1,\"a\":2}")
  assert render(parsed) == render(b)
  let _ = a
}

/// The SIDERIUS judge projection: 4000 chars, 24 items, no confidence.
pub fn judge_projection_test() {
  let finding = fn(i) {
    value.object([
      #("content", JString(string.repeat("evidence ", 20) <> int.to_string(i))),
      #("source_ref", JString("arxiv:" <> int.to_string(i))),
      #("confidence", JFloat(0.5)),
    ])
  }
  let state =
    dict.from_list([#("evidence", JArray(list.map(seq(1, 40), finding)))])
  let r =
    view.render(
      spec(["evidence"], 4000, 24, 8, ["confidence"]),
      [field("evidence", Append)],
      state,
    )
  assert string.length(r.text) <= 4000
  assert !string.contains(r.text, "confidence")
  let assert Ok(omitted) = dict.get(r.omitted, "evidence")
  assert omitted >= 16
}
