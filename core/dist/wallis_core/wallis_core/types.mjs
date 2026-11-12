/// <reference types="./types.d.mts" />
import * as $json from "../../gleam_json/gleam/json.mjs";
import * as $decode from "../../gleam_stdlib/gleam/dynamic/decode.mjs";
import * as $option from "../../gleam_stdlib/gleam/option.mjs";
import {
  List$Empty$const as $List$Empty$const,
  prepend as listPrepend,
  CustomType as $CustomType,
} from "../gleam.mjs";
import * as $json_value from "../wallis_core/value.mjs";

export class Workflow extends $CustomType {
  constructor(name, digest) {
    super();
    this.name = name;
    this.digest = digest;
  }
}
export const Workflow$Workflow = (name, digest) => new Workflow(name, digest);
export const Workflow$isWorkflow = (value) => value instanceof Workflow;
export const Workflow$Workflow$name = (value) => value.name;
export const Workflow$Workflow$0 = (value) => value.name;
export const Workflow$Workflow$digest = (value) => value.digest;
export const Workflow$Workflow$1 = (value) => value.digest;

/**
 * The run begins: its workflow, its input and the core's semantics.
 */
export class Started extends $CustomType {
  constructor(workflow, input, semantics) {
    super();
    this.workflow = workflow;
    this.input = input;
    this.semantics = semantics;
  }
}
export const Event$Started = (workflow, input, semantics) =>
  new Started(workflow, input, semantics);
export const Event$isStarted = (value) => value instanceof Started;
export const Event$Started$workflow = (value) => value.workflow;
export const Event$Started$0 = (value) => value.workflow;
export const Event$Started$input = (value) => value.input;
export const Event$Started$1 = (value) => value.input;
export const Event$Started$semantics = (value) => value.semantics;
export const Event$Started$2 = (value) => value.semantics;

/**
 * A new process drives the run: the body runs again from the top, and
 * every completed call is answered from the journal.
 */
export class Resumed extends $CustomType {
  constructor(digest, semantics) {
    super();
    this.digest = digest;
    this.semantics = semantics;
  }
}
export const Event$Resumed = (digest, semantics) =>
  new Resumed(digest, semantics);
export const Event$isResumed = (value) => value instanceof Resumed;
export const Event$Resumed$digest = (value) => value.digest;
export const Event$Resumed$0 = (value) => value.digest;
export const Event$Resumed$semantics = (value) => value.semantics;
export const Event$Resumed$1 = (value) => value.semantics;

/**
 * The body calls a node. `node` is the node's definition digest,
 * `scope` the call's place (the slot of the nested workflow call it is
 * made in; empty at the top) and `occurrence` how many calls of the same
 * node and input the body made in that scope before it.
 */
export class Requested extends $CustomType {
  constructor(id, request, node, scope, occurrence) {
    super();
    this.id = id;
    this.request = request;
    this.node = node;
    this.scope = scope;
    this.occurrence = occurrence;
  }
}
export const Event$Requested = (id, request, node, scope, occurrence) =>
  new Requested(id, request, node, scope, occurrence);
export const Event$isRequested = (value) => value instanceof Requested;
export const Event$Requested$id = (value) => value.id;
export const Event$Requested$0 = (value) => value.id;
export const Event$Requested$request = (value) => value.request;
export const Event$Requested$1 = (value) => value.request;
export const Event$Requested$node = (value) => value.node;
export const Event$Requested$2 = (value) => value.node;
export const Event$Requested$scope = (value) => value.scope;
export const Event$Requested$3 = (value) => value.scope;
export const Event$Requested$occurrence = (value) => value.occurrence;
export const Event$Requested$4 = (value) => value.occurrence;

/**
 * An agent call stored a checkpoint (a dialogue blob) after a turn.
 */
export class AgentProgressed extends $CustomType {
  constructor(id, checkpoint) {
    super();
    this.id = id;
    this.checkpoint = checkpoint;
  }
}
export const Event$AgentProgressed = (id, checkpoint) =>
  new AgentProgressed(id, checkpoint);
export const Event$isAgentProgressed = (value) =>
  value instanceof AgentProgressed;
export const Event$AgentProgressed$id = (value) => value.id;
export const Event$AgentProgressed$0 = (value) => value.id;
export const Event$AgentProgressed$checkpoint = (value) => value.checkpoint;
export const Event$AgentProgressed$1 = (value) => value.checkpoint;

/**
 * An agent call took mailbox messages into the turn after `turn`.
 */
export class MessagesTaken extends $CustomType {
  constructor(id, messages, turn) {
    super();
    this.id = id;
    this.messages = messages;
    this.turn = turn;
  }
}
export const Event$MessagesTaken = (id, messages, turn) =>
  new MessagesTaken(id, messages, turn);
export const Event$isMessagesTaken = (value) => value instanceof MessagesTaken;
export const Event$MessagesTaken$id = (value) => value.id;
export const Event$MessagesTaken$0 = (value) => value.id;
export const Event$MessagesTaken$messages = (value) => value.messages;
export const Event$MessagesTaken$1 = (value) => value.messages;
export const Event$MessagesTaken$turn = (value) => value.turn;
export const Event$MessagesTaken$2 = (value) => value.turn;

/**
 * An agent call answered: the model that served it, the dialogue after
 * it (a blob) and its session's workspace layers after it.
 */
export class AgentReturned extends $CustomType {
  constructor(id, output, model, dialogue, layers) {
    super();
    this.id = id;
    this.output = output;
    this.model = model;
    this.dialogue = dialogue;
    this.layers = layers;
  }
}
export const Event$AgentReturned = (id, output, model, dialogue, layers) =>
  new AgentReturned(id, output, model, dialogue, layers);
export const Event$isAgentReturned = (value) => value instanceof AgentReturned;
export const Event$AgentReturned$id = (value) => value.id;
export const Event$AgentReturned$0 = (value) => value.id;
export const Event$AgentReturned$output = (value) => value.output;
export const Event$AgentReturned$1 = (value) => value.output;
export const Event$AgentReturned$model = (value) => value.model;
export const Event$AgentReturned$2 = (value) => value.model;
export const Event$AgentReturned$dialogue = (value) => value.dialogue;
export const Event$AgentReturned$3 = (value) => value.dialogue;
export const Event$AgentReturned$layers = (value) => value.layers;
export const Event$AgentReturned$4 = (value) => value.layers;

/**
 * An agent call failed. With a dialogue (a turn limit, say), the call
 * still yields a session to continue from.
 */
export class AgentFailed extends $CustomType {
  constructor(id, failure, model, dialogue, layers) {
    super();
    this.id = id;
    this.failure = failure;
    this.model = model;
    this.dialogue = dialogue;
    this.layers = layers;
  }
}
export const Event$AgentFailed = (id, failure, model, dialogue, layers) =>
  new AgentFailed(id, failure, model, dialogue, layers);
export const Event$isAgentFailed = (value) => value instanceof AgentFailed;
export const Event$AgentFailed$id = (value) => value.id;
export const Event$AgentFailed$0 = (value) => value.id;
export const Event$AgentFailed$failure = (value) => value.failure;
export const Event$AgentFailed$1 = (value) => value.failure;
export const Event$AgentFailed$model = (value) => value.model;
export const Event$AgentFailed$2 = (value) => value.model;
export const Event$AgentFailed$dialogue = (value) => value.dialogue;
export const Event$AgentFailed$3 = (value) => value.dialogue;
export const Event$AgentFailed$layers = (value) => value.layers;
export const Event$AgentFailed$4 = (value) => value.layers;

/**
 * A message to a mailbox. `key` is the send's identity (the sender's
 * scope and occurrence, or the caller's own id): a send journaled before
 * is not delivered again.
 */
export class Sent extends $CustomType {
  constructor(key, to, from, reply_to, body) {
    super();
    this.key = key;
    this.to = to;
    this.from = from;
    this.reply_to = reply_to;
    this.body = body;
  }
}
export const Event$Sent = (key, to, from, reply_to, body) =>
  new Sent(key, to, from, reply_to, body);
export const Event$isSent = (value) => value instanceof Sent;
export const Event$Sent$key = (value) => value.key;
export const Event$Sent$0 = (value) => value.key;
export const Event$Sent$to = (value) => value.to;
export const Event$Sent$1 = (value) => value.to;
export const Event$Sent$from = (value) => value.from;
export const Event$Sent$2 = (value) => value.from;
export const Event$Sent$reply_to = (value) => value.reply_to;
export const Event$Sent$3 = (value) => value.reply_to;
export const Event$Sent$body = (value) => value.body;
export const Event$Sent$4 = (value) => value.body;

export class ToolReturned extends $CustomType {
  constructor(id, output) {
    super();
    this.id = id;
    this.output = output;
  }
}
export const Event$ToolReturned = (id, output) => new ToolReturned(id, output);
export const Event$isToolReturned = (value) => value instanceof ToolReturned;
export const Event$ToolReturned$id = (value) => value.id;
export const Event$ToolReturned$0 = (value) => value.id;
export const Event$ToolReturned$output = (value) => value.output;
export const Event$ToolReturned$1 = (value) => value.output;

export class ToolFailed extends $CustomType {
  constructor(id, message) {
    super();
    this.id = id;
    this.message = message;
  }
}
export const Event$ToolFailed = (id, message) => new ToolFailed(id, message);
export const Event$isToolFailed = (value) => value instanceof ToolFailed;
export const Event$ToolFailed$id = (value) => value.id;
export const Event$ToolFailed$0 = (value) => value.id;
export const Event$ToolFailed$message = (value) => value.message;
export const Event$ToolFailed$1 = (value) => value.message;

/**
 * The caller names a failed call to run again (`resume({ retry })`): a
 * decided failure re-runs only so. An agent continues its own session:
 * with `turns` more turns after a turn limit, or with the validation
 * errors as its next message after an invalid output.
 */
export class Retried extends $CustomType {
  constructor(call, turns) {
    super();
    this.call = call;
    this.turns = turns;
  }
}
export const Event$Retried = (call, turns) => new Retried(call, turns);
export const Event$isRetried = (value) => value instanceof Retried;
export const Event$Retried$call = (value) => value.call;
export const Event$Retried$0 = (value) => value.call;
export const Event$Retried$turns = (value) => value.turns;
export const Event$Retried$1 = (value) => value.turns;

export class CommandReturned extends $CustomType {
  constructor(id, output) {
    super();
    this.id = id;
    this.output = output;
  }
}
export const Event$CommandReturned = (id, output) =>
  new CommandReturned(id, output);
export const Event$isCommandReturned = (value) =>
  value instanceof CommandReturned;
export const Event$CommandReturned$id = (value) => value.id;
export const Event$CommandReturned$0 = (value) => value.id;
export const Event$CommandReturned$output = (value) => value.output;
export const Event$CommandReturned$1 = (value) => value.output;

export class CommandFailed extends $CustomType {
  constructor(id, failure) {
    super();
    this.id = id;
    this.failure = failure;
  }
}
export const Event$CommandFailed = (id, failure) =>
  new CommandFailed(id, failure);
export const Event$isCommandFailed = (value) => value instanceof CommandFailed;
export const Event$CommandFailed$id = (value) => value.id;
export const Event$CommandFailed$0 = (value) => value.id;
export const Event$CommandFailed$failure = (value) => value.failure;
export const Event$CommandFailed$1 = (value) => value.failure;

export class WorkflowReturned extends $CustomType {
  constructor(id, output) {
    super();
    this.id = id;
    this.output = output;
  }
}
export const Event$WorkflowReturned = (id, output) =>
  new WorkflowReturned(id, output);
export const Event$isWorkflowReturned = (value) =>
  value instanceof WorkflowReturned;
export const Event$WorkflowReturned$id = (value) => value.id;
export const Event$WorkflowReturned$0 = (value) => value.id;
export const Event$WorkflowReturned$output = (value) => value.output;
export const Event$WorkflowReturned$1 = (value) => value.output;

export class WorkflowFailed extends $CustomType {
  constructor(id, reason) {
    super();
    this.id = id;
    this.reason = reason;
  }
}
export const Event$WorkflowFailed = (id, reason) =>
  new WorkflowFailed(id, reason);
export const Event$isWorkflowFailed = (value) =>
  value instanceof WorkflowFailed;
export const Event$WorkflowFailed$id = (value) => value.id;
export const Event$WorkflowFailed$0 = (value) => value.id;
export const Event$WorkflowFailed$reason = (value) => value.reason;
export const Event$WorkflowFailed$1 = (value) => value.reason;

/**
 * A host fact (`meta.json` is derived from them): applied even after the
 * end.
 */
export class Noted extends $CustomType {
  constructor(key, value) {
    super();
    this.key = key;
    this.value = value;
  }
}
export const Event$Noted = (key, value) => new Noted(key, value);
export const Event$isNoted = (value) => value instanceof Noted;
export const Event$Noted$key = (value) => value.key;
export const Event$Noted$0 = (value) => value.key;
export const Event$Noted$value = (value) => value.value;
export const Event$Noted$1 = (value) => value.value;

export class BodyFinished extends $CustomType {
  constructor(output) {
    super();
    this.output = output;
  }
}
export const Event$BodyFinished = (output) => new BodyFinished(output);
export const Event$isBodyFinished = (value) => value instanceof BodyFinished;
export const Event$BodyFinished$output = (value) => value.output;
export const Event$BodyFinished$0 = (value) => value.output;

export class BodyFailed extends $CustomType {
  constructor(reason) {
    super();
    this.reason = reason;
  }
}
export const Event$BodyFailed = (reason) => new BodyFailed(reason);
export const Event$isBodyFailed = (value) => value instanceof BodyFailed;
export const Event$BodyFailed$reason = (value) => value.reason;
export const Event$BodyFailed$0 = (value) => value.reason;

export class CommandCall extends $CustomType {
  constructor(name, input) {
    super();
    this.name = name;
    this.input = input;
  }
}
export const Request$CommandCall = (name, input) =>
  new CommandCall(name, input);
export const Request$isCommandCall = (value) => value instanceof CommandCall;
export const Request$CommandCall$name = (value) => value.name;
export const Request$CommandCall$0 = (value) => value.name;
export const Request$CommandCall$input = (value) => value.input;
export const Request$CommandCall$1 = (value) => value.input;

export class WorkflowCall extends $CustomType {
  constructor(name, input) {
    super();
    this.name = name;
    this.input = input;
  }
}
export const Request$WorkflowCall = (name, input) =>
  new WorkflowCall(name, input);
export const Request$isWorkflowCall = (value) => value instanceof WorkflowCall;
export const Request$WorkflowCall$name = (value) => value.name;
export const Request$WorkflowCall$0 = (value) => value.name;
export const Request$WorkflowCall$input = (value) => value.input;
export const Request$WorkflowCall$1 = (value) => value.input;

/**
 * A call of a session value: `session` is `None` for a new session,
 * whose workspace starts from the layers `from`.
 */
export class AgentCall extends $CustomType {
  constructor(name, input, session, from) {
    super();
    this.name = name;
    this.input = input;
    this.session = session;
    this.from = from;
  }
}
export const Request$AgentCall = (name, input, session, from) =>
  new AgentCall(name, input, session, from);
export const Request$isAgentCall = (value) => value instanceof AgentCall;
export const Request$AgentCall$name = (value) => value.name;
export const Request$AgentCall$0 = (value) => value.name;
export const Request$AgentCall$input = (value) => value.input;
export const Request$AgentCall$1 = (value) => value.input;
export const Request$AgentCall$session = (value) => value.session;
export const Request$AgentCall$2 = (value) => value.session;
export const Request$AgentCall$from = (value) => value.from;
export const Request$AgentCall$3 = (value) => value.from;

/**
 * A tool called by the body; `replay_safe`: it may be made again when it
 * was in flight as a process stopped.
 */
export class ToolCall extends $CustomType {
  constructor(name, input, replay_safe) {
    super();
    this.name = name;
    this.input = input;
    this.replay_safe = replay_safe;
  }
}
export const Request$ToolCall = (name, input, replay_safe) =>
  new ToolCall(name, input, replay_safe);
export const Request$isToolCall = (value) => value instanceof ToolCall;
export const Request$ToolCall$name = (value) => value.name;
export const Request$ToolCall$0 = (value) => value.name;
export const Request$ToolCall$input = (value) => value.input;
export const Request$ToolCall$1 = (value) => value.input;
export const Request$ToolCall$replay_safe = (value) => value.replay_safe;
export const Request$ToolCall$2 = (value) => value.replay_safe;

export const Request$input = (value) => value.input;
export const Request$name = (value) => value.name;

export class Fresh extends $CustomType {}
export const Continuation$Fresh$const = new Fresh();
export const Continuation$Fresh = () => Continuation$Fresh$const;
export const Continuation$isFresh = (value) => value instanceof Fresh;

export class MoreTurns extends $CustomType {
  constructor(turns) {
    super();
    this.turns = turns;
  }
}
export const Continuation$MoreTurns = (turns) => new MoreTurns(turns);
export const Continuation$isMoreTurns = (value) => value instanceof MoreTurns;
export const Continuation$MoreTurns$turns = (value) => value.turns;
export const Continuation$MoreTurns$0 = (value) => value.turns;

export class FixOutput extends $CustomType {
  constructor(errors) {
    super();
    this.errors = errors;
  }
}
export const Continuation$FixOutput = (errors) => new FixOutput(errors);
export const Continuation$isFixOutput = (value) => value instanceof FixOutput;
export const Continuation$FixOutput$errors = (value) => value.errors;
export const Continuation$FixOutput$0 = (value) => value.errors;

/**
 * It used its turn budget; the session after it can continue.
 */
export class TurnLimitReached extends $CustomType {
  constructor(turns) {
    super();
    this.turns = turns;
  }
}
export const AgentFailure$TurnLimitReached = (turns) =>
  new TurnLimitReached(turns);
export const AgentFailure$isTurnLimitReached = (value) =>
  value instanceof TurnLimitReached;
export const AgentFailure$TurnLimitReached$turns = (value) => value.turns;
export const AgentFailure$TurnLimitReached$0 = (value) => value.turns;

/**
 * The executor gave up (retries exhausted, a provider error).
 */
export class GaveUp extends $CustomType {
  constructor(error) {
    super();
    this.error = error;
  }
}
export const AgentFailure$GaveUp = (error) => new GaveUp(error);
export const AgentFailure$isGaveUp = (value) => value instanceof GaveUp;
export const AgentFailure$GaveUp$error = (value) => value.error;
export const AgentFailure$GaveUp$0 = (value) => value.error;

export class ContextExhausted extends $CustomType {}
export const AgentFailure$ContextExhausted$const = new ContextExhausted();
export const AgentFailure$ContextExhausted = () =>
  AgentFailure$ContextExhausted$const;
export const AgentFailure$isContextExhausted = (value) =>
  value instanceof ContextExhausted;

/**
 * Its final output does not match the agent's output schema.
 */
export class InvalidOutput extends $CustomType {
  constructor(errors) {
    super();
    this.errors = errors;
  }
}
export const AgentFailure$InvalidOutput = (errors) => new InvalidOutput(errors);
export const AgentFailure$isInvalidOutput = (value) =>
  value instanceof InvalidOutput;
export const AgentFailure$InvalidOutput$errors = (value) => value.errors;
export const AgentFailure$InvalidOutput$0 = (value) => value.errors;

export class Envelope extends $CustomType {
  constructor(id, from, reply_to, body) {
    super();
    this.id = id;
    this.from = from;
    this.reply_to = reply_to;
    this.body = body;
  }
}
export const Envelope$Envelope = (id, from, reply_to, body) =>
  new Envelope(id, from, reply_to, body);
export const Envelope$isEnvelope = (value) => value instanceof Envelope;
export const Envelope$Envelope$id = (value) => value.id;
export const Envelope$Envelope$0 = (value) => value.id;
export const Envelope$Envelope$from = (value) => value.from;
export const Envelope$Envelope$1 = (value) => value.from;
export const Envelope$Envelope$reply_to = (value) => value.reply_to;
export const Envelope$Envelope$2 = (value) => value.reply_to;
export const Envelope$Envelope$body = (value) => value.body;
export const Envelope$Envelope$3 = (value) => value.body;

export class Taken extends $CustomType {
  constructor(turn, messages) {
    super();
    this.turn = turn;
    this.messages = messages;
  }
}
export const Taken$Taken = (turn, messages) => new Taken(turn, messages);
export const Taken$isTaken = (value) => value instanceof Taken;
export const Taken$Taken$turn = (value) => value.turn;
export const Taken$Taken$0 = (value) => value.turn;
export const Taken$Taken$messages = (value) => value.messages;
export const Taken$Taken$1 = (value) => value.messages;

export class ExitCode extends $CustomType {
  constructor(code, stderr_head) {
    super();
    this.code = code;
    this.stderr_head = stderr_head;
  }
}
export const CommandFailure$ExitCode = (code, stderr_head) =>
  new ExitCode(code, stderr_head);
export const CommandFailure$isExitCode = (value) => value instanceof ExitCode;
export const CommandFailure$ExitCode$code = (value) => value.code;
export const CommandFailure$ExitCode$0 = (value) => value.code;
export const CommandFailure$ExitCode$stderr_head = (value) => value.stderr_head;
export const CommandFailure$ExitCode$1 = (value) => value.stderr_head;

/**
 * Killed by a signal (the OOM killer, say).
 */
export class Killed extends $CustomType {
  constructor(signal, stderr_head) {
    super();
    this.signal = signal;
    this.stderr_head = stderr_head;
  }
}
export const CommandFailure$Killed = (signal, stderr_head) =>
  new Killed(signal, stderr_head);
export const CommandFailure$isKilled = (value) => value instanceof Killed;
export const CommandFailure$Killed$signal = (value) => value.signal;
export const CommandFailure$Killed$0 = (value) => value.signal;
export const CommandFailure$Killed$stderr_head = (value) => value.stderr_head;
export const CommandFailure$Killed$1 = (value) => value.stderr_head;

/**
 * Its parsed output does not match the command's output schema.
 */
export class OutputMismatch extends $CustomType {
  constructor(errors) {
    super();
    this.errors = errors;
  }
}
export const CommandFailure$OutputMismatch = (errors) =>
  new OutputMismatch(errors);
export const CommandFailure$isOutputMismatch = (value) =>
  value instanceof OutputMismatch;
export const CommandFailure$OutputMismatch$errors = (value) => value.errors;
export const CommandFailure$OutputMismatch$0 = (value) => value.errors;

/**
 * `r.file(name)` or `r.tree(path)` named something the command did not write.
 */
export class MissingFile extends $CustomType {
  constructor(name) {
    super();
    this.name = name;
  }
}
export const CommandFailure$MissingFile = (name) => new MissingFile(name);
export const CommandFailure$isMissingFile = (value) =>
  value instanceof MissingFile;
export const CommandFailure$MissingFile$name = (value) => value.name;
export const CommandFailure$MissingFile$0 = (value) => value.name;

/**
 * The command's `parse` threw.
 */
export class ParseError extends $CustomType {
  constructor(message) {
    super();
    this.message = message;
  }
}
export const CommandFailure$ParseError = (message) => new ParseError(message);
export const CommandFailure$isParseError = (value) =>
  value instanceof ParseError;
export const CommandFailure$ParseError$message = (value) => value.message;
export const CommandFailure$ParseError$0 = (value) => value.message;

/**
 * It could not be started (no sandbox, a missing program, a bad argv).
 */
export class Unrunnable extends $CustomType {
  constructor(error) {
    super();
    this.error = error;
  }
}
export const CommandFailure$Unrunnable = (error) => new Unrunnable(error);
export const CommandFailure$isUnrunnable = (value) =>
  value instanceof Unrunnable;
export const CommandFailure$Unrunnable$error = (value) => value.error;
export const CommandFailure$Unrunnable$0 = (value) => value.error;

/**
 * The body threw something that is not a node failure.
 */
export class BodyError extends $CustomType {
  constructor(message) {
    super();
    this.message = message;
  }
}
export const FailReason$BodyError = (message) => new BodyError(message);
export const FailReason$isBodyError = (value) => value instanceof BodyError;
export const FailReason$BodyError$message = (value) => value.message;
export const FailReason$BodyError$0 = (value) => value.message;

export class CommandError extends $CustomType {
  constructor(command, failure) {
    super();
    this.command = command;
    this.failure = failure;
  }
}
export const FailReason$CommandError = (command, failure) =>
  new CommandError(command, failure);
export const FailReason$isCommandError = (value) =>
  value instanceof CommandError;
export const FailReason$CommandError$command = (value) => value.command;
export const FailReason$CommandError$0 = (value) => value.command;
export const FailReason$CommandError$failure = (value) => value.failure;
export const FailReason$CommandError$1 = (value) => value.failure;

/**
 * A nested workflow failed: its own reason.
 */
export class WorkflowError extends $CustomType {
  constructor(workflow, reason) {
    super();
    this.workflow = workflow;
    this.reason = reason;
  }
}
export const FailReason$WorkflowError = (workflow, reason) =>
  new WorkflowError(workflow, reason);
export const FailReason$isWorkflowError = (value) =>
  value instanceof WorkflowError;
export const FailReason$WorkflowError$workflow = (value) => value.workflow;
export const FailReason$WorkflowError$0 = (value) => value.workflow;
export const FailReason$WorkflowError$reason = (value) => value.reason;
export const FailReason$WorkflowError$1 = (value) => value.reason;

/**
 * An agent call failed; `session` is the session after it, if any.
 */
export class AgentError extends $CustomType {
  constructor(agent, failure, session) {
    super();
    this.agent = agent;
    this.failure = failure;
    this.session = session;
  }
}
export const FailReason$AgentError = (agent, failure, session) =>
  new AgentError(agent, failure, session);
export const FailReason$isAgentError = (value) => value instanceof AgentError;
export const FailReason$AgentError$agent = (value) => value.agent;
export const FailReason$AgentError$0 = (value) => value.agent;
export const FailReason$AgentError$failure = (value) => value.failure;
export const FailReason$AgentError$1 = (value) => value.failure;
export const FailReason$AgentError$session = (value) => value.session;
export const FailReason$AgentError$2 = (value) => value.session;

export class ToolError extends $CustomType {
  constructor(tool, message) {
    super();
    this.tool = tool;
    this.message = message;
  }
}
export const FailReason$ToolError = (tool, message) =>
  new ToolError(tool, message);
export const FailReason$isToolError = (value) => value instanceof ToolError;
export const FailReason$ToolError$tool = (value) => value.tool;
export const FailReason$ToolError$0 = (value) => value.tool;
export const FailReason$ToolError$message = (value) => value.message;
export const FailReason$ToolError$1 = (value) => value.message;

/**
 * A call's input, or a workflow's output, does not match its schema.
 */
export class SchemaMismatch extends $CustomType {
  constructor(node, errors) {
    super();
    this.node = node;
    this.errors = errors;
  }
}
export const FailReason$SchemaMismatch = (node, errors) =>
  new SchemaMismatch(node, errors);
export const FailReason$isSchemaMismatch = (value) =>
  value instanceof SchemaMismatch;
export const FailReason$SchemaMismatch$node = (value) => value.node;
export const FailReason$SchemaMismatch$0 = (value) => value.node;
export const FailReason$SchemaMismatch$errors = (value) => value.errors;
export const FailReason$SchemaMismatch$1 = (value) => value.errors;

export class Done extends $CustomType {
  constructor(value) {
    super();
    this.value = value;
  }
}
export const Outcome$Done = (value) => new Done(value);
export const Outcome$isDone = (value) => value instanceof Done;
export const Outcome$Done$value = (value) => value.value;
export const Outcome$Done$0 = (value) => value.value;

export class Failed extends $CustomType {
  constructor(reason) {
    super();
    this.reason = reason;
  }
}
export const Outcome$Failed = (reason) => new Failed(reason);
export const Outcome$isFailed = (value) => value instanceof Failed;
export const Outcome$Failed$reason = (value) => value.reason;
export const Outcome$Failed$0 = (value) => value.reason;

export class NotStarted extends $CustomType {}
export const Refusal$NotStarted$const = new NotStarted();
export const Refusal$NotStarted = () => Refusal$NotStarted$const;
export const Refusal$isNotStarted = (value) => value instanceof NotStarted;

export class AlreadyStarted extends $CustomType {}
export const Refusal$AlreadyStarted$const = new AlreadyStarted();
export const Refusal$AlreadyStarted = () => Refusal$AlreadyStarted$const;
export const Refusal$isAlreadyStarted = (value) =>
  value instanceof AlreadyStarted;

/**
 * A finished run takes no calls or results.
 */
export class RunEnded extends $CustomType {}
export const Refusal$RunEnded$const = new RunEnded();
export const Refusal$RunEnded = () => Refusal$RunEnded$const;
export const Refusal$isRunEnded = (value) => value instanceof RunEnded;

/**
 * The log was written by another version of the core.
 */
export class SemanticsChanged extends $CustomType {
  constructor(recorded, current) {
    super();
    this.recorded = recorded;
    this.current = current;
  }
}
export const Refusal$SemanticsChanged = (recorded, current) =>
  new SemanticsChanged(recorded, current);
export const Refusal$isSemanticsChanged = (value) =>
  value instanceof SemanticsChanged;
export const Refusal$SemanticsChanged$recorded = (value) => value.recorded;
export const Refusal$SemanticsChanged$0 = (value) => value.recorded;
export const Refusal$SemanticsChanged$current = (value) => value.current;
export const Refusal$SemanticsChanged$1 = (value) => value.current;

export class UnknownRequest extends $CustomType {
  constructor(id) {
    super();
    this.id = id;
  }
}
export const Refusal$UnknownRequest = (id) => new UnknownRequest(id);
export const Refusal$isUnknownRequest = (value) =>
  value instanceof UnknownRequest;
export const Refusal$UnknownRequest$id = (value) => value.id;
export const Refusal$UnknownRequest$0 = (value) => value.id;

/**
 * A result for a call that is not running (it settled, or is another
 * kind of call).
 */
export class NotRunning extends $CustomType {
  constructor(id) {
    super();
    this.id = id;
  }
}
export const Refusal$NotRunning = (id) => new NotRunning(id);
export const Refusal$isNotRunning = (value) => value instanceof NotRunning;
export const Refusal$NotRunning$id = (value) => value.id;
export const Refusal$NotRunning$0 = (value) => value.id;

/**
 * A session value the run never answered with.
 */
export class UnknownSession extends $CustomType {
  constructor(session) {
    super();
    this.session = session;
  }
}
export const Refusal$UnknownSession = (session) => new UnknownSession(session);
export const Refusal$isUnknownSession = (value) =>
  value instanceof UnknownSession;
export const Refusal$UnknownSession$session = (value) => value.session;
export const Refusal$UnknownSession$0 = (value) => value.session;

/**
 * A session value of another agent (by definition digest).
 */
export class SessionOfAnotherAgent extends $CustomType {
  constructor(session) {
    super();
    this.session = session;
  }
}
export const Refusal$SessionOfAnotherAgent = (session) =>
  new SessionOfAnotherAgent(session);
export const Refusal$isSessionOfAnotherAgent = (value) =>
  value instanceof SessionOfAnotherAgent;
export const Refusal$SessionOfAnotherAgent$session = (value) => value.session;
export const Refusal$SessionOfAnotherAgent$0 = (value) => value.session;

/**
 * Only a call whose newest attempt failed can be retried.
 */
export class NotRetriable extends $CustomType {
  constructor(call) {
    super();
    this.call = call;
  }
}
export const Refusal$NotRetriable = (call) => new NotRetriable(call);
export const Refusal$isNotRetriable = (value) => value instanceof NotRetriable;
export const Refusal$NotRetriable$call = (value) => value.call;
export const Refusal$NotRetriable$0 = (value) => value.call;

export class InvalidEvent extends $CustomType {
  constructor(message) {
    super();
    this.message = message;
  }
}
export const Refusal$InvalidEvent = (message) => new InvalidEvent(message);
export const Refusal$isInvalidEvent = (value) => value instanceof InvalidEvent;
export const Refusal$InvalidEvent$message = (value) => value.message;
export const Refusal$InvalidEvent$0 = (value) => value.message;

/**
 * Append the event to the log: it changed the run.
 */
export class Checkpoint extends $CustomType {}
export const Effect$Checkpoint$const = new Checkpoint();
export const Effect$Checkpoint = () => Effect$Checkpoint$const;
export const Effect$isCheckpoint = (value) => value instanceof Checkpoint;

export class RunCommand extends $CustomType {
  constructor(id, attempt) {
    super();
    this.id = id;
    this.attempt = attempt;
  }
}
export const Effect$RunCommand = (id, attempt) => new RunCommand(id, attempt);
export const Effect$isRunCommand = (value) => value instanceof RunCommand;
export const Effect$RunCommand$id = (value) => value.id;
export const Effect$RunCommand$0 = (value) => value.id;
export const Effect$RunCommand$attempt = (value) => value.attempt;
export const Effect$RunCommand$1 = (value) => value.attempt;

/**
 * Run a nested workflow's body; its own calls are made in `scope`.
 */
export class RunWorkflow extends $CustomType {
  constructor(id, scope, attempt) {
    super();
    this.id = id;
    this.scope = scope;
    this.attempt = attempt;
  }
}
export const Effect$RunWorkflow = (id, scope, attempt) =>
  new RunWorkflow(id, scope, attempt);
export const Effect$isRunWorkflow = (value) => value instanceof RunWorkflow;
export const Effect$RunWorkflow$id = (value) => value.id;
export const Effect$RunWorkflow$0 = (value) => value.id;
export const Effect$RunWorkflow$scope = (value) => value.scope;
export const Effect$RunWorkflow$1 = (value) => value.scope;
export const Effect$RunWorkflow$attempt = (value) => value.attempt;
export const Effect$RunWorkflow$2 = (value) => value.attempt;

/**
 * Run an agent call: the dialogue it continues (a blob), its session's
 * workspace layers, this attempt's newest checkpoint, and the messages
 * it already took (replayed at the same turns). `mailbox` is its own
 * mailbox's address.
 */
export class CallAgent extends $CustomType {
  constructor(id, attempt, mailbox, history, layers, checkpoint, taken, continuation) {
    super();
    this.id = id;
    this.attempt = attempt;
    this.mailbox = mailbox;
    this.history = history;
    this.layers = layers;
    this.checkpoint = checkpoint;
    this.taken = taken;
    this.continuation = continuation;
  }
}
export const Effect$CallAgent = (id, attempt, mailbox, history, layers, checkpoint, taken, continuation) =>
  new CallAgent(id,
  attempt,
  mailbox,
  history,
  layers,
  checkpoint,
  taken,
  continuation);
export const Effect$isCallAgent = (value) => value instanceof CallAgent;
export const Effect$CallAgent$id = (value) => value.id;
export const Effect$CallAgent$0 = (value) => value.id;
export const Effect$CallAgent$attempt = (value) => value.attempt;
export const Effect$CallAgent$1 = (value) => value.attempt;
export const Effect$CallAgent$mailbox = (value) => value.mailbox;
export const Effect$CallAgent$2 = (value) => value.mailbox;
export const Effect$CallAgent$history = (value) => value.history;
export const Effect$CallAgent$3 = (value) => value.history;
export const Effect$CallAgent$layers = (value) => value.layers;
export const Effect$CallAgent$4 = (value) => value.layers;
export const Effect$CallAgent$checkpoint = (value) => value.checkpoint;
export const Effect$CallAgent$5 = (value) => value.checkpoint;
export const Effect$CallAgent$taken = (value) => value.taken;
export const Effect$CallAgent$6 = (value) => value.taken;
export const Effect$CallAgent$continuation = (value) => value.continuation;
export const Effect$CallAgent$7 = (value) => value.continuation;

export class RunTool extends $CustomType {
  constructor(id, attempt) {
    super();
    this.id = id;
    this.attempt = attempt;
  }
}
export const Effect$RunTool = (id, attempt) => new RunTool(id, attempt);
export const Effect$isRunTool = (value) => value instanceof RunTool;
export const Effect$RunTool$id = (value) => value.id;
export const Effect$RunTool$0 = (value) => value.id;
export const Effect$RunTool$attempt = (value) => value.attempt;
export const Effect$RunTool$1 = (value) => value.attempt;

/**
 * A new message for a mailbox: route it to its live owner.
 */
export class Delivered extends $CustomType {
  constructor(mailbox, message) {
    super();
    this.mailbox = mailbox;
    this.message = message;
  }
}
export const Effect$Delivered = (mailbox, message) =>
  new Delivered(mailbox, message);
export const Effect$isDelivered = (value) => value instanceof Delivered;
export const Effect$Delivered$mailbox = (value) => value.mailbox;
export const Effect$Delivered$0 = (value) => value.mailbox;
export const Effect$Delivered$message = (value) => value.message;
export const Effect$Delivered$1 = (value) => value.message;

export class Deliver extends $CustomType {
  constructor(id, value) {
    super();
    this.id = id;
    this.value = value;
  }
}
export const Effect$Deliver = (id, value) => new Deliver(id, value);
export const Effect$isDeliver = (value) => value instanceof Deliver;
export const Effect$Deliver$id = (value) => value.id;
export const Effect$Deliver$0 = (value) => value.id;
export const Effect$Deliver$value = (value) => value.value;
export const Effect$Deliver$1 = (value) => value.value;

export class Fail extends $CustomType {
  constructor(id, reason) {
    super();
    this.id = id;
    this.reason = reason;
  }
}
export const Effect$Fail = (id, reason) => new Fail(id, reason);
export const Effect$isFail = (value) => value instanceof Fail;
export const Effect$Fail$id = (value) => value.id;
export const Effect$Fail$0 = (value) => value.id;
export const Effect$Fail$reason = (value) => value.reason;
export const Effect$Fail$1 = (value) => value.reason;

export class Refuse extends $CustomType {
  constructor(id, refusal) {
    super();
    this.id = id;
    this.refusal = refusal;
  }
}
export const Effect$Refuse = (id, refusal) => new Refuse(id, refusal);
export const Effect$isRefuse = (value) => value instanceof Refuse;
export const Effect$Refuse$id = (value) => value.id;
export const Effect$Refuse$0 = (value) => value.id;
export const Effect$Refuse$refusal = (value) => value.refusal;
export const Effect$Refuse$1 = (value) => value.refusal;

export class Finish extends $CustomType {
  constructor(outcome) {
    super();
    this.outcome = outcome;
  }
}
export const Effect$Finish = (outcome) => new Finish(outcome);
export const Effect$isFinish = (value) => value instanceof Finish;
export const Effect$Finish$outcome = (value) => value.outcome;
export const Effect$Finish$0 = (value) => value.outcome;

export function workflow_to_json(workflow) {
  let name = workflow.name;
  let digest = workflow.digest;
  return $json.object(
    listPrepend(
      ["name", $json.string(name)],
      listPrepend(["digest", $json.string(digest)], $List$Empty$const),
    ),
  );
}

export function workflow_decoder() {
  return $decode.field(
    "name",
    $decode.string,
    (name) => {
      return $decode.field(
        "digest",
        $decode.string,
        (digest) => { return $decode.success(new Workflow(name, digest)); },
      );
    },
  );
}

export function agent_failure_to_json(agent_failure) {
  if (agent_failure instanceof TurnLimitReached) {
    let turns = agent_failure.turns;
    return $json.object(
      listPrepend(
        ["type", $json.string("turn_limit_reached")],
        listPrepend(["turns", $json.int(turns)], $List$Empty$const),
      ),
    );
  } else if (agent_failure instanceof GaveUp) {
    let error = agent_failure.error;
    return $json.object(
      listPrepend(
        ["type", $json.string("gave_up")],
        listPrepend(["error", $json.string(error)], $List$Empty$const),
      ),
    );
  } else if (agent_failure instanceof ContextExhausted) {
    return $json.object(
      listPrepend(
        ["type", $json.string("context_exhausted")],
        $List$Empty$const,
      ),
    );
  } else {
    let errors = agent_failure.errors;
    return $json.object(
      listPrepend(
        ["type", $json.string("invalid_output")],
        listPrepend(
          ["errors", $json.array(errors, $json.string)],
          $List$Empty$const,
        ),
      ),
    );
  }
}

export function command_failure_to_json(command_failure) {
  if (command_failure instanceof ExitCode) {
    let code = command_failure.code;
    let stderr_head = command_failure.stderr_head;
    return $json.object(
      listPrepend(
        ["type", $json.string("exit_code")],
        listPrepend(
          ["code", $json.int(code)],
          listPrepend(
            ["stderr_head", $json.string(stderr_head)],
            $List$Empty$const,
          ),
        ),
      ),
    );
  } else if (command_failure instanceof Killed) {
    let signal = command_failure.signal;
    let stderr_head = command_failure.stderr_head;
    return $json.object(
      listPrepend(
        ["type", $json.string("killed")],
        listPrepend(
          ["signal", $json.string(signal)],
          listPrepend(
            ["stderr_head", $json.string(stderr_head)],
            $List$Empty$const,
          ),
        ),
      ),
    );
  } else if (command_failure instanceof OutputMismatch) {
    let errors = command_failure.errors;
    return $json.object(
      listPrepend(
        ["type", $json.string("output_mismatch")],
        listPrepend(
          ["errors", $json.array(errors, $json.string)],
          $List$Empty$const,
        ),
      ),
    );
  } else if (command_failure instanceof MissingFile) {
    let name = command_failure.name;
    return $json.object(
      listPrepend(
        ["type", $json.string("missing_file")],
        listPrepend(["name", $json.string(name)], $List$Empty$const),
      ),
    );
  } else if (command_failure instanceof ParseError) {
    let message = command_failure.message;
    return $json.object(
      listPrepend(
        ["type", $json.string("parse_error")],
        listPrepend(["message", $json.string(message)], $List$Empty$const),
      ),
    );
  } else {
    let error = command_failure.error;
    return $json.object(
      listPrepend(
        ["type", $json.string("unrunnable")],
        listPrepend(["error", $json.string(error)], $List$Empty$const),
      ),
    );
  }
}

export function fail_reason_to_json(fail_reason) {
  if (fail_reason instanceof BodyError) {
    let message = fail_reason.message;
    return $json.object(
      listPrepend(
        ["type", $json.string("body_error")],
        listPrepend(["message", $json.string(message)], $List$Empty$const),
      ),
    );
  } else if (fail_reason instanceof CommandError) {
    let command = fail_reason.command;
    let failure = fail_reason.failure;
    return $json.object(
      listPrepend(
        ["type", $json.string("command_error")],
        listPrepend(
          ["command", $json.string(command)],
          listPrepend(
            ["failure", command_failure_to_json(failure)],
            $List$Empty$const,
          ),
        ),
      ),
    );
  } else if (fail_reason instanceof WorkflowError) {
    let workflow = fail_reason.workflow;
    let reason = fail_reason.reason;
    return $json.object(
      listPrepend(
        ["type", $json.string("workflow_error")],
        listPrepend(
          ["workflow", $json.string(workflow)],
          listPrepend(
            ["reason", fail_reason_to_json(reason)],
            $List$Empty$const,
          ),
        ),
      ),
    );
  } else if (fail_reason instanceof AgentError) {
    let agent = fail_reason.agent;
    let failure = fail_reason.failure;
    let session = fail_reason.session;
    return $json.object(
      listPrepend(
        ["type", $json.string("agent_error")],
        listPrepend(
          ["agent", $json.string(agent)],
          listPrepend(
            ["failure", agent_failure_to_json(failure)],
            listPrepend(
              [
                "session",
                (() => {
                  if (session instanceof $option.Some) {
                    let value = session[0];
                    return $json.string(value);
                  } else {
                    return $json.null$();
                  }
                })(),
              ],
              $List$Empty$const,
            ),
          ),
        ),
      ),
    );
  } else if (fail_reason instanceof ToolError) {
    let tool = fail_reason.tool;
    let message = fail_reason.message;
    return $json.object(
      listPrepend(
        ["type", $json.string("tool_error")],
        listPrepend(
          ["tool", $json.string(tool)],
          listPrepend(["message", $json.string(message)], $List$Empty$const),
        ),
      ),
    );
  } else {
    let node = fail_reason.node;
    let errors = fail_reason.errors;
    return $json.object(
      listPrepend(
        ["type", $json.string("schema_mismatch")],
        listPrepend(
          ["node", $json.string(node)],
          listPrepend(
            ["errors", $json.array(errors, $json.string)],
            $List$Empty$const,
          ),
        ),
      ),
    );
  }
}

export function request_to_json(request) {
  if (request instanceof CommandCall) {
    let name = request.name;
    let input = request.input;
    return $json.object(
      listPrepend(
        ["type", $json.string("command_call")],
        listPrepend(
          ["name", $json.string(name)],
          listPrepend(["input", $json_value.to_json(input)], $List$Empty$const),
        ),
      ),
    );
  } else if (request instanceof WorkflowCall) {
    let name = request.name;
    let input = request.input;
    return $json.object(
      listPrepend(
        ["type", $json.string("workflow_call")],
        listPrepend(
          ["name", $json.string(name)],
          listPrepend(["input", $json_value.to_json(input)], $List$Empty$const),
        ),
      ),
    );
  } else if (request instanceof AgentCall) {
    let name = request.name;
    let input = request.input;
    let session = request.session;
    let from = request.from;
    return $json.object(
      listPrepend(
        ["type", $json.string("agent_call")],
        listPrepend(
          ["name", $json.string(name)],
          listPrepend(
            ["input", $json_value.to_json(input)],
            listPrepend(
              [
                "session",
                (() => {
                  if (session instanceof $option.Some) {
                    let value = session[0];
                    return $json.string(value);
                  } else {
                    return $json.null$();
                  }
                })(),
              ],
              listPrepend(
                ["from", $json.array(from, $json.string)],
                $List$Empty$const,
              ),
            ),
          ),
        ),
      ),
    );
  } else {
    let name = request.name;
    let input = request.input;
    let replay_safe = request.replay_safe;
    return $json.object(
      listPrepend(
        ["type", $json.string("tool_call")],
        listPrepend(
          ["name", $json.string(name)],
          listPrepend(
            ["input", $json_value.to_json(input)],
            listPrepend(
              ["replay_safe", $json.bool(replay_safe)],
              $List$Empty$const,
            ),
          ),
        ),
      ),
    );
  }
}

export function event_to_json(event) {
  if (event instanceof Started) {
    let workflow = event.workflow;
    let input = event.input;
    let semantics = event.semantics;
    return $json.object(
      listPrepend(
        ["type", $json.string("started")],
        listPrepend(
          ["workflow", workflow_to_json(workflow)],
          listPrepend(
            ["input", $json_value.to_json(input)],
            listPrepend(
              ["semantics", $json.string(semantics)],
              $List$Empty$const,
            ),
          ),
        ),
      ),
    );
  } else if (event instanceof Resumed) {
    let digest = event.digest;
    let semantics = event.semantics;
    return $json.object(
      listPrepend(
        ["type", $json.string("resumed")],
        listPrepend(
          ["digest", $json.string(digest)],
          listPrepend(["semantics", $json.string(semantics)], $List$Empty$const),
        ),
      ),
    );
  } else if (event instanceof Requested) {
    let id = event.id;
    let request = event.request;
    let node = event.node;
    let scope = event.scope;
    let occurrence = event.occurrence;
    return $json.object(
      listPrepend(
        ["type", $json.string("requested")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(
            ["request", request_to_json(request)],
            listPrepend(
              ["node", $json.string(node)],
              listPrepend(
                ["scope", $json.string(scope)],
                listPrepend(
                  ["occurrence", $json.int(occurrence)],
                  $List$Empty$const,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  } else if (event instanceof AgentProgressed) {
    let id = event.id;
    let checkpoint = event.checkpoint;
    return $json.object(
      listPrepend(
        ["type", $json.string("agent_progressed")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(
            ["checkpoint", $json.string(checkpoint)],
            $List$Empty$const,
          ),
        ),
      ),
    );
  } else if (event instanceof MessagesTaken) {
    let id = event.id;
    let messages = event.messages;
    let turn = event.turn;
    return $json.object(
      listPrepend(
        ["type", $json.string("messages_taken")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(
            ["messages", $json.array(messages, $json.string)],
            listPrepend(["turn", $json.int(turn)], $List$Empty$const),
          ),
        ),
      ),
    );
  } else if (event instanceof AgentReturned) {
    let id = event.id;
    let output = event.output;
    let model = event.model;
    let dialogue = event.dialogue;
    let layers = event.layers;
    return $json.object(
      listPrepend(
        ["type", $json.string("agent_returned")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(
            ["output", $json_value.to_json(output)],
            listPrepend(
              ["model", $json.string(model)],
              listPrepend(
                ["dialogue", $json.string(dialogue)],
                listPrepend(
                  ["layers", $json.array(layers, $json.string)],
                  $List$Empty$const,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  } else if (event instanceof AgentFailed) {
    let id = event.id;
    let failure = event.failure;
    let model = event.model;
    let dialogue = event.dialogue;
    let layers = event.layers;
    return $json.object(
      listPrepend(
        ["type", $json.string("agent_failed")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(
            ["failure", agent_failure_to_json(failure)],
            listPrepend(
              ["model", $json.string(model)],
              listPrepend(
                [
                  "dialogue",
                  (() => {
                    if (dialogue instanceof $option.Some) {
                      let value = dialogue[0];
                      return $json.string(value);
                    } else {
                      return $json.null$();
                    }
                  })(),
                ],
                listPrepend(
                  ["layers", $json.array(layers, $json.string)],
                  $List$Empty$const,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  } else if (event instanceof Sent) {
    let key = event.key;
    let to = event.to;
    let from = event.from;
    let reply_to = event.reply_to;
    let body = event.body;
    return $json.object(
      listPrepend(
        ["type", $json.string("sent")],
        listPrepend(
          ["key", $json.string(key)],
          listPrepend(
            ["to", $json.string(to)],
            listPrepend(
              ["from", $json.string(from)],
              listPrepend(
                [
                  "reply_to",
                  (() => {
                    if (reply_to instanceof $option.Some) {
                      let value = reply_to[0];
                      return $json.string(value);
                    } else {
                      return $json.null$();
                    }
                  })(),
                ],
                listPrepend(
                  ["body", $json_value.to_json(body)],
                  $List$Empty$const,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  } else if (event instanceof ToolReturned) {
    let id = event.id;
    let output = event.output;
    return $json.object(
      listPrepend(
        ["type", $json.string("tool_returned")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(
            ["output", $json_value.to_json(output)],
            $List$Empty$const,
          ),
        ),
      ),
    );
  } else if (event instanceof ToolFailed) {
    let id = event.id;
    let message = event.message;
    return $json.object(
      listPrepend(
        ["type", $json.string("tool_failed")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(["message", $json.string(message)], $List$Empty$const),
        ),
      ),
    );
  } else if (event instanceof Retried) {
    let call = event.call;
    let turns = event.turns;
    return $json.object(
      listPrepend(
        ["type", $json.string("retried")],
        listPrepend(
          ["call", $json.string(call)],
          listPrepend(["turns", $json.int(turns)], $List$Empty$const),
        ),
      ),
    );
  } else if (event instanceof CommandReturned) {
    let id = event.id;
    let output = event.output;
    return $json.object(
      listPrepend(
        ["type", $json.string("command_returned")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(
            ["output", $json_value.to_json(output)],
            $List$Empty$const,
          ),
        ),
      ),
    );
  } else if (event instanceof CommandFailed) {
    let id = event.id;
    let failure = event.failure;
    return $json.object(
      listPrepend(
        ["type", $json.string("command_failed")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(
            ["failure", command_failure_to_json(failure)],
            $List$Empty$const,
          ),
        ),
      ),
    );
  } else if (event instanceof WorkflowReturned) {
    let id = event.id;
    let output = event.output;
    return $json.object(
      listPrepend(
        ["type", $json.string("workflow_returned")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(
            ["output", $json_value.to_json(output)],
            $List$Empty$const,
          ),
        ),
      ),
    );
  } else if (event instanceof WorkflowFailed) {
    let id = event.id;
    let reason = event.reason;
    return $json.object(
      listPrepend(
        ["type", $json.string("workflow_failed")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(
            ["reason", fail_reason_to_json(reason)],
            $List$Empty$const,
          ),
        ),
      ),
    );
  } else if (event instanceof Noted) {
    let key = event.key;
    let value = event.value;
    return $json.object(
      listPrepend(
        ["type", $json.string("noted")],
        listPrepend(
          ["key", $json.string(key)],
          listPrepend(["value", $json_value.to_json(value)], $List$Empty$const),
        ),
      ),
    );
  } else if (event instanceof BodyFinished) {
    let output = event.output;
    return $json.object(
      listPrepend(
        ["type", $json.string("body_finished")],
        listPrepend(["output", $json_value.to_json(output)], $List$Empty$const),
      ),
    );
  } else {
    let reason = event.reason;
    return $json.object(
      listPrepend(
        ["type", $json.string("body_failed")],
        listPrepend(["reason", fail_reason_to_json(reason)], $List$Empty$const),
      ),
    );
  }
}

export function agent_failure_decoder() {
  return $decode.field(
    "type",
    $decode.string,
    (variant) => {
      if (variant === "turn_limit_reached") {
        return $decode.field(
          "turns",
          $decode.int,
          (turns) => { return $decode.success(new TurnLimitReached(turns)); },
        );
      } else if (variant === "gave_up") {
        return $decode.field(
          "error",
          $decode.string,
          (error) => { return $decode.success(new GaveUp(error)); },
        );
      } else if (variant === "context_exhausted") {
        return $decode.success(AgentFailure$ContextExhausted$const);
      } else if (variant === "invalid_output") {
        return $decode.field(
          "errors",
          $decode.list($decode.string),
          (errors) => { return $decode.success(new InvalidOutput(errors)); },
        );
      } else {
        return $decode.failure(
          AgentFailure$ContextExhausted$const,
          "AgentFailure",
        );
      }
    },
  );
}

export function command_failure_decoder() {
  return $decode.field(
    "type",
    $decode.string,
    (variant) => {
      if (variant === "exit_code") {
        return $decode.field(
          "code",
          $decode.int,
          (code) => {
            return $decode.field(
              "stderr_head",
              $decode.string,
              (stderr_head) => {
                return $decode.success(new ExitCode(code, stderr_head));
              },
            );
          },
        );
      } else if (variant === "killed") {
        return $decode.field(
          "signal",
          $decode.string,
          (signal) => {
            return $decode.field(
              "stderr_head",
              $decode.string,
              (stderr_head) => {
                return $decode.success(new Killed(signal, stderr_head));
              },
            );
          },
        );
      } else if (variant === "output_mismatch") {
        return $decode.field(
          "errors",
          $decode.list($decode.string),
          (errors) => { return $decode.success(new OutputMismatch(errors)); },
        );
      } else if (variant === "missing_file") {
        return $decode.field(
          "name",
          $decode.string,
          (name) => { return $decode.success(new MissingFile(name)); },
        );
      } else if (variant === "parse_error") {
        return $decode.field(
          "message",
          $decode.string,
          (message) => { return $decode.success(new ParseError(message)); },
        );
      } else if (variant === "unrunnable") {
        return $decode.field(
          "error",
          $decode.string,
          (error) => { return $decode.success(new Unrunnable(error)); },
        );
      } else {
        return $decode.failure(
          new OutputMismatch($List$Empty$const),
          "CommandFailure",
        );
      }
    },
  );
}

export function fail_reason_decoder() {
  return $decode.field(
    "type",
    $decode.string,
    (variant) => {
      if (variant === "body_error") {
        return $decode.field(
          "message",
          $decode.string,
          (message) => { return $decode.success(new BodyError(message)); },
        );
      } else if (variant === "command_error") {
        return $decode.field(
          "command",
          $decode.string,
          (command) => {
            return $decode.field(
              "failure",
              command_failure_decoder(),
              (failure) => {
                return $decode.success(new CommandError(command, failure));
              },
            );
          },
        );
      } else if (variant === "workflow_error") {
        return $decode.field(
          "workflow",
          $decode.string,
          (workflow) => {
            return $decode.field(
              "reason",
              fail_reason_decoder(),
              (reason) => {
                return $decode.success(new WorkflowError(workflow, reason));
              },
            );
          },
        );
      } else if (variant === "agent_error") {
        return $decode.field(
          "agent",
          $decode.string,
          (agent) => {
            return $decode.field(
              "failure",
              agent_failure_decoder(),
              (failure) => {
                return $decode.field(
                  "session",
                  $decode.optional($decode.string),
                  (session) => {
                    return $decode.success(
                      new AgentError(agent, failure, session),
                    );
                  },
                );
              },
            );
          },
        );
      } else if (variant === "tool_error") {
        return $decode.field(
          "tool",
          $decode.string,
          (tool) => {
            return $decode.field(
              "message",
              $decode.string,
              (message) => {
                return $decode.success(new ToolError(tool, message));
              },
            );
          },
        );
      } else if (variant === "schema_mismatch") {
        return $decode.field(
          "node",
          $decode.string,
          (node) => {
            return $decode.field(
              "errors",
              $decode.list($decode.string),
              (errors) => {
                return $decode.success(new SchemaMismatch(node, errors));
              },
            );
          },
        );
      } else {
        return $decode.failure(new BodyError(""), "FailReason");
      }
    },
  );
}

export function request_decoder() {
  return $decode.field(
    "type",
    $decode.string,
    (variant) => {
      if (variant === "command_call") {
        return $decode.field(
          "name",
          $decode.string,
          (name) => {
            return $decode.field(
              "input",
              $json_value.decoder(),
              (input) => {
                return $decode.success(new CommandCall(name, input));
              },
            );
          },
        );
      } else if (variant === "workflow_call") {
        return $decode.field(
          "name",
          $decode.string,
          (name) => {
            return $decode.field(
              "input",
              $json_value.decoder(),
              (input) => {
                return $decode.success(new WorkflowCall(name, input));
              },
            );
          },
        );
      } else if (variant === "agent_call") {
        return $decode.field(
          "name",
          $decode.string,
          (name) => {
            return $decode.field(
              "input",
              $json_value.decoder(),
              (input) => {
                return $decode.field(
                  "session",
                  $decode.optional($decode.string),
                  (session) => {
                    return $decode.field(
                      "from",
                      $decode.list($decode.string),
                      (from) => {
                        return $decode.success(
                          new AgentCall(name, input, session, from),
                        );
                      },
                    );
                  },
                );
              },
            );
          },
        );
      } else if (variant === "tool_call") {
        return $decode.field(
          "name",
          $decode.string,
          (name) => {
            return $decode.field(
              "input",
              $json_value.decoder(),
              (input) => {
                return $decode.field(
                  "replay_safe",
                  $decode.bool,
                  (replay_safe) => {
                    return $decode.success(
                      new ToolCall(name, input, replay_safe),
                    );
                  },
                );
              },
            );
          },
        );
      } else {
        return $decode.failure(
          new CommandCall("", $json_value.Value$JNull$const),
          "Request",
        );
      }
    },
  );
}

export function event_decoder() {
  return $decode.field(
    "type",
    $decode.string,
    (variant) => {
      if (variant === "started") {
        return $decode.field(
          "workflow",
          workflow_decoder(),
          (workflow) => {
            return $decode.field(
              "input",
              $json_value.decoder(),
              (input) => {
                return $decode.field(
                  "semantics",
                  $decode.string,
                  (semantics) => {
                    return $decode.success(
                      new Started(workflow, input, semantics),
                    );
                  },
                );
              },
            );
          },
        );
      } else if (variant === "resumed") {
        return $decode.field(
          "digest",
          $decode.string,
          (digest) => {
            return $decode.field(
              "semantics",
              $decode.string,
              (semantics) => {
                return $decode.success(new Resumed(digest, semantics));
              },
            );
          },
        );
      } else if (variant === "requested") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "request",
              request_decoder(),
              (request) => {
                return $decode.field(
                  "node",
                  $decode.string,
                  (node) => {
                    return $decode.field(
                      "scope",
                      $decode.string,
                      (scope) => {
                        return $decode.field(
                          "occurrence",
                          $decode.int,
                          (occurrence) => {
                            return $decode.success(
                              new Requested(
                                id,
                                request,
                                node,
                                scope,
                                occurrence,
                              ),
                            );
                          },
                        );
                      },
                    );
                  },
                );
              },
            );
          },
        );
      } else if (variant === "agent_progressed") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "checkpoint",
              $decode.string,
              (checkpoint) => {
                return $decode.success(new AgentProgressed(id, checkpoint));
              },
            );
          },
        );
      } else if (variant === "messages_taken") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "messages",
              $decode.list($decode.string),
              (messages) => {
                return $decode.field(
                  "turn",
                  $decode.int,
                  (turn) => {
                    return $decode.success(
                      new MessagesTaken(id, messages, turn),
                    );
                  },
                );
              },
            );
          },
        );
      } else if (variant === "agent_returned") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "output",
              $json_value.decoder(),
              (output) => {
                return $decode.field(
                  "model",
                  $decode.string,
                  (model) => {
                    return $decode.field(
                      "dialogue",
                      $decode.string,
                      (dialogue) => {
                        return $decode.field(
                          "layers",
                          $decode.list($decode.string),
                          (layers) => {
                            return $decode.success(
                              new AgentReturned(
                                id,
                                output,
                                model,
                                dialogue,
                                layers,
                              ),
                            );
                          },
                        );
                      },
                    );
                  },
                );
              },
            );
          },
        );
      } else if (variant === "agent_failed") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "failure",
              agent_failure_decoder(),
              (failure) => {
                return $decode.field(
                  "model",
                  $decode.string,
                  (model) => {
                    return $decode.field(
                      "dialogue",
                      $decode.optional($decode.string),
                      (dialogue) => {
                        return $decode.field(
                          "layers",
                          $decode.list($decode.string),
                          (layers) => {
                            return $decode.success(
                              new AgentFailed(
                                id,
                                failure,
                                model,
                                dialogue,
                                layers,
                              ),
                            );
                          },
                        );
                      },
                    );
                  },
                );
              },
            );
          },
        );
      } else if (variant === "sent") {
        return $decode.field(
          "key",
          $decode.string,
          (key) => {
            return $decode.field(
              "to",
              $decode.string,
              (to) => {
                return $decode.field(
                  "from",
                  $decode.string,
                  (from) => {
                    return $decode.field(
                      "reply_to",
                      $decode.optional($decode.string),
                      (reply_to) => {
                        return $decode.field(
                          "body",
                          $json_value.decoder(),
                          (body) => {
                            return $decode.success(
                              new Sent(key, to, from, reply_to, body),
                            );
                          },
                        );
                      },
                    );
                  },
                );
              },
            );
          },
        );
      } else if (variant === "tool_returned") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "output",
              $json_value.decoder(),
              (output) => {
                return $decode.success(new ToolReturned(id, output));
              },
            );
          },
        );
      } else if (variant === "tool_failed") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "message",
              $decode.string,
              (message) => {
                return $decode.success(new ToolFailed(id, message));
              },
            );
          },
        );
      } else if (variant === "retried") {
        return $decode.field(
          "call",
          $decode.string,
          (call) => {
            return $decode.field(
              "turns",
              $decode.int,
              (turns) => { return $decode.success(new Retried(call, turns)); },
            );
          },
        );
      } else if (variant === "command_returned") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "output",
              $json_value.decoder(),
              (output) => {
                return $decode.success(new CommandReturned(id, output));
              },
            );
          },
        );
      } else if (variant === "command_failed") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "failure",
              command_failure_decoder(),
              (failure) => {
                return $decode.success(new CommandFailed(id, failure));
              },
            );
          },
        );
      } else if (variant === "workflow_returned") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "output",
              $json_value.decoder(),
              (output) => {
                return $decode.success(new WorkflowReturned(id, output));
              },
            );
          },
        );
      } else if (variant === "workflow_failed") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "reason",
              fail_reason_decoder(),
              (reason) => {
                return $decode.success(new WorkflowFailed(id, reason));
              },
            );
          },
        );
      } else if (variant === "noted") {
        return $decode.field(
          "key",
          $decode.string,
          (key) => {
            return $decode.field(
              "value",
              $json_value.decoder(),
              (value) => { return $decode.success(new Noted(key, value)); },
            );
          },
        );
      } else if (variant === "body_finished") {
        return $decode.field(
          "output",
          $json_value.decoder(),
          (output) => { return $decode.success(new BodyFinished(output)); },
        );
      } else if (variant === "body_failed") {
        return $decode.field(
          "reason",
          fail_reason_decoder(),
          (reason) => { return $decode.success(new BodyFailed(reason)); },
        );
      } else {
        return $decode.failure(
          new BodyFinished($json_value.Value$JNull$const),
          "Event",
        );
      }
    },
  );
}

export function continuation_to_json(continuation) {
  if (continuation instanceof Fresh) {
    return $json.object(
      listPrepend(["type", $json.string("fresh")], $List$Empty$const),
    );
  } else if (continuation instanceof MoreTurns) {
    let turns = continuation.turns;
    return $json.object(
      listPrepend(
        ["type", $json.string("more_turns")],
        listPrepend(["turns", $json.int(turns)], $List$Empty$const),
      ),
    );
  } else {
    let errors = continuation.errors;
    return $json.object(
      listPrepend(
        ["type", $json.string("fix_output")],
        listPrepend(
          ["errors", $json.array(errors, $json.string)],
          $List$Empty$const,
        ),
      ),
    );
  }
}

export function continuation_decoder() {
  return $decode.field(
    "type",
    $decode.string,
    (variant) => {
      if (variant === "fresh") {
        return $decode.success(Continuation$Fresh$const);
      } else if (variant === "more_turns") {
        return $decode.field(
          "turns",
          $decode.int,
          (turns) => { return $decode.success(new MoreTurns(turns)); },
        );
      } else if (variant === "fix_output") {
        return $decode.field(
          "errors",
          $decode.list($decode.string),
          (errors) => { return $decode.success(new FixOutput(errors)); },
        );
      } else {
        return $decode.failure(Continuation$Fresh$const, "Continuation");
      }
    },
  );
}

export function envelope_to_json(envelope) {
  let id = envelope.id;
  let from = envelope.from;
  let reply_to = envelope.reply_to;
  let body = envelope.body;
  return $json.object(
    listPrepend(
      ["id", $json.string(id)],
      listPrepend(
        ["from", $json.string(from)],
        listPrepend(
          [
            "reply_to",
            (() => {
              if (reply_to instanceof $option.Some) {
                let value = reply_to[0];
                return $json.string(value);
              } else {
                return $json.null$();
              }
            })(),
          ],
          listPrepend(["body", $json_value.to_json(body)], $List$Empty$const),
        ),
      ),
    ),
  );
}

export function envelope_decoder() {
  return $decode.field(
    "id",
    $decode.string,
    (id) => {
      return $decode.field(
        "from",
        $decode.string,
        (from) => {
          return $decode.field(
            "reply_to",
            $decode.optional($decode.string),
            (reply_to) => {
              return $decode.field(
                "body",
                $json_value.decoder(),
                (body) => {
                  return $decode.success(new Envelope(id, from, reply_to, body));
                },
              );
            },
          );
        },
      );
    },
  );
}

export function taken_to_json(taken) {
  let turn = taken.turn;
  let messages = taken.messages;
  return $json.object(
    listPrepend(
      ["turn", $json.int(turn)],
      listPrepend(
        ["messages", $json.array(messages, $json.string)],
        $List$Empty$const,
      ),
    ),
  );
}

export function taken_decoder() {
  return $decode.field(
    "turn",
    $decode.int,
    (turn) => {
      return $decode.field(
        "messages",
        $decode.list($decode.string),
        (messages) => { return $decode.success(new Taken(turn, messages)); },
      );
    },
  );
}

export function outcome_to_json(outcome) {
  if (outcome instanceof Done) {
    let value = outcome.value;
    return $json.object(
      listPrepend(
        ["type", $json.string("done")],
        listPrepend(["value", $json_value.to_json(value)], $List$Empty$const),
      ),
    );
  } else {
    let reason = outcome.reason;
    return $json.object(
      listPrepend(
        ["type", $json.string("failed")],
        listPrepend(["reason", fail_reason_to_json(reason)], $List$Empty$const),
      ),
    );
  }
}

export function outcome_decoder() {
  return $decode.field(
    "type",
    $decode.string,
    (variant) => {
      if (variant === "done") {
        return $decode.field(
          "value",
          $json_value.decoder(),
          (value) => { return $decode.success(new Done(value)); },
        );
      } else if (variant === "failed") {
        return $decode.field(
          "reason",
          fail_reason_decoder(),
          (reason) => { return $decode.success(new Failed(reason)); },
        );
      } else {
        return $decode.failure(
          new Done($json_value.Value$JNull$const),
          "Outcome",
        );
      }
    },
  );
}

export function refusal_to_json(refusal) {
  if (refusal instanceof NotStarted) {
    return $json.object(
      listPrepend(["type", $json.string("not_started")], $List$Empty$const),
    );
  } else if (refusal instanceof AlreadyStarted) {
    return $json.object(
      listPrepend(["type", $json.string("already_started")], $List$Empty$const),
    );
  } else if (refusal instanceof RunEnded) {
    return $json.object(
      listPrepend(["type", $json.string("run_ended")], $List$Empty$const),
    );
  } else if (refusal instanceof SemanticsChanged) {
    let recorded = refusal.recorded;
    let current = refusal.current;
    return $json.object(
      listPrepend(
        ["type", $json.string("semantics_changed")],
        listPrepend(
          ["recorded", $json.string(recorded)],
          listPrepend(["current", $json.string(current)], $List$Empty$const),
        ),
      ),
    );
  } else if (refusal instanceof UnknownRequest) {
    let id = refusal.id;
    return $json.object(
      listPrepend(
        ["type", $json.string("unknown_request")],
        listPrepend(["id", $json.string(id)], $List$Empty$const),
      ),
    );
  } else if (refusal instanceof NotRunning) {
    let id = refusal.id;
    return $json.object(
      listPrepend(
        ["type", $json.string("not_running")],
        listPrepend(["id", $json.string(id)], $List$Empty$const),
      ),
    );
  } else if (refusal instanceof UnknownSession) {
    let session = refusal.session;
    return $json.object(
      listPrepend(
        ["type", $json.string("unknown_session")],
        listPrepend(["session", $json.string(session)], $List$Empty$const),
      ),
    );
  } else if (refusal instanceof SessionOfAnotherAgent) {
    let session = refusal.session;
    return $json.object(
      listPrepend(
        ["type", $json.string("session_of_another_agent")],
        listPrepend(["session", $json.string(session)], $List$Empty$const),
      ),
    );
  } else if (refusal instanceof NotRetriable) {
    let call = refusal.call;
    return $json.object(
      listPrepend(
        ["type", $json.string("not_retriable")],
        listPrepend(["call", $json.string(call)], $List$Empty$const),
      ),
    );
  } else {
    let message = refusal.message;
    return $json.object(
      listPrepend(
        ["type", $json.string("invalid_event")],
        listPrepend(["message", $json.string(message)], $List$Empty$const),
      ),
    );
  }
}

export function refusal_decoder() {
  return $decode.field(
    "type",
    $decode.string,
    (variant) => {
      if (variant === "not_started") {
        return $decode.success(Refusal$NotStarted$const);
      } else if (variant === "already_started") {
        return $decode.success(Refusal$AlreadyStarted$const);
      } else if (variant === "run_ended") {
        return $decode.success(Refusal$RunEnded$const);
      } else if (variant === "semantics_changed") {
        return $decode.field(
          "recorded",
          $decode.string,
          (recorded) => {
            return $decode.field(
              "current",
              $decode.string,
              (current) => {
                return $decode.success(new SemanticsChanged(recorded, current));
              },
            );
          },
        );
      } else if (variant === "unknown_request") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => { return $decode.success(new UnknownRequest(id)); },
        );
      } else if (variant === "not_running") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => { return $decode.success(new NotRunning(id)); },
        );
      } else if (variant === "unknown_session") {
        return $decode.field(
          "session",
          $decode.string,
          (session) => { return $decode.success(new UnknownSession(session)); },
        );
      } else if (variant === "session_of_another_agent") {
        return $decode.field(
          "session",
          $decode.string,
          (session) => {
            return $decode.success(new SessionOfAnotherAgent(session));
          },
        );
      } else if (variant === "not_retriable") {
        return $decode.field(
          "call",
          $decode.string,
          (call) => { return $decode.success(new NotRetriable(call)); },
        );
      } else if (variant === "invalid_event") {
        return $decode.field(
          "message",
          $decode.string,
          (message) => { return $decode.success(new InvalidEvent(message)); },
        );
      } else {
        return $decode.failure(Refusal$NotStarted$const, "Refusal");
      }
    },
  );
}

export function effect_to_json(effect) {
  if (effect instanceof Checkpoint) {
    return $json.object(
      listPrepend(["type", $json.string("checkpoint")], $List$Empty$const),
    );
  } else if (effect instanceof RunCommand) {
    let id = effect.id;
    let attempt = effect.attempt;
    return $json.object(
      listPrepend(
        ["type", $json.string("run_command")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(["attempt", $json.int(attempt)], $List$Empty$const),
        ),
      ),
    );
  } else if (effect instanceof RunWorkflow) {
    let id = effect.id;
    let scope = effect.scope;
    let attempt = effect.attempt;
    return $json.object(
      listPrepend(
        ["type", $json.string("run_workflow")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(
            ["scope", $json.string(scope)],
            listPrepend(["attempt", $json.int(attempt)], $List$Empty$const),
          ),
        ),
      ),
    );
  } else if (effect instanceof CallAgent) {
    let id = effect.id;
    let attempt = effect.attempt;
    let mailbox = effect.mailbox;
    let history = effect.history;
    let layers = effect.layers;
    let checkpoint = effect.checkpoint;
    let taken = effect.taken;
    let continuation = effect.continuation;
    return $json.object(
      listPrepend(
        ["type", $json.string("call_agent")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(
            ["attempt", $json.int(attempt)],
            listPrepend(
              ["mailbox", $json.string(mailbox)],
              listPrepend(
                [
                  "history",
                  (() => {
                    if (history instanceof $option.Some) {
                      let value = history[0];
                      return $json.string(value);
                    } else {
                      return $json.null$();
                    }
                  })(),
                ],
                listPrepend(
                  ["layers", $json.array(layers, $json.string)],
                  listPrepend(
                    [
                      "checkpoint",
                      (() => {
                        if (checkpoint instanceof $option.Some) {
                          let value = checkpoint[0];
                          return $json.string(value);
                        } else {
                          return $json.null$();
                        }
                      })(),
                    ],
                    listPrepend(
                      ["taken", $json.array(taken, taken_to_json)],
                      listPrepend(
                        ["continuation", continuation_to_json(continuation)],
                        $List$Empty$const,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  } else if (effect instanceof RunTool) {
    let id = effect.id;
    let attempt = effect.attempt;
    return $json.object(
      listPrepend(
        ["type", $json.string("run_tool")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(["attempt", $json.int(attempt)], $List$Empty$const),
        ),
      ),
    );
  } else if (effect instanceof Delivered) {
    let mailbox = effect.mailbox;
    let message = effect.message;
    return $json.object(
      listPrepend(
        ["type", $json.string("delivered")],
        listPrepend(
          ["mailbox", $json.string(mailbox)],
          listPrepend(["message", envelope_to_json(message)], $List$Empty$const),
        ),
      ),
    );
  } else if (effect instanceof Deliver) {
    let id = effect.id;
    let value = effect.value;
    return $json.object(
      listPrepend(
        ["type", $json.string("deliver")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(["value", $json_value.to_json(value)], $List$Empty$const),
        ),
      ),
    );
  } else if (effect instanceof Fail) {
    let id = effect.id;
    let reason = effect.reason;
    return $json.object(
      listPrepend(
        ["type", $json.string("fail")],
        listPrepend(
          ["id", $json.string(id)],
          listPrepend(
            ["reason", fail_reason_to_json(reason)],
            $List$Empty$const,
          ),
        ),
      ),
    );
  } else if (effect instanceof Refuse) {
    let id = effect.id;
    let refusal = effect.refusal;
    return $json.object(
      listPrepend(
        ["type", $json.string("refuse")],
        listPrepend(
          [
            "id",
            (() => {
              if (id instanceof $option.Some) {
                let value = id[0];
                return $json.string(value);
              } else {
                return $json.null$();
              }
            })(),
          ],
          listPrepend(["refusal", refusal_to_json(refusal)], $List$Empty$const),
        ),
      ),
    );
  } else {
    let outcome = effect.outcome;
    return $json.object(
      listPrepend(
        ["type", $json.string("finish")],
        listPrepend(["outcome", outcome_to_json(outcome)], $List$Empty$const),
      ),
    );
  }
}

export function effect_decoder() {
  return $decode.field(
    "type",
    $decode.string,
    (variant) => {
      if (variant === "checkpoint") {
        return $decode.success(Effect$Checkpoint$const);
      } else if (variant === "run_command") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "attempt",
              $decode.int,
              (attempt) => {
                return $decode.success(new RunCommand(id, attempt));
              },
            );
          },
        );
      } else if (variant === "run_workflow") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "scope",
              $decode.string,
              (scope) => {
                return $decode.field(
                  "attempt",
                  $decode.int,
                  (attempt) => {
                    return $decode.success(new RunWorkflow(id, scope, attempt));
                  },
                );
              },
            );
          },
        );
      } else if (variant === "call_agent") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "attempt",
              $decode.int,
              (attempt) => {
                return $decode.field(
                  "mailbox",
                  $decode.string,
                  (mailbox) => {
                    return $decode.field(
                      "history",
                      $decode.optional($decode.string),
                      (history) => {
                        return $decode.field(
                          "layers",
                          $decode.list($decode.string),
                          (layers) => {
                            return $decode.field(
                              "checkpoint",
                              $decode.optional($decode.string),
                              (checkpoint) => {
                                return $decode.field(
                                  "taken",
                                  $decode.list(taken_decoder()),
                                  (taken) => {
                                    return $decode.field(
                                      "continuation",
                                      continuation_decoder(),
                                      (continuation) => {
                                        return $decode.success(
                                          new CallAgent(
                                            id,
                                            attempt,
                                            mailbox,
                                            history,
                                            layers,
                                            checkpoint,
                                            taken,
                                            continuation,
                                          ),
                                        );
                                      },
                                    );
                                  },
                                );
                              },
                            );
                          },
                        );
                      },
                    );
                  },
                );
              },
            );
          },
        );
      } else if (variant === "run_tool") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "attempt",
              $decode.int,
              (attempt) => { return $decode.success(new RunTool(id, attempt)); },
            );
          },
        );
      } else if (variant === "delivered") {
        return $decode.field(
          "mailbox",
          $decode.string,
          (mailbox) => {
            return $decode.field(
              "message",
              envelope_decoder(),
              (message) => {
                return $decode.success(new Delivered(mailbox, message));
              },
            );
          },
        );
      } else if (variant === "deliver") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "value",
              $json_value.decoder(),
              (value) => { return $decode.success(new Deliver(id, value)); },
            );
          },
        );
      } else if (variant === "fail") {
        return $decode.field(
          "id",
          $decode.string,
          (id) => {
            return $decode.field(
              "reason",
              fail_reason_decoder(),
              (reason) => { return $decode.success(new Fail(id, reason)); },
            );
          },
        );
      } else if (variant === "refuse") {
        return $decode.field(
          "id",
          $decode.optional($decode.string),
          (id) => {
            return $decode.field(
              "refusal",
              refusal_decoder(),
              (refusal) => { return $decode.success(new Refuse(id, refusal)); },
            );
          },
        );
      } else if (variant === "finish") {
        return $decode.field(
          "outcome",
          outcome_decoder(),
          (outcome) => { return $decode.success(new Finish(outcome)); },
        );
      } else {
        return $decode.failure(Effect$Checkpoint$const, "Effect");
      }
    },
  );
}
