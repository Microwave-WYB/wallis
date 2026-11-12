import type * as $json from "../../gleam_json/gleam/json.d.mts";
import type * as $dict from "../../gleam_stdlib/gleam/dict.d.mts";
import type * as $option from "../../gleam_stdlib/gleam/option.d.mts";
import type * as _ from "../gleam.d.mts";
import type * as $ids from "../wallis_core/ids.d.mts";
import type * as $types from "../wallis_core/types.d.mts";
import type * as $value from "../wallis_core/value.d.mts";

declare class NotYetStarted extends _.CustomType {}

declare class Active extends _.CustomType {
  /** @deprecated */
  constructor(argument$0: Run$);
  /** @deprecated */
  0: Run$;
}

export type RunState$ = NotYetStarted | Active;

declare class Live extends _.CustomType {}

declare class Ended extends _.CustomType {
  /** @deprecated */
  constructor(argument$0: $types.Outcome$);
  /** @deprecated */
  0: $types.Outcome$;
}

type Lifecycle$ = Live | Ended;

declare class Run extends _.CustomType {
  /** @deprecated */
  constructor(
    lifecycle: Lifecycle$,
    workflow: $types.Workflow$,
    prior_digests: _.List<string>,
    input: $value.Value$,
    calls: $dict.Dict$<$ids.Slot$, Call$>,
    ids: $dict.Dict$<$ids.RequestId$, $ids.Slot$>,
    sessions: $dict.Dict$<$ids.SessionId$, Origin$>,
    mailboxes: $dict.Dict$<string, _.List<$types.Envelope$>>,
    sends: $dict.Dict$<string, string>,
    facts: $dict.Dict$<string, $value.Value$>
  );
  /** @deprecated */
  lifecycle: Lifecycle$;
  /** @deprecated */
  workflow: $types.Workflow$;
  /** @deprecated */
  prior_digests: _.List<string>;
  /** @deprecated */
  input: $value.Value$;
  /** @deprecated */
  calls: $dict.Dict$<$ids.Slot$, Call$>;
  /** @deprecated */
  ids: $dict.Dict$<$ids.RequestId$, $ids.Slot$>;
  /** @deprecated */
  sessions: $dict.Dict$<$ids.SessionId$, Origin$>;
  /** @deprecated */
  mailboxes: $dict.Dict$<string, _.List<$types.Envelope$>>;
  /** @deprecated */
  sends: $dict.Dict$<string, string>;
  /** @deprecated */
  facts: $dict.Dict$<string, $value.Value$>;
}

type Run$ = Run;

declare class Origin extends _.CustomType {
  /** @deprecated */
  constructor(
    node: $ids.Digest$,
    after: $ids.Slot$,
    attempt: number,
    dialogue: $option.Option$<$ids.Digest$>,
    layers: _.List<$ids.Digest$>
  );
  /** @deprecated */
  node: $ids.Digest$;
  /** @deprecated */
  after: $ids.Slot$;
  /** @deprecated */
  attempt: number;
  /** @deprecated */
  dialogue: $option.Option$<$ids.Digest$>;
  /** @deprecated */
  layers: _.List<$ids.Digest$>;
}

type Origin$ = Origin;

declare class CommandKind extends _.CustomType {}

declare class WorkflowKind extends _.CustomType {}

declare class AgentKind extends _.CustomType {
  /** @deprecated */
  constructor(
    session: $option.Option$<$ids.SessionId$>,
    from: _.List<$ids.Digest$>
  );
  /** @deprecated */
  session: $option.Option$<$ids.SessionId$>;
  /** @deprecated */
  from: _.List<$ids.Digest$>;
}

declare class ToolKind extends _.CustomType {
  /** @deprecated */
  constructor(replay_safe: boolean);
  /** @deprecated */
  replay_safe: boolean;
}

type Kind$ = CommandKind | WorkflowKind | AgentKind | ToolKind;

declare class Call extends _.CustomType {
  /** @deprecated */
  constructor(
    id: $ids.RequestId$,
    kind: Kind$,
    name: string,
    node: $ids.Digest$,
    input: $value.Value$,
    scope: string,
    occurrence: number,
    attempts: _.List<Attempt$>
  );
  /** @deprecated */
  id: $ids.RequestId$;
  /** @deprecated */
  kind: Kind$;
  /** @deprecated */
  name: string;
  /** @deprecated */
  node: $ids.Digest$;
  /** @deprecated */
  input: $value.Value$;
  /** @deprecated */
  scope: string;
  /** @deprecated */
  occurrence: number;
  /** @deprecated */
  attempts: _.List<Attempt$>;
}

type Call$ = Call;

declare class Running extends _.CustomType {
  /** @deprecated */
  constructor(
    issued: Issued$,
    checkpoint: $option.Option$<$ids.Digest$>,
    taken: _.List<$types.Taken$>,
    continuation: $types.Continuation$
  );
  /** @deprecated */
  issued: Issued$;
  /** @deprecated */
  checkpoint: $option.Option$<$ids.Digest$>;
  /** @deprecated */
  taken: _.List<$types.Taken$>;
  /** @deprecated */
  continuation: $types.Continuation$;
}

declare class Settled extends _.CustomType {
  /** @deprecated */
  constructor(entry: Entry$);
  /** @deprecated */
  entry: Entry$;
}

type Attempt$ = Running | Settled;

declare class NotIssued extends _.CustomType {}

declare class IssuedNow extends _.CustomType {}

declare class Pending extends _.CustomType {}

type Issued$ = NotIssued | IssuedNow | Pending;

declare class Answered extends _.CustomType {
  /** @deprecated */
  constructor(argument$0: $value.Value$);
  /** @deprecated */
  0: $value.Value$;
}

declare class Errored extends _.CustomType {
  /** @deprecated */
  constructor(argument$0: $types.FailReason$);
  /** @deprecated */
  0: $types.FailReason$;
}

declare class Decided extends _.CustomType {
  /** @deprecated */
  constructor(
    argument$0: $types.FailReason$,
    dialogue: $option.Option$<$ids.Digest$>
  );
  /** @deprecated */
  0: $types.FailReason$;
  /** @deprecated */
  dialogue: $option.Option$<$ids.Digest$>;
}

type Entry$ = Answered | Errored | Decided;

declare class Starting extends _.CustomType {
  /** @deprecated */
  constructor(
    workflow: $types.Workflow$,
    input: $value.Value$,
    semantics: string
  );
  /** @deprecated */
  workflow: $types.Workflow$;
  /** @deprecated */
  input: $value.Value$;
  /** @deprecated */
  semantics: string;
}

declare class Resuming extends _.CustomType {
  /** @deprecated */
  constructor(digest: string, semantics: string);
  /** @deprecated */
  digest: string;
  /** @deprecated */
  semantics: string;
}

declare class Noting extends _.CustomType {
  /** @deprecated */
  constructor(key: string, value: $value.Value$);
  /** @deprecated */
  key: string;
  /** @deprecated */
  value: $value.Value$;
}

declare class Applying extends _.CustomType {}

type Phase$ = Starting | Resuming | Noting | Applying;

export const semantics: string;

export function new$(): RunState$;

export function step(state: RunState$, event: $types.Event$): [
  RunState$,
  _.List<$types.Effect$>
];

export function full_state(state: RunState$): string;

export function attempt_count(state: RunState$, id: string): number;

export function host_facts(state: RunState$): $json.Json$;

export function snapshot(state: RunState$): $json.Json$;

export function mailbox(state: RunState$, address: string): _.List<
  $types.Envelope$
>;

export function slot_of(state: RunState$, id: string): string;

export function sent_id(state: RunState$, key: string): string;

export function call_state(state: RunState$, slot_text: string): string;
