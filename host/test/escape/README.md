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

### ESCAPE-02 — TOCTOU in the host file tools: arbitrary host file read (HIGH)

**Where:** `host/src/host/layers.ts` — `readViewFile` (and the same pattern in
`writeViewFile`, `resolveDrafts`→`storeFile`, and the `read`/`ls`/`edit`/
`export_artifact` tools in `host/src/host/tools.ts`).

**The bug.** A file tool resolves a path with `locate()`, which walks the path
one component at a time with `lstatSync`, refusing any host symlink. It then
opens the *resolved full path* with `openSync(entry.host, … | O_NOFOLLOW)`.
`O_NOFOLLOW` rejects a symlink only at the **final** component. An **intermediate**
directory that was validated as a real directory by `locate` can be swapped for
a symlink before the `openSync`, and the open follows it out of the sandbox.

**Who can race it.** An agent's own `bash` runs in bwrap with `/w` as an overlay
whose **upper dir is the same host directory** the file tools read and write. So
the agent can create and rename symlinks inside `/w` while concurrently issuing
`read` calls — a check/use race across the same directory.

**Repro.** `test/escape/toctou.test.ts` with `fixtures/swap-racer.mjs`. The racer
flips `<upper>/a` between a real directory (holding a decoy file) and a symlink
to `/etc`; the main loop calls `locate()` + `readViewFile()` on `/w/a/hostname`.
It wins in well under 50 ms on this host and returns `/etc/hostname`'s contents
(`"cachyos\n"`) — a file entirely outside the sandbox. A second case steals an
arbitrary attacker-chosen file.

**Impact.** Arbitrary host file **read** through the `read` tool (and
`export_artifact`, which would exfiltrate the stolen bytes as an artifact). The
`write`/`edit` path re-`lstat`s each parent just before `openSync`, so its window
is narrower, but it is the same class and should be fixed together — a win there
is an arbitrary host file **write**. This defeats the core claim that host file
tools "never read or write outside the sandbox roots … through … races (TOCTOU
between check and open)."

**Suggested fix.** Resolve and open atomically. Walk the component chain with
`openat(dirfd, part, O_NOFOLLOW | O_PATH | O_DIRECTORY)` starting from an fd for
the root's upper/lower dir, so every intermediate symlink swap is caught at open
time; open the final component with `openat(parentfd, name, O_NOFOLLOW)` and read
through the fd. (Node: `fs.openSync` of each directory with `O_NOFOLLOW` and
`process.binding`-free `openat` via an fd-relative path is not directly exposed,
so this likely needs a small helper that opens each component relative to the
parent fd, e.g. via `fs.opendirSync`/`dirfd` + a native `openat`, or opening
`"/proc/self/fd/<parentfd>/name"` with `O_NOFOLLOW`.) Alternatively, open the
located path with `O_PATH | O_NOFOLLOW`, `fstat` it, and compare
`(dev, ino)` to the `lstat` captured during `locate` — rejecting on mismatch
closes the window for reads. The overlay layers are immutable, so only the
**upper** dir (writable by the agent) needs this treatment.

## Closed holes this suite guards against (regression gate)

These were reproduced by earlier reviews and are now fixed; the suite keeps them
shut:

- host file tools following static symlinks / `..` / absolute links;
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
