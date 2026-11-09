import gleam/string
import gleeunit
import wallis_core

pub fn main() -> Nil {
  gleeunit.main()
}

// The JSON entry point: events in, effects out, both as text.
pub fn step_json_roundtrip_test() {
  let wf =
    "{\"name\":\"t\",\"agents\":[{\"name\":\"a\",\"model\":\"default\",\"max_turns\":4,\"steerable\":true}],\"commands\":[],\"orchestrators\":[],\"tools\":[],"
    <> "\"budget\":{\"turns\":null,\"compute_minutes\":null}}"
  let pin =
    "{\"workflow_digest\":\"d\",\"prior_digests\":[],\"models\":{\"default\":\"fake/m\"},\"seed\":1,\"inputs\":{},\"semantics\":\""
    <> wallis_core.semantics()
    <> "\"}"
  let #(s, effects) =
    wallis_core.step_json(
      wallis_core.init(),
      "{\"type\":\"started\",\"workflow\":"
        <> wf
        <> ",\"pin\":"
        <> pin
        <> ",\"input\":{\"goal\":1}}",
    )
  assert effects == "[{\"type\":\"checkpoint\"}]"
  let #(s, effects) =
    wallis_core.step_json(
      s,
      "{\"type\":\"requested\",\"id\":\"#0\",\"node_digest\":\"nd\",\"occurrence\":\"0\",\"request\":{\"type\":\"call\",\"agent\":\"a\",\"input\":{\"x\":1},\"session\":null}}",
    )
  assert string.contains(effects, "\"type\":\"call_agent\"")
  assert string.contains(effects, "\"model\":\"fake/m\"")
  assert string.contains(effects, "\"transcript\":[]")
  assert string.contains(effects, "\"note\":null")
  let #(s, effects) =
    wallis_core.step_json(
      s,
      "{\"type\":\"agent_returned\",\"id\":\"#0\",\"output\":{\"summary\":\"s1\"},\"usage\":{\"usd\":0.1,\"tokens\":5,\"turns\":1},\"model\":\"fake/m\",\"dialogue\":null}",
    )
  assert effects
    == "[{\"type\":\"checkpoint\"},{\"type\":\"deliver\",\"id\":\"#0\",\"value\":{\"output\":{\"summary\":\"s1\"},\"session\":\"sa43deac0d9c6dfcc\"}}]"
  let snapshot = wallis_core.snapshot_json(s)
  assert string.contains(
    snapshot,
    "{\"type\":\"node_done\",\"id\":\"#0\",\"agent\":\"a\",\"model\":\"fake/m\",\"steerable\":true,\"inbox\":[],\"outcome\":{\"type\":\"submitted\"}}",
  )
  assert !string.contains(snapshot, "\"state\"")
}

pub fn step_json_rejects_bad_event_test() {
  let #(_, effects) =
    wallis_core.step_json(wallis_core.init(), "{\"type\":\"nope\"}")
  assert string.starts_with(
    effects,
    "[{\"type\":\"refuse\",\"id\":null,\"refusal\":{\"type\":\"invalid_event\"",
  )
}
