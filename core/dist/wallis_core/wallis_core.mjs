/// <reference types="./wallis_core.d.mts" />
import * as $json from "../gleam_json/gleam/json.mjs";
import * as $int from "../gleam_stdlib/gleam/int.mjs";
import * as $list from "../gleam_stdlib/gleam/list.mjs";
import * as $option from "../gleam_stdlib/gleam/option.mjs";
import { Some, Option$None$const } from "../gleam_stdlib/gleam/option.mjs";
import * as $string from "../gleam_stdlib/gleam/string.mjs";
import { Ok, List$Empty$const as $List$Empty$const, prepend as listPrepend } from "./gleam.mjs";
import * as $ids from "./wallis_core/ids.mjs";
import * as $run from "./wallis_core/run.mjs";
import * as $types from "./wallis_core/types.mjs";
import { InvalidEvent, Refuse } from "./wallis_core/types.mjs";
import * as $value from "./wallis_core/value.mjs";

export function init() {
  return $run.new$();
}

export function step(state, event) {
  return $run.step(state, event);
}

/**
 * Steps one JSON event and returns the effects as a JSON array. An event
 * that does not decode leaves the state unchanged and yields a `refuse`.
 */
export function step_json(state, event) {
  let _block;
  let $1 = $json.parse(event, $types.event_decoder());
  if ($1 instanceof Ok) {
    let event$1 = $1[0];
    _block = $run.step(state, event$1);
  } else {
    let error = $1[0];
    _block = [
      state,
      listPrepend(
        new Refuse(Option$None$const, new InvalidEvent($string.inspect(error))),
        $List$Empty$const,
      ),
    ];
  }
  let $ = _block;
  let state$1 = $[0];
  let effects = $[1];
  return [
    state$1,
    (() => {
      let _pipe = effects;
      let _pipe$1 = $list.map(_pipe, $types.effect_to_json);
      let _pipe$2 = $json.preprocessed_array(_pipe$1);
      return $json.to_string(_pipe$2);
    })(),
  ];
}

/**
 * JSON of the run: workflow, status, mailboxes and every call.
 */
export function snapshot_json(state) {
  return $json.to_string($run.snapshot(state));
}

/**
 * The whole state as text, for the differential check.
 */
export function full_state(state) {
  return $run.full_state(state);
}

/**
 * JSON of the host facts the log noted.
 */
export function facts_json(state) {
  return $json.to_string($run.host_facts(state));
}

/**
 * A mailbox's messages in their journaled order, as a JSON array.
 */
export function mailbox_json(state, address) {
  let _pipe = $run.mailbox(state, address);
  let _pipe$1 = $json.array(_pipe, $types.envelope_to_json);
  return $json.to_string(_pipe$1);
}

/**
 * How many attempts the call at this request id has had (0: none).
 */
export function attempt_count(state, id) {
  return $run.attempt_count(state, id);
}

/**
 * The core's semantics version, recorded with every run.
 */
export function semantics() {
  return $run.semantics;
}

/**
 * The journal key of a call, as the core computes it (see `run.requested`):
 * a running agent's mailbox address and a call's id derive from it.
 * `within` is "" for none. Returns "" when the input is not JSON.
 */
export function slot_text(node, kind, input, scope, within, occurrence) {
  let $ = $value.parse(input);
  if ($ instanceof Ok) {
    let v = $[0];
    let _block;
    if (within === "") {
      _block = Option$None$const;
    } else {
      let w = within;
      _block = new Some($ids.session_id(w));
    }
    let within$1 = _block;
    return $ids.slot_text(
      $ids.slot(
        $ids.digest(node),
        kind,
        v,
        scope,
        within$1,
        $int.to_string(occurrence),
      ),
    );
  } else {
    return "";
  }
}

export function slot_of(state, id) {
  return $run.slot_of(state, id);
}

export function sent_id(state, key) {
  return $run.sent_id(state, key);
}

export function call_state(state, slot) {
  return $run.call_state(state, slot);
}
