import { readFileSync, writeFileSync } from "node:fs";
const args = JSON.parse(readFileSync(0, "utf8"));
writeFileSync(`${process.env.WALLIS_SCRATCH}/model.txt`, args.text);
writeFileSync(`${process.env.WALLIS_SCRATCH}/not-exported.tmp`, "discarded");
process.stdout.write(JSON.stringify({ model: { artifact: "model.txt", media: "text/plain" } }));
