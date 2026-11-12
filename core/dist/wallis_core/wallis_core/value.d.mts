import type * as $json from "../../gleam_json/gleam/json.d.mts";
import type * as $decode from "../../gleam_stdlib/gleam/dynamic/decode.d.mts";
import type * as $option from "../../gleam_stdlib/gleam/option.d.mts";
import type * as _ from "../gleam.d.mts";

export class JNull extends _.CustomType {}
export function Value$JNull(): Value$;
export function Value$isJNull(value: any): value is Value$;

export class JBool extends _.CustomType {
  /** @deprecated */
  constructor(argument$0: boolean);
  /** @deprecated */
  0: boolean;
}
export function Value$JBool($0: boolean): Value$;
export function Value$isJBool(value: any): value is Value$;
export function Value$JBool$0(value: Value$): boolean;

export class JInt extends _.CustomType {
  /** @deprecated */
  constructor(argument$0: number);
  /** @deprecated */
  0: number;
}
export function Value$JInt($0: number): Value$;
export function Value$isJInt(value: any): value is Value$;
export function Value$JInt$0(value: Value$): number;

export class JFloat extends _.CustomType {
  /** @deprecated */
  constructor(argument$0: number);
  /** @deprecated */
  0: number;
}
export function Value$JFloat($0: number): Value$;
export function Value$isJFloat(value: any): value is Value$;
export function Value$JFloat$0(value: Value$): number;

export class JString extends _.CustomType {
  /** @deprecated */
  constructor(argument$0: string);
  /** @deprecated */
  0: string;
}
export function Value$JString($0: string): Value$;
export function Value$isJString(value: any): value is Value$;
export function Value$JString$0(value: Value$): string;

export class JArray extends _.CustomType {
  /** @deprecated */
  constructor(argument$0: _.List<Value$>);
  /** @deprecated */
  0: _.List<Value$>;
}
export function Value$JArray($0: _.List<Value$>): Value$;
export function Value$isJArray(value: any): value is Value$;
export function Value$JArray$0(value: Value$): _.List<Value$>;

export class JObject extends _.CustomType {
  /** @deprecated */
  constructor(argument$0: _.List<[string, Value$]>);
  /** @deprecated */
  0: _.List<[string, Value$]>;
}
export function Value$JObject($0: _.List<[string, Value$]>): Value$;
export function Value$isJObject(value: any): value is Value$;
export function Value$JObject$0(value: Value$): _.List<[string, Value$]>;

export type Value$ = JNull | JBool | JInt | JFloat | JString | JArray | JObject;

export function object(entries: _.List<[string, Value$]>): Value$;

export function decoder(): $decode.Decoder$<Value$>;

export function to_json(value: Value$): $json.Json$;

export function canonical(value: Value$): string;

export function parse(text: string): _.Result<Value$, $json.DecodeError$>;

export function get(value: Value$, path: string): $option.Option$<Value$>;
