//// Reducers fold a write into a state field. Each one is classified as
//// commutative (safe in parallel branches) or not. `llmMerge` is the one
//// reducer that needs an effect; the run module drives it and uses
//// `merge_fallback` once its call cap is reached.

import gleam/int
import gleam/list
import gleam/option.{None, Some}
import gleam/order
import gleam/result
import wallis_core/types.{
  type Reducer, Append, AppendByKey, Ascending, CountByKey, Descending, Freeze,
  KeepLatest, LlmMerge, Replace, Sum, TopK, TopOnly, Union,
}
import wallis_core/value.{type Value, JArray, JInt, JNull, JObject, JString}

pub type Commutativity {
  Commutative
  NonCommutative
}

pub fn commutativity(reducer: Reducer) -> Commutativity {
  case reducer {
    Union | Sum | CountByKey -> Commutative
    // A top-k with a total tie-break is order-independent unless it also
    // keeps the latest write.
    TopK(latest: TopOnly, ..) -> Commutative
    TopK(latest: KeepLatest, ..) -> NonCommutative
    Replace | Append | AppendByKey(..) | Freeze | LlmMerge(..) -> NonCommutative
  }
}

/// How a view orders fields, from stable to volatile.
pub type Stability {
  Frozen
  AppendOnly
  Volatile
}

pub fn stability(reducer: Reducer) -> Stability {
  case reducer {
    Freeze -> Frozen
    Append | Union | AppendByKey(..) -> AppendOnly
    Replace | Sum | CountByKey | TopK(..) | LlmMerge(..) -> Volatile
  }
}

pub fn stability_rank(stability: Stability) -> Int {
  case stability {
    Frozen -> 0
    AppendOnly -> 1
    Volatile -> 2
  }
}

pub fn default_initial(reducer: Reducer) -> Value {
  case reducer {
    Replace | Freeze -> JNull
    Append | Union | TopK(..) | LlmMerge(..) -> JArray([])
    Sum -> JInt(0)
    CountByKey | AppendByKey(..) -> JObject([])
  }
}

/// Applies one write. `LlmMerge` here is the deterministic fallback.
pub fn apply(
  reducer: Reducer,
  current: Value,
  write: Value,
) -> Result(Value, String) {
  case reducer {
    Replace -> Ok(write)
    Append ->
      case current {
        JArray(items) -> Ok(JArray(list.append(items, [write])))
        _ -> Error("append: field is not a list")
      }
    Union ->
      case current, write {
        JArray(items), JArray(new) ->
          Ok(JArray(set_of(list.append(items, new))))
        JArray(_), _ -> Error("union: write must be a list")
        _, _ -> Error("union: field is not a list")
      }
    Sum -> value.add(current, write) |> result.map_error(fn(e) { "sum: " <> e })
    CountByKey -> count_by_key(current, write)
    TopK(k:, by:, order:, key:, latest:) -> {
      use items <- result.try(case current {
        JArray(items) -> Ok(items)
        _ -> Error("topK: field is not a list")
      })
      let pool = case key {
        None -> list.unique(list.append(items, [write]))
        Some(path) ->
          list.append(
            list.filter(items, fn(i) {
              !value.equal(key_of(i, path), key_of(write, path))
            }),
            [write],
          )
      }
      let top =
        pool
        |> list.sort(fn(a, b) {
          let by_score = case score(a, by), score(b, by), order {
            Scored(x), Scored(y), Ascending -> compare_floats(x, y)
            Scored(x), Scored(y), Descending -> compare_floats(y, x)
            Scored(_), Unscored, _ -> order.Lt
            Unscored, Scored(_), _ -> order.Gt
            Unscored, Unscored, _ -> order.Eq
          }
          order.break_tie(by_score, value.compare(a, b))
        })
        |> list.take(k)
      case latest, list.any(top, value.equal(_, write)) {
        KeepLatest, False -> Ok(JArray(list.append(top, [write])))
        _, _ -> Ok(JArray(top))
      }
    }
    AppendByKey(key:) ->
      case current, value.get(write, key) {
        JObject(entries), Some(JString(k)) -> {
          let existing = case list.key_find(entries, k) {
            Ok(JArray(items)) -> items
            _ -> []
          }
          Ok(
            value.object(list.key_set(
              entries,
              k,
              JArray(list.append(existing, [write])),
            )),
          )
        }
        JObject(_), _ -> Error("appendByKey: write has no string key " <> key)
        _, _ -> Error("appendByKey: field is not an object")
      }
    // First write wins; later writes are ignored.
    Freeze ->
      case current {
        JNull -> Ok(write)
        _ -> Ok(current)
      }
    LlmMerge(max:, ..) ->
      merge_fallback(max, current, write) |> result.map(fn(r) { r.0 })
  }
}

/// Deterministic llmMerge: keep the newest `max` items, return the rest as
/// archived.
pub fn merge_fallback(
  max: Int,
  current: Value,
  incoming: Value,
) -> Result(#(Value, List(Value)), String) {
  case current, incoming {
    JArray(items), JArray(new) -> {
      let all = list.unique(list.append(items, new))
      let drop = int.max(0, list.length(all) - max)
      Ok(#(JArray(list.drop(all, drop)), list.take(all, drop)))
    }
    JArray(_), _ -> Error("llmMerge: write must be a list")
    _, _ -> Error("llmMerge: field is not a list")
  }
}

fn set_of(items: List(Value)) -> List(Value) {
  items |> list.unique |> list.sort(value.compare)
}

fn count_by_key(current: Value, write: Value) -> Result(Value, String) {
  use entries <- result.try(case current {
    JObject(entries) -> Ok(entries)
    _ -> Error("countByKey: field is not an object")
  })
  use keys <- result.try(case write {
    JString(k) -> Ok([k])
    JArray(items) ->
      list.try_map(items, fn(i) {
        case i {
          JString(k) -> Ok(k)
          _ -> Error("countByKey: keys must be strings")
        }
      })
    _ -> Error("countByKey: write must be a key or a list of keys")
  })
  list.fold(keys, entries, fn(acc, k) {
    let n = case list.key_find(acc, k) {
      Ok(JInt(n)) -> n
      _ -> 0
    }
    list.key_set(acc, k, JInt(n + 1))
  })
  |> value.object
  |> Ok
}

fn key_of(item: Value, path: String) -> Value {
  option.unwrap(value.get(item, path), JNull)
}

/// Missing or non-numeric scores sort last in either direction.
type Score {
  Scored(Float)
  Unscored
}

fn score(item: Value, path: String) -> Score {
  case option.then(value.get(item, path), value.as_number) {
    Some(f) -> Scored(f)
    None -> Unscored
  }
}

fn compare_floats(x: Float, y: Float) -> order.Order {
  case x <. y, x >. y {
    True, _ -> order.Lt
    _, True -> order.Gt
    _, _ -> order.Eq
  }
}
