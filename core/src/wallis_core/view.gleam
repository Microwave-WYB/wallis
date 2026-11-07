//// Views: what an agent (or the workflow body) may see of the run state.
////
//// A view selects fields, removes filtered keys, caps list and object sizes
//// and the total rendered size, and records how much it omitted. Fields are
//// ordered from stable to volatile, and append-only lists are windowed in
//// chunks, so consecutive renders share a long common prefix (prompt
//// caching). Rendering is canonical: equal states render equal text.

import gleam/dict.{type Dict}
import gleam/int
import gleam/list
import gleam/option
import gleam/order
import gleam/string
import wallis_core/reducer.{type Stability, AppendOnly, Frozen, Volatile}
import wallis_core/types.{type Field, type ViewSpec}
import wallis_core/value.{type Value, JArray, JNull, JObject}

pub type Rendered {
  Rendered(text: String, omitted: Dict(String, Int), data: Value)
}

type Shape {
  ListShape(items: List(Value))
  ObjectShape(entries: List(#(String, Value)))
  ScalarShape(Value)
}

type Part {
  Part(name: String, stability: Stability, shape: Shape, omitted: Int)
}

const truncation_marker = "\n…[truncated]"

pub fn render(
  spec: ViewSpec,
  fields: List(Field),
  state: Dict(String, Value),
) -> Rendered {
  let parts =
    fields
    |> list.index_map(fn(f, i) { #(f, i) })
    |> list.filter(fn(p) { list.contains(spec.fields, { p.0 }.name) })
    |> list.sort(fn(a, b) {
      order.break_tie(int.compare(rank(a.0), rank(b.0)), int.compare(a.1, b.1))
    })
    |> list.map(fn(p) {
      let f = p.0
      let v =
        dict.get(state, f.name)
        |> option.from_result
        |> option.unwrap(JNull)
        |> value.without_keys(spec.omit)
      cap(f.name, reducer.stability(f.reducer), v, spec)
    })
    |> shrink(spec.max_chars)
  let text = case string.length(text_of(parts)) > spec.max_chars {
    True ->
      string.slice(
        text_of(parts),
        0,
        int.max(0, spec.max_chars - string.length(truncation_marker)),
      )
      <> truncation_marker
    False -> text_of(parts)
  }
  Rendered(
    text:,
    omitted: parts
      |> list.filter(fn(p) { p.omitted > 0 })
      |> list.map(fn(p) { #(p.name, p.omitted) })
      |> dict.from_list,
    data: value.object(
      list.map(parts, fn(p) { #(p.name, shape_value(p.shape)) }),
    ),
  )
}

fn rank(f: Field) -> Int {
  reducer.stability_rank(reducer.stability(f.reducer))
}

fn cap(name: String, stability: Stability, v: Value, spec: ViewSpec) -> Part {
  case v {
    JArray(items) -> {
      let #(shown, omitted) = window(items, stability, spec)
      Part(name, stability, ListShape(shown), omitted)
    }
    JObject(entries) -> {
      let kept = list.take(entries, spec.max_items)
      let key_omitted = list.length(entries) - list.length(kept)
      let #(kept, inner_omitted) =
        list.map_fold(kept, 0, fn(acc, e) {
          case e.1 {
            JArray(items) -> {
              let #(shown, omitted) = window(items, AppendOnly, spec)
              #(acc + omitted, #(e.0, JArray(shown)))
            }
            _ -> #(acc, e)
          }
        })
        |> fn(r) { #(r.1, r.0) }
      Part(name, stability, ObjectShape(kept), key_omitted + inner_omitted)
    }
    _ -> Part(name, stability, ScalarShape(v), 0)
  }
}

/// Append-only lists show their newest items; the window start moves in
/// steps of `chunk`, so between moves new items only append. Volatile lists
/// (ranked or merged) show their head.
fn window(
  items: List(Value),
  stability: Stability,
  spec: ViewSpec,
) -> #(List(Value), Int) {
  let n = list.length(items)
  let m = int.max(0, spec.max_items)
  case n <= m, stability {
    True, _ -> #(items, 0)
    False, Volatile -> #(list.take(items, m), n - m)
    False, Frozen | False, AppendOnly -> {
      let c = int.max(1, spec.chunk)
      let start = { n - m + c - 1 } / c * c
      #(list.drop(items, start), start)
    }
  }
}

/// Drops one item at a time from the part showing the most items until the
/// rendering fits.
fn shrink(parts: List(Part), max_chars: Int) -> List(Part) {
  case string.length(text_of(parts)) > max_chars {
    False -> parts
    True -> {
      let sizes = list.map(parts, fn(p) { shape_size(p.shape) })
      let largest = list.fold(sizes, 0, int.max)
      case largest {
        0 -> parts
        _ -> {
          // The last part with the most items: volatile fields go first.
          let target =
            list.index_map(sizes, fn(s, i) { #(s, i) })
            |> list.filter(fn(p) { p.0 == largest })
            |> list.last
            |> fn(r) {
              case r {
                Ok(p) -> p.1
                Error(Nil) -> 0
              }
            }
          parts
          |> list.index_map(fn(p, i) {
            case i == target {
              True -> drop_one(p)
              False -> p
            }
          })
          |> shrink(max_chars)
        }
      }
    }
  }
}

fn drop_one(part: Part) -> Part {
  let shape = case part.shape, part.stability {
    ListShape(items), Volatile ->
      ListShape(list.take(items, list.length(items) - 1))
    ListShape(items), _ -> ListShape(list.drop(items, 1))
    ObjectShape(entries), _ ->
      ObjectShape(list.take(entries, list.length(entries) - 1))
    ScalarShape(_), _ -> part.shape
  }
  Part(..part, shape:, omitted: part.omitted + 1)
}

fn shape_size(shape: Shape) -> Int {
  case shape {
    ListShape(items) -> list.length(items)
    ObjectShape(entries) -> list.length(entries)
    ScalarShape(_) -> 0
  }
}

fn shape_value(shape: Shape) -> Value {
  case shape {
    ListShape(items) -> JArray(items)
    ObjectShape(entries) -> JObject(entries)
    ScalarShape(v) -> v
  }
}

fn text_of(parts: List(Part)) -> String {
  parts |> list.map(part_text) |> string.join("\n")
}

fn part_text(part: Part) -> String {
  let attrs = case part.omitted {
    0 -> ""
    n -> " omitted=\"" <> int.to_string(n) <> "\""
  }
  let body = case part.shape {
    ListShape(items) -> list.map(items, value.canonical)
    ObjectShape(entries) ->
      list.map(entries, fn(e) { e.0 <> ": " <> value.canonical(e.1) })
    ScalarShape(v) -> [value.canonical(v)]
  }
  ["<field name=\"" <> part.name <> "\"" <> attrs <> ">", ..body]
  |> list.append(["</field>"])
  |> string.join("\n")
}
