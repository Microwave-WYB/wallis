import type * as $json from "../../gleam_json/gleam/json.d.mts";
import type * as $decode from "../../gleam_stdlib/gleam/dynamic/decode.d.mts";
import type * as $option from "../../gleam_stdlib/gleam/option.d.mts";
import type * as _ from "../gleam.d.mts";
import type * as $json_value from "../wallis_core/value.d.mts";

export class Workflow extends _.CustomType {
  /** @deprecated */
  constructor(name: string, digest: string);
  /** @deprecated */
  name: string;
  /** @deprecated */
  digest: string;
}
export function Workflow$Workflow(name: string, digest: string): Workflow$;
export function Workflow$isWorkflow(value: any): value is Workflow$;
export function Workflow$Workflow$0(value: Workflow$): string;
export function Workflow$Workflow$name(value: Workflow$): string;
export function Workflow$Workflow$1(value: Workflow$): string;
export function Workflow$Workflow$digest(value: Workflow$): string;

export type Workflow$ = Workflow;

export class Started extends _.CustomType {
  /** @deprecated */
  constructor(workflow: Workflow$, input: $json_value.Value$, semantics: string);
  /** @deprecated */
  workflow: Workflow$;
  /** @deprecated */
  input: $json_value.Value$;
  /** @deprecated */
  semantics: string;
}
export function Event$Started(
  workflow: Workflow$,
  input: $json_value.Value$,
  semantics: string,
): Event$;
export function Event$isStarted(value: any): value is Event$;
export function Event$Started$0(value: Event$): Workflow$;
export function Event$Started$workflow(value: Event$): Workflow$;
export function Event$Started$1(value: Event$): $json_value.Value$;
export function Event$Started$input(value: Event$): $json_value.Value$;
export function Event$Started$2(value: Event$): string;
export function Event$Started$semantics(value: Event$): string;

export class Resumed extends _.CustomType {
  /** @deprecated */
  constructor(digest: string, semantics: string);
  /** @deprecated */
  digest: string;
  /** @deprecated */
  semantics: string;
}
export function Event$Resumed(digest: string, semantics: string): Event$;
export function Event$isResumed(value: any): value is Event$;
export function Event$Resumed$0(value: Event$): string;
export function Event$Resumed$digest(value: Event$): string;
export function Event$Resumed$1(value: Event$): string;
export function Event$Resumed$semantics(value: Event$): string;

export class Requested extends _.CustomType {
  /** @deprecated */
  constructor(
    id: string,
    request: Request$,
    node: string,
    scope: string,
    occurrence: number
  );
  /** @deprecated */
  id: string;
  /** @deprecated */
  request: Request$;
  /** @deprecated */
  node: string;
  /** @deprecated */
  scope: string;
  /** @deprecated */
  occurrence: number;
}
export function Event$Requested(
  id: string,
  request: Request$,
  node: string,
  scope: string,
  occurrence: number,
): Event$;
export function Event$isRequested(value: any): value is Event$;
export function Event$Requested$0(value: Event$): string;
export function Event$Requested$id(value: Event$): string;
export function Event$Requested$1(value: Event$): Request$;
export function Event$Requested$request(value: Event$): Request$;
export function Event$Requested$2(value: Event$): string;
export function Event$Requested$node(value: Event$): string;
export function Event$Requested$3(value: Event$): string;
export function Event$Requested$scope(value: Event$): string;
export function Event$Requested$4(value: Event$): number;
export function Event$Requested$occurrence(value: Event$): number;

export class AgentProgressed extends _.CustomType {
  /** @deprecated */
  constructor(id: string, checkpoint: string);
  /** @deprecated */
  id: string;
  /** @deprecated */
  checkpoint: string;
}
export function Event$AgentProgressed(id: string, checkpoint: string): Event$;
export function Event$isAgentProgressed(value: any): value is Event$;
export function Event$AgentProgressed$0(value: Event$): string;
export function Event$AgentProgressed$id(value: Event$): string;
export function Event$AgentProgressed$1(value: Event$): string;
export function Event$AgentProgressed$checkpoint(value: Event$): string;

export class MessagesTaken extends _.CustomType {
  /** @deprecated */
  constructor(id: string, messages: _.List<string>, turn: number);
  /** @deprecated */
  id: string;
  /** @deprecated */
  messages: _.List<string>;
  /** @deprecated */
  turn: number;
}
export function Event$MessagesTaken(
  id: string,
  messages: _.List<string>,
  turn: number,
): Event$;
export function Event$isMessagesTaken(value: any): value is Event$;
export function Event$MessagesTaken$0(value: Event$): string;
export function Event$MessagesTaken$id(value: Event$): string;
export function Event$MessagesTaken$1(value: Event$): _.List<string>;
export function Event$MessagesTaken$messages(value: Event$): _.List<string>;
export function Event$MessagesTaken$2(value: Event$): number;
export function Event$MessagesTaken$turn(value: Event$): number;

export class AgentReturned extends _.CustomType {
  /** @deprecated */
  constructor(
    id: string,
    output: $json_value.Value$,
    model: string,
    dialogue: string,
    layers: _.List<string>
  );
  /** @deprecated */
  id: string;
  /** @deprecated */
  output: $json_value.Value$;
  /** @deprecated */
  model: string;
  /** @deprecated */
  dialogue: string;
  /** @deprecated */
  layers: _.List<string>;
}
export function Event$AgentReturned(
  id: string,
  output: $json_value.Value$,
  model: string,
  dialogue: string,
  layers: _.List<string>,
): Event$;
export function Event$isAgentReturned(value: any): value is Event$;
export function Event$AgentReturned$0(value: Event$): string;
export function Event$AgentReturned$id(value: Event$): string;
export function Event$AgentReturned$1(value: Event$): $json_value.Value$;
export function Event$AgentReturned$output(value: Event$): $json_value.Value$;
export function Event$AgentReturned$2(value: Event$): string;
export function Event$AgentReturned$model(value: Event$): string;
export function Event$AgentReturned$3(value: Event$): string;
export function Event$AgentReturned$dialogue(value: Event$): string;
export function Event$AgentReturned$4(value: Event$): _.List<string>;
export function Event$AgentReturned$layers(value: Event$): _.List<string>;

export class AgentFailed extends _.CustomType {
  /** @deprecated */
  constructor(
    id: string,
    failure: AgentFailure$,
    model: string,
    dialogue: $option.Option$<string>,
    layers: _.List<string>
  );
  /** @deprecated */
  id: string;
  /** @deprecated */
  failure: AgentFailure$;
  /** @deprecated */
  model: string;
  /** @deprecated */
  dialogue: $option.Option$<string>;
  /** @deprecated */
  layers: _.List<string>;
}
export function Event$AgentFailed(
  id: string,
  failure: AgentFailure$,
  model: string,
  dialogue: $option.Option$<string>,
  layers: _.List<string>,
): Event$;
export function Event$isAgentFailed(value: any): value is Event$;
export function Event$AgentFailed$0(value: Event$): string;
export function Event$AgentFailed$id(value: Event$): string;
export function Event$AgentFailed$1(value: Event$): AgentFailure$;
export function Event$AgentFailed$failure(value: Event$): AgentFailure$;
export function Event$AgentFailed$2(value: Event$): string;
export function Event$AgentFailed$model(value: Event$): string;
export function Event$AgentFailed$3(value: Event$): $option.Option$<string>;
export function Event$AgentFailed$dialogue(value: Event$): $option.Option$<
  string
>;
export function Event$AgentFailed$4(value: Event$): _.List<string>;
export function Event$AgentFailed$layers(value: Event$): _.List<string>;

export class Sent extends _.CustomType {
  /** @deprecated */
  constructor(
    key: string,
    to: string,
    from: string,
    reply_to: $option.Option$<string>,
    body: $json_value.Value$
  );
  /** @deprecated */
  key: string;
  /** @deprecated */
  to: string;
  /** @deprecated */
  from: string;
  /** @deprecated */
  reply_to: $option.Option$<string>;
  /** @deprecated */
  body: $json_value.Value$;
}
export function Event$Sent(
  key: string,
  to: string,
  from: string,
  reply_to: $option.Option$<string>,
  body: $json_value.Value$,
): Event$;
export function Event$isSent(value: any): value is Event$;
export function Event$Sent$0(value: Event$): string;
export function Event$Sent$key(value: Event$): string;
export function Event$Sent$1(value: Event$): string;
export function Event$Sent$to(value: Event$): string;
export function Event$Sent$2(value: Event$): string;
export function Event$Sent$from(value: Event$): string;
export function Event$Sent$3(value: Event$): $option.Option$<string>;
export function Event$Sent$reply_to(value: Event$): $option.Option$<string>;
export function Event$Sent$4(value: Event$): $json_value.Value$;
export function Event$Sent$body(value: Event$): $json_value.Value$;

export class ToolReturned extends _.CustomType {
  /** @deprecated */
  constructor(id: string, output: $json_value.Value$);
  /** @deprecated */
  id: string;
  /** @deprecated */
  output: $json_value.Value$;
}
export function Event$ToolReturned(
  id: string,
  output: $json_value.Value$,
): Event$;
export function Event$isToolReturned(value: any): value is Event$;
export function Event$ToolReturned$0(value: Event$): string;
export function Event$ToolReturned$id(value: Event$): string;
export function Event$ToolReturned$1(value: Event$): $json_value.Value$;
export function Event$ToolReturned$output(value: Event$): $json_value.Value$;

export class ToolFailed extends _.CustomType {
  /** @deprecated */
  constructor(id: string, message: string);
  /** @deprecated */
  id: string;
  /** @deprecated */
  message: string;
}
export function Event$ToolFailed(id: string, message: string): Event$;
export function Event$isToolFailed(value: any): value is Event$;
export function Event$ToolFailed$0(value: Event$): string;
export function Event$ToolFailed$id(value: Event$): string;
export function Event$ToolFailed$1(value: Event$): string;
export function Event$ToolFailed$message(value: Event$): string;

export class Retried extends _.CustomType {
  /** @deprecated */
  constructor(call: string, turns: number);
  /** @deprecated */
  call: string;
  /** @deprecated */
  turns: number;
}
export function Event$Retried(call: string, turns: number): Event$;
export function Event$isRetried(value: any): value is Event$;
export function Event$Retried$0(value: Event$): string;
export function Event$Retried$call(value: Event$): string;
export function Event$Retried$1(value: Event$): number;
export function Event$Retried$turns(value: Event$): number;

export class CommandReturned extends _.CustomType {
  /** @deprecated */
  constructor(id: string, output: $json_value.Value$);
  /** @deprecated */
  id: string;
  /** @deprecated */
  output: $json_value.Value$;
}
export function Event$CommandReturned(
  id: string,
  output: $json_value.Value$,
): Event$;
export function Event$isCommandReturned(value: any): value is Event$;
export function Event$CommandReturned$0(value: Event$): string;
export function Event$CommandReturned$id(value: Event$): string;
export function Event$CommandReturned$1(value: Event$): $json_value.Value$;
export function Event$CommandReturned$output(value: Event$): $json_value.Value$;

export class CommandFailed extends _.CustomType {
  /** @deprecated */
  constructor(id: string, failure: CommandFailure$);
  /** @deprecated */
  id: string;
  /** @deprecated */
  failure: CommandFailure$;
}
export function Event$CommandFailed(
  id: string,
  failure: CommandFailure$,
): Event$;
export function Event$isCommandFailed(value: any): value is Event$;
export function Event$CommandFailed$0(value: Event$): string;
export function Event$CommandFailed$id(value: Event$): string;
export function Event$CommandFailed$1(value: Event$): CommandFailure$;
export function Event$CommandFailed$failure(value: Event$): CommandFailure$;

export class WorkflowReturned extends _.CustomType {
  /** @deprecated */
  constructor(id: string, output: $json_value.Value$);
  /** @deprecated */
  id: string;
  /** @deprecated */
  output: $json_value.Value$;
}
export function Event$WorkflowReturned(
  id: string,
  output: $json_value.Value$,
): Event$;
export function Event$isWorkflowReturned(value: any): value is Event$;
export function Event$WorkflowReturned$0(value: Event$): string;
export function Event$WorkflowReturned$id(value: Event$): string;
export function Event$WorkflowReturned$1(value: Event$): $json_value.Value$;
export function Event$WorkflowReturned$output(value: Event$): $json_value.Value$;

export class WorkflowFailed extends _.CustomType {
  /** @deprecated */
  constructor(id: string, reason: FailReason$);
  /** @deprecated */
  id: string;
  /** @deprecated */
  reason: FailReason$;
}
export function Event$WorkflowFailed(id: string, reason: FailReason$): Event$;
export function Event$isWorkflowFailed(value: any): value is Event$;
export function Event$WorkflowFailed$0(value: Event$): string;
export function Event$WorkflowFailed$id(value: Event$): string;
export function Event$WorkflowFailed$1(value: Event$): FailReason$;
export function Event$WorkflowFailed$reason(value: Event$): FailReason$;

export class Noted extends _.CustomType {
  /** @deprecated */
  constructor(key: string, value: $json_value.Value$);
  /** @deprecated */
  key: string;
  /** @deprecated */
  value: $json_value.Value$;
}
export function Event$Noted(key: string, value: $json_value.Value$): Event$;
export function Event$isNoted(value: any): value is Event$;
export function Event$Noted$0(value: Event$): string;
export function Event$Noted$key(value: Event$): string;
export function Event$Noted$1(value: Event$): $json_value.Value$;
export function Event$Noted$value(value: Event$): $json_value.Value$;

export class BodyFinished extends _.CustomType {
  /** @deprecated */
  constructor(output: $json_value.Value$);
  /** @deprecated */
  output: $json_value.Value$;
}
export function Event$BodyFinished(output: $json_value.Value$): Event$;
export function Event$isBodyFinished(value: any): value is Event$;
export function Event$BodyFinished$0(value: Event$): $json_value.Value$;
export function Event$BodyFinished$output(value: Event$): $json_value.Value$;

export class BodyFailed extends _.CustomType {
  /** @deprecated */
  constructor(reason: FailReason$);
  /** @deprecated */
  reason: FailReason$;
}
export function Event$BodyFailed(reason: FailReason$): Event$;
export function Event$isBodyFailed(value: any): value is Event$;
export function Event$BodyFailed$0(value: Event$): FailReason$;
export function Event$BodyFailed$reason(value: Event$): FailReason$;

export type Event$ = Started | Resumed | Requested | AgentProgressed | MessagesTaken | AgentReturned | AgentFailed | Sent | ToolReturned | ToolFailed | Retried | CommandReturned | CommandFailed | WorkflowReturned | WorkflowFailed | Noted | BodyFinished | BodyFailed;

export class CommandCall extends _.CustomType {
  /** @deprecated */
  constructor(name: string, input: $json_value.Value$);
  /** @deprecated */
  name: string;
  /** @deprecated */
  input: $json_value.Value$;
}
export function Request$CommandCall(
  name: string,
  input: $json_value.Value$,
): Request$;
export function Request$isCommandCall(value: any): value is Request$;
export function Request$CommandCall$0(value: Request$): string;
export function Request$CommandCall$name(value: Request$): string;
export function Request$CommandCall$1(value: Request$): $json_value.Value$;
export function Request$CommandCall$input(value: Request$): $json_value.Value$;

export class WorkflowCall extends _.CustomType {
  /** @deprecated */
  constructor(name: string, input: $json_value.Value$);
  /** @deprecated */
  name: string;
  /** @deprecated */
  input: $json_value.Value$;
}
export function Request$WorkflowCall(
  name: string,
  input: $json_value.Value$,
): Request$;
export function Request$isWorkflowCall(value: any): value is Request$;
export function Request$WorkflowCall$0(value: Request$): string;
export function Request$WorkflowCall$name(value: Request$): string;
export function Request$WorkflowCall$1(value: Request$): $json_value.Value$;
export function Request$WorkflowCall$input(value: Request$): $json_value.Value$;

export class AgentCall extends _.CustomType {
  /** @deprecated */
  constructor(
    name: string,
    input: $json_value.Value$,
    session: $option.Option$<string>,
    from: _.List<string>
  );
  /** @deprecated */
  name: string;
  /** @deprecated */
  input: $json_value.Value$;
  /** @deprecated */
  session: $option.Option$<string>;
  /** @deprecated */
  from: _.List<string>;
}
export function Request$AgentCall(
  name: string,
  input: $json_value.Value$,
  session: $option.Option$<string>,
  from: _.List<string>,
): Request$;
export function Request$isAgentCall(value: any): value is Request$;
export function Request$AgentCall$0(value: Request$): string;
export function Request$AgentCall$name(value: Request$): string;
export function Request$AgentCall$1(value: Request$): $json_value.Value$;
export function Request$AgentCall$input(value: Request$): $json_value.Value$;
export function Request$AgentCall$2(value: Request$): $option.Option$<string>;
export function Request$AgentCall$session(value: Request$): $option.Option$<
  string
>;
export function Request$AgentCall$3(value: Request$): _.List<string>;
export function Request$AgentCall$from(value: Request$): _.List<string>;

export class ToolCall extends _.CustomType {
  /** @deprecated */
  constructor(name: string, input: $json_value.Value$, replay_safe: boolean);
  /** @deprecated */
  name: string;
  /** @deprecated */
  input: $json_value.Value$;
  /** @deprecated */
  replay_safe: boolean;
}
export function Request$ToolCall(
  name: string,
  input: $json_value.Value$,
  replay_safe: boolean,
): Request$;
export function Request$isToolCall(value: any): value is Request$;
export function Request$ToolCall$0(value: Request$): string;
export function Request$ToolCall$name(value: Request$): string;
export function Request$ToolCall$1(value: Request$): $json_value.Value$;
export function Request$ToolCall$input(value: Request$): $json_value.Value$;
export function Request$ToolCall$2(value: Request$): boolean;
export function Request$ToolCall$replay_safe(value: Request$): boolean;

export type Request$ = CommandCall | WorkflowCall | AgentCall | ToolCall;

export function Request$input(value: Request$): $json_value.Value$;
export function Request$name(value: Request$): string;

export class Fresh extends _.CustomType {}
export function Continuation$Fresh(): Continuation$;
export function Continuation$isFresh(value: any): value is Continuation$;

export class MoreTurns extends _.CustomType {
  /** @deprecated */
  constructor(turns: number);
  /** @deprecated */
  turns: number;
}
export function Continuation$MoreTurns(turns: number): Continuation$;
export function Continuation$isMoreTurns(value: any): value is Continuation$;
export function Continuation$MoreTurns$0(value: Continuation$): number;
export function Continuation$MoreTurns$turns(value: Continuation$): number;

export class FixOutput extends _.CustomType {
  /** @deprecated */
  constructor(errors: _.List<string>);
  /** @deprecated */
  errors: _.List<string>;
}
export function Continuation$FixOutput(errors: _.List<string>): Continuation$;
export function Continuation$isFixOutput(value: any): value is Continuation$;
export function Continuation$FixOutput$0(value: Continuation$): _.List<string>;
export function Continuation$FixOutput$errors(value: Continuation$): _.List<
  string
>;

export type Continuation$ = Fresh | MoreTurns | FixOutput;

export class TurnLimitReached extends _.CustomType {
  /** @deprecated */
  constructor(turns: number);
  /** @deprecated */
  turns: number;
}
export function AgentFailure$TurnLimitReached(turns: number): AgentFailure$;
export function AgentFailure$isTurnLimitReached(
  value: any,
): value is AgentFailure$;
export function AgentFailure$TurnLimitReached$0(value: AgentFailure$): number;
export function AgentFailure$TurnLimitReached$turns(value: AgentFailure$): number;

export class GaveUp extends _.CustomType {
  /** @deprecated */
  constructor(error: string);
  /** @deprecated */
  error: string;
}
export function AgentFailure$GaveUp(error: string): AgentFailure$;
export function AgentFailure$isGaveUp(value: any): value is AgentFailure$;
export function AgentFailure$GaveUp$0(value: AgentFailure$): string;
export function AgentFailure$GaveUp$error(value: AgentFailure$): string;

export class ContextExhausted extends _.CustomType {}
export function AgentFailure$ContextExhausted(): AgentFailure$;
export function AgentFailure$isContextExhausted(
  value: any,
): value is AgentFailure$;

export class InvalidOutput extends _.CustomType {
  /** @deprecated */
  constructor(errors: _.List<string>);
  /** @deprecated */
  errors: _.List<string>;
}
export function AgentFailure$InvalidOutput(
  errors: _.List<string>,
): AgentFailure$;
export function AgentFailure$isInvalidOutput(
  value: any,
): value is AgentFailure$;
export function AgentFailure$InvalidOutput$0(value: AgentFailure$): _.List<
  string
>;
export function AgentFailure$InvalidOutput$errors(value: AgentFailure$): _.List<
  string
>;

export type AgentFailure$ = TurnLimitReached | GaveUp | ContextExhausted | InvalidOutput;

export class Envelope extends _.CustomType {
  /** @deprecated */
  constructor(
    id: string,
    from: string,
    reply_to: $option.Option$<string>,
    body: $json_value.Value$
  );
  /** @deprecated */
  id: string;
  /** @deprecated */
  from: string;
  /** @deprecated */
  reply_to: $option.Option$<string>;
  /** @deprecated */
  body: $json_value.Value$;
}
export function Envelope$Envelope(
  id: string,
  from: string,
  reply_to: $option.Option$<string>,
  body: $json_value.Value$,
): Envelope$;
export function Envelope$isEnvelope(value: any): value is Envelope$;
export function Envelope$Envelope$0(value: Envelope$): string;
export function Envelope$Envelope$id(value: Envelope$): string;
export function Envelope$Envelope$1(value: Envelope$): string;
export function Envelope$Envelope$from(value: Envelope$): string;
export function Envelope$Envelope$2(value: Envelope$): $option.Option$<string>;
export function Envelope$Envelope$reply_to(value: Envelope$): $option.Option$<
  string
>;
export function Envelope$Envelope$3(value: Envelope$): $json_value.Value$;
export function Envelope$Envelope$body(value: Envelope$): $json_value.Value$;

export type Envelope$ = Envelope;

export class Taken extends _.CustomType {
  /** @deprecated */
  constructor(turn: number, messages: _.List<string>);
  /** @deprecated */
  turn: number;
  /** @deprecated */
  messages: _.List<string>;
}
export function Taken$Taken(turn: number, messages: _.List<string>): Taken$;
export function Taken$isTaken(value: any): value is Taken$;
export function Taken$Taken$0(value: Taken$): number;
export function Taken$Taken$turn(value: Taken$): number;
export function Taken$Taken$1(value: Taken$): _.List<string>;
export function Taken$Taken$messages(value: Taken$): _.List<string>;

export type Taken$ = Taken;

export class ExitCode extends _.CustomType {
  /** @deprecated */
  constructor(code: number, stderr_head: string);
  /** @deprecated */
  code: number;
  /** @deprecated */
  stderr_head: string;
}
export function CommandFailure$ExitCode(
  code: number,
  stderr_head: string,
): CommandFailure$;
export function CommandFailure$isExitCode(value: any): value is CommandFailure$;
export function CommandFailure$ExitCode$0(value: CommandFailure$): number;
export function CommandFailure$ExitCode$code(value: CommandFailure$): number;
export function CommandFailure$ExitCode$1(value: CommandFailure$): string;
export function CommandFailure$ExitCode$stderr_head(value: CommandFailure$): string;

export class Killed extends _.CustomType {
  /** @deprecated */
  constructor(signal: string, stderr_head: string);
  /** @deprecated */
  signal: string;
  /** @deprecated */
  stderr_head: string;
}
export function CommandFailure$Killed(
  signal: string,
  stderr_head: string,
): CommandFailure$;
export function CommandFailure$isKilled(value: any): value is CommandFailure$;
export function CommandFailure$Killed$0(value: CommandFailure$): string;
export function CommandFailure$Killed$signal(value: CommandFailure$): string;
export function CommandFailure$Killed$1(value: CommandFailure$): string;
export function CommandFailure$Killed$stderr_head(value: CommandFailure$): string;

export class OutputMismatch extends _.CustomType {
  /** @deprecated */
  constructor(errors: _.List<string>);
  /** @deprecated */
  errors: _.List<string>;
}
export function CommandFailure$OutputMismatch(
  errors: _.List<string>,
): CommandFailure$;
export function CommandFailure$isOutputMismatch(
  value: any,
): value is CommandFailure$;
export function CommandFailure$OutputMismatch$0(value: CommandFailure$): _.List<
  string
>;
export function CommandFailure$OutputMismatch$errors(value: CommandFailure$): _.List<
  string
>;

export class MissingFile extends _.CustomType {
  /** @deprecated */
  constructor(name: string);
  /** @deprecated */
  name: string;
}
export function CommandFailure$MissingFile(name: string): CommandFailure$;
export function CommandFailure$isMissingFile(
  value: any,
): value is CommandFailure$;
export function CommandFailure$MissingFile$0(value: CommandFailure$): string;
export function CommandFailure$MissingFile$name(value: CommandFailure$): string;

export class ParseError extends _.CustomType {
  /** @deprecated */
  constructor(message: string);
  /** @deprecated */
  message: string;
}
export function CommandFailure$ParseError(message: string): CommandFailure$;
export function CommandFailure$isParseError(
  value: any,
): value is CommandFailure$;
export function CommandFailure$ParseError$0(value: CommandFailure$): string;
export function CommandFailure$ParseError$message(value: CommandFailure$): string;

export class Unrunnable extends _.CustomType {
  /** @deprecated */
  constructor(error: string);
  /** @deprecated */
  error: string;
}
export function CommandFailure$Unrunnable(error: string): CommandFailure$;
export function CommandFailure$isUnrunnable(
  value: any,
): value is CommandFailure$;
export function CommandFailure$Unrunnable$0(value: CommandFailure$): string;
export function CommandFailure$Unrunnable$error(value: CommandFailure$): string;

export type CommandFailure$ = ExitCode | Killed | OutputMismatch | MissingFile | ParseError | Unrunnable;

export class BodyError extends _.CustomType {
  /** @deprecated */
  constructor(message: string);
  /** @deprecated */
  message: string;
}
export function FailReason$BodyError(message: string): FailReason$;
export function FailReason$isBodyError(value: any): value is FailReason$;
export function FailReason$BodyError$0(value: FailReason$): string;
export function FailReason$BodyError$message(value: FailReason$): string;

export class CommandError extends _.CustomType {
  /** @deprecated */
  constructor(command: string, failure: CommandFailure$);
  /** @deprecated */
  command: string;
  /** @deprecated */
  failure: CommandFailure$;
}
export function FailReason$CommandError(
  command: string,
  failure: CommandFailure$,
): FailReason$;
export function FailReason$isCommandError(value: any): value is FailReason$;
export function FailReason$CommandError$0(value: FailReason$): string;
export function FailReason$CommandError$command(value: FailReason$): string;
export function FailReason$CommandError$1(value: FailReason$): CommandFailure$;
export function FailReason$CommandError$failure(value: FailReason$): CommandFailure$;

export class WorkflowError extends _.CustomType {
  /** @deprecated */
  constructor(workflow: string, reason: FailReason$);
  /** @deprecated */
  workflow: string;
  /** @deprecated */
  reason: FailReason$;
}
export function FailReason$WorkflowError(
  workflow: string,
  reason: FailReason$,
): FailReason$;
export function FailReason$isWorkflowError(value: any): value is FailReason$;
export function FailReason$WorkflowError$0(value: FailReason$): string;
export function FailReason$WorkflowError$workflow(value: FailReason$): string;
export function FailReason$WorkflowError$1(value: FailReason$): FailReason$;
export function FailReason$WorkflowError$reason(value: FailReason$): FailReason$;

export class AgentError extends _.CustomType {
  /** @deprecated */
  constructor(
    agent: string,
    failure: AgentFailure$,
    session: $option.Option$<string>
  );
  /** @deprecated */
  agent: string;
  /** @deprecated */
  failure: AgentFailure$;
  /** @deprecated */
  session: $option.Option$<string>;
}
export function FailReason$AgentError(
  agent: string,
  failure: AgentFailure$,
  session: $option.Option$<string>,
): FailReason$;
export function FailReason$isAgentError(value: any): value is FailReason$;
export function FailReason$AgentError$0(value: FailReason$): string;
export function FailReason$AgentError$agent(value: FailReason$): string;
export function FailReason$AgentError$1(value: FailReason$): AgentFailure$;
export function FailReason$AgentError$failure(value: FailReason$): AgentFailure$;
export function FailReason$AgentError$2(
  value: FailReason$,
): $option.Option$<string>;
export function FailReason$AgentError$session(value: FailReason$): $option.Option$<
  string
>;

export class ToolError extends _.CustomType {
  /** @deprecated */
  constructor(tool: string, message: string);
  /** @deprecated */
  tool: string;
  /** @deprecated */
  message: string;
}
export function FailReason$ToolError(
  tool: string,
  message: string,
): FailReason$;
export function FailReason$isToolError(value: any): value is FailReason$;
export function FailReason$ToolError$0(value: FailReason$): string;
export function FailReason$ToolError$tool(value: FailReason$): string;
export function FailReason$ToolError$1(value: FailReason$): string;
export function FailReason$ToolError$message(value: FailReason$): string;

export class SchemaMismatch extends _.CustomType {
  /** @deprecated */
  constructor(node: string, errors: _.List<string>);
  /** @deprecated */
  node: string;
  /** @deprecated */
  errors: _.List<string>;
}
export function FailReason$SchemaMismatch(
  node: string,
  errors: _.List<string>,
): FailReason$;
export function FailReason$isSchemaMismatch(value: any): value is FailReason$;
export function FailReason$SchemaMismatch$0(value: FailReason$): string;
export function FailReason$SchemaMismatch$node(value: FailReason$): string;
export function FailReason$SchemaMismatch$1(value: FailReason$): _.List<string>;
export function FailReason$SchemaMismatch$errors(value: FailReason$): _.List<
  string
>;

export type FailReason$ = BodyError | CommandError | WorkflowError | AgentError | ToolError | SchemaMismatch;

export class Done extends _.CustomType {
  /** @deprecated */
  constructor(value: $json_value.Value$);
  /** @deprecated */
  value: $json_value.Value$;
}
export function Outcome$Done(value: $json_value.Value$): Outcome$;
export function Outcome$isDone(value: any): value is Outcome$;
export function Outcome$Done$0(value: Outcome$): $json_value.Value$;
export function Outcome$Done$value(value: Outcome$): $json_value.Value$;

export class Failed extends _.CustomType {
  /** @deprecated */
  constructor(reason: FailReason$);
  /** @deprecated */
  reason: FailReason$;
}
export function Outcome$Failed(reason: FailReason$): Outcome$;
export function Outcome$isFailed(value: any): value is Outcome$;
export function Outcome$Failed$0(value: Outcome$): FailReason$;
export function Outcome$Failed$reason(value: Outcome$): FailReason$;

export type Outcome$ = Done | Failed;

export class NotStarted extends _.CustomType {}
export function Refusal$NotStarted(): Refusal$;
export function Refusal$isNotStarted(value: any): value is Refusal$;

export class AlreadyStarted extends _.CustomType {}
export function Refusal$AlreadyStarted(): Refusal$;
export function Refusal$isAlreadyStarted(value: any): value is Refusal$;

export class RunEnded extends _.CustomType {}
export function Refusal$RunEnded(): Refusal$;
export function Refusal$isRunEnded(value: any): value is Refusal$;

export class SemanticsChanged extends _.CustomType {
  /** @deprecated */
  constructor(recorded: string, current: string);
  /** @deprecated */
  recorded: string;
  /** @deprecated */
  current: string;
}
export function Refusal$SemanticsChanged(
  recorded: string,
  current: string,
): Refusal$;
export function Refusal$isSemanticsChanged(value: any): value is Refusal$;
export function Refusal$SemanticsChanged$0(value: Refusal$): string;
export function Refusal$SemanticsChanged$recorded(value: Refusal$): string;
export function Refusal$SemanticsChanged$1(value: Refusal$): string;
export function Refusal$SemanticsChanged$current(value: Refusal$): string;

export class UnknownRequest extends _.CustomType {
  /** @deprecated */
  constructor(id: string);
  /** @deprecated */
  id: string;
}
export function Refusal$UnknownRequest(id: string): Refusal$;
export function Refusal$isUnknownRequest(value: any): value is Refusal$;
export function Refusal$UnknownRequest$0(value: Refusal$): string;
export function Refusal$UnknownRequest$id(value: Refusal$): string;

export class NotRunning extends _.CustomType {
  /** @deprecated */
  constructor(id: string);
  /** @deprecated */
  id: string;
}
export function Refusal$NotRunning(id: string): Refusal$;
export function Refusal$isNotRunning(value: any): value is Refusal$;
export function Refusal$NotRunning$0(value: Refusal$): string;
export function Refusal$NotRunning$id(value: Refusal$): string;

export class UnknownSession extends _.CustomType {
  /** @deprecated */
  constructor(session: string);
  /** @deprecated */
  session: string;
}
export function Refusal$UnknownSession(session: string): Refusal$;
export function Refusal$isUnknownSession(value: any): value is Refusal$;
export function Refusal$UnknownSession$0(value: Refusal$): string;
export function Refusal$UnknownSession$session(value: Refusal$): string;

export class SessionOfAnotherAgent extends _.CustomType {
  /** @deprecated */
  constructor(session: string);
  /** @deprecated */
  session: string;
}
export function Refusal$SessionOfAnotherAgent(session: string): Refusal$;
export function Refusal$isSessionOfAnotherAgent(value: any): value is Refusal$;
export function Refusal$SessionOfAnotherAgent$0(value: Refusal$): string;
export function Refusal$SessionOfAnotherAgent$session(value: Refusal$): string;

export class NotRetriable extends _.CustomType {
  /** @deprecated */
  constructor(call: string);
  /** @deprecated */
  call: string;
}
export function Refusal$NotRetriable(call: string): Refusal$;
export function Refusal$isNotRetriable(value: any): value is Refusal$;
export function Refusal$NotRetriable$0(value: Refusal$): string;
export function Refusal$NotRetriable$call(value: Refusal$): string;

export class InvalidEvent extends _.CustomType {
  /** @deprecated */
  constructor(message: string);
  /** @deprecated */
  message: string;
}
export function Refusal$InvalidEvent(message: string): Refusal$;
export function Refusal$isInvalidEvent(value: any): value is Refusal$;
export function Refusal$InvalidEvent$0(value: Refusal$): string;
export function Refusal$InvalidEvent$message(value: Refusal$): string;

export type Refusal$ = NotStarted | AlreadyStarted | RunEnded | SemanticsChanged | UnknownRequest | NotRunning | UnknownSession | SessionOfAnotherAgent | NotRetriable | InvalidEvent;

export class Checkpoint extends _.CustomType {}
export function Effect$Checkpoint(): Effect$;
export function Effect$isCheckpoint(value: any): value is Effect$;

export class RunCommand extends _.CustomType {
  /** @deprecated */
  constructor(id: string, attempt: number);
  /** @deprecated */
  id: string;
  /** @deprecated */
  attempt: number;
}
export function Effect$RunCommand(id: string, attempt: number): Effect$;
export function Effect$isRunCommand(value: any): value is Effect$;
export function Effect$RunCommand$0(value: Effect$): string;
export function Effect$RunCommand$id(value: Effect$): string;
export function Effect$RunCommand$1(value: Effect$): number;
export function Effect$RunCommand$attempt(value: Effect$): number;

export class RunWorkflow extends _.CustomType {
  /** @deprecated */
  constructor(id: string, scope: string, attempt: number);
  /** @deprecated */
  id: string;
  /** @deprecated */
  scope: string;
  /** @deprecated */
  attempt: number;
}
export function Effect$RunWorkflow(
  id: string,
  scope: string,
  attempt: number,
): Effect$;
export function Effect$isRunWorkflow(value: any): value is Effect$;
export function Effect$RunWorkflow$0(value: Effect$): string;
export function Effect$RunWorkflow$id(value: Effect$): string;
export function Effect$RunWorkflow$1(value: Effect$): string;
export function Effect$RunWorkflow$scope(value: Effect$): string;
export function Effect$RunWorkflow$2(value: Effect$): number;
export function Effect$RunWorkflow$attempt(value: Effect$): number;

export class CallAgent extends _.CustomType {
  /** @deprecated */
  constructor(
    id: string,
    attempt: number,
    mailbox: string,
    history: $option.Option$<string>,
    layers: _.List<string>,
    checkpoint: $option.Option$<string>,
    taken: _.List<Taken$>,
    continuation: Continuation$
  );
  /** @deprecated */
  id: string;
  /** @deprecated */
  attempt: number;
  /** @deprecated */
  mailbox: string;
  /** @deprecated */
  history: $option.Option$<string>;
  /** @deprecated */
  layers: _.List<string>;
  /** @deprecated */
  checkpoint: $option.Option$<string>;
  /** @deprecated */
  taken: _.List<Taken$>;
  /** @deprecated */
  continuation: Continuation$;
}
export function Effect$CallAgent(
  id: string,
  attempt: number,
  mailbox: string,
  history: $option.Option$<string>,
  layers: _.List<string>,
  checkpoint: $option.Option$<string>,
  taken: _.List<Taken$>,
  continuation: Continuation$,
): Effect$;
export function Effect$isCallAgent(value: any): value is Effect$;
export function Effect$CallAgent$0(value: Effect$): string;
export function Effect$CallAgent$id(value: Effect$): string;
export function Effect$CallAgent$1(value: Effect$): number;
export function Effect$CallAgent$attempt(value: Effect$): number;
export function Effect$CallAgent$2(value: Effect$): string;
export function Effect$CallAgent$mailbox(value: Effect$): string;
export function Effect$CallAgent$3(value: Effect$): $option.Option$<string>;
export function Effect$CallAgent$history(value: Effect$): $option.Option$<
  string
>;
export function Effect$CallAgent$4(value: Effect$): _.List<string>;
export function Effect$CallAgent$layers(value: Effect$): _.List<string>;
export function Effect$CallAgent$5(value: Effect$): $option.Option$<string>;
export function Effect$CallAgent$checkpoint(value: Effect$): $option.Option$<
  string
>;
export function Effect$CallAgent$6(value: Effect$): _.List<Taken$>;
export function Effect$CallAgent$taken(value: Effect$): _.List<Taken$>;
export function Effect$CallAgent$7(value: Effect$): Continuation$;
export function Effect$CallAgent$continuation(value: Effect$): Continuation$;

export class RunTool extends _.CustomType {
  /** @deprecated */
  constructor(id: string, attempt: number);
  /** @deprecated */
  id: string;
  /** @deprecated */
  attempt: number;
}
export function Effect$RunTool(id: string, attempt: number): Effect$;
export function Effect$isRunTool(value: any): value is Effect$;
export function Effect$RunTool$0(value: Effect$): string;
export function Effect$RunTool$id(value: Effect$): string;
export function Effect$RunTool$1(value: Effect$): number;
export function Effect$RunTool$attempt(value: Effect$): number;

export class Delivered extends _.CustomType {
  /** @deprecated */
  constructor(mailbox: string, message: Envelope$);
  /** @deprecated */
  mailbox: string;
  /** @deprecated */
  message: Envelope$;
}
export function Effect$Delivered(mailbox: string, message: Envelope$): Effect$;
export function Effect$isDelivered(value: any): value is Effect$;
export function Effect$Delivered$0(value: Effect$): string;
export function Effect$Delivered$mailbox(value: Effect$): string;
export function Effect$Delivered$1(value: Effect$): Envelope$;
export function Effect$Delivered$message(value: Effect$): Envelope$;

export class Deliver extends _.CustomType {
  /** @deprecated */
  constructor(id: string, value: $json_value.Value$);
  /** @deprecated */
  id: string;
  /** @deprecated */
  value: $json_value.Value$;
}
export function Effect$Deliver(id: string, value: $json_value.Value$): Effect$;
export function Effect$isDeliver(value: any): value is Effect$;
export function Effect$Deliver$0(value: Effect$): string;
export function Effect$Deliver$id(value: Effect$): string;
export function Effect$Deliver$1(value: Effect$): $json_value.Value$;
export function Effect$Deliver$value(value: Effect$): $json_value.Value$;

export class Fail extends _.CustomType {
  /** @deprecated */
  constructor(id: string, reason: FailReason$);
  /** @deprecated */
  id: string;
  /** @deprecated */
  reason: FailReason$;
}
export function Effect$Fail(id: string, reason: FailReason$): Effect$;
export function Effect$isFail(value: any): value is Effect$;
export function Effect$Fail$0(value: Effect$): string;
export function Effect$Fail$id(value: Effect$): string;
export function Effect$Fail$1(value: Effect$): FailReason$;
export function Effect$Fail$reason(value: Effect$): FailReason$;

export class Refuse extends _.CustomType {
  /** @deprecated */
  constructor(id: $option.Option$<string>, refusal: Refusal$);
  /** @deprecated */
  id: $option.Option$<string>;
  /** @deprecated */
  refusal: Refusal$;
}
export function Effect$Refuse(
  id: $option.Option$<string>,
  refusal: Refusal$,
): Effect$;
export function Effect$isRefuse(value: any): value is Effect$;
export function Effect$Refuse$0(value: Effect$): $option.Option$<string>;
export function Effect$Refuse$id(value: Effect$): $option.Option$<string>;
export function Effect$Refuse$1(value: Effect$): Refusal$;
export function Effect$Refuse$refusal(value: Effect$): Refusal$;

export class Finish extends _.CustomType {
  /** @deprecated */
  constructor(outcome: Outcome$);
  /** @deprecated */
  outcome: Outcome$;
}
export function Effect$Finish(outcome: Outcome$): Effect$;
export function Effect$isFinish(value: any): value is Effect$;
export function Effect$Finish$0(value: Effect$): Outcome$;
export function Effect$Finish$outcome(value: Effect$): Outcome$;

export type Effect$ = Checkpoint | RunCommand | RunWorkflow | CallAgent | RunTool | Delivered | Deliver | Fail | Refuse | Finish;

export function workflow_to_json(workflow: Workflow$): $json.Json$;

export function workflow_decoder(): $decode.Decoder$<Workflow$>;

export function agent_failure_to_json(agent_failure: AgentFailure$): $json.Json$;

export function command_failure_to_json(command_failure: CommandFailure$): $json.Json$;

export function fail_reason_to_json(fail_reason: FailReason$): $json.Json$;

export function request_to_json(request: Request$): $json.Json$;

export function event_to_json(event: Event$): $json.Json$;

export function agent_failure_decoder(): $decode.Decoder$<AgentFailure$>;

export function command_failure_decoder(): $decode.Decoder$<CommandFailure$>;

export function fail_reason_decoder(): $decode.Decoder$<FailReason$>;

export function request_decoder(): $decode.Decoder$<Request$>;

export function event_decoder(): $decode.Decoder$<Event$>;

export function continuation_to_json(continuation: Continuation$): $json.Json$;

export function continuation_decoder(): $decode.Decoder$<Continuation$>;

export function envelope_to_json(envelope: Envelope$): $json.Json$;

export function envelope_decoder(): $decode.Decoder$<Envelope$>;

export function taken_to_json(taken: Taken$): $json.Json$;

export function taken_decoder(): $decode.Decoder$<Taken$>;

export function outcome_to_json(outcome: Outcome$): $json.Json$;

export function outcome_decoder(): $decode.Decoder$<Outcome$>;

export function refusal_to_json(refusal: Refusal$): $json.Json$;

export function refusal_decoder(): $decode.Decoder$<Refusal$>;

export function effect_to_json(effect: Effect$): $json.Json$;

export function effect_decoder(): $decode.Decoder$<Effect$>;
