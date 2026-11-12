import type * as $option from "../../gleam_stdlib/gleam/option.d.mts";
import type * as $order from "../../gleam_stdlib/gleam/order.d.mts";
import type * as _ from "../gleam.d.mts";
import type * as $value from "../wallis_core/value.d.mts";

declare class RequestId extends _.CustomType {
  /** @deprecated */
  constructor(argument$0: string);
  /** @deprecated */
  0: string;
}

export type RequestId$ = RequestId;

declare class SessionId extends _.CustomType {
  /** @deprecated */
  constructor(argument$0: string);
  /** @deprecated */
  0: string;
}

export type SessionId$ = SessionId;

declare class Digest extends _.CustomType {
  /** @deprecated */
  constructor(argument$0: string);
  /** @deprecated */
  0: string;
}

export type Digest$ = Digest;

declare class Slot extends _.CustomType {
  /** @deprecated */
  constructor(argument$0: string);
  /** @deprecated */
  0: string;
}

export type Slot$ = Slot;

export function request_id(text: string): RequestId$;

export function request_text(id: RequestId$): string;

export function compare_requests(a: RequestId$, b: RequestId$): $order.Order$;

export function session_id(text: string): SessionId$;

export function session_text(id: SessionId$): string;

export function digest(text: string): Digest$;

export function digest_text(d: Digest$): string;

export function slot(
  node: Digest$,
  kind: string,
  input: $value.Value$,
  scope: string,
  within: $option.Option$<SessionId$>,
  occurrence: string
): Slot$;

export function slot_text(slot: Slot$): string;

export function next_session(slot: Slot$, attempt: number): SessionId$;
