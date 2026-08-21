import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parserSource = readFileSync(
  path.join(root, "ViewCoder Extension", "core", "parser.js"),
  "utf8",
);
const context = vm.createContext({});
vm.runInContext(`${parserSource}\nthis.__viewCoderParser = ZSParse;`, context);
const parser = context.__viewCoderParser;

const lines = Array.from({ length: 5000 }, (_, index) => {
  const n = index + 1;
  return `local value_${n} = "row ${n} with braces { }"`;
});
const code = [
  'local folder = Instance.new("Folder")',
  'folder.Name = "LongLuaRegression"',
  ...lines,
  'folder.Parent = workspace',
  'return folder:GetFullName()',
].join("\n");
const reply = `I will create it now.\n\n###LUA###\n${code}\n###END_LUA###`;

assert.equal(parser.hasOpenToolBlock(reply), false);
const calls = parser.parseToolCalls(reply);
assert.equal(calls.length, 1);
assert.equal(calls[0].tool, "execute_luau");
assert.equal(calls[0].arguments.datamodel_type, "Edit");
assert.equal(calls[0].arguments.code, code);

const partial = reply.slice(0, reply.indexOf("###END_LUA###"));
assert.equal(parser.hasOpenToolBlock(partial), true);
assert.equal(parser.parseToolCalls(partial).length, 0);

const withCopyChrome =
  '###lua### Copy task.wait(0.1)\nreturn "complete"\n###END_LUA###';
assert.equal(
  parser.parseToolCalls(withCopyChrome)[0].arguments.code,
  'task.wait(0.1)\nreturn "complete"',
);

// ChatGPT can render the opening marker as a raw text node followed by inline
// syntax spans. The old child-only join dropped that raw node. The complete
// innerText candidate must win over the markerless child reconstruction.
const domCompleteLua = `###LUA###\n${code}\n###END_LUA###`;
const domChildJoinWithoutOpener = `${code}\n###END_LUA###`;
assert.equal(
  parser.chooseRenderedCodeText([
    domChildJoinWithoutOpener,
    domCompleteLua,
    domCompleteLua.replaceAll("\n", ""),
  ]),
  domCompleteLua,
);

// Current ChatGPT CodeMirror keeps the correct source in nested `.cm-line`
// nodes while both pre.innerText and pre.textContent can collapse all lines.
// The explicitly joined line candidate must win so Luau statements remain
// separated even after the raw block has been hidden by ViewCoder's chip.
const collapsedCodeMirrorLua = domCompleteLua.replaceAll("\n", "");
assert.equal(
  parser.chooseRenderedCodeText([collapsedCodeMirrorLua, domCompleteLua]),
  domCompleteLua,
);

const completeJson = '{"command":"viewcoder/get_capabilities","params":{"server":"all"}}';
const truncatedSpanJoin = '{"command":"viewcoder/get_capabilities","params":{"server":"all"}';
assert.equal(
  parser.chooseRenderedCodeText([truncatedSpanJoin, completeJson]),
  completeJson,
);

console.log("Long execute_luau parser regression passed.");
