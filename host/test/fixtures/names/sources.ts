// Two toolsets that both export a tool named `search`.
import { agent, lib, names, other } from "./common.ts";

export default names([agent("sources", [lib.search, other.search])]);
