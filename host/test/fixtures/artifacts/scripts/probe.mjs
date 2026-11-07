// Reports what the sandbox lets it do.
import { readFileSync, writeFileSync } from "node:fs";
const args = JSON.parse(readFileSync(0, "utf8"));
const attempt = (f) => {
	try {
		f();
		return true;
	} catch {
		return false;
	}
};
const input = `${process.env.WALLIS_INPUTS}/${args.model.digest.slice(7)}/${args.model.name}`;
process.stdout.write(
	JSON.stringify({
		reads_input: attempt(() => readFileSync(input)),
		writes_input: attempt(() => writeFileSync(input, "tampered")),
		writes_scratch: attempt(() => writeFileSync(`${process.env.WALLIS_SCRATCH}/x`, "ok")),
		reads_outside: attempt(() => readFileSync(args.outside)),
		writes_outside: attempt(() => writeFileSync(`${args.outside}.copy`, "leak")),
		sees_home: attempt(() => readFileSync(`${process.env.WALLIS_HOME_PROBE ?? "/home"}`)),
	}),
);
