import type * as _ from "./gleam.d.mts";
import type * as $run from "./wallis_core/run.d.mts";
import type * as $types from "./wallis_core/types.d.mts";

export function init(): $run.RunState$;

export function step(state: $run.RunState$, event: $types.Event$): [
  $run.RunState$,
  _.List<$types.Effect$>
];

export function step_json(state: $run.RunState$, event: string): [
  $run.RunState$,
  string
];

export function snapshot_json(state: $run.RunState$): string;

export function full_state(state: $run.RunState$): string;

export function facts_json(state: $run.RunState$): string;

export function mailbox_json(state: $run.RunState$, address: string): string;

export function attempt_count(state: $run.RunState$, id: string): number;

export function semantics(): string;

export function slot_text(
  node: string,
  kind: string,
  input: string,
  scope: string,
  within: string,
  occurrence: number
): string;

export function slot_of(state: $run.RunState$, id: string): string;

export function sent_id(state: $run.RunState$, key: string): string;

export function call_state(state: $run.RunState$, slot: string): string;
