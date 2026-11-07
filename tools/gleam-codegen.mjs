// Drives `gleam lsp` headless to apply the "Generate dynamic decoder" and
// "Generate to-JSON function" code actions to custom types in a Gleam file.
//
// Usage (from core/): node ../tools/gleam-codegen.mjs src/wallis_core/x.gleam TypeA TypeB ...
// Each named type gets both actions; the edits are written back to the file.
// Then nested-type `todo`s are resolved by naming convention (see below).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [file, ...types] = process.argv.slice(2);
const path = resolve(file);
const uri = pathToFileURL(path).href;
const root = pathToFileURL(process.cwd()).href;

const lsp = spawn("gleam", ["lsp"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = Buffer.alloc(0);
let nextId = 1;
const waiting = new Map();
lsp.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf("\r\n\r\n");
    if (sep < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, sep).toString())[1]);
    if (buf.length < sep + 4 + len) return;
    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString());
    buf = buf.subarray(sep + 4 + len);
    if (msg.id !== undefined && waiting.has(msg.id) && msg.method === undefined) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    } else if (msg.id !== undefined && msg.method) {
      send({ jsonrpc: "2.0", id: msg.id, result: null });
    }
  }
});
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  lsp.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  lsp.stdin.write(body);
}
function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((ok) => waiting.set(id, ok));
}
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

function offsetAt(text, line, character) {
  const lines = text.split("\n");
  let off = 0;
  for (let i = 0; i < line; i++) off += lines[i].length + 1;
  return off + character;
}
function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) =>
    offsetAt(text, b.range.start.line, b.range.start.character) -
    offsetAt(text, a.range.start.line, a.range.start.character));
  for (const e of sorted) {
    const s = offsetAt(text, e.range.start.line, e.range.start.character);
    const t = offsetAt(text, e.range.end.line, e.range.end.character);
    text = text.slice(0, s) + e.newText + text.slice(t);
  }
  return text;
}

await request("initialize", { processId: process.pid, rootUri: root, capabilities: {
  workspace: { workspaceEdit: { documentChanges: true } },
  textDocument: { codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.rewrite"] } }, resolveSupport: { properties: ["edit"] } } },
} });
notify("initialized", {});

let text = readFileSync(path, "utf8");
let version = 1;
notify("textDocument/didOpen", { textDocument: { uri, languageId: "gleam", version, text } });

const wanted = [/decoder/i, /to-?json/i];
for (const type of types) {
  for (const pattern of wanted) {
    const lines = text.split("\n");
    const line = lines.findIndex((l) => new RegExp(`^(pub )?type ${type}\\b`).test(l));
    if (line < 0) throw new Error(`type ${type} not found`);
    const character = lines[line].indexOf(type);
    const res = await request("textDocument/codeAction", {
      textDocument: { uri },
      range: { start: { line, character }, end: { line, character } },
      context: { diagnostics: [] },
    });
    const actions = res.result ?? [];
    let action = actions.find((a) => pattern.test(a.title));
    if (!action) {
      console.error(`${type}: no action matching ${pattern}; got ${actions.map((a) => a.title).join(", ")}`);
      continue;
    }
    if (!action.edit) action = (await request("codeAction/resolve", action)).result;
    const changes = action.edit.changes?.[uri] ?? action.edit.documentChanges?.flatMap((d) => d.edits) ?? [];
    text = applyEdits(text, changes);
    version++;
    notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    console.error(`${type}: applied "${action.title}"`);
  }
}
// The actions leave `todo` for nested custom types. Point them at the
// generated (or, for `Value`, the hand-written) functions by naming
// convention: `foo_decoder()` and `foo_to_json`. `Value` comes from
// `import wallis_core/value.{type Value} as json_value`.
const snake = (t) => t.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
text = text
  .replace(/#\("(\w+)", todo as "Encoder for Value"\)/g, '#("$1", json_value.to_json($1))')
  .replace(/#\("(\w+)", todo as "Encoder for (\w+)"\)/g, (_, f, t) => `#("${f}", ${snake(t)}_to_json(${f}))`)
  .replace(/todo as "Decoder for Value"/g, "json_value.decoder()")
  .replace(/todo as "Encoder for Value"/g, "json_value.to_json")
  .replace(/todo as "Decoder for (\w+)"/g, (_, t) => `${snake(t)}_decoder()`)
  .replace(/todo as "Encoder for (\w+)"/g, (_, t) => `${snake(t)}_to_json`);
// Encoders and decoders are part of the wire API.
text = text.replace(/^fn (\w+_(?:decoder|to_json))\(/gm, "pub fn $1(");
writeFileSync(path, text);
await request("shutdown", null);
notify("exit", null);
