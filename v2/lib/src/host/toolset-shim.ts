// What a toolset module gets when it imports "wallis": the schema builder
// only. A toolset runs in its own process, from a bundle, so it never pulls
// in the host. Type-only imports (WallisTool) are erased by the bundler.

export { Type } from "typebox";
