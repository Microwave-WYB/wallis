// The default executor module for the CLI and `wallis serve`: pi, with
// pi-ai's built-in provider catalog. Provider auth comes from pi-ai's usual
// environment variables. Use `--executor <module>` for anything else.

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { PiExecutor } from "../host/pi.ts";

export default function create() {
	return { executor: new PiExecutor({ models: builtinModels() as never }) };
}
