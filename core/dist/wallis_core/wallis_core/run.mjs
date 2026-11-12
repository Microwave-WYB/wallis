/// <reference types="./run.d.mts" />
import * as $json from "../../gleam_json/gleam/json.mjs";
import * as $dict from "../../gleam_stdlib/gleam/dict.mjs";
import * as $int from "../../gleam_stdlib/gleam/int.mjs";
import * as $list from "../../gleam_stdlib/gleam/list.mjs";
import * as $option from "../../gleam_stdlib/gleam/option.mjs";
import { Some, Option$None$const } from "../../gleam_stdlib/gleam/option.mjs";
import * as $string from "../../gleam_stdlib/gleam/string.mjs";
import {
  Ok,
  Error,
  Empty as $Empty,
  List$Empty$const as $List$Empty$const,
  prepend as listPrepend,
  CustomType as $CustomType,
  isEqual,
} from "../gleam.mjs";
import * as $ids from "../wallis_core/ids.mjs";
import * as $types from "../wallis_core/types.mjs";
import * as $value from "../wallis_core/value.mjs";

class NotYetStarted extends $CustomType {}
const RunState$NotYetStarted$const = new NotYetStarted();

class Active extends $CustomType {
  constructor($0) {
    super();
    this[0] = $0;
  }
}

class Live extends $CustomType {}
const Lifecycle$Live$const = new Live();

class Ended extends $CustomType {
  constructor($0) {
    super();
    this[0] = $0;
  }
}

class Run extends $CustomType {
  constructor(lifecycle, workflow, prior_digests, input, calls, ids, sessions, mailboxes, sends, facts) {
    super();
    this.lifecycle = lifecycle;
    this.workflow = workflow;
    this.prior_digests = prior_digests;
    this.input = input;
    this.calls = calls;
    this.ids = ids;
    this.sessions = sessions;
    this.mailboxes = mailboxes;
    this.sends = sends;
    this.facts = facts;
  }
}

class Origin extends $CustomType {
  constructor(node, after, attempt, dialogue, layers) {
    super();
    this.node = node;
    this.after = after;
    this.attempt = attempt;
    this.dialogue = dialogue;
    this.layers = layers;
  }
}

class CommandKind extends $CustomType {}
const Kind$CommandKind$const = new CommandKind();

class WorkflowKind extends $CustomType {}
const Kind$WorkflowKind$const = new WorkflowKind();

/**
 * A call of a session value (`None`: a new session, whose workspace
 * starts from the layers `from`).
 * 
 * @ignore
 */
class AgentKind extends $CustomType {
  constructor(session, from) {
    super();
    this.session = session;
    this.from = from;
  }
}

class ToolKind extends $CustomType {
  constructor(replay_safe) {
    super();
    this.replay_safe = replay_safe;
  }
}

class Call extends $CustomType {
  constructor(id, kind, name, node, input, scope, occurrence, attempts) {
    super();
    this.id = id;
    this.kind = kind;
    this.name = name;
    this.node = node;
    this.input = input;
    this.scope = scope;
    this.occurrence = occurrence;
    this.attempts = attempts;
  }
}

class Running extends $CustomType {
  constructor(issued, checkpoint, taken, continuation) {
    super();
    this.issued = issued;
    this.checkpoint = checkpoint;
    this.taken = taken;
    this.continuation = continuation;
  }
}

class Settled extends $CustomType {
  constructor(entry) {
    super();
    this.entry = entry;
  }
}

class NotIssued extends $CustomType {}
const Issued$NotIssued$const = new NotIssued();

class IssuedNow extends $CustomType {}
const Issued$IssuedNow$const = new IssuedNow();

class Pending extends $CustomType {}
const Issued$Pending$const = new Pending();

class Answered extends $CustomType {
  constructor($0) {
    super();
    this[0] = $0;
  }
}

class Errored extends $CustomType {
  constructor($0) {
    super();
    this[0] = $0;
  }
}

/**
 * A failure that is the call's own outcome: answered from the journal
 * like a result, and run again only when retried. `dialogue`: an agent's
 * dialogue after it, which a retry continues.
 * 
 * @ignore
 */
class Decided extends $CustomType {
  constructor($0, dialogue) {
    super();
    this[0] = $0;
    this.dialogue = dialogue;
  }
}

class Starting extends $CustomType {
  constructor(workflow, input, semantics) {
    super();
    this.workflow = workflow;
    this.input = input;
    this.semantics = semantics;
  }
}

class Resuming extends $CustomType {
  constructor(digest, semantics) {
    super();
    this.digest = digest;
    this.semantics = semantics;
  }
}

/**
 * Host facts: applied even on a finished run.
 * 
 * @ignore
 */
class Noting extends $CustomType {
  constructor(key, value) {
    super();
    this.key = key;
    this.value = value;
  }
}

/**
 * Everything else: applied to a live run only (`live_event`).
 * 
 * @ignore
 */
class Applying extends $CustomType {}
const Phase$Applying$const = new Applying();

/**
 * Bumped when a change to the core changes what a log means.
 */
export const semantics = "wallis-core/v2.1";

function running() {
  return new Running(
    Issued$IssuedNow$const,
    Option$None$const,
    $List$Empty$const,
    $types.Continuation$Fresh$const,
  );
}

export function new$() {
  return RunState$NotYetStarted$const;
}

function phase(event) {
  if (event instanceof $types.Started) {
    let workflow = event.workflow;
    let input = event.input;
    let semantics$1 = event.semantics;
    return new Starting(workflow, input, semantics$1);
  } else if (event instanceof $types.Resumed) {
    let digest = event.digest;
    let semantics$1 = event.semantics;
    return new Resuming(digest, semantics$1);
  } else if (event instanceof $types.Requested) {
    return Phase$Applying$const;
  } else if (event instanceof $types.AgentProgressed) {
    return Phase$Applying$const;
  } else if (event instanceof $types.MessagesTaken) {
    return Phase$Applying$const;
  } else if (event instanceof $types.AgentReturned) {
    return Phase$Applying$const;
  } else if (event instanceof $types.AgentFailed) {
    return Phase$Applying$const;
  } else if (event instanceof $types.Sent) {
    return Phase$Applying$const;
  } else if (event instanceof $types.ToolReturned) {
    return Phase$Applying$const;
  } else if (event instanceof $types.ToolFailed) {
    return Phase$Applying$const;
  } else if (event instanceof $types.Retried) {
    return Phase$Applying$const;
  } else if (event instanceof $types.CommandReturned) {
    return Phase$Applying$const;
  } else if (event instanceof $types.CommandFailed) {
    return Phase$Applying$const;
  } else if (event instanceof $types.WorkflowReturned) {
    return Phase$Applying$const;
  } else if (event instanceof $types.WorkflowFailed) {
    return Phase$Applying$const;
  } else if (event instanceof $types.Noted) {
    let key = event.key;
    let value = event.value;
    return new Noting(key, value);
  } else if (event instanceof $types.BodyFinished) {
    return Phase$Applying$const;
  } else {
    return Phase$Applying$const;
  }
}

function finish(run, outcome) {
  return [
    new Run(
      new Ended(outcome),
      run.workflow,
      run.prior_digests,
      run.input,
      run.calls,
      run.ids,
      run.sessions,
      run.mailboxes,
      run.sends,
      run.facts,
    ),
    listPrepend(
      $types.Effect$Checkpoint$const,
      listPrepend(new $types.Finish(outcome), $List$Empty$const),
    ),
  ];
}

function result_or(r, default$) {
  if (r instanceof Ok) {
    let a = r[0];
    return a;
  } else {
    return default$;
  }
}

/**
 * A send: journaled once by its key, in its mailbox's order.
 * 
 * @ignore
 */
function sent(run, key, to, from, reply_to, body) {
  let $ = $dict.get(run.sends, key);
  if ($ instanceof Ok) {
    return [run, $List$Empty$const];
  } else {
    let messages = result_or($dict.get(run.mailboxes, to), $List$Empty$const);
    let id = (to + "/") + $int.to_string($list.length(messages));
    let envelope = new $types.Envelope(id, from, reply_to, body);
    return [
      new Run(
        run.lifecycle,
        run.workflow,
        run.prior_digests,
        run.input,
        run.calls,
        run.ids,
        run.sessions,
        $dict.insert(run.mailboxes, to, listPrepend(envelope, messages)),
        $dict.insert(run.sends, key, id),
        run.facts,
      ),
      listPrepend(
        $types.Effect$Checkpoint$const,
        listPrepend(new $types.Delivered(to, envelope), $List$Empty$const),
      ),
    ];
  }
}

function put(run, slot, call) {
  return new Run(
    run.lifecycle,
    run.workflow,
    run.prior_digests,
    run.input,
    $dict.insert(run.calls, slot, call),
    $dict.insert(run.ids, call.id, slot),
    run.sessions,
    run.mailboxes,
    run.sends,
    run.facts,
  );
}

function is_agent(kind) {
  if (kind instanceof CommandKind) {
    return false;
  } else if (kind instanceof WorkflowKind) {
    return false;
  } else if (kind instanceof AgentKind) {
    return true;
  } else {
    return false;
  }
}

/**
 * The call a request id names now (not one that moved away from it).
 * 
 * @ignore
 */
function lookup(run, id) {
  let $ = $dict.get(run.ids, id);
  if ($ instanceof Ok) {
    let slot = $[0];
    let $1 = $dict.get(run.calls, slot);
    if ($1 instanceof Ok) {
      let call = $1[0];
      if (isEqual(call.id, id)) {
        return new Ok([slot, call]);
      } else {
        return new Error(undefined);
      }
    } else {
      return new Error(undefined);
    }
  } else {
    return $;
  }
}

/**
 * Updates the running attempt of an agent call (a checkpoint, messages
 * taken); anything else is refused, typed.
 * 
 * @ignore
 */
function update_running(run, id, f) {
  let text = $ids.request_text(id);
  let $ = lookup(run, id);
  if ($ instanceof Ok) {
    let slot = $[0][0];
    let call = $[0][1];
    let $1 = call.attempts;
    let $2 = is_agent(call.kind);
    if ($1 instanceof $Empty) {
      return [
        run,
        listPrepend(
          new $types.Refuse(new Some(text), new $types.NotRunning(text)),
          $List$Empty$const,
        ),
      ];
    } else {
      let $3 = $1.head;
      if ($3 instanceof Running && $2) {
        let older = $1.tail;
        let issued = $3.issued;
        let checkpoint = $3.checkpoint;
        let taken = $3.taken;
        let continuation = $3.continuation;
        let $4 = f(checkpoint, taken);
        let checkpoint$1 = $4[0];
        let taken$1 = $4[1];
        let call$1 = new Call(
          call.id,
          call.kind,
          call.name,
          call.node,
          call.input,
          call.scope,
          call.occurrence,
          listPrepend(
            new Running(issued, checkpoint$1, taken$1, continuation),
            older,
          ),
        );
        return [
          put(run, slot, call$1),
          listPrepend($types.Effect$Checkpoint$const, $List$Empty$const),
        ];
      } else {
        return [
          run,
          listPrepend(
            new $types.Refuse(new Some(text), new $types.NotRunning(text)),
            $List$Empty$const,
          ),
        ];
      }
    }
  } else {
    return [
      run,
      listPrepend(
        new $types.Refuse(new Some(text), new $types.UnknownRequest(text)),
        $List$Empty$const,
      ),
    ];
  }
}

/**
 * The caller names a failed call to run again: its next request opens a
 * new attempt. An agent's decided failure continues its own dialogue (with
 * more turns, or with its output's errors); anything else starts fresh.
 * 
 * @ignore
 */
function retried(run, text, turns) {
  let _block;
  let _pipe = $dict.to_list(run.calls);
  _block = $list.find(_pipe, (e) => { return $ids.slot_text(e[0]) === text; });
  let found = _block;
  if (found instanceof Ok) {
    let slot = found[0][0];
    let call = found[0][1];
    let $ = call.attempts;
    if ($ instanceof $Empty) {
      return [
        run,
        listPrepend(
          new $types.Refuse(Option$None$const, new $types.NotRetriable(text)),
          $List$Empty$const,
        ),
      ];
    } else {
      let $1 = $.head;
      if ($1 instanceof Running) {
        return [
          run,
          listPrepend(
            new $types.Refuse(Option$None$const, new $types.NotRetriable(text)),
            $List$Empty$const,
          ),
        ];
      } else {
        let $2 = $1.entry;
        if ($2 instanceof Answered) {
          return [
            run,
            listPrepend(
              new $types.Refuse(
                Option$None$const,
                new $types.NotRetriable(text),
              ),
              $List$Empty$const,
            ),
          ];
        } else if ($2 instanceof Errored) {
          return [run, $List$Empty$const];
        } else {
          let reason = $2[0];
          let dialogue = $2.dialogue;
          let _block$1;
          if (reason instanceof $types.BodyError) {
            _block$1 = $types.Continuation$Fresh$const;
          } else if (reason instanceof $types.CommandError) {
            _block$1 = $types.Continuation$Fresh$const;
          } else if (reason instanceof $types.WorkflowError) {
            _block$1 = $types.Continuation$Fresh$const;
          } else if (reason instanceof $types.AgentError) {
            let $3 = reason.failure;
            if ($3 instanceof $types.TurnLimitReached) {
              _block$1 = new $types.MoreTurns(turns);
            } else if ($3 instanceof $types.InvalidOutput) {
              let errors = $3.errors;
              _block$1 = new $types.FixOutput(errors);
            } else {
              _block$1 = $types.Continuation$Fresh$const;
            }
          } else if (reason instanceof $types.ToolError) {
            _block$1 = $types.Continuation$Fresh$const;
          } else {
            _block$1 = $types.Continuation$Fresh$const;
          }
          let continuation = _block$1;
          let attempt = new Running(
            Issued$Pending$const,
            dialogue,
            $List$Empty$const,
            continuation,
          );
          let call$1 = new Call(
            call.id,
            call.kind,
            call.name,
            call.node,
            call.input,
            call.scope,
            call.occurrence,
            listPrepend(attempt, call.attempts),
          );
          return [
            put(run, slot, call$1),
            listPrepend($types.Effect$Checkpoint$const, $List$Empty$const),
          ];
        }
      }
    }
  } else {
    return [
      run,
      listPrepend(
        new $types.Refuse(Option$None$const, new $types.NotRetriable(text)),
        $List$Empty$const,
      ),
    ];
  }
}

function is_tool(kind) {
  if (kind instanceof CommandKind) {
    return false;
  } else if (kind instanceof WorkflowKind) {
    return false;
  } else if (kind instanceof AgentKind) {
    return false;
  } else {
    return true;
  }
}

/**
 * A result settles the running attempt of a call of its kind; any other
 * result is refused, typed.
 * 
 * @ignore
 */
function settle(run, id, kind, entry) {
  let text = $ids.request_text(id);
  let $ = lookup(run, id);
  if ($ instanceof Ok) {
    let slot = $[0][0];
    let call = $[0][1];
    let $1 = call.attempts;
    let $2 = kind(call.kind);
    if ($1 instanceof $Empty) {
      return [
        run,
        listPrepend(
          new $types.Refuse(new Some(text), new $types.NotRunning(text)),
          $List$Empty$const,
        ),
      ];
    } else if ($1.head instanceof Running && $2) {
      let older = $1.tail;
      let $3 = entry(slot, call);
      let run$1 = $3[0];
      let entry$1 = $3[1];
      let call$1 = new Call(
        call.id,
        call.kind,
        call.name,
        call.node,
        call.input,
        call.scope,
        call.occurrence,
        listPrepend(new Settled(entry$1), older),
      );
      let _block;
      if (entry$1 instanceof Answered) {
        let v = entry$1[0];
        _block = new $types.Deliver(text, v);
      } else if (entry$1 instanceof Errored) {
        let reason = entry$1[0];
        _block = new $types.Fail(text, reason);
      } else {
        let reason = entry$1[0];
        _block = new $types.Fail(text, reason);
      }
      let answer = _block;
      return [
        put(run$1, slot, call$1),
        listPrepend(
          $types.Effect$Checkpoint$const,
          listPrepend(answer, $List$Empty$const),
        ),
      ];
    } else {
      return [
        run,
        listPrepend(
          new $types.Refuse(new Some(text), new $types.NotRunning(text)),
          $List$Empty$const,
        ),
      ];
    }
  } else {
    return [
      run,
      listPrepend(
        new $types.Refuse(new Some(text), new $types.UnknownRequest(text)),
        $List$Empty$const,
      ),
    ];
  }
}

/**
 * The session a settled agent call answers with: a hash chain over its
 * slot and attempt, so a new attempt yields a new session value.
 * 
 * @ignore
 */
function register(run, slot, call, dialogue, layers) {
  let attempt = $list.length(call.attempts);
  let session = $ids.next_session(slot, attempt);
  let origin = new Origin(
    call.node,
    slot,
    attempt,
    dialogue,
    $list.map(layers, $ids.digest),
  );
  return [
    new Run(
      run.lifecycle,
      run.workflow,
      run.prior_digests,
      run.input,
      run.calls,
      run.ids,
      $dict.insert(run.sessions, session, origin),
      run.mailboxes,
      run.sends,
      run.facts,
    ),
    session,
  ];
}

function is_workflow(kind) {
  if (kind instanceof CommandKind) {
    return false;
  } else if (kind instanceof WorkflowKind) {
    return true;
  } else if (kind instanceof AgentKind) {
    return false;
  } else {
    return false;
  }
}

function is_command(kind) {
  if (kind instanceof CommandKind) {
    return true;
  } else if (kind instanceof WorkflowKind) {
    return false;
  } else if (kind instanceof AgentKind) {
    return false;
  } else {
    return false;
  }
}

/**
 * A running agent call's mailbox address: its slot, stable across resumes.
 * 
 * @ignore
 */
function mailbox_of(slot) {
  return "agent:" + $ids.slot_text(slot);
}

function issue(run, slot, call) {
  let id = $ids.request_text(call.id);
  let attempt = $list.length(call.attempts);
  let $ = call.kind;
  if ($ instanceof CommandKind) {
    return new $types.RunCommand(id, attempt);
  } else if ($ instanceof WorkflowKind) {
    return new $types.RunWorkflow(id, $ids.slot_text(slot), attempt);
  } else if ($ instanceof AgentKind) {
    let session = $.session;
    let from = $.from;
    let _block;
    if (session instanceof Some) {
      let s = session[0];
      _block = $option.from_result($dict.get(run.sessions, s));
    } else {
      _block = session;
    }
    let origin = _block;
    let _block$1;
    if (origin instanceof Some) {
      let o = origin[0];
      _block$1 = [o.dialogue, o.layers];
    } else {
      _block$1 = [Option$None$const, from];
    }
    let $1 = _block$1;
    let history = $1[0];
    let layers = $1[1];
    let _block$2;
    let $3 = call.attempts;
    if ($3 instanceof $Empty) {
      _block$2 = [
        Option$None$const,
        $List$Empty$const,
        $types.Continuation$Fresh$const,
      ];
    } else {
      let $4 = $3.head;
      if ($4 instanceof Running) {
        let checkpoint = $4.checkpoint;
        let taken = $4.taken;
        let continuation = $4.continuation;
        _block$2 = [checkpoint, taken, continuation];
      } else {
        _block$2 = [
          Option$None$const,
          $List$Empty$const,
          $types.Continuation$Fresh$const,
        ];
      }
    }
    let $2 = _block$2;
    let checkpoint = $2[0];
    let taken = $2[1];
    let continuation = $2[2];
    return new $types.CallAgent(
      id,
      attempt,
      mailbox_of(slot),
      $option.map(history, $ids.digest_text),
      $list.map(layers, $ids.digest_text),
      $option.map(checkpoint, $ids.digest_text),
      $list.reverse(taken),
      continuation,
    );
  } else {
    return new $types.RunTool(id, attempt);
  }
}

function kind_text(kind) {
  if (kind instanceof CommandKind) {
    return "command";
  } else if (kind instanceof WorkflowKind) {
    return "workflow";
  } else if (kind instanceof AgentKind) {
    return "agent";
  } else {
    return "tool";
  }
}

function requested_checked(run, id, kind, name, node, input, scope, occurrence) {
  let _block;
  if (kind instanceof CommandKind) {
    _block = Option$None$const;
  } else if (kind instanceof WorkflowKind) {
    _block = Option$None$const;
  } else if (kind instanceof AgentKind) {
    let $ = kind.session;
    if ($ instanceof Some) {
      let s = $[0];
      _block = new Some(s);
    } else {
      let $1 = kind.from;
      if ($1 instanceof $Empty) {
        _block = Option$None$const;
      } else {
        let from = $1;
        _block = new Some(
          $ids.session_id(
            "new:" + $string.join($list.map(from, $ids.digest_text), ","),
          ),
        );
      }
    }
  } else {
    _block = Option$None$const;
  }
  let within = _block;
  let slot = $ids.slot(
    node,
    kind_text(kind),
    input,
    scope,
    within,
    $int.to_string(occurrence),
  );
  let $ = $dict.get(run.calls, slot);
  if ($ instanceof Ok) {
    let call = $[0];
    let moved = !isEqual(call.id, id);
    let call$1 = new Call(
      id,
      call.kind,
      call.name,
      call.node,
      call.input,
      call.scope,
      call.occurrence,
      call.attempts,
    );
    let _block$1;
    let $2 = call$1.attempts;
    if ($2 instanceof $Empty) {
      let call$2 = new Call(
        call$1.id,
        call$1.kind,
        call$1.name,
        call$1.node,
        call$1.input,
        call$1.scope,
        call$1.occurrence,
        listPrepend(running(), call$1.attempts),
      );
      _block$1 = [
        call$2,
        listPrepend(
          $types.Effect$Checkpoint$const,
          listPrepend(issue(run, slot, call$2), $List$Empty$const),
        ),
      ];
    } else {
      let $3 = $2.head;
      if ($3 instanceof Running) {
        let $4 = $3.issued;
        if ($4 instanceof NotIssued) {
          if (isEqual(call$1.kind, new ToolKind(false))) {
            let older = $2.tail;
            let reason = new $types.ToolError(
              call$1.name,
              "outcome unknown: it was in flight when the run stopped; check, then retry it",
            );
            let call$2 = new Call(
              call$1.id,
              call$1.kind,
              call$1.name,
              call$1.node,
              call$1.input,
              call$1.scope,
              call$1.occurrence,
              listPrepend(
                new Settled(new Decided(reason, Option$None$const)),
                older,
              ),
            );
            _block$1 = [
              call$2,
              listPrepend(
                $types.Effect$Checkpoint$const,
                listPrepend(
                  new $types.Fail($ids.request_text(id), reason),
                  $List$Empty$const,
                ),
              ),
            ];
          } else {
            let older$1 = $2.tail;
            let checkpoint = $3.checkpoint;
            let taken = $3.taken;
            let continuation = $3.continuation;
            let call$3 = new Call(
              call$1.id,
              call$1.kind,
              call$1.name,
              call$1.node,
              call$1.input,
              call$1.scope,
              call$1.occurrence,
              listPrepend(
                new Running(
                  Issued$IssuedNow$const,
                  checkpoint,
                  taken,
                  continuation,
                ),
                older$1,
              ),
            );
            _block$1 = [
              call$3,
              listPrepend(issue(run, slot, call$3), $List$Empty$const),
            ];
          }
        } else if ($4 instanceof IssuedNow) {
          _block$1 = [call$1, $List$Empty$const];
        } else {
          let older = $2.tail;
          let checkpoint = $3.checkpoint;
          let taken = $3.taken;
          let continuation = $3.continuation;
          let call$2 = new Call(
            call$1.id,
            call$1.kind,
            call$1.name,
            call$1.node,
            call$1.input,
            call$1.scope,
            call$1.occurrence,
            listPrepend(
              new Running(
                Issued$IssuedNow$const,
                checkpoint,
                taken,
                continuation,
              ),
              older,
            ),
          );
          _block$1 = [
            call$2,
            listPrepend(
              $types.Effect$Checkpoint$const,
              listPrepend(issue(run, slot, call$2), $List$Empty$const),
            ),
          ];
        }
      } else {
        let $4 = $3.entry;
        if ($4 instanceof Answered) {
          let v = $4[0];
          _block$1 = [
            call$1,
            listPrepend(
              new $types.Deliver($ids.request_text(id), v),
              $List$Empty$const,
            ),
          ];
        } else if ($4 instanceof Errored) {
          let call$2 = new Call(
            call$1.id,
            call$1.kind,
            call$1.name,
            call$1.node,
            call$1.input,
            call$1.scope,
            call$1.occurrence,
            listPrepend(running(), call$1.attempts),
          );
          _block$1 = [
            call$2,
            listPrepend(
              $types.Effect$Checkpoint$const,
              listPrepend(issue(run, slot, call$2), $List$Empty$const),
            ),
          ];
        } else {
          let reason = $4[0];
          _block$1 = [
            call$1,
            listPrepend(
              new $types.Fail($ids.request_text(id), reason),
              $List$Empty$const,
            ),
          ];
        }
      }
    }
    let $1 = _block$1;
    let call$2 = $1[0];
    let effects = $1[1];
    let logged = $list.contains(effects, $types.Effect$Checkpoint$const);
    let _block$2;
    let $3 = moved && !logged;
    if ($3) {
      _block$2 = listPrepend($types.Effect$Checkpoint$const, effects);
    } else {
      _block$2 = effects;
    }
    let effects$1 = _block$2;
    return [put(run, slot, call$2), effects$1];
  } else {
    let call = new Call(
      id,
      kind,
      name,
      node,
      input,
      scope,
      occurrence,
      listPrepend(running(), $List$Empty$const),
    );
    return [
      put(run, slot, call),
      listPrepend(
        $types.Effect$Checkpoint$const,
        listPrepend(issue(run, slot, call), $List$Empty$const),
      ),
    ];
  }
}

/**
 * What a session call continues, checked: a session value this run
 * answered with, of this agent (by identity: a renamed agent still does).
 * 
 * @ignore
 */
function session_check(run, kind, node) {
  if (kind instanceof CommandKind) {
    return new Ok(Option$None$const);
  } else if (kind instanceof WorkflowKind) {
    return new Ok(Option$None$const);
  } else if (kind instanceof AgentKind) {
    let $ = kind.session;
    if ($ instanceof Some) {
      let s = $[0];
      let $1 = $dict.get(run.sessions, s);
      if ($1 instanceof Ok) {
        let origin = $1[0];
        if (!isEqual(origin.node, node)) {
          return new Error(
            new $types.SessionOfAnotherAgent($ids.session_text(s)),
          );
        } else {
          let origin$1 = $1[0];
          return new Ok(new Some(origin$1));
        }
      } else {
        return new Error(new $types.UnknownSession($ids.session_text(s)));
      }
    } else {
      return new Ok(Option$None$const);
    }
  } else {
    return new Ok(Option$None$const);
  }
}

function kind_of(request) {
  if (request instanceof $types.CommandCall) {
    let name = request.name;
    let input = request.input;
    return [Kind$CommandKind$const, name, input];
  } else if (request instanceof $types.WorkflowCall) {
    let name = request.name;
    let input = request.input;
    return [Kind$WorkflowKind$const, name, input];
  } else if (request instanceof $types.AgentCall) {
    let name = request.name;
    let input = request.input;
    let session = request.session;
    let from = request.from;
    return [
      new AgentKind(
        $option.map(session, $ids.session_id),
        $list.map(from, $ids.digest),
      ),
      name,
      input,
    ];
  } else {
    let name = request.name;
    let input = request.input;
    let replay_safe = request.replay_safe;
    return [new ToolKind(replay_safe), name, input];
  }
}

function requested(run, id, request, node, scope, occurrence) {
  let $ = kind_of(request);
  let kind = $[0];
  let name = $[1];
  let input = $[2];
  let $1 = session_check(run, kind, node);
  if ($1 instanceof Ok) {
    return requested_checked(
      run,
      id,
      kind,
      name,
      node,
      input,
      scope,
      occurrence,
    );
  } else {
    let refusal = $1[0];
    return [
      run,
      listPrepend(
        new $types.Refuse(new Some($ids.request_text(id)), refusal),
        $List$Empty$const,
      ),
    ];
  }
}

function live_event(run, event) {
  let rid = $ids.request_id;
  if (event instanceof $types.Started) {
    return [run, $List$Empty$const];
  } else if (event instanceof $types.Resumed) {
    return [run, $List$Empty$const];
  } else if (event instanceof $types.Requested) {
    let id = event.id;
    let request = event.request;
    let node = event.node;
    let scope = event.scope;
    let occurrence = event.occurrence;
    return requested(
      run,
      rid(id),
      request,
      $ids.digest(node),
      scope,
      occurrence,
    );
  } else if (event instanceof $types.AgentProgressed) {
    let id = event.id;
    let checkpoint = event.checkpoint;
    return update_running(
      run,
      rid(id),
      (_, taken) => { return [new Some($ids.digest(checkpoint)), taken]; },
    );
  } else if (event instanceof $types.MessagesTaken) {
    let id = event.id;
    let messages = event.messages;
    let turn = event.turn;
    return update_running(
      run,
      rid(id),
      (c, taken) => {
        return [c, listPrepend(new $types.Taken(turn, messages), taken)];
      },
    );
  } else if (event instanceof $types.AgentReturned) {
    let id = event.id;
    let output = event.output;
    let dialogue = event.dialogue;
    let layers = event.layers;
    return settle(
      run,
      rid(id),
      is_agent,
      (slot, call) => {
        let $ = register(
          run,
          slot,
          call,
          new Some($ids.digest(dialogue)),
          layers,
        );
        let run$1 = $[0];
        let session = $[1];
        return [
          run$1,
          new Answered(
            $value.object(
              listPrepend(
                ["output", output],
                listPrepend(
                  ["session", new $value.JString($ids.session_text(session))],
                  listPrepend(
                    [
                      "layers",
                      new $value.JArray(
                        $list.map(
                          layers,
                          (var0) => { return new $value.JString(var0); },
                        ),
                      ),
                    ],
                    $List$Empty$const,
                  ),
                ),
              ),
            ),
          ),
        ];
      },
    );
  } else if (event instanceof $types.AgentFailed) {
    let id = event.id;
    let failure = event.failure;
    let dialogue = event.dialogue;
    let layers = event.layers;
    return settle(
      run,
      rid(id),
      is_agent,
      (slot, call) => {
        let dialogue$1 = $option.map(dialogue, $ids.digest);
        let _block;
        if (dialogue$1 instanceof Some) {
          let $1 = register(run, slot, call, dialogue$1, layers);
          let run$1 = $1[0];
          let session = $1[1];
          _block = [run$1, new Some($ids.session_text(session))];
        } else {
          _block = [run, Option$None$const];
        }
        let $ = _block;
        let run$1 = $[0];
        let session = $[1];
        let reason = new $types.AgentError(call.name, failure, session);
        return [
          run$1,
          (() => {
            if (failure instanceof $types.TurnLimitReached) {
              return new Decided(reason, dialogue$1);
            } else if (failure instanceof $types.GaveUp) {
              return new Errored(reason);
            } else if (failure instanceof $types.ContextExhausted) {
              return new Errored(reason);
            } else {
              return new Decided(reason, dialogue$1);
            }
          })(),
        ];
      },
    );
  } else if (event instanceof $types.Sent) {
    let key = event.key;
    let to = event.to;
    let from = event.from;
    let reply_to = event.reply_to;
    let body = event.body;
    return sent(run, key, to, from, reply_to, body);
  } else if (event instanceof $types.ToolReturned) {
    let id = event.id;
    let output = event.output;
    return settle(
      run,
      rid(id),
      is_tool,
      (_, _1) => { return [run, new Answered(output)]; },
    );
  } else if (event instanceof $types.ToolFailed) {
    let id = event.id;
    let message = event.message;
    return settle(
      run,
      rid(id),
      is_tool,
      (_, call) => {
        return [run, new Errored(new $types.ToolError(call.name, message))];
      },
    );
  } else if (event instanceof $types.Retried) {
    let call = event.call;
    let turns = event.turns;
    return retried(run, call, turns);
  } else if (event instanceof $types.CommandReturned) {
    let id = event.id;
    let output = event.output;
    return settle(
      run,
      rid(id),
      is_command,
      (_, _1) => { return [run, new Answered(output)]; },
    );
  } else if (event instanceof $types.CommandFailed) {
    let id = event.id;
    let failure = event.failure;
    return settle(
      run,
      rid(id),
      is_command,
      (_, call) => {
        return [run, new Errored(new $types.CommandError(call.name, failure))];
      },
    );
  } else if (event instanceof $types.WorkflowReturned) {
    let id = event.id;
    let output = event.output;
    return settle(
      run,
      rid(id),
      is_workflow,
      (_, _1) => { return [run, new Answered(output)]; },
    );
  } else if (event instanceof $types.WorkflowFailed) {
    let id = event.id;
    let reason = event.reason;
    return settle(
      run,
      rid(id),
      is_workflow,
      (_, call) => {
        return [run, new Errored(new $types.WorkflowError(call.name, reason))];
      },
    );
  } else if (event instanceof $types.Noted) {
    return [run, $List$Empty$const];
  } else if (event instanceof $types.BodyFinished) {
    let output = event.output;
    return finish(run, new $types.Done(output));
  } else {
    let reason = event.reason;
    return finish(run, new $types.Failed(reason));
  }
}

function unissued(call) {
  let $ = call.attempts;
  if ($ instanceof $Empty) {
    return call;
  } else {
    let $1 = $.head;
    if ($1 instanceof Running) {
      let $2 = $1.issued;
      if ($2 instanceof NotIssued) {
        let older = $.tail;
        let checkpoint = $1.checkpoint;
        let taken = $1.taken;
        let continuation = $1.continuation;
        return new Call(
          call.id,
          call.kind,
          call.name,
          call.node,
          call.input,
          call.scope,
          call.occurrence,
          listPrepend(
            new Running(Issued$NotIssued$const, checkpoint, taken, continuation),
            older,
          ),
        );
      } else if ($2 instanceof IssuedNow) {
        let older = $.tail;
        let checkpoint = $1.checkpoint;
        let taken = $1.taken;
        let continuation = $1.continuation;
        return new Call(
          call.id,
          call.kind,
          call.name,
          call.node,
          call.input,
          call.scope,
          call.occurrence,
          listPrepend(
            new Running(Issued$NotIssued$const, checkpoint, taken, continuation),
            older,
          ),
        );
      } else {
        return call;
      }
    } else {
      return call;
    }
  }
}

/**
 * A new process drives the run. A completed run stays completed (its
 * outcome is the answer); a failed or stopped one is live again, with
 * nothing in flight issued by this process yet.
 * 
 * @ignore
 */
function resume(run, digest) {
  let _block;
  let $ = digest === run.workflow.digest;
  if ($) {
    _block = run.prior_digests;
  } else {
    _block = $list.append(
      run.prior_digests,
      listPrepend(run.workflow.digest, $List$Empty$const),
    );
  }
  let prior_digests = _block;
  let run$1 = new Run(
    run.lifecycle,
    (() => {
      let _record = run.workflow;
      return new $types.Workflow(_record.name, digest);
    })(),
    prior_digests,
    run.input,
    $dict.map_values(run.calls, (_, call) => { return unissued(call); }),
    run.ids,
    run.sessions,
    run.mailboxes,
    run.sends,
    run.facts,
  );
  let $1 = run$1.lifecycle;
  if ($1 instanceof Live) {
    return [
      new Run(
        Lifecycle$Live$const,
        run$1.workflow,
        run$1.prior_digests,
        run$1.input,
        run$1.calls,
        run$1.ids,
        run$1.sessions,
        run$1.mailboxes,
        run$1.sends,
        run$1.facts,
      ),
      listPrepend($types.Effect$Checkpoint$const, $List$Empty$const),
    ];
  } else {
    let $2 = $1[0];
    if ($2 instanceof $types.Done) {
      let outcome = $2;
      return [
        run$1,
        listPrepend(
          $types.Effect$Checkpoint$const,
          listPrepend(new $types.Finish(outcome), $List$Empty$const),
        ),
      ];
    } else {
      return [
        new Run(
          Lifecycle$Live$const,
          run$1.workflow,
          run$1.prior_digests,
          run$1.input,
          run$1.calls,
          run$1.ids,
          run$1.sessions,
          run$1.mailboxes,
          run$1.sends,
          run$1.facts,
        ),
        listPrepend($types.Effect$Checkpoint$const, $List$Empty$const),
      ];
    }
  }
}

export function step(state, event) {
  let $ = phase(event);
  if (state instanceof NotYetStarted) {
    if ($ instanceof Starting) {
      let workflow = $.workflow;
      let input = $.input;
      let s = $.semantics;
      let $1 = s === semantics;
      if ($1) {
        return [
          new Active(
            new Run(
              Lifecycle$Live$const,
              workflow,
              $List$Empty$const,
              input,
              $dict.new$(),
              $dict.new$(),
              $dict.new$(),
              $dict.new$(),
              $dict.new$(),
              $dict.new$(),
            ),
          ),
          listPrepend($types.Effect$Checkpoint$const, $List$Empty$const),
        ];
      } else {
        return [
          state,
          listPrepend(
            new $types.Refuse(
              Option$None$const,
              new $types.SemanticsChanged(s, semantics),
            ),
            $List$Empty$const,
          ),
        ];
      }
    } else if ($ instanceof Resuming) {
      return [
        state,
        listPrepend(
          new $types.Refuse(Option$None$const, $types.Refusal$NotStarted$const),
          $List$Empty$const,
        ),
      ];
    } else if ($ instanceof Noting) {
      return [
        state,
        listPrepend(
          new $types.Refuse(Option$None$const, $types.Refusal$NotStarted$const),
          $List$Empty$const,
        ),
      ];
    } else {
      return [
        state,
        listPrepend(
          new $types.Refuse(Option$None$const, $types.Refusal$NotStarted$const),
          $List$Empty$const,
        ),
      ];
    }
  } else if ($ instanceof Starting) {
    return [
      state,
      listPrepend(
        new $types.Refuse(
          Option$None$const,
          $types.Refusal$AlreadyStarted$const,
        ),
        $List$Empty$const,
      ),
    ];
  } else if ($ instanceof Resuming) {
    let r = state[0];
    let digest = $.digest;
    let $1 = resume(r, digest);
    let r$1 = $1[0];
    let effects = $1[1];
    return [new Active(r$1), effects];
  } else if ($ instanceof Noting) {
    let r = state[0];
    let key = $.key;
    let value = $.value;
    return [
      new Active(
        new Run(
          r.lifecycle,
          r.workflow,
          r.prior_digests,
          r.input,
          r.calls,
          r.ids,
          r.sessions,
          r.mailboxes,
          r.sends,
          $dict.insert(r.facts, key, value),
        ),
      ),
      listPrepend($types.Effect$Checkpoint$const, $List$Empty$const),
    ];
  } else if (state[0].lifecycle instanceof Live) {
    let r = state[0];
    let $1 = live_event(r, event);
    let r$1 = $1[0];
    let effects = $1[1];
    return [new Active(r$1), effects];
  } else {
    return [
      state,
      listPrepend(
        new $types.Refuse(Option$None$const, $types.Refusal$RunEnded$const),
        $List$Empty$const,
      ),
    ];
  }
}

/**
 * The whole state as text, for the differential check: everything but
 * what this process issued (which a log cannot know).
 */
export function full_state(state) {
  if (state instanceof NotYetStarted) {
    return "not_started";
  } else {
    let r = state[0];
    return $string.inspect(
      new Run(
        r.lifecycle,
        r.workflow,
        r.prior_digests,
        r.input,
        $dict.map_values(r.calls, (_, c) => { return unissued(c); }),
        r.ids,
        r.sessions,
        r.mailboxes,
        r.sends,
        r.facts,
      ),
    );
  }
}

/**
 * How many attempts the call at this request id has had (0: none).
 */
export function attempt_count(state, id) {
  if (state instanceof NotYetStarted) {
    return 0;
  } else {
    let r = state[0];
    let $ = lookup(r, $ids.request_id(id));
    if ($ instanceof Ok) {
      let call = $[0][1];
      return $list.length(call.attempts);
    } else {
      return 0;
    }
  }
}

function sorted_object(d, encode) {
  let _pipe = d;
  let _pipe$1 = $dict.to_list(_pipe);
  let _pipe$2 = $list.sort(
    _pipe$1,
    (a, b) => { return $string.compare(a[0], b[0]); },
  );
  let _pipe$3 = $list.map(_pipe$2, (e) => { return [e[0], encode(e[1])]; });
  return $json.object(_pipe$3);
}

export function host_facts(state) {
  if (state instanceof NotYetStarted) {
    return $json.object($List$Empty$const);
  } else {
    let r = state[0];
    return sorted_object(r.facts, $value.to_json);
  }
}

function attempt_json(attempt) {
  if (attempt instanceof Running) {
    return $json.object(
      listPrepend(["type", $json.string("running")], $List$Empty$const),
    );
  } else {
    let $ = attempt.entry;
    if ($ instanceof Answered) {
      let v = $[0];
      return $json.object(
        listPrepend(
          ["type", $json.string("answered")],
          listPrepend(["output", $value.to_json(v)], $List$Empty$const),
        ),
      );
    } else if ($ instanceof Errored) {
      let reason = $[0];
      return $json.object(
        listPrepend(
          ["type", $json.string("failed")],
          listPrepend(
            ["reason", $types.fail_reason_to_json(reason)],
            listPrepend(["decided", $json.bool(false)], $List$Empty$const),
          ),
        ),
      );
    } else {
      let reason = $[0];
      return $json.object(
        listPrepend(
          ["type", $json.string("failed")],
          listPrepend(
            ["reason", $types.fail_reason_to_json(reason)],
            listPrepend(["decided", $json.bool(true)], $List$Empty$const),
          ),
        ),
      );
    }
  }
}

function call_json(slot, call) {
  return $json.object(
    listPrepend(
      ["id", $json.string($ids.request_text(call.id))],
      listPrepend(
        ["slot", $json.string($ids.slot_text(slot))],
        listPrepend(
          ["kind", $json.string(kind_text(call.kind))],
          listPrepend(
            ["name", $json.string(call.name)],
            listPrepend(
              ["node", $json.string($ids.digest_text(call.node))],
              listPrepend(
                ["scope", $json.string(call.scope)],
                listPrepend(
                  ["occurrence", $json.int(call.occurrence)],
                  listPrepend(
                    ["input", $value.to_json(call.input)],
                    listPrepend(
                      [
                        "attempts",
                        $json.array($list.reverse(call.attempts), attempt_json),
                      ],
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
}

/**
 * The run as JSON: its workflow, status and every call with its attempts,
 * in slot order (the host orders them for display).
 */
export function snapshot(state) {
  if (state instanceof NotYetStarted) {
    return $json.object(
      listPrepend(["status", $json.string("not_started")], $List$Empty$const),
    );
  } else {
    let r = state[0];
    return $json.object(
      listPrepend(
        ["workflow", $types.workflow_to_json(r.workflow)],
        listPrepend(
          ["prior_digests", $json.array(r.prior_digests, $json.string)],
          listPrepend(
            ["input", $value.to_json(r.input)],
            listPrepend(
              [
                "status",
                (() => {
                  let $ = r.lifecycle;
                  if ($ instanceof Live) {
                    return $json.object(
                      listPrepend(
                        ["type", $json.string("live")],
                        $List$Empty$const,
                      ),
                    );
                  } else {
                    let outcome = $[0];
                    return $json.object(
                      listPrepend(
                        ["type", $json.string("ended")],
                        listPrepend(
                          ["outcome", $types.outcome_to_json(outcome)],
                          $List$Empty$const,
                        ),
                      ),
                    );
                  }
                })(),
              ],
              listPrepend(
                [
                  "mailboxes",
                  sorted_object(
                    r.mailboxes,
                    (m) => {
                      return $json.array(
                        $list.reverse(m),
                        $types.envelope_to_json,
                      );
                    },
                  ),
                ],
                listPrepend(
                  [
                    "calls",
                    (() => {
                      let _pipe = r.calls;
                      let _pipe$1 = $dict.to_list(_pipe);
                      let _pipe$2 = $list.sort(
                        _pipe$1,
                        (a, b) => {
                          return $string.compare(
                            $ids.slot_text(a[0]),
                            $ids.slot_text(b[0]),
                          );
                        },
                      );
                      return $json.array(
                        _pipe$2,
                        (e) => { return call_json(e[0], e[1]); },
                      );
                    })(),
                  ],
                  $List$Empty$const,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/**
 * A mailbox's messages in their journaled delivery order: what it
 * replays on resume before anything new.
 */
export function mailbox(state, address) {
  if (state instanceof NotYetStarted) {
    return $List$Empty$const;
  } else {
    let r = state[0];
    return $list.reverse(
      result_or($dict.get(r.mailboxes, address), $List$Empty$const),
    );
  }
}

/**
 * The journal key (slot) the request id names, "" when none.
 */
export function slot_of(state, id) {
  if (state instanceof NotYetStarted) {
    return "";
  } else {
    let r = state[0];
    let $ = $dict.get(r.ids, $ids.request_id(id));
    if ($ instanceof Ok) {
      let slot = $[0];
      return $ids.slot_text(slot);
    } else {
      return "";
    }
  }
}

/**
 * The id a journaled send's key was delivered as, "" when none.
 */
export function sent_id(state, key) {
  if (state instanceof NotYetStarted) {
    return "";
  } else {
    let r = state[0];
    return result_or($dict.get(r.sends, key), "");
  }
}

/**
 * Where the call at this slot is: "running" (its newest attempt is open),
 * "settled", or "none" (the run has no such call). A settled agent call's
 * mailbox is closed.
 */
export function call_state(state, slot_text) {
  if (state instanceof NotYetStarted) {
    return "none";
  } else {
    let r = state[0];
    let $ = (() => {
      let _pipe = $dict.to_list(r.calls);
      return $list.find(
        _pipe,
        (e) => { return $ids.slot_text(e[0]) === slot_text; },
      );
    })();
    if ($ instanceof Ok) {
      let call = $[0][1];
      let $1 = call.attempts;
      if ($1 instanceof $Empty) {
        return "none";
      } else if ($1.head instanceof Running) {
        return "running";
      } else {
        return "settled";
      }
    } else {
      return "none";
    }
  }
}
