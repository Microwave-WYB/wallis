import gleam/string
import gleeunit
import wallis_core

pub fn main() -> Nil {
  gleeunit.main()
}

// The JSON entry point: events in, effects out, both as text.
pub fn step_json_roundtrip_test() {
  let #(s, effects) =
    wallis_core.step_json(
      wallis_core.init(),
      "{\"type\":\"started\",\"workflow\":{\"name\":\"t\",\"digest\":\"d\"},\"input\":{\"goal\":1},\"semantics\":\""
        <> wallis_core.semantics()
        <> "\"}",
    )
  assert effects == "[{\"type\":\"checkpoint\"}]"
  let #(s, effects) =
    wallis_core.step_json(
      s,
      "{\"type\":\"requested\",\"id\":\"0\",\"request\":{\"type\":\"command_call\",\"name\":\"c\",\"input\":1},\"node\":\"n\",\"scope\":\"\",\"occurrence\":0}",
    )
  assert effects
    == "[{\"type\":\"checkpoint\"},{\"type\":\"run_command\",\"id\":\"0\",\"attempt\":1}]"
  let #(_, effects) =
    wallis_core.step_json(
      s,
      "{\"type\":\"command_returned\",\"id\":\"0\",\"output\":{\"x\":2}}",
    )
  assert effects
    == "[{\"type\":\"checkpoint\"},{\"type\":\"deliver\",\"id\":\"0\",\"value\":{\"x\":2}}]"
}

pub fn a_bad_event_is_a_typed_refusal_test() {
  let #(_, effects) = wallis_core.step_json(wallis_core.init(), "{\"type\":1}")
  assert string.contains(effects, "invalid_event")
}

pub fn a_log_of_another_semantics_is_refused_test() {
  let #(_, effects) =
    wallis_core.step_json(
      wallis_core.init(),
      "{\"type\":\"started\",\"workflow\":{\"name\":\"t\",\"digest\":\"d\"},\"input\":null,\"semantics\":\"wallis-core/0\"}",
    )
  assert string.contains(effects, "semantics_changed")
}
