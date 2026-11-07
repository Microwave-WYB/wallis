import gleam/option.{None, Some}
import wallis_core/reducer.{Commutative, NonCommutative}
import wallis_core/types.{
  Append, AppendByKey, Ascending, CountByKey, Descending, Freeze, KeepLatest,
  LlmMerge, Replace, Sum, TopK, TopOnly, Union,
}
import wallis_core/value.{JArray, JFloat, JInt, JNull, JObject, JString}

fn fold(r, writes) {
  let assert Ok(v) =
    writes
    |> fold_from(r, reducer.default_initial(r), _)
  v
}

fn fold_from(r, init, writes) {
  case writes {
    [] -> Ok(init)
    [w, ..rest] ->
      case reducer.apply(r, init, w) {
        Ok(v) -> fold_from(r, v, rest)
        Error(e) -> Error(e)
      }
  }
}

fn model(name, score) {
  value.object([#("model_type", JString(name)), #("metric", JFloat(score))])
}

pub fn replace_test() {
  assert fold(Replace, [JInt(1), JInt(2)]) == JInt(2)
}

pub fn append_test() {
  assert fold(Append, [JInt(1), JInt(2)]) == JArray([JInt(1), JInt(2)])
}

pub fn union_dedupes_and_sorts_test() {
  assert fold(Union, [
      JArray([JString("b"), JString("a")]),
      JArray([JString("a")]),
    ])
    == JArray([JString("a"), JString("b")])
  assert reducer.apply(Union, JArray([]), JString("a")) |> option.from_result
    == None
}

pub fn sum_test() {
  assert fold(Sum, [JInt(1), JInt(2)]) == JInt(3)
  assert fold(Sum, [JInt(1), JFloat(0.5)]) == JFloat(1.5)
}

pub fn count_by_key_test() {
  assert fold(CountByKey, [
      JString("confirmed"),
      JArray([JString("refuted"), JString("confirmed")]),
    ])
    == value.object([#("confirmed", JInt(2)), #("refuted", JInt(1))])
}

pub fn top_k_keeps_best_with_total_tiebreak_test() {
  let r =
    TopK(k: 2, by: "metric", order: Descending, key: None, latest: TopOnly)
  assert fold(r, [model("a", 0.1), model("b", 0.9), model("c", 0.5)])
    == JArray([model("b", 0.9), model("c", 0.5)])
  let asc =
    TopK(k: 1, by: "metric", order: Ascending, key: None, latest: TopOnly)
  assert fold(asc, [model("a", 0.1), model("b", 0.9)])
    == JArray([model("a", 0.1)])
  // Unscored entries sort last in either direction.
  let unscored = value.object([#("model_type", JString("u"))])
  assert fold(r, [unscored, model("a", 0.1)])
    == JArray([model("a", 0.1), unscored])
}

/// SIDERIUS cap_knowledge_cache: top 4 by metric plus the current model,
/// keyed by model_type (latest entry per model wins).
pub fn top_k_plus_latest_test() {
  let r =
    TopK(
      k: 2,
      by: "metric",
      order: Descending,
      key: Some("model_type"),
      latest: KeepLatest,
    )
  assert fold(r, [model("a", 0.9), model("b", 0.8), model("c", 0.1)])
    == JArray([model("a", 0.9), model("b", 0.8), model("c", 0.1)])
  // The previous latest drops out once it is no longer the current model.
  assert fold(r, [
      model("a", 0.9),
      model("b", 0.8),
      model("c", 0.1),
      model("d", 0.2),
    ])
    == JArray([model("a", 0.9), model("b", 0.8), model("d", 0.2)])
  // A re-run of a model replaces its entry.
  assert fold(r, [model("a", 0.9), model("a", 0.3)])
    == JArray([model("a", 0.3)])
}

pub fn append_by_key_test() {
  let r = AppendByKey(key: "model_type")
  assert fold(r, [model("a", 1.0), model("b", 2.0), model("a", 3.0)])
    == value.object([
      #("a", JArray([model("a", 1.0), model("a", 3.0)])),
      #("b", JArray([model("b", 2.0)])),
    ])
  assert reducer.apply(r, JObject([]), JInt(1)) |> option.from_result == None
}

pub fn freeze_first_write_wins_test() {
  assert fold(Freeze, [JString("v1"), JString("other")]) == JString("v1")
  assert reducer.default_initial(Freeze) == JNull
}

pub fn llm_merge_fallback_keeps_newest_and_archives_test() {
  let assert Ok(#(kept, archived)) =
    reducer.merge_fallback(2, JArray([JInt(1), JInt(2)]), JArray([JInt(3)]))
  assert kept == JArray([JInt(2), JInt(3)])
  assert archived == [JInt(1)]
}

pub fn classification_test() {
  assert reducer.commutativity(Union) == Commutative
  assert reducer.commutativity(Sum) == Commutative
  assert reducer.commutativity(CountByKey) == Commutative
  assert reducer.commutativity(TopK(3, "m", Descending, None, TopOnly))
    == Commutative
  assert reducer.commutativity(TopK(3, "m", Descending, None, KeepLatest))
    == NonCommutative
  assert reducer.commutativity(Replace) == NonCommutative
  assert reducer.commutativity(Append) == NonCommutative
  assert reducer.commutativity(AppendByKey("k")) == NonCommutative
  assert reducer.commutativity(Freeze) == NonCommutative
  assert reducer.commutativity(LlmMerge("m", 8, 2, None)) == NonCommutative
}

/// Commutative reducers give the same result in any write order.
pub fn commutative_reducers_ignore_order_test() {
  let top =
    TopK(k: 2, by: "metric", order: Descending, key: None, latest: TopOnly)
  let ws = [model("a", 0.3), model("b", 0.3), model("c", 0.9)]
  assert fold(top, ws)
    == fold(top, [model("c", 0.9), model("b", 0.3), model("a", 0.3)])
  let keys = [JString("x"), JString("y"), JString("x")]
  assert fold(CountByKey, keys)
    == fold(CountByKey, [JString("x"), JString("x"), JString("y")])
}
