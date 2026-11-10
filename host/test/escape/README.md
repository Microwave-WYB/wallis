# Escape suite — a permanent containment gate

Adversarial tests for wallis's sandbox claims. They use **real bwrap** where it
matters (skipping with an explicit reason when bwrap cannot create a sandbox
here), **fake executors / scripted agents only** (never a paid model), and each
test cleans up after itself (throwaway files under `/tmp` only).

Run with `mise run test:escape`; they are also part of `mise run test` (the
`test:host` glob includes `test/escape/*.test.ts`).

Two kinds of test:

- **Claims that hold** assert the containment *precisely*: the typed refusal
  kind, the host file left unchanged, the network unreachable, the secret
  absent. If a future change breaks one, the suite goes **red**.
- **Confirmed holes** are committed as `node:test` `todo`s naming the hole
  (`ESCAPE-NN`). The suite reports them without turning the main run red. Each
  is listed below with a repro, impact and suggested fix.

## Files

| File | What it attacks |
| --- | --- |
| `file-tools.test.ts` | Host file tools (`read`/`write`/`edit`/`ls`/`export_artifact`) vs symlinks, `..`, special files (FIFO/socket/device), odd names, long paths, read-only roots. Unit-level, no bwrap. |
| `toctou.test.ts` | TOCTOU race between `locate()` and the tool's `openSync` (**ESCAPE-02**). |
| `sandbox.test.ts` | Real bwrap: no network, private `/proc`, minimal `/dev`, no `$HOME`/workflow dir, named-volume read-only for agents, bind read-only. Hosts **ESCAPE-01**. |
| `declarations.test.ts` | Hand-built malicious declaration JSON at the host parser/resolvers: network on agents/commands, undeclared sandboxes, reserved/overlapping/`..` volume targets, `.wallis` self-snapshot, device rules, prototype-pollution and host-steering env/secret names. |
| `secrets.test.ts` | Secrets never in argv; agent/command spawns get none and don't inherit wallis's env; under bwrap, an agent's `/proc/1/environ` holds no secret. |
| `requires.test.ts` | `programBinds` never exposes `$HOME`, `~/.local`, `/opt` or the project; host programs resolve by absolute path from wallis's own PATH; env-key guards. |

## Open holes (todos)

### ESCAPE-02 — TOCTOU in the host file tools (HIGH) — CLOSED

`locate()` checked each component with `lstat`, then the tool opened the
full path; `O_NOFOLLOW` guarded only the last component, so an agent's bash
could swap an intermediate dir for a symlink in between. Now every use
opens the path as `openat` would (`openBeneath`, `host/src/host/layers.ts`):
each component relative to its parent's fd through `/proc/self/fd/<fd>/`,
with `O_NOFOLLOW` (and `O_NONBLOCK`, so a swapped-in FIFO never blocks the
host), and reads, lists, writes and stores artifacts through the fds; a
swap fails the open with a typed tool error. `toctou.test.ts` races
`read`, `write`, `ls` and `export_artifact` (`resolveDrafts`) and is now a
normal part of the gate.

## Closed holes this suite guards against (regression gate)

These were reproduced by earlier reviews and are now fixed; the suite keeps them
shut:

- host file tools following static symlinks / `..` / absolute links;
- ESCAPE-02: a TOCTOU swap of an intermediate dir (`toctou.test.ts`);
- `devices` binding arbitrary host paths (only char devices under `/dev`);
- `environment.PATH` hijacking the host-side bwrap spawn (`hostbin.ts`);
- `requires` exposing `$HOME`, `~/.local`, `/opt` (`programBinds`);
- the host trusting unparsed VM declarations (`parseDeclarations` + re-checks);
- agents/commands getting network; named volumes writable by agents.

## Documented residual risks (not gated)

- **ESCAPE-01** (see `sandbox.test.ts`) — `/proc/1/cmdline` leaks the host-side
  bwrap argv (bind-volume **host source paths**, `$HOME` layout via program
  install prefixes, cache dirs, and every `--setenv` value) into the sandbox,
  because bwrap runs as PID 1 of the sandbox's PID namespace. Information
  disclosure, not a read/write escape; **secrets are not leaked** for agent and
  command sandboxes (their host-side bwrap env is empty). Fix: pass `--as-pid-1`
  to bwrap so `/proc/1` is the sandboxed program itself (verified: with
  `--as-pid-1`, `/proc/1/cmdline` is the program's own argv and no host path
  appears; `/proc/1/environ` then holds only the inside `--setenv` vars the
  process already has, so no new exposure).
- **Resource exhaustion** inside a sandbox (fork bombs, huge `/w` files, deep
  directories) is **not** bounded by wallis itself for agent/command sandboxes:
  bwrap applies no memory/pids cgroup to them (only a command that declares
  `resources.memoryGb` is wrapped in `systemd-run --scope -p MemoryMax=…`;
  agents and unscoped commands get none). A fork bomb in an agent's `bash` is
  contained to the sandbox's PID namespace but can still exhaust host memory/PIDs.
  This is called out here rather than failing open silently.
