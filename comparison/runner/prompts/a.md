## Target technology: a small custom TypeScript program on the pi SDK

Build the replica as a small TypeScript program, following the skill mounted read-only at /mnt/skill. Read /mnt/skill/SKILL.md first; its snippets/ directory has more patterns.

/work/project is already a copy of the skill's template, with its npm dependencies installed (pi-agent-core and pi-ai 1.5.0, typebox, typescript). Adapt and extend it. Node 26 is on PATH (`node`, `npx`).

ML code that would be Python in reality may be stubbed in Python (python3 is available, standard library only) or in TypeScript. The bwrap sandbox helper in the template cannot nest inside your sandbox. In tests, make sandboxing switchable and exercise it with sandboxing off, but keep the real code path in place.
