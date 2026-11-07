import gleam/string
import gleeunit
import wallis_core

pub fn main() -> Nil {
  gleeunit.main()
}

// The JSON entry point: events in, effects out, both as text.
pub fn step_json_roundtrip_test() {
  let wf =
    "{\"name\":\"t\",\"fields\":[{\"name\":\"runs\",\"reducer\":{\"type\":\"append\"},\"initial\":[]}],"
    <> "\"agents\":[{\"name\":\"a\",\"model\":\"default\",\"view\":{\"fields\":[\"runs\"],\"max_chars\":1000,\"max_items\":10,\"chunk\":1,\"omit\":[]},"
    <> "\"writes\":[{\"field\":\"runs\",\"from\":\"summary\"}],\"max_turns\":4}],\"scripts\":[],"
    <> "\"budget\":{\"usd\":null,\"tokens\":null,\"turns\":null,\"compute_minutes\":null}}"
  let pin =
    "{\"workflow_digest\":\"d\",\"models\":{\"default\":\"fake/m\"},\"seed\":1,\"inputs\":{}}"
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
      "{\"type\":\"requested\",\"id\":\"#0\",\"branch\":null,\"request\":{\"type\":\"call\",\"agent\":\"a\",\"input\":{\"x\":1}}}",
    )
  assert string.contains(effects, "\"type\":\"call_agent\"")
  assert string.contains(effects, "\"model\":\"fake/m\"")
  let #(s, effects) =
    wallis_core.step_json(
      s,
      "{\"type\":\"agent_returned\",\"id\":\"#0\",\"output\":{\"summary\":\"s1\"},\"emits\":[],\"usage\":{\"usd\":0.1,\"tokens\":5,\"turns\":1}}",
    )
  assert effects
    == "[{\"type\":\"checkpoint\"},{\"type\":\"deliver\",\"id\":\"#0\",\"value\":{\"summary\":\"s1\"}}]"
  assert string.contains(wallis_core.snapshot_json(s), "\"runs\":[\"s1\"]")
}

pub fn step_json_rejects_bad_event_test() {
  let #(_, effects) =
    wallis_core.step_json(wallis_core.init(), "{\"type\":\"nope\"}")
  assert string.starts_with(
    effects,
    "[{\"type\":\"refuse\",\"id\":null,\"reason\":\"invalid event",
  )
}
