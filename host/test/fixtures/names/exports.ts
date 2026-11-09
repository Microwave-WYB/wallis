// Two exports of one toolset that share a name (`dup`).
import { agent, lib, names } from "./common.ts";

export default names([agent("exports", [lib.first, lib.second])]);
