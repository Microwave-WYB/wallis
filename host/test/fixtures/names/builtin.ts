// A custom tool named like a built-in (`read`).
import { agent, lib, names } from "./common.ts";

export default names([agent("builtin", [lib.reader])]);
