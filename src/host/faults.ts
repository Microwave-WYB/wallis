// Fault injection for crash tests: `WALLIS_CRASH_AT=<point>:<n>` kills this
// process (SIGKILL) the nth time it reaches `point`, e.g. right after a blob
// is written and before the event that names it.

const crashes = new Map<string, number>();

export function crashPoint(point: string): void {
	const at = process.env.WALLIS_CRASH_AT;
	if (!at) return;
	const [name, n] = at.split(":");
	if (name !== point) return;
	const count = (crashes.get(point) ?? 0) + 1;
	crashes.set(point, count);
	if (count === Number(n)) process.kill(process.pid, "SIGKILL");
}
