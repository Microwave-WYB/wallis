// The model arrives as a mounted input artifact (its path as argv[2]), the corpus as a mount at /mnt/corpus.
import { readFileSync, writeFileSync } from "node:fs";
const model = readFileSync(process.argv[2], "utf8");
const corpus = readFileSync("/mnt/corpus/words.txt", "utf8");
writeFileSync("ckpt.bin", `${model}+${corpus}`);
process.stdout.write(String(model.length + corpus.length));
