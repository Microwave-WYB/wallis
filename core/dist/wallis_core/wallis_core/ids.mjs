/// <reference types="./ids.d.mts" />
import * as $int from "../../gleam_stdlib/gleam/int.mjs";
import * as $option from "../../gleam_stdlib/gleam/option.mjs";
import * as $order from "../../gleam_stdlib/gleam/order.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import {
  List$Empty$const as $List$Empty$const,
  prepend as listPrepend,
  CustomType as $CustomType,
} from "../gleam.mjs";
import * as $sha from "../wallis_core/digest.mjs";
import * as $value from "../wallis_core/value.mjs";

class RequestId extends $CustomType {
  constructor($0) {
    super();
    this[0] = $0;
  }
}

class SessionId extends $CustomType {
  constructor($0) {
    super();
    this[0] = $0;
  }
}

class Digest extends $CustomType {
  constructor($0) {
    super();
    this[0] = $0;
  }
}

class Slot extends $CustomType {
  constructor($0) {
    super();
    this[0] = $0;
  }
}

export function request_id(text) {
  return new RequestId(text);
}

export function request_text(id) {
  let text = id[0];
  return text;
}

/**
 * Request ids in display order (by their text).
 */
export function compare_requests(a, b) {
  return $string.compare(request_text(a), request_text(b));
}

export function session_id(text) {
  return new SessionId(text);
}

export function session_text(id) {
  let text = id[0];
  return text;
}

export function digest(text) {
  return new Digest(text);
}

export function digest_text(d) {
  let text = d[0];
  return text;
}

/**
 * The journal slot of a call: the node's definition digest, the request's
 * kind and canonical input (not its name: names are labels), its scope
 * (the slot of the nested workflow call it is made in, "" at the top), the
 * session it continues (`None` for a new session, and for calls that are
 * not session calls), and its occurrence in its scope.
 */
export function slot(node, kind, input, scope, within, occurrence) {
  let _block;
  if (within instanceof $option.Some) {
    let text = within[0][0];
    _block = text;
  } else {
    _block = "";
  }
  let within$1 = _block;
  return new Slot(
    ($sha.hex(
      $string.join(
        listPrepend(
          digest_text(node),
          listPrepend(
            kind,
            listPrepend(
              $value.canonical(input),
              listPrepend(scope, listPrepend(within$1, $List$Empty$const)),
            ),
          ),
        ),
        "\n",
      ),
    ) + "#") + occurrence,
  );
}

export function slot_text(slot) {
  let text = slot[0];
  return text;
}

/**
 * The session value after a call: a hash chain over the session it
 * continued, the call's slot and the attempt that answered, so a new
 * attempt (a restart) yields a new session and everything after it misses.
 */
export function next_session(slot, attempt) {
  let text = slot[0];
  return new SessionId("s" + $sha.hex((text + "\n") + $int.to_string(attempt)));
}
