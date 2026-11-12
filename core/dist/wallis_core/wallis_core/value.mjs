/// <reference types="./value.d.mts" />
import * as $json from "../../gleam_json/gleam/json.mjs";
import * as $dict from "../../gleam_stdlib/gleam/dict.mjs";
import * as $decode from "../../gleam_stdlib/gleam/dynamic/decode.mjs";
import * as $list from "../../gleam_stdlib/gleam/list.mjs";
import * as $option from "../../gleam_stdlib/gleam/option.mjs";
import { Some, Option$None$const } from "../../gleam_stdlib/gleam/option.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import {
  Ok,
  Empty as $Empty,
  List$Empty$const as $List$Empty$const,
  prepend as listPrepend,
  CustomType as $CustomType,
} from "../gleam.mjs";

export class JNull extends $CustomType {}
export const Value$JNull$const = new JNull();
export const Value$JNull = () => Value$JNull$const;
export const Value$isJNull = (value) => value instanceof JNull;

export class JBool extends $CustomType {
  constructor($0) {
    super();
    this[0] = $0;
  }
}
export const Value$JBool = ($0) => new JBool($0);
export const Value$isJBool = (value) => value instanceof JBool;
export const Value$JBool$0 = (value) => value[0];

export class JInt extends $CustomType {
  constructor($0) {
    super();
    this[0] = $0;
  }
}
export const Value$JInt = ($0) => new JInt($0);
export const Value$isJInt = (value) => value instanceof JInt;
export const Value$JInt$0 = (value) => value[0];

export class JFloat extends $CustomType {
  constructor($0) {
    super();
    this[0] = $0;
  }
}
export const Value$JFloat = ($0) => new JFloat($0);
export const Value$isJFloat = (value) => value instanceof JFloat;
export const Value$JFloat$0 = (value) => value[0];

export class JString extends $CustomType {
  constructor($0) {
    super();
    this[0] = $0;
  }
}
export const Value$JString = ($0) => new JString($0);
export const Value$isJString = (value) => value instanceof JString;
export const Value$JString$0 = (value) => value[0];

export class JArray extends $CustomType {
  constructor($0) {
    super();
    this[0] = $0;
  }
}
export const Value$JArray = ($0) => new JArray($0);
export const Value$isJArray = (value) => value instanceof JArray;
export const Value$JArray$0 = (value) => value[0];

export class JObject extends $CustomType {
  constructor($0) {
    super();
    this[0] = $0;
  }
}
export const Value$JObject = ($0) => new JObject($0);
export const Value$isJObject = (value) => value instanceof JObject;
export const Value$JObject$0 = (value) => value[0];

/**
 * Builds an object with sorted keys; later duplicates win.
 */
export function object(entries) {
  let _pipe = entries;
  let _pipe$1 = $dict.from_list(_pipe);
  let _pipe$2 = $dict.to_list(_pipe$1);
  let _pipe$3 = $list.sort(
    _pipe$2,
    (a, b) => { return $string.compare(a[0], b[0]); },
  );
  return new JObject(_pipe$3);
}

export function decoder() {
  return $decode.recursive(
    () => {
      return $decode.one_of(
        (() => {
          let _pipe = $decode.optional($decode.int);
          return $decode.map(
            _pipe,
            (i) => {
              if (i instanceof Some) {
                let i$1 = i[0];
                return new JInt(i$1);
              } else {
                return Value$JNull$const;
              }
            },
          );
        })(),
        listPrepend(
          $decode.map($decode.float, (var0) => { return new JFloat(var0); }),
          listPrepend(
            $decode.map($decode.string, (var0) => { return new JString(var0); }),
            listPrepend(
              $decode.map($decode.bool, (var0) => { return new JBool(var0); }),
              listPrepend(
                $decode.map(
                  $decode.list(decoder()),
                  (var0) => { return new JArray(var0); },
                ),
                listPrepend(
                  $decode.map(
                    $decode.dict($decode.string, decoder()),
                    (d) => { return object($dict.to_list(d)); },
                  ),
                  $List$Empty$const,
                ),
              ),
            ),
          ),
        ),
      );
    },
  );
}

export function to_json(value) {
  if (value instanceof JNull) {
    return $json.null$();
  } else if (value instanceof JBool) {
    let b = value[0];
    return $json.bool(b);
  } else if (value instanceof JInt) {
    let i = value[0];
    return $json.int(i);
  } else if (value instanceof JFloat) {
    let f = value[0];
    return $json.float(f);
  } else if (value instanceof JString) {
    let s = value[0];
    return $json.string(s);
  } else if (value instanceof JArray) {
    let items = value[0];
    return $json.array(items, to_json);
  } else {
    let entries = value[0];
    return $json.object(
      $list.map(entries, (e) => { return [e[0], to_json(e[1])]; }),
    );
  }
}

/**
 * Canonical text: sorted keys, no whitespace.
 */
export function canonical(value) {
  return $json.to_string(to_json(value));
}

export function parse(text) {
  return $json.parse(text, decoder());
}

function get_segments(loop$value, loop$segments) {
  while (true) {
    let value = loop$value;
    let segments = loop$segments;
    if (segments instanceof $Empty) {
      return new Some(value);
    } else if (value instanceof JNull) {
      return Option$None$const;
    } else if (value instanceof JBool) {
      return Option$None$const;
    } else if (value instanceof JInt) {
      return Option$None$const;
    } else if (value instanceof JFloat) {
      return Option$None$const;
    } else if (value instanceof JString) {
      return Option$None$const;
    } else if (value instanceof JArray) {
      return Option$None$const;
    } else {
      let key = segments.head;
      let rest = segments.tail;
      let entries = value[0];
      let $ = $list.key_find(entries, key);
      if ($ instanceof Ok) {
        let inner = $[0];
        loop$value = inner;
        loop$segments = rest;
      } else {
        return Option$None$const;
      }
    }
  }
}

/**
 * Looks up a dotted path such as `_stats.best_score`. The empty path is
 * the value itself.
 */
export function get(value, path) {
  if (path === "") {
    return new Some(value);
  } else {
    return get_segments(value, $string.split(path, "."));
  }
}
