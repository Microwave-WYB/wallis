// The model arrives as a mounted input artifact, the corpus as a mounted dataset.
import { readFileSync, writeFileSync } from "node:fs";
const args = JSON.parse(readFileSync(0, "utf8"));
const model = readFileSync(`${process.env.WALLIS_INPUTS}/${args.model.digest.slice(7)}/${args.model.name}`, "utf8");
const corpus = readFileSync(`${process.env.WALLIS_DATA_CORPUS}/words.txt`, "utf8");
writeFileSync(`${process.env.WALLIS_SCRATCH}/ckpt.bin`, `${model}+${corpus}`);
process.stdout.write(JSON.stringify({ checkpoint: { artifact: "ckpt.bin", media: "application/octet-stream" } }));
